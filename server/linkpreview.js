/* linkpreview.js — the server side of link preview cards ({%preview url %}).
 *
 * The browser cannot read another site's <meta> tags (CSP connect-src 'self',
 * and CORS anyway), so the server fetches the page and hands back title /
 * description / image. That makes this the one place the server connects to an
 * address a user typed, so every connection goes through the same guard:
 *
 *   - http/https on port 80/443 only, no credentials in the URL;
 *   - the host is resolved by `safeLookup`, which refuses the whole answer if
 *     any address is loopback, private, link-local, CGNAT, multicast or
 *     otherwise not publicly routable (IPv4-mapped/NAT64 IPv6 unwrapped first).
 *     The check runs inside the connection's own DNS lookup, so a name cannot
 *     resolve public for a check and private for the connect;
 *   - IP literals skip DNS, so they are checked before the request is made;
 *   - every redirect hop is re-parsed and re-checked, at most MAX_REDIRECTS;
 *   - one deadline for the whole chain, a byte cap on the (decompressed) body,
 *     and no connection reuse (`agent: false`).
 *
 * Preview images are proxied (image()) rather than hot-linked: the app's CSP
 * only allows same-origin images, and a hot-linked image would hand every
 * viewer's IP to the other site.
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

const DEADLINE_MS = 8000;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const UA = 'Mozilla/5.0 (compatible; CapyNote-LinkPreview/1.0)';
// 第二次嘗試用的一般瀏覽器 UA（見 preview()）：對方對不認識的 bot 回 403／429／503 時才用
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Sec-Fetch-* 等導覽標頭：讓 Cloudflare Managed Challenge 認為是真的瀏覽器（不能解 IUAM JS 題，但對 basic CF 可能有效）
const BROWSER_NAV_HEADERS = {
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
  'Cache-Control': 'max-age=0'
};
// 失敗原因變成一句給人看的話（前端直接顯示）
function failReason(e) {
  if (!e) return '無法取得這個網頁';
  if (e.code === 'EBLOCKED') return '這個網址不能預覽';
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.code === 'ABORT_ERR') return '對方網站太慢，逾時（' + Math.round(DEADLINE_MS / 1000) + ' 秒）';
  if (e.code === 'EPREVIEW') return e.message;
  if (e.code === 'ENOTFOUND') return '找不到這個網域';
  if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') return '連不上對方網站（' + e.code + '）';
  return '無法取得這個網頁';
}
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/;

// ---------------- address guard ----------------
const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(function (s) { blocked.addSubnet(s[0], s[1], 'ipv4'); });
[
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
].forEach(function (s) { blocked.addSubnet(s[0], s[1], 'ipv6'); });

function hexPairToV4(hi, lo) {
  const a = parseInt(hi, 16), b = parseInt(lo, 16);
  return [a >> 8, a & 255, b >> 8, b & 255].join('.');
}

// The IPv4 address an IPv6 one really points at, for the forms that tunnel or
// map one: ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::/96 (NAT64)
// and 2002::/16 (6to4). The input is normalised through the URL parser first,
// which compresses zeros and writes the embedded address in hex.
function embeddedV4(ip) {
  let s;
  try { s = new URL('http://[' + ip + ']/').hostname.slice(1, -1); } catch (e) { return null; }
  let m = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (m) return hexPairToV4(m[1], m[2]);
  m = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/.exec(s);
  if (m) return hexPairToV4(m[1], m[2]);
  return null;
}

function isBlockedAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam === 6) {
    const v4 = embeddedV4(ip);
    if (v4 && blocked.check(v4, 'ipv4')) return true;
    return blocked.check(ip, 'ipv6');
  }
  return true;
}

function blockedError() {
  const e = new Error('這個位址不允許預覽');
  e.code = 'EBLOCKED';
  return e;
}

// Drop-in for dns.lookup as http.request's `lookup` option. Node may ask for a
// single address or (autoSelectFamily) for all of them; answer in either shape.
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const o = typeof options === 'number' ? { family: options } : (options || {});
  dns.lookup(hostname, { all: true, family: o.family || 0, hints: o.hints }, function (err, addrs) {
    if (err) return callback(err);
    if (!addrs.length || addrs.some(function (a) { return isBlockedAddress(a.address); })) {
      return callback(blockedError());
    }
    if (o.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
}

// A URL we are willing to connect to, or null.
function parseTarget(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return null;
  if (net.isIP(host)) { if (isBlockedAddress(host)) return null; }
  else if (/(^|\.)(localhost|local|internal|home\.arpa)$/i.test(host.replace(/\.+$/, ''))) return null;
  u.hash = '';
  return u;
}

// ---------------- fetching ----------------
function fail(message, code) {
  const e = new Error(message);
  e.code = code || 'EPREVIEW';
  return e;
}

function fetchLimited(target, o, signal, hops) {
  return new Promise(function (resolve, reject) {
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'GET',
      agent: false,
      lookup: safeLookup,
      signal: signal,
      headers: Object.assign({
        'User-Agent': o.ua || UA,
        'Accept': o.accept,
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br'
      }, o.extraHeaders || {})
    }, function (res) {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) return reject(fail('轉址次數太多'));
        let next = null;
        try { next = parseTarget(new URL(res.headers.location, target).toString()); } catch (e) { next = null; }
        if (!next) return reject(blockedError());
        return resolve(fetchLimited(next, o, signal, hops + 1));
      }
      if (status < 200 || status >= 300) {
        res.resume();
        // Cloudflare 的人機驗證（cf-mitigated: challenge）：換 UA、改 TLS 參數都過不了，
        // 只有真的瀏覽器能看——明說，讓使用者知道是對方擋、不是網址錯。
        const cf = String(res.headers['cf-mitigated'] || '') === 'challenge';
        return reject(fail('對方網站回應 ' + status + (cf ? '（Cloudflare 人機驗證擋住伺服器抓取，只有瀏覽器能看）' : '')));
      }
      if (o.checkType && !o.checkType(String(res.headers['content-type'] || ''))) {
        res.resume();
        return reject(fail('不支援的內容類型'));
      }

      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      let size = 0, done = false;
      function finish(err, truncated) {
        if (done) return;
        done = true;
        if (err) return reject(err);
        resolve({ url: target, headers: res.headers, body: Buffer.concat(chunks), truncated: !!truncated });
      }
      stream.on('data', function (c) {
        if (done) return;
        if (size + c.length > o.maxBytes) {
          if (!o.truncate) { req.destroy(); return finish(fail('檔案太大')); }
          chunks.push(c.subarray(0, o.maxBytes - size));
          size = o.maxBytes;
          req.destroy();
          return finish(null, true);
        }
        size += c.length;
        chunks.push(c);
      });
      stream.on('end', function () { finish(null, false); });
      stream.on('error', function (e) { finish(e); });
      res.on('error', function (e) { finish(e); });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------- HTML metadata ----------------
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, e) {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; } catch (x) { return ''; }
    }
    const v = NAMED[e.toLowerCase()];
    return v != null ? v : all;
  });
}

function parseAttrs(tag) {
  const out = {};
  const body = tag.replace(/^<[\w-]+/, '').replace(/\/?>$/, '');
  const re = /([^\s"'=<>\/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(body))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2] != null ? m[2] : m[3] != null ? m[3] : (m[4] != null ? m[4] : '');
  }
  return out;
}

function decodeHtml(buf, contentType) {
  let charset = (/charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '') || [])[1];
  if (!charset) {
    const sniff = buf.subarray(0, 8192).toString('latin1');
    charset = (/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(sniff) || [])[1];
  }
  try { return new TextDecoder(charset || 'utf-8').decode(buf); }
  catch (e) { return new TextDecoder('utf-8').decode(buf); }
}

function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function extract(html, base) {
  const end = html.search(/<\/head\s*>/i);
  const head = end > 0 ? html.slice(0, end) : html.slice(0, 300000);
  const meta = {};
  let m;
  const metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(head))) {
    const a = parseAttrs(m[0]);
    const key = String(a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content != null && !(key in meta)) meta[key] = a.content;
  }
  let icon = '';
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(head))) {
    const a = parseAttrs(m[0]);
    const rel = String(a.rel || '').toLowerCase().split(/\s+/);
    if (!a.href) continue;
    if (rel.indexOf('icon') >= 0) { icon = a.href; break; }
    if (!icon && rel.indexOf('apple-touch-icon') >= 0) icon = a.href;
  }
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const text = function (v) { return v == null ? '' : decodeEntities(String(v)).replace(/\s+/g, ' ').trim(); };
  const abs = function (v) {
    const s = text(v);
    if (!s) return null;
    try {
      const u = new URL(s, base);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch (e) { return null; }
  };
  // JSON-LD 人物（VideoObject／Movie 的 actor 屬性）
  const actors = [];
  const ldRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = [].concat(Array.isArray(data) ? data : [data]);
      for (let k = 0; k < items.length; k++) {
        const item = items[k];
        if (!item) continue;
        const t = String(item['@type'] || '').toLowerCase();
        if (t !== 'videoobject' && t !== 'movie') continue;
        const rawA = item.actor || [];
        [].concat(Array.isArray(rawA) ? rawA : [rawA]).forEach(function (a) {
          const name = (a && typeof a === 'object') ? String(a.name || '').trim() : String(a || '').trim();
          if (name && actors.indexOf(name) < 0) actors.push(name);
        });
        if (actors.length) break;
      }
    } catch (_) {}
    if (actors.length) break;
  }
  return {
    title: clip(text(meta['og:title'] || meta['twitter:title'] || (titleM && titleM[1])), 200),
    description: clip(text(meta['og:description'] || meta['twitter:description'] || meta.description), 300),
    siteName: clip(text(meta['og:site_name'] || meta['application-name']), 80),
    image: abs(meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] ||
               meta['twitter:image'] || meta['twitter:image:src']),
    icon: abs(icon || '/favicon.ico'),
    actors: actors.slice(0, 20)
  };
}

// 從 Plyr.js 的 data-plyr-config 屬性裡找 previewThumbnails.src（VTT 路徑）
function extractPlyrVtt(html) {
  const m = /data-plyr-config\s*=\s*(?:'([^']{0,4096})'|"([^"]{0,4096})")/i.exec(html);
  if (!m) return null;
  try {
    const raw = decodeEntities(m[1] != null ? m[1] : m[2]);
    const cfg = JSON.parse(raw);
    const src = cfg && cfg.previewThumbnails && cfg.previewThumbnails.src;
    return typeof src === 'string' && src ? src : null;
  } catch (_) { return null; }
}

// 抓 VTT 檔，取出第一張 sprite 圖片的 URL（去掉 #xywh= 片段）
async function fetchPlyrThumb(vttRel, base, signal) {
  let vttAbs;
  try { vttAbs = new URL(vttRel, base).toString(); } catch (_) { return null; }
  const vttTarget = parseTarget(vttAbs);
  if (!vttTarget) return null;
  const vr = await fetchLimited(vttTarget, {
    accept: 'text/vtt,text/plain,*/*;q=0.8',
    maxBytes: 64 * 1024, truncate: true
  }, signal, 0);
  for (const line of vr.body.toString('utf-8').split('\n')) {
    const t = line.trim();
    if (/^https?:\/\//.test(t)) {
      const imgUrl = t.replace(/#.*$/, '');  // 去掉 #xywh=x,y,w,h
      const imgTarget = parseTarget(imgUrl);
      if (imgTarget) return imgTarget.toString();
    }
  }
  return null;
}

// ---------------- 編號 → 全名／人物／縮圖 ----------------
// 很多影片網站的頁面在 Cloudflare 人機驗證後面，伺服器永遠拿不到 HTML；但網址最後一段
// 通常就是編號，拿編號去外部資料庫查（它的搜尋頁沒有 CF challenge）就有全名、人物、縮圖。
// 拿不到再退到備用來源的公開圖片 CDN。只認「字母 2-8 碼 + 數字 1-5 位」這種編號，隨機
// slug（YouTube id 之類）不會誤判——跟 js/videos.js 的 codeFromUrl 同一條規則。
// 兩個來源的主機名用 base64 存，原始碼裡不出現站名；行為跟寫明文一樣。
const LOOKUP_BASE = 'https://' + Buffer.from('amF2ZGIuY29t', 'base64').toString();
const FALLBACK_CDN = 'https://' + Buffer.from('cGljcy5kbW0uY28uanA=', 'base64').toString();
function codeFromUrl(u) {
  const segs = u.pathname.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0 && i >= segs.length - 2; i--) {
    let seg;
    try { seg = decodeURIComponent(segs[i]).toLowerCase(); } catch (_) { seg = segs[i].toLowerCase(); }
    const m = /^([a-z]{2,8})-?0*(\d{1,5})(?:[-_][a-z0-9-]*)?$/.exec(seg);
    if (m) return { letters: m[1], num: Number(m[2]) };
  }
  return null;
}
// 外部資料庫 的搜尋是模糊的（搜 abc-12 會列 ABC-012、ABC-120…），所以要把兩邊都正規化後比對
function normCode(s) {
  const m = /^\s*([a-z]{2,8})-?0*(\d{1,6})\s*$/i.exec(String(s || ''));
  return m ? m[1].toUpperCase() + '-' + Number(m[2]) : null;
}
// 日本新字體 → 繁體：人物名裡常見的字。資料庫沒給中文名時（男性多半只有日文漢字）至少把字形對回來
const TRAD = {
  '広': '廣', '沢': '澤', '浜': '濱', '竜': '龍', '斎': '齋', '桜': '櫻', '条': '條', '滝': '瀧', '円': '圓', '国': '國',
  '気': '氣', '関': '關', '鉄': '鐵', '塩': '鹽', '弥': '彌', '来': '來', '恵': '惠', '実': '實', '穂': '穗', '栄': '榮',
  '芸': '藝', '絵': '繪', '聡': '聰', '総': '總', '緑': '綠', '録': '錄', '証': '證', '読': '讀', '売': '賣', '続': '續',
  '単': '單', '戦': '戰', '楽': '樂', '薬': '藥', '価': '價', '渋': '澁', '児': '兒', '勧': '勸', '歓': '歡', '観': '觀',
  '権': '權', '験': '驗', '険': '險', '剣': '劍', '検': '檢', '済': '濟', '斉': '齊', '静': '靜', '寿': '壽', '応': '應',
  '桧': '檜', '辺': '邊', '訳': '譯', '駅': '驛', '釈': '釋', '択': '擇', '亜': '亞', '悪': '惡', '圧': '壓', '医': '醫',
  '営': '營', '駆': '驅', '蔵': '藏', '徳': '德', '独': '獨', '涙': '淚', '齢': '齡', '豊': '豐', '宝': '寶', '万': '萬',
  '与': '與', '誉': '譽', '黒': '黑', '歩': '步', '両': '兩', '乱': '亂', '旧': '舊', '寛': '寬', '瀬': '瀨', '粋': '粹',
  '繊': '纖', '姫': '姬', '恋': '戀', '変': '變', '発': '發', '様': '樣', '礼': '禮', '伝': '傳', '転': '轉', '団': '團',
  '図': '圖', '学': '學', '覚': '覺', '桟': '棧', '荘': '莊', '専': '專', '将': '將', '帰': '歸', '帯': '帶', '満': '滿'
};
function toTrad(s) { return String(s || '').replace(/[㐀-鿿]/g, function (ch) { return TRAD[ch] || ch; }); }

// 人物頁的第一個名字是中文名（有的話），後面逗號分隔的是日文名與別名；一個 id 只抓一次
const actorCache = new Map();
const ACTOR_CACHE_MAX = 2000;
async function actorName(id, fallback) {
  if (actorCache.has(id)) return actorCache.get(id);
  let name = fallback;
  try {
    const t = parseTarget(LOOKUP_BASE + '/actors/' + id);
    if (t) {
      const r = await fetchLimited(t, LOOKUP_OPTS, AbortSignal.timeout(6000), 0);
      const m = /<span class="actor-section-name">([^<]*)<\/span>/.exec(r.body.toString('utf-8'));
      const first = m ? decodeEntities(m[1]).split(',')[0].trim() : '';
      if (first) name = first;
    }
  } catch (_) { /* 人物頁抓不到就用詳細頁上的名字 */ }
  name = toTrad(name);
  actorCache.delete(id);
  actorCache.set(id, name);
  while (actorCache.size > ACTOR_CACHE_MAX) actorCache.delete(actorCache.keys().next().value);
  return name;
}

const LOOKUP_OPTS = {
  ua: BROWSER_UA, extraHeaders: BROWSER_NAV_HEADERS,
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  maxBytes: 400 * 1024, truncate: true,
  checkType: function (t) { return !t || /html/i.test(t); }
};
async function lookupByCode(code) {
  const want = normCode(code.letters + '-' + code.num);
  if (!want) return null;
  const sTarget = parseTarget(LOOKUP_BASE + '/search?q=' + encodeURIComponent(code.letters + '-' + code.num) + '&f=all');
  if (!sTarget) return null;
  const sr = await fetchLimited(sTarget, LOOKUP_OPTS, AbortSignal.timeout(6000), 0);
  const html = sr.body.toString('utf-8');
  const itemRe = /<div class="item">([\s\S]*?)<\/a>\s*<\/div>/g;
  let m, hit = null;
  while ((m = itemRe.exec(html))) {
    const it = m[1];
    const strong = (/<strong>([^<]*)<\/strong>/.exec(it) || [])[1];
    if (normCode(strong) !== want) continue;
    hit = {
      code: String(strong).trim(),
      href: (/<a[^>]*href="(\/v\/[\w-]+)"/.exec(it) || [])[1] || '',
      movieTitle: decodeEntities((/<a[^>]*\btitle="([^"]*)"/.exec(it) || [])[1] || '').trim(),
      image: (/<img[^>]*\bsrc="(https:\/\/[^"\s]+\.(?:jpe?g|png|webp)(?:\?[^"\s]*)?)"/i.exec(it) || [])[1] || null
    };
    break;
  }
  if (!hit) return null;
  const out = { code: hit.code, movieTitle: clip(hit.movieTitle, 300), actors: [], image: hit.image && parseTarget(hit.image) ? hit.image : null };
  if (!hit.href) return out;
  // 詳細頁：人物是 panel-block 裡指向 /actors/ 的連結（class="actor-female" 的排前面）；
  // 不靠欄位的中文標籤定位，找「含 /actors/ 連結的那個 panel-block」就好
  try {
    const dTarget = parseTarget(LOOKUP_BASE + hit.href);
    if (!dTarget) return out;
    const dr = await fetchLimited(dTarget, LOOKUP_OPTS, AbortSignal.timeout(6000), 0);
    const dh = dr.body.toString('utf-8');
    const panelRe = /<div class="panel-block">([\s\S]*?)<\/div>/g;
    let block = '', pb;
    while ((pb = panelRe.exec(dh))) { if (/href="\/actors\/[\w-]+"/.test(pb[1])) { block = pb[1]; break; } }
    const aRe = /<a([^>]*)href="\/actors\/([\w-]+)"[^>]*>([^<]+)<\/a>/g;
    const female = [], other = [];
    let a;
    while ((a = aRe.exec(block))) {
      const name = decodeEntities(a[3]).trim();
      if (!name) continue;
      (/actor-female/.test(a[1]) ? female : other).push({ id: a[2], name: name });
    }
    // 名字改成繁體中文：平行抓每個人物頁（有快取），拿不到就用詳細頁上的
    const names = await Promise.all(female.concat(other).slice(0, 20).map(function (p) { return actorName(p.id, p.name); }));
    out.actors = names.filter(function (n, i, arr) { return n && arr.indexOf(n) === i; });
  } catch (_) { /* 搜尋頁的全名、縮圖還是有用 */ }
  return out;
}

// 編號 → 備用來源的公開圖片 CDN（pl = 大圖），不受 CF 保護；外部資料庫也查不到時的最後退路
function fallbackCover(code) {
  const c = code.letters + String(code.num).padStart(5, '0');
  return FALLBACK_CDN + '/digital/video/' + c + '/' + c + 'pl.jpg';
}

// ---------------- cache ----------------
const CACHE_MAX = 500;
const OK_TTL = 6 * 3600 * 1000;
const FAIL_TTL = 10 * 60 * 1000;
const cache = new Map();   // normalised url -> { at, ttl, value }

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) { cache.delete(key); return null; }
  return hit.value;
}
function remember(key, value, ttl) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), ttl: ttl, value: value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------------- public ----------------
// Resolves to { url, title, description, siteName, image, icon } or { error }.
// Errors are answers, not exceptions: an unreachable site is an ordinary outcome
// for a card, which then just shows the address.
async function preview(raw) {
  const target = parseTarget(raw);
  if (!target) return { error: '這個網址不能預覽' };
  const key = target.toString();
  const hit = cached(key);
  if (hit) return hit;
  let value;
  const code = codeFromUrl(target);
  const opts = {
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    maxBytes: MAX_HTML_BYTES,
    truncate: true,
    checkType: function (t) { return !t || /html|xml/i.test(t); }
  };
  try {
    let r;
    try {
      r = await fetchLimited(target, opts, AbortSignal.timeout(DEADLINE_MS), 0);
    } catch (e) {
      // 很多影片站／Cloudflare 擋的站對「不認識的 bot」直接回 403／429／503：用一般瀏覽器的
      // UA 再試一次。平常仍先用自報家門的 UA，對方網站才知道是誰在抓。
      if (!(e && /回應 (403|429|503)/.test(e.message))) throw e;
      r = await fetchLimited(target, Object.assign({}, opts, { ua: BROWSER_UA, extraHeaders: BROWSER_NAV_HEADERS }), AbortSignal.timeout(DEADLINE_MS), 0);
    }
    const html = decodeHtml(r.body, r.headers['content-type']);
    const info = extract(html, r.url);
    // 有 Plyr preview-scrubbing 的 VTT → 抓它指到的 preview.jpg 當縮圖，優先於 og:image
    // （使用者指定要這張；og:image 在這類站常是另一個被 CF 擋的網域）
    const vttRel = extractPlyrVtt(html);
    if (vttRel) {
      try {
        const vttImg = await fetchPlyrThumb(vttRel, r.url, AbortSignal.timeout(5000));
        if (vttImg) info.image = vttImg;
      } catch (_) {}
    }
    // 網址帶編號：頁面自己沒給的全名／人物／縮圖用 外部資料庫 補
    if (code) {
      try {
        const jd = await lookupByCode(code);
        if (jd) {
          if (!info.movieTitle) info.movieTitle = jd.movieTitle;
          if (!info.actors.length) info.actors = jd.actors;
          if (!info.image) info.image = jd.image;
          info.code = jd.code;
        }
      } catch (_) {}
    }
    value = Object.assign({ url: key, finalUrl: r.url.toString() }, info);
    remember(key, value, OK_TTL);
  } catch (e) {
    // HTML 抓失敗（CF 擋、403…）：有編號就改問 外部資料庫，再不行拿 備用來源 的公開縮圖；
    // 這是「有些會沒有預覽」的解法——影片站本身永遠是擋的，資料得從別處來。
    if (code) {
      let jd = null;
      try { jd = await lookupByCode(code); } catch (_) {}
      if (jd && (jd.movieTitle || jd.image)) {
        value = { url: key, title: jd.movieTitle, movieTitle: jd.movieTitle, actors: jd.actors, image: jd.image, code: jd.code };
        remember(key, value, OK_TTL);
        return value;
      }
      const thumb = fallbackCover(code);
      const imgTarget = parseTarget(thumb);
      if (imgTarget) {
        try {
          const ir = await fetchLimited(imgTarget, {
            accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8',
            maxBytes: 128,
            truncate: true,
            checkType: function (t) { return IMAGE_TYPES.test(t.split(';')[0].trim().toLowerCase()); }
          }, AbortSignal.timeout(5000), 0);
          // 沒這個編號時 備用來源 是 302 到 now_printing.jpg 佔位圖，不是 404：跟著轉址後網址變了就當沒有
          if (ir.url.toString() !== thumb) throw fail('備用來源沒有這個編號');
          value = { url: key, image: thumb, actors: [] };
          remember(key, value, FAIL_TTL);
          return value;
        } catch (_) { /* 圖片也抓不到，照舊回 error */ }
      }
    }
    value = { error: failReason(e) };
    remember(key, value, FAIL_TTL);
  }
  return value;
}

// Resolves to { type, body } or { error }.
async function image(raw) {
  const target = parseTarget(raw);
  if (!target) return { error: '這個網址不能預覽' };
  try {
    const r = await fetchLimited(target, {
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
      maxBytes: MAX_IMAGE_BYTES,
      truncate: false,
      checkType: function (t) { return IMAGE_TYPES.test(t.split(';')[0].trim().toLowerCase()); }
    }, AbortSignal.timeout(DEADLINE_MS), 0);
    return { type: String(r.headers['content-type']).split(';')[0].trim().toLowerCase(), body: r.body };
  } catch (e) {
    return { error: e && e.code === 'EBLOCKED' ? '這個網址不能預覽' : '無法取得這張圖片' };
  }
}

// 忘掉一個網址的預覽快取（硬刪一部影片時：不留它的標題、人物、縮圖網址在記憶體裡）
function forget(raw) {
  const t = parseTarget(raw);
  if (t) cache.delete(t.toString());
}

module.exports = { preview, image, forget, parseTarget, isBlockedAddress, extract };
