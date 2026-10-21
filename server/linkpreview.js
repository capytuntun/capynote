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
          // 頁面自己給的名字也過一次字形轉換（日本新字體 → 繁體）
          const name = toTrad((a && typeof a === 'object') ? String(a.name || '').trim() : String(a || '').trim());
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
    // 編號後面可以接 -xxx／_xxx／+xxx 的字尾（有的站把標題用 + 接在編號後面）
    const m = /^([a-z]{2,8})-?0*(\d{1,5})(?:[-_+ ][a-z0-9+ _-]*)?$/.exec(seg);
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
// 反向：庫裡已經是繁體的名字（阿部智廣）資料庫搜不到，退回新字體（阿部智広）再搜一次
const JP = {};
Object.keys(TRAD).forEach(function (k) { if (!JP[TRAD[k]]) JP[TRAD[k]] = k; });
function toJp(s) { return String(s || '').replace(/[㐀-鿿]/g, function (ch) { return JP[ch] || ch; }); }

// 人物頁：第一個名字是中文名（有的話），後面逗號分隔的是日文名與別名；頁首那顆
// <span class="avatar" style="background-image: url(…)"> 是大頭照。每次都抓，不留快取
// （使用者要求影片這一塊完全不留快取）。回 { name, image, aliases }。
function pickImage(u) { return u && /^https:\/\/[^\s"'<>)]+\.(?:jpe?g|png|webp)(?:\?[^\s"'<>)]*)?$/i.test(u) && parseTarget(u) ? u : null; }
// 人物頁名字底下那行 section-meta 以這兩個字開頭的是男性（「…, N 部影片」）——影片庫不收男性人物
const MALE_MARK = String.fromCharCode(0x7537, 0x512a);
async function actorInfo(id, fallback) {
  let name = fallback, image = null, aliases = [], male = false, known = false, works = 0;
  try {
    const t = parseTarget(LOOKUP_BASE + '/actors/' + id);
    if (t) {
      const r = await fetchLimited(t, LOOKUP_OPTS, AbortSignal.timeout(6000), 0);
      const h = r.body.toString('utf-8');
      const m = /<span class="actor-section-name">([^<]*)<\/span>/.exec(h);
      if (m) {
        known = true;
        aliases = decodeEntities(m[1]).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        if (aliases[0]) name = aliases[0];
      }
      const av = /<span class="avatar"[^>]*background-image:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i.exec(h);
      if (av) image = pickImage(decodeEntities(av[1]));
      male = new RegExp('<span class="section-meta">\\s*' + MALE_MARK).test(h);
      // 名字底下的 section-meta 之一是「N 部影片」（男性的是「標記, N 部影片」）：作品數
      let sm; const smRe = /<span class="section-meta">([^<]*)<\/span>/g;
      while ((sm = smRe.exec(h))) { const w = /(\d{1,6})\s*部/.exec(sm[1]); if (w) { works = Number(w[1]); break; } }
      // 第二個 section-meta（沒有性別標記的那行）是更多別名
      smRe.lastIndex = 0;
      while ((sm = smRe.exec(h))) {
        const txt = decodeEntities(sm[1]);
        if (/\d\s*部/.test(txt) || txt.indexOf(MALE_MARK) >= 0) continue;
        txt.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (a) { if (aliases.indexOf(a) < 0) aliases.push(a); });
      }
    }
  } catch (_) { /* 人物頁抓不到就用詳細頁上的名字 */ }
  const seenA = {};
  const al = aliases.map(toTrad).filter(function (a) { if (seenA[a]) return false; seenA[a] = true; return true; });
  return { id: id, name: toTrad(name), image: image, aliases: al, male: male, known: known, works: works };
}
async function actorName(id, fallback) { return (await actorInfo(id, fallback)).name; }

// 用名字找人：外部資料庫的人物搜尋（f=actor）回一排 actor-box，每個帶 /actors/<id>、title 裡
// 是所有別名（中文、日文、舊藝名）、一張大頭照、<strong> 裡是主名。別名裡剛好有查的名字那
// 一個優先，沒有就拿第一個；再進人物頁拿中文名與大頭照。找不到回 { error }。
async function person(rawName) {
  // 用原名去搜（資料庫認的是它自己的寫法，先轉成繁體反而搜不到）；比對時兩邊都轉繁體
  const rawQ = String(rawName || '').trim().slice(0, 80);
  const want = toTrad(rawQ);
  if (!want) return { error: '沒有名字' };
  async function searchBoxes(qs) {
    const sTarget = parseTarget(LOOKUP_BASE + '/search?q=' + encodeURIComponent(qs) + '&f=actor');
    if (!sTarget) return [];
    const sr = await fetchLimited(sTarget, LOOKUP_OPTS, AbortSignal.timeout(6000), 0);
    const html = sr.body.toString('utf-8');
    const boxRe = /<div class="box actor-box">\s*<a href="\/actors\/([\w-]+)"(?:\s+title="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/g;
    const boxes = [];
    let m;
    while ((m = boxRe.exec(html)) && boxes.length < 20) {
      const inner = m[3];
      boxes.push({
        id: m[1],
        aliases: decodeEntities(m[2] || '').split(',').map(function (s) { return toTrad(s.trim()); }).filter(Boolean),
        image: pickImage((/<img[^>]*\bsrc="([^"]+)"/.exec(inner) || [])[1] || ''),
        name: toTrad(decodeEntities((/<strong>\s*([^<]*?)\s*<\/strong>/.exec(inner) || [])[1] || '').trim())
      });
    }
    return boxes;
  }
  try {
    let boxes = await searchBoxes(rawQ);
    if (!boxes.length && want !== rawQ) boxes = await searchBoxes(want);
    if (!boxes.length && toJp(rawQ) !== rawQ) boxes = await searchBoxes(toJp(rawQ));
    if (!boxes.length) return { error: '查不到這個人' };
    const lw = want.toLowerCase();
    const hit = boxes.find(function (b) { return b.aliases.concat([b.name]).some(function (a) { return a.toLowerCase() === lw; }); }) || boxes[0];
    const info = await actorInfo(hit.id, hit.name || want);
    const aliases = info.aliases.concat(hit.aliases, [hit.name]).filter(function (a, i, arr) { return a && arr.indexOf(a) === i; });
    // known：人物頁真的讀到了（性別才算數）；matched：查的名字就在這個人的別名裡（不是隨便拿第一個）
    return {
      name: info.name || hit.name, image: info.image || hit.image, aliases: aliases.slice(0, 20),
      matched: hit.aliases.concat([hit.name]).some(function (a) { return a.toLowerCase() === lw; }),
      male: info.male, known: info.known, works: info.works || 0
    };
  } catch (e) {
    return { error: failReason(e) };
  }
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
  const out = { code: hit.code, movieTitle: clip(hit.movieTitle, 300), actors: [], people: [], image: hit.image && parseTarget(hit.image) ? hit.image : null, tags: [], released: '', duration: 0, maker: '' };
  if (!hit.href) return out;
  // 詳細頁：人物是 panel-block 裡指向 /actors/ 的連結（class="actor-female" 的排前面）；
  // 不靠欄位的中文標籤定位，每個 block 都用「連結指向哪裡／值長什麼樣」認：
  //   /tags? 連結 → 類別（變 hashtag）、/makers/ 連結 → 片商、值是 YYYY-MM-DD → 發行日、值是「N 分…」→ 片長
  try {
    const dTarget = parseTarget(LOOKUP_BASE + hit.href);
    if (!dTarget) return out;
    const dr = await fetchLimited(dTarget, LOOKUP_OPTS, AbortSignal.timeout(6000), 0);
    const dh = dr.body.toString('utf-8');
    const panelRe = /<div class="panel-block">([\s\S]*?)<\/div>/g;
    let block = '', pb;
    const linkText = function (b, hrefRe) {
      const re = new RegExp('<a[^>]*href="' + hrefRe + '"[^>]*>([^<]+)<\\/a>', 'g'), outl = [];
      let x;
      while ((x = re.exec(b))) { const t = decodeEntities(x[1]).trim(); if (t && outl.indexOf(t) < 0) outl.push(t); }
      return outl;
    };
    while ((pb = panelRe.exec(dh))) {
      const b = pb[1];
      if (!block && /href="\/actors\/[\w-]+"/.test(b)) { block = b; continue; }
      if (!out.tags.length && /href="\/tags\?/.test(b)) { out.tags = linkText(b, '\\/tags\\?[^"]*').slice(0, 20); continue; }
      if (!out.maker && /href="\/makers\//.test(b)) { out.maker = clip(linkText(b, '\\/makers\\/[^"]*')[0] || '', 120); continue; }
      const val = (/<span class="value">\s*([^<]*?)\s*<\/span>/.exec(b) || [])[1];
      if (!val) continue;
      const v = decodeEntities(val).trim();
      if (!out.released && /^\d{4}-\d{2}-\d{2}$/.test(v)) out.released = v;
      else if (!out.duration && /^\d{1,4}\s*分/.test(v)) out.duration = Number(/^\d{1,4}/.exec(v)[0]);
    }
    const aRe = /<a([^>]*)href="\/actors\/([\w-]+)"[^>]*>([^<]+)<\/a>/g;
    const female = [];
    let a;
    while ((a = aRe.exec(block))) {
      const name = decodeEntities(a[3]).trim();
      if (!name) continue;
      // 只收標成 actor-female 的；男性人物（沒有這個 class）整個不要，連人物頁都不去抓
      if (/actor-female/.test(a[1])) female.push({ id: a[2], name: name });
    }
    // 名字改成繁體中文、順便拿大頭照：平行抓每個人物頁，拿不到就用詳細頁上的名字
    const infos = await Promise.all(female.slice(0, 20).map(function (p) { return actorInfo(p.id, p.name); }));
    const seenName = {};
    infos.forEach(function (p) {
      if (!p.name || p.male || seenName[p.name]) return;
      seenName[p.name] = true;
      out.actors.push(p.name);
      out.people.push({ name: p.name, image: p.image });
    });
  } catch (_) { /* 搜尋頁的全名、縮圖還是有用 */ }
  return out;
}

// 什麼都抓不到時（整站被 CF 擋、網址又沒有編號）：至少把網址最後一段的 slug 變成標題
// （/123abc/video/some+title+words → "some title words"），卡片才不會空白。純數字／短 id 不算。
function slugTitle(target) {
  try {
    const segs = target.pathname.split('/').filter(Boolean);
    for (let i = segs.length - 1; i >= 0; i--) {
      let s = '';
      try { s = decodeURIComponent(segs[i].replace(/\+/g, ' ')); } catch (_) { s = segs[i]; }
      s = s.replace(/[-_]+/g, ' ').replace(/\.(?:html?|php)$/i, '').replace(/\s+/g, ' ').trim();
      if (s.length < 8 || /^[\da-f]+$/i.test(s) || !/[a-z぀-ヿ一-鿿]/i.test(s)) continue;
      if (/^(?:videos?|watch|v|embed|play|movies?)$/i.test(s)) continue;
      return clip(s, 200);
    }
  } catch (_) { /* no slug */ }
  return '';
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
// opts.noCache：影片庫用——不讀也不寫伺服器的預覽快取，什麼都不留在記憶體裡
async function preview(raw, o) {
  const noCache = !!(o && o.noCache);
  const target = parseTarget(raw);
  if (!target) return { error: '這個網址不能預覽' };
  const key = target.toString();
  const keep = function (v, ttl) { if (!noCache) remember(key, v, ttl); };
  const hit = noCache ? null : cached(key);
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
    let jd = null;
    if (code) {
      try { jd = await lookupByCode(code); } catch (_) { jd = null; }
      if (jd) {
        if (!info.movieTitle) info.movieTitle = jd.movieTitle;
        if (!info.image) info.image = jd.image;
        info.code = jd.code;
        info.tags = jd.tags; info.released = jd.released; info.duration = jd.duration; info.maker = jd.maker;
      }
    }
    // 人物一律要經過資料庫驗證（只收女性）：資料庫依編號查到的人物已經驗過；頁面自己 JSON-LD 給的
    // 名字則一個一個用名字去查，查不到、對不上、男性的都丟掉。驗不過就寧可沒有人物。
    if (jd && jd.people.length) { info.actors = jd.actors; info.people = jd.people; }
    else if (noCache) {   // 影片庫才驗；一般連結卡片不顯示人物，照舊
      const checked = await Promise.all(info.actors.slice(0, 8).map(function (nm) { return person(nm).catch(function () { return null; }); }));
      info.people = []; info.actors = [];
      checked.forEach(function (p) {
        if (!p || p.error || !p.known || !p.matched || p.male || !p.name) return;
        if (info.actors.indexOf(p.name) >= 0) return;
        info.actors.push(p.name); info.people.push({ name: p.name, image: p.image });
      });
    }
    value = Object.assign({ url: key, finalUrl: r.url.toString() }, info);
    keep(value, OK_TTL);
  } catch (e) {
    // HTML 抓失敗（CF 擋、403…）：有編號就改問 外部資料庫，再不行拿 備用來源 的公開縮圖；
    // 這是「有些會沒有預覽」的解法——影片站本身永遠是擋的，資料得從別處來。
    if (code) {
      let jd = null;
      try { jd = await lookupByCode(code); } catch (_) {}
      if (jd && (jd.movieTitle || jd.image)) {
        value = { url: key, title: jd.movieTitle, movieTitle: jd.movieTitle, actors: jd.actors, people: jd.people, image: jd.image, code: jd.code, tags: jd.tags, released: jd.released, duration: jd.duration, maker: jd.maker };
        keep(value, OK_TTL);
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
          keep(value, FAIL_TTL);
          return value;
        } catch (_) { /* 圖片也抓不到，照舊回 error */ }
      }
    }
    // 影片庫（noCache）：整站被擋又沒編號時，用網址 slug 當標題，不當成失敗——卡片至少有名字
    const st = noCache ? slugTitle(target) : '';
    if (st) return { url: key, title: st, actors: [], weak: true };
    value = { error: failReason(e) };
    keep(value, FAIL_TTL);
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

// ---------------- 地理編碼（美食地圖，js/foodmap.js） ----------------
// 固定問 OpenStreetMap 的 Nominatim（免費、不用金鑰），不是使用者給的網址——但同一條 fetchLimited／safeLookup
// 路，同一個期限。它的使用規範：每秒最多一次請求、UA 要說明是誰；所以這裡排隊（前一個問完至少隔 1.1 秒才問下一個），
// 答案快取一天（同一個地址不會再問第二次）。錯誤是答案不是例外：找不到地址就是 { error }。
const GEO_HOST = 'https://nominatim.openstreetmap.org';
const GEO_UA = 'CapyNote-FoodMap/1.0 (self-hosted note app; +https://github.com/capytuntun)';
const GEO_GAP_MS = 1100;
let geoChain = Promise.resolve(), geoLast = 0;
function geoFetch(path) {
  const run = async function () {
    const wait = geoLast + GEO_GAP_MS - Date.now();
    if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
    geoLast = Date.now();
    const target = parseTarget(GEO_HOST + path);
    if (!target) throw fail('地理編碼的網址不正確');
    const r = await fetchLimited(target, { accept: 'application/json', maxBytes: 512 * 1024, truncate: false, ua: GEO_UA }, AbortSignal.timeout(DEADLINE_MS), 0);
    return JSON.parse(r.body.toString('utf8'));
  };
  const p = geoChain.then(run, run);
  geoChain = p.catch(function () { /* 下一個照排 */ });
  return p;
}
function num(v, lo, hi) { const n = parseFloat(v); return isFinite(n) && n >= lo && n <= hi ? n : null; }
function shapeHit(h) {
  const lat = num(h.lat, -90, 90), lng = num(h.lon, -180, 180);
  if (lat === null || lng === null) return null;
  const a = h.address || {};
  return {
    name: clip(String(h.name || (h.namedetails && h.namedetails.name) || '').trim(), 200),
    displayName: clip(String(h.display_name || '').trim(), 400),
    type: clip(String(h.type || ''), 60),
    lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6,
    // 比 display_name 短的一行地址：縣市＋區＋路＋門牌（Nominatim 的 address 分欄）
    short: clip([a.city || a.county || a.state || '', a.suburb || a.city_district || a.district || a.town || '', a.road || '', a.house_number || ''].filter(Boolean).join(''), 200)
  };
}
// { results: [{ name, displayName, short, type, lat, lng }] } 或 { error }
async function geocode(raw) {
  const q = String(raw || '').trim().slice(0, 300);
  if (!q) return { error: '請輸入地址或店名' };
  const key = 'geo:' + q.toLowerCase();
  const hit = cached(key);
  if (hit) return hit;
  let value;
  try {
    // Nominatim 看不懂台灣式的門牌（「峨眉街8-1號」整串找不到，「峨眉街 8-1」或「峨眉街」就找得到），日本的
    // 「2-29-1」也一樣，所以一階一階退：原樣 → 門牌拆開、去掉「號」後面的樓層 → 整個門牌拿掉（只到路段，標 approx，
    // 讓畫面提醒使用者在地圖上微調）。每一階都算一次請求（1.1 秒），最多四階。
    const variants = [q];
    const noFloor = q.replace(/(\d+(?:[-－之]\d+)*)\s*[號号].*$/, ' $1').trim();
    if (variants.indexOf(noFloor) < 0) variants.push(noFloor);
    const street = q.replace(/\s*\d+(?:[-－之]\d+)*\s*[號号]?.*$/, '').trim();
    if (street && street !== q && variants.indexOf(street) < 0) variants.push(street);
    let results = [], approx = false;
    for (let i = 0; i < variants.length && !results.length; i++) {
      const arr = await geoFetch('/search?format=jsonv2&addressdetails=1&namedetails=1&limit=6&accept-language=zh-TW,zh,en&q=' + encodeURIComponent(variants[i]));
      results = (Array.isArray(arr) ? arr : []).map(shapeHit).filter(Boolean);
      approx = variants[i] === street && street !== noFloor;
    }
    value = results.length ? { results: results, approx: approx } : { error: '找不到這個地址，試試加上縣市或換個寫法，或直接在地圖上點位置' };
  } catch (e) {
    value = { error: '查地址失敗：' + failReason(e) };
  }
  remember(key, value, value.error ? 10 * 60 * 1000 : 24 * 3600 * 1000);
  return value;
}
// { address, displayName, lat, lng } 或 { error }
async function reverseGeocode(rawLat, rawLng) {
  const lat = num(rawLat, -90, 90), lng = num(rawLng, -180, 180);
  if (lat === null || lng === null) return { error: '座標不正確' };
  const key = 'rgeo:' + lat.toFixed(5) + ',' + lng.toFixed(5);
  const hit = cached(key);
  if (hit) return hit;
  let value;
  try {
    const h = await geoFetch('/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=zh-TW,zh,en&lat=' + lat + '&lon=' + lng);
    const s = h && !h.error ? shapeHit(h) : null;
    value = s ? { address: s.short || s.displayName, displayName: s.displayName, name: s.name, lat: s.lat, lng: s.lng } : { error: '這個位置查不到地址' };
  } catch (e) {
    value = { error: '查地址失敗：' + failReason(e) };
  }
  remember(key, value, value.error ? 10 * 60 * 1000 : 24 * 3600 * 1000);
  return value;
}

module.exports = { preview, image, person, forget, parseTarget, isBlockedAddress, extract, geocode, reverseGeocode };
