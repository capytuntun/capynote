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
      headers: {
        'User-Agent': o.ua || UA,
        'Accept': o.accept,
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br'
      }
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
  // JSON-LD 演員（VideoObject／Movie 的 actor 屬性）
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

// Site-specific thumbnail guessers for Cloudflare-blocked sites.
// Image CDNs are usually not behind CF's JS challenge even when the HTML pages are.
function guessThumbnail(u) {
  const host = u.hostname.replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean);

  // jable.tv：試從 assets-cdn 取 plyr__preview-scrubbing 的 preview.jpg
  // CDN 通常不在 CF 的 JS challenge 後面
  if (host === 'jable.tv') {
    for (let i = Math.max(0, segs.length - 2); i < segs.length; i++) {
      let seg;
      try { seg = decodeURIComponent(segs[i]).toLowerCase(); } catch (_) { seg = segs[i].toLowerCase(); }
      if (/^[a-z]{2,8}-\d{1,5}/.test(seg)) {
        return 'https://assets-cdn.jable.tv/contents/videos_screenshots/' + seg + '/preview.jpg';
      }
    }
  }

  // 日系 AV 番號（英文字母 2-8 碼 + 數字 1-5 位）→ DMM 公開封面 CDN，不受 CF 保護
  // 格式：pics.dmm.co.jp/digital/video/{alpha}{num5}/{alpha}{num5}ps.jpg
  for (let i = Math.max(0, segs.length - 2); i < segs.length; i++) {
    let seg;
    try { seg = decodeURIComponent(segs[i]).toLowerCase(); } catch (_) { seg = segs[i].toLowerCase(); }
    const m = /^([a-z]{2,8})-?0*(\d{1,5})(?:[-_]|$)/.exec(seg);
    if (!m) continue;
    const code = m[1] + m[2].padStart(5, '0');
    return 'https://pics.dmm.co.jp/digital/video/' + code + '/' + code + 'ps.jpg';
  }

  return null;
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
      r = await fetchLimited(target, Object.assign({}, opts, { ua: BROWSER_UA }), AbortSignal.timeout(DEADLINE_MS), 0);
    }
    const html = decodeHtml(r.body, r.headers['content-type']);
    const info = extract(html, r.url);
    // 有 Plyr preview-scrubbing 的 VTT → 抓第一張 sprite 當縮圖（og:image 優先）
    if (!info.image) {
      const vttRel = extractPlyrVtt(html);
      if (vttRel) {
        try { info.image = await fetchPlyrThumb(vttRel, r.url, AbortSignal.timeout(5000)); } catch (_) {}
      }
    }
    value = Object.assign({ url: key, finalUrl: r.url.toString() }, info);
    remember(key, value, OK_TTL);
  } catch (e) {
    // HTML 抓失敗（CF 擋、403…）→ 試從已知圖片 CDN 直接取封面
    const thumb = guessThumbnail(target);
    if (thumb) {
      const imgTarget = parseTarget(thumb);
      if (imgTarget) {
        try {
          await fetchLimited(imgTarget, {
            accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8',
            maxBytes: 128,
            truncate: true,
            checkType: function (t) { return IMAGE_TYPES.test(t.split(';')[0].trim().toLowerCase()); }
          }, AbortSignal.timeout(5000), 0);
          value = { url: key, image: thumb };
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

module.exports = { preview, image, parseTarget, isBlockedAddress, extract };
