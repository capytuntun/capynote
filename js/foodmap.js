/* foodmap.js — 美食地圖（使用者的話：「新增一個美食地圖，串接 openstreetmap 或是 GoogleMap，我要免費的，讓我可以把店名、地址、
 * 資料來源塞進去，並使用 tag 做分類，可以搜尋，同時顯示在地圖上」）。
 *
 * 免費的做法：底圖是 OpenStreetMap 的標準圖磚（tile.openstreetmap.org，不用金鑰），畫在 Leaflet（vendor/leaflet/）上；
 * 地址 → 座標走伺服器的 GET /api/geocode（server/linkpreview.js geocode()，固定問 OSM 的 Nominatim，每秒一次、快取一天），
 * 瀏覽器自己不對外連線（CSP connect-src 'self'）。Google 地圖只是每家店的「在 Google 地圖開啟」連結（免費、不需 API）。
 *
 * 一張地圖是一篇 area:'foodmap'、meta.foodmap 的筆記，標題是地圖名稱，內容是 ```foodmap 圍欄裡的 JSON（跟行事曆／課程進度
 * 一樣「文字就是真相」：版本、備份、搜尋、垃圾桶、標籤都不用新東西）：
 *   { color, places: [{ id, name, address, source, tags: [], lat, lng, note, rating 0–5, visited, added }] }
 *   - lat/lng 可以是 null：還沒定位的店照樣列在清單裡（標「未定位」），只是地圖上沒有針。
 *   - source 是文字或網址；是網址就顯示成連結。
 * 畫面（#foodmap 一頁，FoodMap.render）：左欄是地圖清單（勾選顯示／隱藏，像 timetree 的行事曆）、標籤雲（點了 AND 篩選）、
 * 去過／還沒去；中間是店家清單（搜尋名稱／地址／標籤／來源／備註），右邊是 Leaflet 地圖——點清單飛到那根針、點針開小卡。
 * 新增／編輯是一個對話框：地址旁「查地址」問 Nominatim 選一筆，或「在地圖上點位置」（對話框先收起、點地圖一下、反查地址帶回）。
 * blockHTML 把一張地圖畫成靜態的店家清單（預覽、PDF、電子書——那裡沒有圖磚可載）。
 */
(function (global) {
  'use strict';

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }
  function uid(p) { return (p || 'p') + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } }
  function toast(t) { if (global.App && App.toast) App.toast(t); }
  function isUrl(s) { return /^https?:\/\/\S+$/i.test(String(s || '').trim()); }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } }

  const COLORS = ['#e0542c', '#3b7ddd', '#17934f', '#d9962a', '#8e5bc7', '#26a69a', '#e46ba0', '#5b7fa6', '#c5221f', '#2ec4a6'];
  // 標籤 chip 的顏色：名稱雜湊到這幾個，同一個標籤到哪裡都同一色
  const TAG_HUES = [14, 36, 92, 160, 200, 230, 270, 320];
  function tagHue(t) { let h = 0; const s = String(t).toLowerCase(); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return TAG_HUES[h % TAG_HUES.length]; }
  function tagStyle(t) { return 'style="--h:' + tagHue(t) + '"'; }

  // ---------------- 模型 ----------------
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 500) : ''; }
  function coord(v, lim) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) && Math.abs(n) <= lim ? Math.round(n * 1e6) / 1e6 : null; }
  function cleanTags(a) {
    const out = [], seen = {};
    (Array.isArray(a) ? a : []).forEach(function (t) {
      t = str(t, 40).replace(/^#+/, '').trim();
      if (!t) return;
      const k = t.toLowerCase();
      if (seen[k] || out.length >= 20) return;
      seen[k] = 1; out.push(t);
    });
    return out;
  }
  function cleanPlace(p, seen) {
    if (!p || typeof p !== 'object') return null;
    let id = typeof p.id === 'string' && p.id ? p.id.slice(0, 40) : uid('p');
    if (seen[id]) id = uid('p');
    seen[id] = 1;
    const lat = coord(p.lat, 90), lng = coord(p.lng, 180);
    const o = {
      id: id, name: str(p.name, 200).trim(), address: str(p.address, 300).trim(), source: str(p.source, 500).trim(),
      tags: cleanTags(p.tags), lat: lat !== null && lng !== null ? lat : null, lng: lat !== null && lng !== null ? lng : null,
      note: str(p.note, 2000), rating: Math.max(0, Math.min(5, parseInt(p.rating, 10) || 0)), visited: !!p.visited,
      added: p.added > 0 ? Math.floor(p.added) : Date.now()
    };
    if (!o.name) o.name = '（未命名店家）';
    return o;
  }
  function cleanMap(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const o = { color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : COLORS[0], places: [] };
    const seen = {};
    (Array.isArray(raw.places) ? raw.places : []).forEach(function (p) { const x = cleanPlace(p, seen); if (x) o.places.push(x); });
    return o;
  }
  function parse(text) { let raw = null; try { raw = JSON.parse(String(text || '')); } catch (e) { raw = null; } return cleanMap(raw); }
  function serialize(m) { return JSON.stringify(m, null, 1); }
  function payloadOf(content) { const m = /^```foodmap[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/m.exec(String(content || '')); return m ? m[1] : null; }
  function wrap(json) { return '```foodmap\n' + json + '\n```\n'; }
  function isNote(note) { return !!(note && note.meta && note.meta.foodmap); }
  function generate(color) { return wrap(serialize(cleanMap({ color: color }))); }

  function gmapsUrl(p) {
    if (p.lat !== null) return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(p.lat + ',' + p.lng);
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((p.name + ' ' + p.address).trim());
  }
  function osmUrl(p) { return 'https://www.openstreetmap.org/?mlat=' + p.lat + '&mlon=' + p.lng + '#map=18/' + p.lat + '/' + p.lng; }
  function stars(n) { let s = ''; for (let i = 1; i <= 5; i++) s += '<i class="fm-star' + (i <= n ? ' on' : '') + '">★</i>'; return s; }
  function tagsHTML(tags, cls) { return tags.map(function (t) { return '<span class="' + (cls || 'fm-tag') + '" ' + tagStyle(t) + ' data-tag="' + esc(t) + '">' + esc(t) + '</span>'; }).join(''); }
  function sourceHTML(src, cls) {
    if (!src) return '';
    if (isUrl(src)) return '<a class="' + (cls || 'fm-src') + '" href="' + esc(src) + '" target="_blank" rel="noopener noreferrer">' + ic('link') + esc(hostOf(src)) + '</a>';
    return '<span class="' + (cls || 'fm-src') + '">' + ic('book-open') + esc(src) + '</span>';
  }

  // 靜態版（預覽、PDF、電子書）：沒有圖磚可載，就是一張店家清單
  function blockHTML(payload, name) {
    const m = parse(payload);
    const located = m.places.filter(function (p) { return p.lat !== null; }).length;
    return '<div class="fms"><div class="fms-head"><i style="background:' + m.color + '"></i><b>' + esc(name || '美食地圖') + '</b><span>' + m.places.length + ' 家店' + (located < m.places.length ? '・' + (m.places.length - located) + ' 家未定位' : '') + '</span></div>' +
      (m.places.length ? '<ul class="fms-list">' + m.places.map(function (p) {
        return '<li' + (p.visited ? ' class="is-visited"' : '') + '><div class="fms-row"><span class="fms-pin">' + ic('map-pin') + '</span><b class="fms-name">' + esc(p.name) + '</b>' + (p.rating ? '<span class="fms-stars">' + stars(p.rating) + '</span>' : '') + (p.visited ? '<span class="fms-visited">去過</span>' : '') + tagsHTML(p.tags, 'fms-tag') + '</div>' +
          (p.address ? '<div class="fms-addr">' + esc(p.address) + '</div>' : '') +
          (p.source || p.note ? '<div class="fms-meta">' + sourceHTML(p.source, 'fms-src') + (p.note ? '<span class="fms-note">' + esc(p.note) + '</span>' : '') + '</div>' : '') + '</li>';
      }).join('') + '</ul>' : '<div class="fms-empty">還沒有店家</div>') + '</div>';
  }

  // ---------------- 頁面 ----------------
  let popEl = null, menuEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } if (menuEl) { menuEl.remove(); menuEl = null; } }
  function placeFixed(node, x, y) {
    document.body.appendChild(node);
    const w = node.offsetWidth, h = node.offsetHeight;
    node.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    node.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  }
  function menuAt(x, y, items, onPick) {
    closePop();
    menuEl = el('div', 'tt-menu fm-menu');
    menuEl.innerHTML = items.map(function (it) { return it ? '<button class="tt-menu-item' + (it[3] ? ' is-danger' : '') + '" type="button" data-a="' + it[0] + '"' + (it[2] ? ' disabled' : '') + '>' + esc(it[1]) + '</button>' : '<div class="tt-menu-sep"></div>'; }).join('');
    placeFixed(menuEl, x, y);
    menuEl.addEventListener('click', function (e) { const b = e.target.closest('[data-a]'); if (!b || b.disabled) return; const a = b.getAttribute('data-a'); closePop(); onPick(a); });
  }
  document.addEventListener('mousedown', function (e) { if ((popEl && !popEl.contains(e.target)) || (menuEl && !menuEl.contains(e.target))) { if (!e.target.closest('.tt-pop, .tt-menu')) closePop(); } }, true);

  const S = { search: '', tags: [], visit: 'all', hidden: {}, selected: null, picking: null };
  try { S.hidden = JSON.parse(lsGet('fmHidden', '{}')) || {}; } catch (e) { S.hidden = {}; }
  const cache = new Map();   // noteId → { content, map }
  let host = null, O = null, built = null;
  // Leaflet 的東西，建一次、跨 render 留著（重畫清單時地圖不重載圖磚）
  let leaf = null, markerLayer = null, markers = {}, fitted = false, pickBanner = null;

  function mapsOf() {
    return (O.maps || []).map(function (n) {
      let c = cache.get(n.id);
      if (!c || c.content !== n.content) { c = { content: n.content, map: parse(payloadOf(n.content) || '') }; cache.set(n.id, c); }
      return { id: n.id, note: n, map: c.map, name: n.title || '美食地圖', ro: !!(O.readOnly && O.readOnly(n)) };
    });
  }
  function visibleMaps() { return mapsOf().filter(function (m) { return !S.hidden[m.id]; }); }
  function mapById(id) { return mapsOf().find(function (m) { return m.id === id; }) || null; }
  function save(m) {
    const json = serialize(m.map), content = wrap(json);
    cache.set(m.id, { content: content, map: m.map });
    m.note.content = content;
    if (O.onChange) O.onChange(m.note, content);
  }
  // 所有看得見的店，帶著它的地圖
  function allPlaces() {
    const out = [];
    visibleMaps().forEach(function (m) { m.map.places.forEach(function (p) { out.push({ p: p, m: m }); }); });
    return out;
  }
  function matches(x) {
    const p = x.p;
    if (S.visit === 'visited' && !p.visited) return false;
    if (S.visit === 'todo' && p.visited) return false;
    if (S.tags.length && !S.tags.every(function (t) { return p.tags.some(function (u) { return u.toLowerCase() === t.toLowerCase(); }); })) return false;
    const q = S.search.trim().toLowerCase();
    if (q) {
      const hay = [p.name, p.address, p.source, p.note, p.tags.join(' '), x.m.name].join('\n').toLowerCase();
      if (q.split(/\s+/).some(function (w) { return hay.indexOf(w) < 0; })) return false;
    }
    return true;
  }
  function filtered() {
    return allPlaces().filter(matches).sort(function (a, b) { return (a.p.visited === b.p.visited ? 0 : a.p.visited ? 1 : -1) || b.p.added - a.p.added; });
  }
  function tagCounts() {
    const c = {};
    allPlaces().forEach(function (x) { x.p.tags.forEach(function (t) { const k = t.toLowerCase(); c[k] = c[k] || { name: t, n: 0 }; c[k].n++; }); });
    return Object.keys(c).map(function (k) { return c[k]; }).sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name, 'zh-Hant'); });
  }
  function findPlace(id) { let hit = null; allPlaces().some(function (x) { if (x.p.id === id) { hit = x; return true; } return false; }); return hit; }

  // ---------------- 畫面 ----------------
  function render(container, opts) {
    O = opts || {};
    if (host !== container || !built || !container.contains(built)) {
      host = container;
      container.innerHTML = '';
      built = el('div', 'fm-page');
      built.innerHTML = '<aside class="fm-side"></aside><section class="fm-main"><div class="fm-head"></div><div class="fm-body"><div class="fm-list-wrap"><div class="fm-list"></div></div><div class="fm-map-wrap"><div class="fm-map"></div><div class="fm-map-empty" hidden></div></div></div></section>';
      container.appendChild(built);
      bind(built);
      leaf = null; markers = {}; fitted = false;
      if (!(O.maps || []).length && O.onCreate) O.onCreate({ title: '美食地圖', color: COLORS[0], auto: true });   // 第一次：先給一張地圖
    }
    paint();
    ensureMap();
    paintMarkers();
  }
  function paint() {
    paintSide(); paintHead(); paintList();
  }
  function paintSide() {
    const side = built.querySelector('.fm-side');
    const maps = mapsOf(), tags = tagCounts(), all = allPlaces();
    const visited = all.filter(function (x) { return x.p.visited; }).length;
    let h = '<div class="tt-side-t">地圖 <small>' + maps.length + '</small></div><div class="fm-maps">';
    maps.forEach(function (m) {
      h += '<div class="tt-cal fm-mapline' + (S.hidden[m.id] ? ' is-hidden' : '') + '" data-map="' + esc(m.id) + '"><label class="tt-cal-chk" title="顯示／隱藏"><input type="checkbox" data-vis="' + esc(m.id) + '"' + (S.hidden[m.id] ? '' : ' checked') + '><i style="background:' + m.map.color + '"></i></label><span class="tt-cal-name">' + esc(m.name) + '</span><small class="fm-mapn">' + m.map.places.length + '</small>' + (m.ro ? '<span class="tt-cal-ro" title="別人分享給我的，只能看">' + ic('lock') + '</span>' : '') + '<button class="tt-cal-more" type="button" data-more="' + esc(m.id) + '" title="更多">' + ic('more-horizontal') + '</button></div>';
    });
    if (!maps.length) h += '<div class="tt-side-empty">還沒有地圖。</div>';
    h += '</div>' + (O.onCreate ? '<button class="tt-side-add" type="button" data-e="newmap">' + ic('plus') + ' 建立地圖</button>' : '');
    h += '<div class="tt-side-t">去過沒 </div><div class="fm-visit">' + [['all', '全部', all.length], ['todo', '還沒去', all.length - visited], ['visited', '去過', visited]].map(function (v) { return '<button type="button" class="fm-visit-b' + (S.visit === v[0] ? ' on' : '') + '" data-visit="' + v[0] + '">' + v[1] + '<small>' + v[2] + '</small></button>'; }).join('') + '</div>';
    h += '<div class="tt-side-t">標籤 <small>' + tags.length + '</small>' + (S.tags.length ? '<button type="button" class="fm-side-clear" data-e="cleartags">清除</button>' : '') + '</div><div class="fm-tagcloud">';
    if (!tags.length) h += '<div class="tt-side-empty">新增店家時填標籤，這裡就會出現，點了可以篩選。</div>';
    tags.forEach(function (t) { const on = S.tags.some(function (x) { return x.toLowerCase() === t.name.toLowerCase(); }); h += '<button type="button" class="fm-tag fm-tag-b' + (on ? ' on' : '') + '" ' + tagStyle(t.name) + ' data-tag="' + esc(t.name) + '">' + esc(t.name) + '<small>' + t.n + '</small></button>'; });
    h += '</div>';
    h += '<div class="tt-side-foot fm-foot">底圖 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> 貢獻者</div>';
    side.innerHTML = h;
  }
  function paintHead() {
    const head = built.querySelector('.fm-head');
    const n = filtered().length, total = allPlaces().length;
    const canAdd = mapsOf().some(function (m) { return !m.ro; });
    head.innerHTML = '<label class="tt-search fm-search">' + ic('search') + '<input type="search" placeholder="搜尋店名、地址、標籤、來源…" value="' + esc(S.search) + '" data-f="search" aria-label="搜尋店家"></label>' +
      (S.tags.length ? '<div class="fm-active-tags">' + S.tags.map(function (t) { return '<span class="fm-tag" ' + tagStyle(t) + '>' + esc(t) + '<button type="button" data-untag="' + esc(t) + '" title="取消這個標籤的篩選">' + ic('x') + '</button></span>'; }).join('') + '</div>' : '') +
      '<span class="fm-count">' + (n === total ? total + ' 家店' : n + ' / ' + total + ' 家店') + '</span><span class="tt-sp"></span>' +
      '<button class="tt-tb" type="button" data-e="fit" title="把所有看得到的店都放進畫面">' + ic('maximize') + '<span class="fm-tb-t">全部顯示</span></button>' +
      (canAdd ? '<button class="tt-btn tt-btn-primary fm-add" type="button" data-e="add">' + ic('plus') + ' 新增店家</button>' : '');
  }
  function placeRow(x) {
    const p = x.p, m = x.m;
    return '<div class="fm-row' + (S.selected === p.id ? ' is-sel' : '') + (p.visited ? ' is-visited' : '') + (p.lat === null ? ' is-nowhere' : '') + '" data-id="' + esc(p.id) + '" tabindex="0">' +
      '<span class="fm-row-pin" style="--c:' + m.map.color + '" title="' + esc(m.name) + '">' + ic('map-pin') + '</span>' +
      '<div class="fm-row-main"><div class="fm-row-top"><b class="fm-row-name">' + esc(p.name) + '</b>' + (p.rating ? '<span class="fm-stars">' + stars(p.rating) + '</span>' : '') + (p.visited ? '<span class="fm-badge fm-badge-v">去過</span>' : '') + (p.lat === null ? '<span class="fm-badge fm-badge-n">未定位</span>' : '') + '</div>' +
      (p.address ? '<div class="fm-row-addr">' + esc(p.address) + '</div>' : '') +
      (p.tags.length || p.source ? '<div class="fm-row-meta">' + tagsHTML(p.tags) + sourceHTML(p.source) + '</div>' : '') + '</div>' +
      (m.ro ? '' : '<div class="fm-row-tools"><button class="tt-tb fm-row-tb" type="button" data-edit="' + esc(p.id) + '" title="編輯">' + ic('pencil') + '</button><button class="tt-tb fm-row-tb" type="button" data-pmore="' + esc(p.id) + '" title="更多">' + ic('more-horizontal') + '</button></div>') + '</div>';
  }
  function paintList() {
    const list = built.querySelector('.fm-list');
    const rows = filtered();
    if (!rows.length) {
      const total = allPlaces().length;
      list.innerHTML = '<div class="fm-empty">' + ic('map-pin') + '<p>' + (total ? '沒有符合的店家，換個關鍵字或清掉篩選。' : mapsOf().length ? '還沒有店家。按右上「新增店家」，填店名跟地址就會出現在地圖上。' : '先建立一張地圖。') + '</p></div>';
      return;
    }
    list.innerHTML = rows.map(placeRow).join('');
  }

  // ---------------- Leaflet ----------------
  function ensureMap() {
    const box = built.querySelector('.fm-map'), empty = built.querySelector('.fm-map-empty');
    if (!global.L) { empty.hidden = false; empty.textContent = '地圖程式庫（vendor/leaflet）沒有載入'; return; }
    if (leaf) { setTimeout(function () { if (leaf) leaf.invalidateSize(); }, 0); return; }
    leaf = L.map(box, { zoomControl: true, attributionControl: false, worldCopyJump: true });
    // referrerPolicy：整個站是 Referrer-Policy: no-referrer，圖磚請求就一個 Referer 都沒帶，OSM 的圖磚伺服器把這種
    // 瀏覽器請求當成「不守使用規範的 app」回 403（整張地圖都是 Access blocked 的格子——正式站上發生過）。
    // 它的規範要的是「能辨認是哪個 app 的 Referer 或 UA」，所以只對圖磚的 <img> 單獨送站台的 origin（只有 origin，沒有路徑）。
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, minZoom: 2, detectRetina: false, referrerPolicy: 'strict-origin' });
    tiles.addTo(leaf);
    // 圖磚還是載不到（403／斷網）就在地圖上說一聲，不要只剩一片灰或一堆錯誤圖
    let tileErrors = 0, tileOk = 0;
    tiles.on('tileload', function () { tileOk++; });
    tiles.on('tileerror', function () {
      tileErrors++;
      if (tileErrors >= 4 && !tileOk && !built.querySelector('.fm-tile-warn')) {
        const w = el('div', 'fm-tile-warn', ic('alert-triangle') + ' 底圖載不進來（tile.openstreetmap.org 沒有回應或回 403）。店家的針跟清單不受影響；請檢查網路，或稍後再試。');
        built.querySelector('.fm-map-wrap').appendChild(w);
      }
    });
    markerLayer = L.layerGroup().addTo(leaf);
    leaf.setView([25.04, 121.53], 12);   // 第一眼：台北；有店就會 fitBounds 蓋過去
    leaf.on('click', function (e) {
      if (S.picking) { finishPick(e.latlng); return; }
      S.selected = null; paintList();
    });
    leaf.on('popupclose', function () { /* 保持選取，只收小卡 */ });
  }
  function pinIcon(color, sel) {
    return L.divIcon({ className: 'fm-pin-wrap', html: '<i class="fm-pin' + (sel ? ' is-sel' : '') + '" style="--c:' + color + '"></i>', iconSize: [26, 34], iconAnchor: [13, 32], popupAnchor: [0, -30] });
  }
  function popupHTML(x) {
    const p = x.p, m = x.m;
    return '<div class="fm-pop"><div class="fm-pop-top"><b>' + esc(p.name) + '</b>' + (p.rating ? '<span class="fm-stars">' + stars(p.rating) + '</span>' : '') + (p.visited ? '<span class="fm-badge fm-badge-v">去過</span>' : '') + '</div>' +
      (p.address ? '<div class="fm-pop-addr">' + esc(p.address) + '</div>' : '') +
      (p.tags.length ? '<div class="fm-pop-tags">' + tagsHTML(p.tags) + '</div>' : '') +
      (p.source ? '<div class="fm-pop-src">來源：' + sourceHTML(p.source) + '</div>' : '') +
      (p.note ? '<div class="fm-pop-note">' + esc(p.note) + '</div>' : '') +
      '<div class="fm-pop-foot"><small>' + esc(m.name) + '</small><span class="tt-sp"></span><a href="' + esc(gmapsUrl(p)) + '" target="_blank" rel="noopener noreferrer" title="在 Google 地圖開啟">Google 地圖</a><a href="' + esc(osmUrl(p)) + '" target="_blank" rel="noopener noreferrer" title="在 OpenStreetMap 開啟">OSM</a>' + (m.ro ? '' : '<button type="button" data-edit="' + esc(p.id) + '">編輯</button>') + '</div></div>';
  }
  function paintMarkers() {
    if (!leaf) return;
    const rows = filtered().filter(function (x) { return x.p.lat !== null; });
    const keep = {};
    rows.forEach(function (x) {
      const p = x.p, key = p.id;
      keep[key] = 1;
      const sel = S.selected === p.id;
      let mk = markers[key];
      const sig = [p.lat, p.lng, x.m.map.color, sel ? 1 : 0, p.name, p.address, p.tags.join(','), p.source, p.note, p.rating, p.visited ? 1 : 0, x.m.name].join('|');
      if (mk && mk._fmSig === sig) return;
      if (!mk) {
        mk = L.marker([p.lat, p.lng], { icon: pinIcon(x.m.map.color, sel), title: p.name, riseOnHover: true, keyboard: false });
        mk.on('click', function () { S.selected = p.id; paintList(); paintMarkers(); scrollRowIntoView(p.id); });
        mk.bindPopup('', { maxWidth: 300, className: 'fm-popup', autoPanPadding: [30, 30] });
        markerLayer.addLayer(mk);
        markers[key] = mk;
      } else {
        mk.setLatLng([p.lat, p.lng]);
        mk.setIcon(pinIcon(x.m.map.color, sel));
      }
      mk.setPopupContent(popupHTML(x));
      mk.setZIndexOffset(sel ? 1000 : 0);
      mk._fmSig = sig;
    });
    Object.keys(markers).forEach(function (k) { if (!keep[k]) { markerLayer.removeLayer(markers[k]); delete markers[k]; } });
    if (!fitted && rows.length) { fitted = true; fitAll(rows); }
  }
  function fitAll(rows) {
    rows = rows || filtered().filter(function (x) { return x.p.lat !== null; });
    if (!leaf) return;
    if (!rows.length) { toast('沒有定位過的店家'); return; }
    if (rows.length === 1) { leaf.setView([rows[0].p.lat, rows[0].p.lng], 16); return; }
    leaf.fitBounds(L.latLngBounds(rows.map(function (x) { return [x.p.lat, x.p.lng]; })), { padding: [40, 40], maxZoom: 17 });
  }
  function focusPlace(id, open) {
    const x = findPlace(id);
    S.selected = id;
    paintList(); paintMarkers();
    if (!x || !leaf) return;
    if (x.p.lat === null) { toast('「' + x.p.name + '」還沒有位置，編輯它查地址或在地圖上點位置'); return; }
    const mk = markers[id];
    const z = Math.max(leaf.getZoom(), 16);
    leaf.flyTo([x.p.lat, x.p.lng], z, { duration: 0.6 });
    if (open && mk) setTimeout(function () { if (markers[id]) markers[id].openPopup(); }, 650);
  }
  function scrollRowIntoView(id) {
    const r = built.querySelector('.fm-row[data-id="' + id + '"]');
    if (r) r.scrollIntoView({ block: 'nearest' });
  }

  // 在地圖上點位置：對話框先收起、地圖上掛一條提示，點一下就把座標帶回對話框（反查一次地址）
  function startPick(onPick) {
    S.picking = onPick;
    if (leaf) leaf.getContainer().classList.add('is-picking');
    pickBanner = el('div', 'fm-pick-banner', ic('map-pin') + ' 在地圖上點一下店的位置　<button type="button" class="tt-btn" data-e="cancelpick">取消（Esc）</button>');
    built.querySelector('.fm-map-wrap').appendChild(pickBanner);
    pickBanner.querySelector('[data-e="cancelpick"]').addEventListener('click', function () { cancelPick(); });
  }
  function endPick() {
    S.picking = null;
    if (leaf) leaf.getContainer().classList.remove('is-picking');
    if (pickBanner) { pickBanner.remove(); pickBanner = null; }
  }
  function finishPick(latlng) { const fn = S.picking; endPick(); if (fn) fn({ lat: Math.round(latlng.lat * 1e6) / 1e6, lng: Math.round(latlng.lng * 1e6) / 1e6 }, false); }
  function cancelPick() { const fn = S.picking; endPick(); if (fn) fn(null, true); }

  // ---------------- 事件 ----------------
  function bind(root) {
    root.addEventListener('input', function (e) {
      if (e.target.getAttribute('data-f') === 'search') { S.search = e.target.value; paintList(); paintMarkers(); const c = root.querySelector('.fm-count'); if (c) { const n = filtered().length, t = allPlaces().length; c.textContent = n === t ? t + ' 家店' : n + ' / ' + t + ' 家店'; } }
    });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.picking) { cancelPick(); e.stopPropagation(); return; }
      const row = e.target.closest('.fm-row');
      if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); focusPlace(row.getAttribute('data-id'), true); }
    });
    root.addEventListener('change', function (e) {
      const v = e.target.getAttribute('data-vis');
      if (v) { if (e.target.checked) delete S.hidden[v]; else S.hidden[v] = 1; lsSet('fmHidden', JSON.stringify(S.hidden)); paint(); paintMarkers(); }
    });
    root.addEventListener('click', function (e) {
      const t = e.target;
      let b;
      if ((b = t.closest('[data-e]'))) {
        const a = b.getAttribute('data-e');
        if (a === 'newmap') return newMapDialog();
        if (a === 'add') return openEditor(null, null);
        if (a === 'fit') return fitAll();
        if (a === 'cleartags') { S.tags = []; paint(); paintMarkers(); return; }
      }
      if ((b = t.closest('[data-untag]'))) { const u = b.getAttribute('data-untag'); S.tags = S.tags.filter(function (x) { return x !== u; }); paint(); paintMarkers(); return; }
      if ((b = t.closest('[data-visit]'))) { S.visit = b.getAttribute('data-visit'); paint(); paintMarkers(); return; }
      if ((b = t.closest('.fm-side [data-tag], .fm-list [data-tag]'))) {
        const tg = b.getAttribute('data-tag');
        const i = S.tags.findIndex(function (x) { return x.toLowerCase() === tg.toLowerCase(); });
        if (i >= 0) S.tags.splice(i, 1); else S.tags.push(tg);
        paint(); paintMarkers(); return;
      }
      if ((b = t.closest('[data-more]'))) { const m = mapById(b.getAttribute('data-more')); if (m) { const r = b.getBoundingClientRect(); mapMenu(m, r.left, r.bottom + 4); } return; }
      if ((b = t.closest('[data-edit]'))) { const x = findPlace(b.getAttribute('data-edit')); if (x && !x.m.ro) openEditor(x.p, x.m); return; }
      if ((b = t.closest('[data-pmore]'))) { const x = findPlace(b.getAttribute('data-pmore')); if (x) { const r = b.getBoundingClientRect(); placeMenu(x, r.left, r.bottom + 4); } return; }
      if (t.closest('a')) return;
      const row = t.closest('.fm-row');
      if (row) { focusPlace(row.getAttribute('data-id'), true); return; }
    });
    root.addEventListener('contextmenu', function (e) {
      const row = e.target.closest('.fm-row');
      if (row) { const x = findPlace(row.getAttribute('data-id')); if (x) { e.preventDefault(); placeMenu(x, e.clientX, e.clientY); } return; }
      const ml = e.target.closest('.fm-mapline');
      if (ml) { const m = mapById(ml.getAttribute('data-map')); if (m) { e.preventDefault(); mapMenu(m, e.clientX, e.clientY); } }
    });
    // Leaflet 小卡裡的「編輯」：小卡在地圖容器裡，也在 root 底下，上面的 [data-edit] 分支就接得到
  }
  function mapMenu(m, x, y) {
    menuAt(x, y, [
      ['only', '只顯示這張'], ['all', '顯示全部'], null,
      ['rename', '重新命名', m.ro || !O.onRename], ['color', '變更顏色', m.ro], ['tags', '標籤…', !O.onTags], null,
      ['export', '匯出 CSV'], null,
      ['delete', '移到垃圾桶', m.ro || !O.onDelete, true]
    ], function (a) {
      if (a === 'only') { S.hidden = {}; mapsOf().forEach(function (o) { if (o.id !== m.id) S.hidden[o.id] = 1; }); lsSet('fmHidden', JSON.stringify(S.hidden)); paint(); paintMarkers(); fitted = false; paintMarkers(); }
      else if (a === 'all') { S.hidden = {}; lsSet('fmHidden', '{}'); paint(); paintMarkers(); }
      else if (a === 'rename') O.onRename(m.note);
      else if (a === 'color') colorPop(m, x, y);
      else if (a === 'tags') O.onTags(m.note);
      else if (a === 'export') exportCSV(m);
      else if (a === 'delete') O.onDelete(m.note);
    });
  }
  function colorPop(m, x, y) {
    closePop();
    popEl = el('div', 'tt-pop fm-colors');
    popEl.innerHTML = COLORS.map(function (c) { return '<button type="button" class="fm-color' + (c === m.map.color ? ' on' : '') + '" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></button>'; }).join('');
    placeFixed(popEl, x, y);
    popEl.addEventListener('click', function (e) { const b = e.target.closest('[data-c]'); if (!b) return; m.map.color = b.getAttribute('data-c'); save(m); closePop(); paint(); paintMarkers(); });
  }
  function placeMenu(x, px, py) {
    const p = x.p, ro = x.m.ro;
    menuAt(px, py, [
      ['show', '在地圖上看', p.lat === null], ['gmaps', '在 Google 地圖開啟'], null,
      ['edit', '編輯', ro], ['visited', p.visited ? '標成還沒去' : '標成去過', ro], ['copy', '複製到別張地圖', ro || mapsOf().filter(function (o) { return !o.ro && o.id !== x.m.id; }).length === 0], null,
      ['delete', '刪除店家', ro, true]
    ], function (a) {
      if (a === 'show') focusPlace(p.id, true);
      else if (a === 'gmaps') window.open(gmapsUrl(p), '_blank', 'noopener');
      else if (a === 'edit') openEditor(p, x.m);
      else if (a === 'visited') { p.visited = !p.visited; save(x.m); paint(); paintMarkers(); }
      else if (a === 'copy') copyPlaceDialog(x);
      else if (a === 'delete') {
        const go = function (yes) { if (!yes) return; x.m.map.places = x.m.map.places.filter(function (q) { return q.id !== p.id; }); if (S.selected === p.id) S.selected = null; save(x.m); paint(); paintMarkers(); toast('已刪除「' + p.name + '」'); };
        if (global.App && App.confirm) App.confirm({ title: '刪除店家', message: '刪除「' + p.name + '」？這張地圖的版本歷史裡還找得回來。', ok: '刪除', danger: true }).then(go); else go(window.confirm('刪除「' + p.name + '」？'));
      }
    });
  }
  function copyPlaceDialog(x) {
    const targets = mapsOf().filter(function (o) { return !o.ro && o.id !== x.m.id; });
    const r = x.m.note && targets[0];
    if (!r) return;
    menuAt(window.innerWidth / 2 - 90, window.innerHeight / 2 - 60, targets.map(function (o) { return [o.id, o.name]; }), function (id) {
      const to = mapById(id); if (!to) return;
      const seen = {}; to.map.places.forEach(function (q) { seen[q.id] = 1; });
      const c = cleanPlace(Object.assign({}, x.p, { id: uid('p'), added: Date.now() }), seen);
      to.map.places.push(c); save(to); paint(); paintMarkers(); toast('已複製到「' + to.name + '」');
    });
  }
  function exportCSV(m) {
    const cols = ['店名', '地址', '資料來源', '標籤', '緯度', '經度', '評分', '去過', '備註'];
    const q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [cols.join(',')].concat(m.map.places.map(function (p) { return [p.name, p.address, p.source, p.tags.join(' '), p.lat === null ? '' : p.lat, p.lng === null ? '' : p.lng, p.rating || '', p.visited ? '是' : '', p.note].map(q).join(','); }));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (m.name || '美食地圖') + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function newMapDialog() {
    closePop();
    if (!O.onCreate) return;
    const ov = el('div', 'modal-overlay tt-dialog-overlay');
    ov.innerHTML = '<div class="modal tt-dialog fm-dialog-sm" role="dialog" aria-modal="true"><div class="modal-title">建立地圖</div><div class="tt-dialog-body">' +
      '<div class="tt-ed-row"><input class="tt-input" type="text" maxlength="100" placeholder="地圖名稱，例如：台北小吃、東京 2027" data-f="title"></div>' +
      '<div class="tt-ed-row fm-colors-row">' + COLORS.map(function (c, i) { return '<button type="button" class="fm-color' + (i === 0 ? ' on' : '') + '" data-c="' + c + '" style="background:' + c + '"></button>'; }).join('') + '</div>' +
      '</div><div class="modal-actions"><button class="btn" type="button" data-e="close">取消</button><button class="btn btn-primary" type="button" data-e="ok">建立</button></div></div>';
    document.body.appendChild(ov);
    let color = COLORS[0];
    const inp = ov.querySelector('[data-f="title"]');
    const close = function () { ov.remove(); };
    const ok = function () { const t = inp.value.trim(); if (!t) { inp.focus(); return; } close(); O.onCreate({ title: t, color: color }); };
    ov.addEventListener('click', function (e) {
      const c = e.target.closest('[data-c]'); if (c) { color = c.getAttribute('data-c'); ov.querySelectorAll('.fm-color').forEach(function (b) { b.classList.toggle('on', b === c); }); return; }
      const b = e.target.closest('[data-e]'); if (!b) { if (e.target === ov) close(); return; }
      if (b.getAttribute('data-e') === 'close') close(); else ok();
    });
    ov.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === inp) { e.preventDefault(); ok(); } if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    setTimeout(function () { inp.focus(); }, 0);
  }

  // ---------------- 新增／編輯店家 ----------------
  function openEditor(place, m) {
    closePop();
    const maps = mapsOf().filter(function (x) { return !x.ro; });
    if (!maps.length) { toast('先建立一張地圖'); return; }
    m = m || mapById(S.lastMap) || maps[0];
    const isNew = !place;
    const base = place ? JSON.parse(JSON.stringify(place)) : { id: uid('p'), name: '', address: '', source: '', tags: S.tags.slice(), lat: null, lng: null, note: '', rating: 0, visited: false, added: Date.now() };
    const allTags = tagCounts().map(function (t) { return t.name; });
    const ov = el('div', 'modal-overlay tt-dialog-overlay fm-ov');
    ov.innerHTML = '<div class="modal tt-dialog fm-dialog" role="dialog" aria-modal="true">' +
      '<div class="tt-ed-head"><input class="tt-ed-title" type="text" maxlength="200" placeholder="店名" value="' + esc(base.name) + '" data-f="name"><button class="tt-tb" type="button" data-e="close" title="關閉">' + ic('x') + '</button></div>' +
      '<div class="tt-dialog-body">' +
      '<div class="tt-ed-row"><span class="tt-ed-l">' + ic('map-pin') + '</span><input class="tt-input" type="text" maxlength="300" placeholder="地址（填了按「查地址」就會定位）" data-f="address" value="' + esc(base.address) + '"><button class="tt-btn" type="button" data-e="geocode">查地址</button></div>' +
      '<div class="fm-geo-results" hidden></div>' +
      '<div class="tt-ed-row fm-coord-row"><span class="tt-ed-l"></span><span class="fm-coord" data-f="coord"></span><span class="tt-sp"></span><button class="tt-btn" type="button" data-e="pick">在地圖上點位置</button><button class="tt-btn" type="button" data-e="clearpos" title="拿掉座標">清除</button></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">' + ic('book-open') + '</span><input class="tt-input" type="text" maxlength="500" placeholder="資料來源（例如：朋友推薦、IG 帳號、文章網址）" data-f="source" value="' + esc(base.source) + '"></div>' +
      '<div class="tt-ed-row fm-tags-row"><span class="tt-ed-l">' + ic('tag') + '</span><div class="fm-chips" data-f="tags"><input type="text" class="fm-chip-in" placeholder="標籤，Enter 或逗號分開" list="fm-tag-list" maxlength="40"></div></div>' +
      '<datalist id="fm-tag-list">' + allTags.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist>' +
      (allTags.length ? '<div class="tt-ed-row fm-tag-sugg"><span class="tt-ed-l"></span><div>' + allTags.slice(0, 16).map(function (t) { return '<button type="button" class="fm-tag fm-tag-b" ' + tagStyle(t) + ' data-sugg="' + esc(t) + '">' + esc(t) + '</button>'; }).join('') + '</div></div>' : '') +
      '<div class="tt-ed-row"><span class="tt-ed-l">' + ic('star') + '</span><div class="fm-rate" data-f="rating">' + [1, 2, 3, 4, 5].map(function (i) { return '<button type="button" class="fm-rate-b' + (i <= base.rating ? ' on' : '') + '" data-r="' + i + '" title="' + i + ' 星">★</button>'; }).join('') + '<button type="button" class="fm-rate-clr" data-r="0" title="不評分">清除</button></div>' +
      '<label class="tt-ed-check"><input type="checkbox" data-f="visited"' + (base.visited ? ' checked' : '') + '> 去過了</label></div>' +
      (maps.length > 1 ? '<div class="tt-ed-row"><span class="tt-ed-l">地圖</span><select class="tt-input" data-f="map">' + maps.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === m.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></div>' : '') +
      '<div class="tt-ed-row tt-ed-notes"><span class="tt-ed-l">' + ic('file-text') + '</span><textarea class="tt-input" rows="3" maxlength="2000" placeholder="備註：推薦什麼、營業時間、要不要訂位…" data-f="note">' + esc(base.note) + '</textarea></div>' +
      '</div><div class="modal-actions">' + (isNew ? '' : '<button class="btn tt-ed-del" type="button" data-e="del">刪除</button>') + '<span class="tt-sp"></span><button class="btn" type="button" data-e="close">取消</button><button class="btn btn-primary" type="button" data-e="save">' + (isNew ? '新增' : '儲存') + '</button></div></div>';
    document.body.appendChild(ov);
    const q = function (sel) { return ov.querySelector(sel); };
    const f = function (name) { return q('[data-f="' + name + '"]'); };
    let tags = base.tags.slice(), rating = base.rating, lat = base.lat, lng = base.lng, approx = false;
    const chipsBox = f('tags'), chipIn = chipsBox.querySelector('input');
    const paintChips = function () {
      chipsBox.querySelectorAll('.fm-chip').forEach(function (c) { c.remove(); });
      tags.forEach(function (t) { const c = el('span', 'fm-tag fm-chip', esc(t) + '<button type="button" data-rm="' + esc(t) + '" title="移除">' + ic('x') + '</button>'); c.setAttribute('style', '--h:' + tagHue(t)); chipsBox.insertBefore(c, chipIn); });
      ov.querySelectorAll('[data-sugg]').forEach(function (b) { b.classList.toggle('on', tags.some(function (t) { return t.toLowerCase() === b.getAttribute('data-sugg').toLowerCase(); })); });
    };
    const addTag = function (t) { t = String(t || '').replace(/^#+/, '').trim(); if (!t) return; if (!tags.some(function (x) { return x.toLowerCase() === t.toLowerCase(); }) && tags.length < 20) tags.push(t); paintChips(); };
    const paintCoord = function () { f('coord').innerHTML = lat === null ? '<span class="fm-coord-none">還沒有位置</span>' : esc(lat.toFixed(5) + ', ' + lng.toFixed(5)) + (approx ? ' <span class="fm-badge fm-badge-n">只到路段，建議在地圖上微調</span>' : ''); q('[data-e="clearpos"]').hidden = lat === null; };
    paintChips(); paintCoord();
    const results = q('.fm-geo-results');
    const geocode = function () {
      const addr = f('address').value.trim() || f('name').value.trim();
      if (!addr) { toast('先填地址或店名'); f('address').focus(); return; }
      if (!global.Store || !Store.geocode) return;
      results.hidden = false; results.innerHTML = '<div class="fm-geo-wait">查詢中…</div>';
      Store.geocode(addr).then(function (r) {
        if (r.error) { results.innerHTML = '<div class="fm-geo-err">' + esc(r.error) + '</div>'; return; }
        results.innerHTML = (r.approx ? '<div class="fm-geo-note">門牌找不到，只找到路段——選一筆後請在地圖上微調位置</div>' : '') + r.results.map(function (h, i) { return '<button type="button" class="fm-geo-hit" data-hit="' + i + '"><b>' + esc(h.name || h.short || '（無名稱）') + '</b><small>' + esc(h.displayName) + '</small></button>'; }).join('');
        results._hits = r.results; results._approx = !!r.approx;
      });
    };
    ov.addEventListener('click', function (e) {
      const t = e.target;
      let b;
      if ((b = t.closest('[data-hit]'))) {
        const h = results._hits[+b.getAttribute('data-hit')];
        if (!h) return;
        lat = h.lat; lng = h.lng; approx = !!results._approx;
        if (!f('address').value.trim() && (h.short || h.displayName)) f('address').value = h.short || h.displayName;
        if (!f('name').value.trim() && h.name) f('name').value = h.name;
        results.hidden = true; paintCoord(); return;
      }
      if ((b = t.closest('[data-rm]'))) { const u = b.getAttribute('data-rm'); tags = tags.filter(function (x) { return x !== u; }); paintChips(); return; }
      if ((b = t.closest('[data-sugg]'))) { const u = b.getAttribute('data-sugg'); if (tags.some(function (x) { return x.toLowerCase() === u.toLowerCase(); })) tags = tags.filter(function (x) { return x.toLowerCase() !== u.toLowerCase(); }); else addTag(u); return; }
      if ((b = t.closest('[data-r]'))) { rating = +b.getAttribute('data-r'); ov.querySelectorAll('.fm-rate-b').forEach(function (x) { x.classList.toggle('on', +x.getAttribute('data-r') <= rating); }); return; }
      b = t.closest('[data-e]');
      if (!b) { if (t === ov) close(); return; }
      const a = b.getAttribute('data-e');
      if (a === 'close') close();
      else if (a === 'geocode') geocode();
      else if (a === 'clearpos') { lat = null; lng = null; approx = false; paintCoord(); }
      else if (a === 'pick') {
        // 對話框先藏起來（不是關掉，欄位都留著），點完地圖再回來
        ov.hidden = true;
        startPick(function (pt, cancelled) {
          ov.hidden = false;
          if (cancelled || !pt) return;
          lat = pt.lat; lng = pt.lng; approx = false; paintCoord();
          if (!f('address').value.trim() && global.Store && Store.reverseGeocode) {
            f('address').placeholder = '查地址中…';
            Store.reverseGeocode(lat, lng).then(function (r) { f('address').placeholder = '地址'; if (!r.error && !f('address').value.trim()) f('address').value = r.address || r.displayName || ''; });
          }
        });
        if (lat !== null && leaf) leaf.setView([lat, lng], Math.max(leaf.getZoom(), 16));
      }
      else if (a === 'del') {
        const go = function (yes) { if (!yes) return; m.map.places = m.map.places.filter(function (p) { return p.id !== base.id; }); if (S.selected === base.id) S.selected = null; save(m); close(); paint(); paintMarkers(); };
        if (global.App && App.confirm) App.confirm({ title: '刪除店家', message: '刪除「' + (f('name').value.trim() || base.name) + '」？', ok: '刪除', danger: true }).then(go); else go(window.confirm('刪除？'));
      }
      else if (a === 'save') doSave();
    });
    chipIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') { e.preventDefault(); addTag(chipIn.value); chipIn.value = ''; }
      else if (e.key === 'Backspace' && !chipIn.value && tags.length) { tags.pop(); paintChips(); }
    });
    chipIn.addEventListener('input', function () { if (/[,，]/.test(chipIn.value)) { chipIn.value.split(/[,，]/).forEach(addTag); chipIn.value = ''; } });
    chipIn.addEventListener('blur', function () { if (chipIn.value.trim()) { addTag(chipIn.value); chipIn.value = ''; } });
    f('address').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); geocode(); } });
    ov.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); if (!results.hidden) { results.hidden = true; return; } close(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSave(); }
    });
    const close = function () { if (S.picking) endPick(); ov.remove(); };
    const doSave = function () {
      const name = f('name').value.trim();
      if (!name) { f('name').focus(); toast('店名要填'); return; }
      if (chipIn.value.trim()) { addTag(chipIn.value); chipIn.value = ''; }
      const target = f('map') ? mapById(f('map').value) || m : m;
      const p = cleanPlace({ id: base.id, name: name, address: f('address').value, source: f('source').value, tags: tags, lat: lat, lng: lng, note: f('note').value, rating: rating, visited: f('visited').checked, added: base.added }, {});
      // 從別張地圖搬過來：舊的那張拿掉
      if (!isNew && target.id !== m.id) { m.map.places = m.map.places.filter(function (x) { return x.id !== base.id; }); save(m); }
      const i = target.map.places.findIndex(function (x) { return x.id === p.id; });
      if (i >= 0) target.map.places[i] = p; else target.map.places.push(p);
      S.lastMap = target.id;
      save(target);
      close();
      S.selected = p.id;
      // 新的店若在篩選外（例如正篩著別的標籤）清掉篩選，不然看不到自己剛加的
      if (!matches({ p: p, m: target })) { S.tags = []; S.search = ''; S.visit = 'all'; }
      if (S.hidden[target.id]) { delete S.hidden[target.id]; lsSet('fmHidden', JSON.stringify(S.hidden)); }
      paint(); paintMarkers();
      if (p.lat !== null) focusPlace(p.id, isNew);
      toast(isNew ? '已新增「' + p.name + '」' : '已儲存');
    };
    setTimeout(function () { (isNew ? f('name') : f('name')).focus(); }, 0);
  }

  function teardown() {
    closePop();
    if (S.picking) endPick();
    document.querySelectorAll('.fm-ov').forEach(function (o) { o.remove(); });
    if (leaf) { try { leaf.remove(); } catch (e) { /* */ } }
    leaf = null; markerLayer = null; markers = {}; fitted = false; built = null;
  }
  // 從別處進來（#note/<地圖 id>）：把那張地圖顯示出來、全部放進畫面
  function reveal(mapId) {
    if (S.hidden[mapId]) { delete S.hidden[mapId]; lsSet('fmHidden', JSON.stringify(S.hidden)); }
    fitted = false;
  }

  global.FoodMap = { isNote: isNote, generate: generate, parse: parse, serialize: serialize, payloadOf: payloadOf, wrap: wrap, blockHTML: blockHTML, render: render, teardown: teardown, closePop: closePop, reveal: reveal, state: S, COLORS: COLORS };
})(window);
