/* foodmap.js — 圖資中心（先是美食地圖：「新增一個美食地圖，串接 openstreetmap 或是 GoogleMap，我要免費的，讓我可以把店名、地址、
 * 資料來源塞進去，並使用 tag 做分類，可以搜尋，同時顯示在地圖上」；接著「把美食地圖改成圖資中心，我可以在圖資中心自己新增圖層、
 * 並編輯圖層，幫我預設有美食地圖、步道地圖」）。檔名、模組名 FoodMap、area 'foodmap'、meta.foodmap、#foodmap 都沿用，
 * 跟 strikenote 的識別字一樣——已經存在的資料不用搬。
 *
 * 一個「圖層」就是一篇筆記（下面說的「地圖」就是圖層）：名稱是筆記標題，kind（food 美食／trail 步道／place 一般）決定用詞
 * （店家／步道／地點）、icon 是針上和清單裡的圖示、color 是針的顏色、desc 是說明；第一次打開沒有任何圖層時自動建「美食地圖」
 * 和「步道地圖」兩層。建立／編輯圖層都是 layerDialog（名稱、類型、圖示、顏色、說明）。
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
  // 圖層類型：決定用詞跟預設的圖示／顏色。只有用詞不同，欄位都一樣（名稱、地址、來源、標籤、評分、去過、備註）。
  const KINDS = {
    food: { label: '美食', one: '店家', name: '店名', icon: 'utensils', color: '#e0542c' },
    trail: { label: '步道', one: '步道', name: '步道名稱', icon: 'mountain', color: '#17934f' },
    place: { label: '一般', one: '地點', name: '名稱', icon: 'map-pin', color: '#3b7ddd' }
  };
  const KIND_ORDER = ['food', 'trail', 'place'];
  const LAYER_ICONS = ['utensils', 'mountain', 'map-pin', 'coffee', 'camera', 'star', 'home', 'globe', 'award', 'book-open', 'film', 'shield', 'pin', 'image', 'users', 'archive'];
  const DEFAULT_LAYERS = [{ title: '美食地圖', kind: 'food' }, { title: '步道地圖', kind: 'trail' }];
  function kindOf(map) { return KINDS[map && map.kind] || KINDS.place; }
  // 縣市：地址裡找得到就自動帶出（臺→台統一，篩選才不會「臺北市」「台北市」各算一邊）；台灣以外抓「○○県／都／府」
  const TW_CITIES = ['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市', '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'];
  function normCity(s) { return str(s, 40).trim().replace(/^臺/, '台'); }
  function cityFromAddress(addr) {
    const a = String(addr || '').replace(/臺/g, '台');
    for (let i = 0; i < TW_CITIES.length; i++) if (a.indexOf(TW_CITIES[i]) >= 0) return TW_CITIES[i];
    const m = /(東京都|北海道|京都府|大阪府|[\u4e00-\u9fff]{1,3}県)/.exec(a);
    return m ? m[1] : '';
  }
  // 圖片：存成 "img:<id>"（不是光 id）——伺服器判斷「誰看得到這張圖」「檔案管理算不算用到」都是找內文裡的 img:<id>，
  // 這樣分享出去的圖層對方也看得到圖、檔案管理不會把它當成沒用到的
  const IMG_ID = /^(?:img:)?([A-Za-z0-9_][\w.-]{0,63})$/;
  function imgId(v) { const m = IMG_ID.exec(String(v || '').trim()); return m ? m[1] : ''; }
  function imgSrc(v) { return '/api/images/' + encodeURIComponent(imgId(v)); }
  function cleanImages(a) { const out = []; (Array.isArray(a) ? a : []).forEach(function (v) { const id = imgId(v); if (id && out.indexOf('img:' + id) < 0 && out.length < 12) out.push('img:' + id); }); return out; }
  function safeUrl(u) { u = str(u, 500).trim(); return /^https?:\/\/\S+$/i.test(u) ? u : ''; }
  // 完整的 Google 地圖網址裡常有座標（@lat,lng、!3dlat!4dlng、q=lat,lng）；短網址 maps.app.goo.gl 沒有，只能靠地址定位
  function coordsFromUrl(u) {
    const m = /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(u) || /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/.exec(u) || /[?&](?:q|ll|query)=(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(u);
    return m ? { lat: parseFloat(m[1]), lng: parseFloat(m[2]) } : null;
  }
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
    let lat = coord(p.lat, 90), lng = coord(p.lng, 180);
    const gmap = safeUrl(p.gmap);
    if ((lat === null || lng === null) && gmap) { const c = coordsFromUrl(gmap); if (c) { lat = coord(c.lat, 90); lng = coord(c.lng, 180); } }
    const address = str(p.address, 300).trim();
    const o = {
      id: id, name: str(p.name, 200).trim(), address: address, city: normCity(p.city) || cityFromAddress(address), source: str(p.source, 500).trim(), gmap: gmap,
      tags: cleanTags(p.tags), lat: lat !== null && lng !== null ? lat : null, lng: lat !== null && lng !== null ? lng : null,
      note: str(p.note, 2000), rating: Math.max(0, Math.min(5, parseInt(p.rating, 10) || 0)), visited: !!p.visited,
      images: cleanImages(p.images), added: p.added > 0 ? Math.floor(p.added) : Date.now()
    };
    if (!o.name) o.name = '（未命名）';
    return o;
  }
  function cleanMap(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const kind = KINDS[raw.kind] ? raw.kind : 'place';
    const o = { kind: kind, icon: LAYER_ICONS.indexOf(raw.icon) >= 0 ? raw.icon : KINDS[kind].icon, color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : KINDS[kind].color, desc: str(raw.desc, 500).trim(), places: [] };
    const seen = {};
    (Array.isArray(raw.places) ? raw.places : []).forEach(function (p) { const x = cleanPlace(p, seen); if (x) o.places.push(x); });
    return o;
  }
  function parse(text) { let raw = null; try { raw = JSON.parse(String(text || '')); } catch (e) { raw = null; } return cleanMap(raw); }
  function serialize(m) { return JSON.stringify(m, null, 1); }
  function payloadOf(content) { const m = /^```foodmap[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/m.exec(String(content || '')); return m ? m[1] : null; }
  function wrap(json) { return '```foodmap\n' + json + '\n```\n'; }
  function isNote(note) { return !!(note && note.meta && note.meta.foodmap); }
  // d：{ kind, icon, color, desc }（舊的呼叫法 generate('#hex') 也收）
  function generate(d) { if (typeof d === 'string') d = { color: d }; return wrap(serialize(cleanMap(d || {}))); }

  function gmapsUrl(p) {
    if (p.gmap) return p.gmap;
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
    const k = kindOf(m);
    return '<div class="fms"><div class="fms-head"><i style="background:' + m.color + '"></i><b>' + esc(name || '圖層') + '</b><small>' + esc(k.label) + '</small><span>' + m.places.length + ' 個' + esc(k.one) + (located < m.places.length ? '・' + (m.places.length - located) + ' 個未定位' : '') + '</span></div>' +
      (m.desc ? '<div class="fms-desc">' + esc(m.desc) + '</div>' : '') +
      (m.places.length ? '<ul class="fms-list">' + m.places.map(function (p) {
        return '<li' + (p.visited ? ' class="is-visited"' : '') + '><div class="fms-row"><span class="fms-pin" style="color:' + m.color + '">' + ic(m.icon) + '</span><b class="fms-name">' + esc(p.name) + '</b>' + (p.rating ? '<span class="fms-stars">' + stars(p.rating) + '</span>' : '') + (p.visited ? '<span class="fms-visited">去過</span>' : '') + tagsHTML(p.tags, 'fms-tag') + '</div>' +
          (p.address || p.city ? '<div class="fms-addr">' + (p.city ? '<span class="fms-city">' + esc(p.city) + '</span>' : '') + esc(p.address) + '</div>' : '') +
          '<div class="fms-meta">' + sourceHTML(p.source, 'fms-src') + '<a class="fms-src" href="' + esc(gmapsUrl(p)) + '" target="_blank" rel="noopener noreferrer">' + ic('map-pin') + 'Google 地圖</a>' + (p.note ? '<span class="fms-note">' + esc(p.note) + '</span>' : '') + '</div>' +
          (p.images.length ? '<div class="fms-imgs">' + p.images.map(function (v) { return '<img class="fms-img" data-img-id="' + esc(imgId(v)) + '" alt="' + esc(p.name) + '">'; }).join('') + '</div>' : '') + '</li>';
      }).join('') + '</ul>' : '<div class="fms-empty">還沒有' + esc(k.one) + '</div>') + '</div>';
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

  const S = { search: '', tags: [], visit: 'all', city: '', hidden: {}, selected: null, picking: null, locating: null };
  try { S.hidden = JSON.parse(lsGet('fmHidden', '{}')) || {}; } catch (e) { S.hidden = {}; }
  const cache = new Map();   // noteId → { content, map }
  let host = null, O = null, built = null;
  // Leaflet 的東西，建一次、跨 render 留著（重畫清單時地圖不重載圖磚）
  let leaf = null, markerLayer = null, markers = {}, fitted = false, pickBanner = null, seeding = false;

  function mapsOf() {
    return (O.maps || []).map(function (n) {
      let c = cache.get(n.id);
      if (!c || c.content !== n.content) { c = { content: n.content, map: parse(payloadOf(n.content) || '') }; cache.set(n.id, c); }
      return { id: n.id, note: n, map: c.map, name: n.title || '圖層', kind: kindOf(c.map), ro: !!(O.readOnly && O.readOnly(n)) };
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
    if (S.city && normCity(p.city) !== S.city) return false;
    if (S.tags.length && !S.tags.every(function (t) { return p.tags.some(function (u) { return u.toLowerCase() === t.toLowerCase(); }); })) return false;
    const q = S.search.trim().toLowerCase();
    if (q) {
      const hay = [p.name, p.address, p.city, p.source, p.note, p.tags.join(' '), x.m.name].join('\n').toLowerCase();
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
    }
    // 第一次：一個圖層都沒有就把預設的兩層建起來（美食地圖、步道地圖），一層一層建，render 連著被叫也只建一次
    if (!(O.maps || []).length && O.onCreate && !seeding) {
      seeding = true;
      DEFAULT_LAYERS.reduce(function (p, d) { return p.then(function () { return O.onCreate(Object.assign({ auto: true }, d, KINDS[d.kind] ? { icon: KINDS[d.kind].icon, color: KINDS[d.kind].color } : {})); }); }, Promise.resolve())
        .then(function () { seeding = false; }, function () { seeding = false; });
    }
    paint();
    ensureMap();
    paintMarkers();
  }
  function paint() {
    paintSide(); paintHead(); paintList();
  }
  // 左欄：圖層（彩色圖示方塊＝那一層的針，點方塊切換顯示）、去過沒（一列三段）、縣市（膠囊，單選）、標籤（膠囊，多選 AND）
  function paintSide() {
    const side = built.querySelector('.fm-side');
    const maps = mapsOf(), tags = tagCounts(), all = allPlaces();
    const visited = all.filter(function (x) { return x.p.visited; }).length;
    let h = '<section class="fm-sec fm-sec-layers"><div class="fm-sec-h"><span>圖層</span><small>' + maps.length + '</small>' + (O.onCreate ? '<button type="button" class="fm-sec-btn" data-e="newmap" title="新增圖層">' + ic('plus') + '</button>' : '') + '</div><div class="fm-layers">';
    maps.forEach(function (m) {
      const hid = !!S.hidden[m.id];
      h += '<div class="fm-mapline fm-layer' + (hid ? ' is-hidden' : '') + '" data-map="' + esc(m.id) + '" title="' + esc(m.kind.label + (m.map.desc ? '：' + m.map.desc : '')) + '">' +
        '<label class="fm-layer-vis" title="' + (hid ? '顯示這一層' : '隱藏這一層') + '"><input type="checkbox" data-vis="' + esc(m.id) + '"' + (hid ? '' : ' checked') + '><span class="fm-layer-badge" style="--c:' + m.map.color + '">' + ic(m.map.icon) + '</span></label>' +
        '<span class="fm-layer-name">' + esc(m.name) + '</span>' +
        (m.ro ? '<span class="fm-layer-ro" title="別人分享給我的，只能看">' + ic('lock') + '</span>' : '') +
        '<span class="fm-layer-n">' + m.map.places.length + '</span>' +
        '<button class="fm-layer-more" type="button" data-more="' + esc(m.id) + '" title="更多">' + ic('more-horizontal') + '</button></div>';
    });
    if (!maps.length) h += '<div class="fm-sec-empty">還沒有圖層。' + (O.onCreate ? '<button type="button" class="fm-link-btn" data-e="newmap">新增一個</button>' : '') + '</div>';
    h += '</div></section>';
    h += '<section class="fm-sec"><div class="fm-sec-h"><span>去過沒</span></div><div class="fm-seg">' + [['all', '全部', all.length], ['todo', '還沒去', all.length - visited], ['visited', '去過', visited]].map(function (v) { return '<button type="button" class="fm-seg-b' + (S.visit === v[0] ? ' on' : '') + '" data-visit="' + v[0] + '">' + v[1] + '<small>' + v[2] + '</small></button>'; }).join('') + '</div></section>';
    const cities = {};
    all.forEach(function (x) { const c = normCity(x.p.city); if (c) cities[c] = (cities[c] || 0) + 1; });
    const cityList = Object.keys(cities).sort(function (a, b) { return cities[b] - cities[a] || a.localeCompare(b, 'zh-Hant'); });
    if (cityList.length || S.city) {
      h += '<section class="fm-sec"><div class="fm-sec-h"><span>縣市</span><small>' + cityList.length + '</small>' + (S.city ? '<button type="button" class="fm-sec-btn fm-sec-txt" data-city="">清除</button>' : '') + '</div><div class="fm-chips-wrap fm-cities">' +
        cityList.map(function (c) { return '<button type="button" class="fm-chip-b' + (S.city === c ? ' on' : '') + '" data-city="' + esc(c) + '">' + esc(c) + '<small>' + cities[c] + '</small></button>'; }).join('') + '</div></section>';
    }
    h += '<section class="fm-sec"><div class="fm-sec-h"><span>標籤</span><small>' + tags.length + '</small>' + (S.tags.length ? '<button type="button" class="fm-sec-btn fm-sec-txt" data-e="cleartags">清除</button>' : '') + '</div><div class="fm-chips-wrap fm-tagcloud">';
    if (!tags.length) h += '<div class="fm-sec-empty">新增地點時填標籤，這裡就會出現，點了可以篩選。</div>';
    tags.forEach(function (t) { const on = S.tags.some(function (x) { return x.toLowerCase() === t.name.toLowerCase(); }); h += '<button type="button" class="fm-tag fm-tag-b' + (on ? ' on' : '') + '" ' + tagStyle(t.name) + ' data-tag="' + esc(t.name) + '">' + esc(t.name) + '<small>' + t.n + '</small></button>'; });
    h += '</div></section>';
    h += '<div class="fm-foot">底圖 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> 貢獻者</div>';
    side.innerHTML = h;
  }
  function paintHead() {
    const head = built.querySelector('.fm-head');
    const n = filtered().length, total = allPlaces().length;
    const canAdd = mapsOf().some(function (m) { return !m.ro; });
    head.innerHTML = '<label class="tt-search fm-search">' + ic('search') + '<input type="search" placeholder="搜尋名稱、地址、標籤、來源…" value="' + esc(S.search) + '" data-f="search" aria-label="搜尋地點"></label>' +
      (S.tags.length ? '<div class="fm-active-tags">' + S.tags.map(function (t) { return '<span class="fm-tag" ' + tagStyle(t) + '>' + esc(t) + '<button type="button" data-untag="' + esc(t) + '" title="取消這個標籤的篩選">' + ic('x') + '</button></span>'; }).join('') + '</div>' : '') +
      '<span class="fm-count">' + countText() + '</span><span class="tt-sp"></span>' +
      (missingCount() && !S.locating ? '<button class="tt-tb" type="button" data-e="locate" title="用地址把還沒有座標的地點定位到地圖上">' + ic('map-pin') + '<span class="fm-tb-t">定位 ' + missingCount() + ' 個未定位</span></button>' : '') +
      '<button class="tt-tb" type="button" data-e="io" title="匯入 JSON、匯出">' + ic('upload') + '<span class="fm-tb-t">匯入／匯出</span></button>' +
      '<button class="tt-tb" type="button" data-e="fit" title="把所有看得到的地點都放進畫面">' + ic('maximize') + '<span class="fm-tb-t">全部顯示</span></button>' +
      (canAdd ? '<button class="tt-btn tt-btn-primary fm-add" type="button" data-e="add">' + ic('plus') + ' ' + addLabel() + '</button>' : '');
  }
  // 看得見的圖層都是同一種類型就用那種的詞（新增店家／新增步道），不然就「新增地點」
  function oneKind() { const ks = {}; visibleMaps().forEach(function (m) { ks[m.map.kind] = 1; }); const a = Object.keys(ks); return a.length === 1 ? KINDS[a[0]] : null; }
  function missingOf(maps) { const out = []; (maps || visibleMaps()).forEach(function (m) { if (m.ro) return; m.map.places.forEach(function (p) { if (p.lat === null && (p.address || p.name)) out.push({ p: p, m: m }); }); }); return out; }
  function missingCount() { return missingOf().length; }
  function addLabel() { const k = oneKind(); return '新增' + (k ? k.one : '地點'); }
  function countText() { const n = filtered().length, total = allPlaces().length, k = oneKind(); const u = ' 個' + (k ? k.one : '地點'); return n === total ? total + u : n + ' / ' + total + u; }
  function placeRow(x) {
    const p = x.p, m = x.m;
    return '<div class="fm-row' + (S.selected === p.id ? ' is-sel' : '') + (p.visited ? ' is-visited' : '') + (p.lat === null ? ' is-nowhere' : '') + '" data-id="' + esc(p.id) + '" tabindex="0">' +
      '<span class="fm-row-pin" style="--c:' + m.map.color + '" title="' + esc(m.name) + '">' + ic(m.map.icon) + '</span>' +
      '<div class="fm-row-main"><div class="fm-row-top"><b class="fm-row-name">' + esc(p.name) + '</b>' + (p.rating ? '<span class="fm-stars">' + stars(p.rating) + '</span>' : '') + (p.visited ? '<span class="fm-badge fm-badge-v">去過</span>' : '') + (p.lat === null ? '<span class="fm-badge fm-badge-n">未定位</span>' : '') + '</div>' +
      (p.address || p.city ? '<div class="fm-row-addr">' + (p.city ? '<span class="fm-row-city">' + esc(p.city) + '</span>' : '') + esc(p.address) + '</div>' : '') +
      '<div class="fm-row-meta">' + tagsHTML(p.tags) + sourceHTML(p.source) + '<a class="fm-src fm-gmap" href="' + esc(gmapsUrl(p)) + '" target="_blank" rel="noopener noreferrer" title="在 Google 地圖開啟">' + ic('map-pin') + 'Google 地圖</a></div></div>' +
      (p.images.length ? '<button type="button" class="fm-row-thumb" data-gallery="' + esc(p.id) + '" title="看圖片"><img src="' + esc(imgSrc(p.images[0])) + '" alt="" loading="lazy">' + (p.images.length > 1 ? '<span>' + p.images.length + '</span>' : '') + '</button>' : '') +
      (m.ro ? '' : '<div class="fm-row-tools"><button class="tt-tb fm-row-tb" type="button" data-edit="' + esc(p.id) + '" title="編輯">' + ic('pencil') + '</button><button class="tt-tb fm-row-tb" type="button" data-pmore="' + esc(p.id) + '" title="更多">' + ic('more-horizontal') + '</button></div>') + '</div>';
  }
  function paintList() {
    const list = built.querySelector('.fm-list');
    const rows = filtered();
    if (!rows.length) {
      const total = allPlaces().length;
      list.innerHTML = '<div class="fm-empty">' + ic('map-pin') + '<p>' + (total ? '沒有符合的地點，換個關鍵字或清掉篩選。' : mapsOf().length ? '還沒有地點。按右上「' + addLabel() + '」，填名稱跟地址就會出現在地圖上。' : '先新增一個圖層。') + '</p></div>';
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
        const w = el('div', 'fm-tile-warn', ic('alert-triangle') + ' 底圖載不進來（tile.openstreetmap.org 沒有回應或回 403）。地點的針跟清單不受影響；請檢查網路，或稍後再試。');
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
  function pinIcon(color, sel, icon) {
    return L.divIcon({ className: 'fm-pin-wrap', html: '<i class="fm-pin' + (sel ? ' is-sel' : '') + '" style="--c:' + color + '">' + ic(icon || 'map-pin') + '</i>', iconSize: [26, 34], iconAnchor: [13, 32], popupAnchor: [0, -30] });
  }
  function popupHTML(x) {
    const p = x.p, m = x.m;
    return '<div class="fm-pop"><div class="fm-pop-top"><b>' + esc(p.name) + '</b>' + (p.rating ? '<span class="fm-stars">' + stars(p.rating) + '</span>' : '') + (p.visited ? '<span class="fm-badge fm-badge-v">去過</span>' : '') + '</div>' +
      (p.address ? '<div class="fm-pop-addr">' + esc(p.address) + '</div>' : '') +
      (p.tags.length ? '<div class="fm-pop-tags">' + tagsHTML(p.tags) + '</div>' : '') +
      (p.source ? '<div class="fm-pop-src">來源：' + sourceHTML(p.source) + '</div>' : '') +
      (p.note ? '<div class="fm-pop-note">' + esc(p.note) + '</div>' : '') +
      (p.images.length ? '<div class="fm-pop-imgs">' + p.images.slice(0, 4).map(function (v, i) { return '<button type="button" class="fm-pop-img" data-gallery="' + esc(p.id) + '" data-i="' + i + '"><img src="' + esc(imgSrc(v)) + '" alt="">' + (i === 3 && p.images.length > 4 ? '<span>+' + (p.images.length - 4) + '</span>' : '') + '</button>'; }).join('') + '</div>' : '') +
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
      const sig = [p.lat, p.lng, x.m.map.color, x.m.map.icon, sel ? 1 : 0, p.name, p.address, p.tags.join(','), p.source, p.note, p.rating, p.visited ? 1 : 0, p.images.join(','), x.m.name].join('|');
      if (mk && mk._fmSig === sig) return;
      if (!mk) {
        mk = L.marker([p.lat, p.lng], { icon: pinIcon(x.m.map.color, sel, x.m.map.icon), title: p.name, riseOnHover: true, keyboard: false });
        mk.on('click', function () { S.selected = p.id; paintList(); paintMarkers(); scrollRowIntoView(p.id); });
        mk.bindPopup('', { maxWidth: 300, className: 'fm-popup', autoPanPadding: [30, 30] });
        markerLayer.addLayer(mk);
        markers[key] = mk;
      } else {
        mk.setLatLng([p.lat, p.lng]);
        mk.setIcon(pinIcon(x.m.map.color, sel, x.m.map.icon));
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
    if (!rows.length) { toast('沒有定位過的地點'); return; }
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
        if (a === 'newmap') return layerDialog(null);
        if (a === 'add') return openEditor(null, null);
        if (a === 'fit') return fitAll();
        if (a === 'io') { const r = b.getBoundingClientRect(); return ioMenu(r.left, r.bottom + 4); }
        if (a === 'locate') return locateMissing();
        if (a === 'cancellocate') { if (S.locating) S.locating.cancel = true; return; }
        if (a === 'cleartags') { S.tags = []; paint(); paintMarkers(); return; }
      }
      if ((b = t.closest('[data-untag]'))) { const u = b.getAttribute('data-untag'); S.tags = S.tags.filter(function (x) { return x !== u; }); paint(); paintMarkers(); return; }
      if ((b = t.closest('[data-visit]'))) { S.visit = b.getAttribute('data-visit'); paint(); paintMarkers(); return; }
      if ((b = t.closest('[data-city]'))) { S.city = b.getAttribute('data-city'); paint(); paintMarkers(); return; }
      if ((b = t.closest('.fm-side [data-tag], .fm-list [data-tag]'))) {
        const tg = b.getAttribute('data-tag');
        const i = S.tags.findIndex(function (x) { return x.toLowerCase() === tg.toLowerCase(); });
        if (i >= 0) S.tags.splice(i, 1); else S.tags.push(tg);
        paint(); paintMarkers(); return;
      }
      if ((b = t.closest('[data-more]'))) { const m = mapById(b.getAttribute('data-more')); if (m) { const r = b.getBoundingClientRect(); mapMenu(m, r.left, r.bottom + 4); } return; }
      if ((b = t.closest('[data-gallery]'))) { const x = findPlace(b.getAttribute('data-gallery')); if (x && x.p.images.length) openGallery(x.p, +(b.getAttribute('data-i') || 0)); return; }
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
      ['only', '只顯示這層'], ['all', '顯示全部'], null,
      ['edit', '編輯圖層…', m.ro], ['color', '變更顏色', m.ro], ['tags', '標籤…', !O.onTags], null,
      ['export', '匯出 CSV'], null,
      ['delete', '移到垃圾桶', m.ro || !O.onDelete, true]
    ], function (a) {
      if (a === 'only') { S.hidden = {}; mapsOf().forEach(function (o) { if (o.id !== m.id) S.hidden[o.id] = 1; }); lsSet('fmHidden', JSON.stringify(S.hidden)); paint(); paintMarkers(); fitted = false; paintMarkers(); }
      else if (a === 'all') { S.hidden = {}; lsSet('fmHidden', '{}'); paint(); paintMarkers(); }
      else if (a === 'edit') layerDialog(m);
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
      ['edit', '編輯', ro], ['visited', p.visited ? '標成還沒去' : '標成去過', ro], ['copy', '複製到別的圖層', ro || mapsOf().filter(function (o) { return !o.ro && o.id !== x.m.id; }).length === 0], null,
      ['delete', '刪除' + x.m.kind.one, ro, true]
    ], function (a) {
      if (a === 'show') focusPlace(p.id, true);
      else if (a === 'gmaps') window.open(gmapsUrl(p), '_blank', 'noopener');
      else if (a === 'edit') openEditor(p, x.m);
      else if (a === 'visited') { p.visited = !p.visited; save(x.m); paint(); paintMarkers(); }
      else if (a === 'copy') copyPlaceDialog(x);
      else if (a === 'delete') {
        const go = function (yes) { if (!yes) return; x.m.map.places = x.m.map.places.filter(function (q) { return q.id !== p.id; }); if (S.selected === p.id) S.selected = null; save(x.m); paint(); paintMarkers(); toast('已刪除「' + p.name + '」'); };
        if (global.App && App.confirm) App.confirm({ title: '刪除' + x.m.kind.one, message: '刪除「' + p.name + '」？這個圖層的版本歷史裡還找得回來。', ok: '刪除', danger: true }).then(go); else go(window.confirm('刪除「' + p.name + '」？'));
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
    const cols = ['名稱', '縣市', '地址', '資料來源', 'Google 地圖', '標籤', '緯度', '經度', '評分', '去過', '備註'];
    const q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [cols.join(',')].concat(m.map.places.map(function (p) { return [p.name, p.city, p.address, p.source, p.gmap, p.tags.join(' '), p.lat === null ? '' : p.lat, p.lng === null ? '' : p.lng, p.rating || '', p.visited ? '是' : '', p.note].map(q).join(','); }));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (m.name || '圖層') + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  // ---------------- 圖片檢視（點小圖放大，←／→ 換張，Esc／點背景關） ----------------
  let galleryEl = null;
  function closeGallery() { if (galleryEl) { galleryEl.remove(); galleryEl = null; } }
  function openGallery(p, i) {
    closeGallery();
    const ids = p.images.slice();
    if (!ids.length) return;
    let cur = Math.max(0, Math.min(ids.length - 1, i || 0));
    galleryEl = el('div', 'fm-gallery');
    galleryEl.innerHTML = '<div class="fm-gallery-bar"><b></b><span class="fm-gallery-n"></span><span class="tt-sp"></span><a class="tt-tb" target="_blank" rel="noopener noreferrer" title="新分頁開啟">' + ic('external-link') + '</a><button type="button" class="tt-tb" data-g="close" title="關閉（Esc）">' + ic('x') + '</button></div>' +
      '<div class="fm-gallery-stage"><button type="button" class="fm-gallery-nav" data-g="prev" title="上一張（←）">' + ic('chevron-left') + '</button><img alt=""><button type="button" class="fm-gallery-nav" data-g="next" title="下一張（→）">' + ic('chevron-right') + '</button></div>' +
      '<div class="fm-gallery-thumbs">' + ids.map(function (v, k) { return '<button type="button" data-g="go" data-k="' + k + '"><img src="' + esc(imgSrc(v)) + '" alt=""></button>'; }).join('') + '</div>';
    const show = function () {
      galleryEl.querySelector('.fm-gallery-stage img').src = imgSrc(ids[cur]);
      galleryEl.querySelector('.fm-gallery-bar b').textContent = p.name;
      galleryEl.querySelector('.fm-gallery-n').textContent = (cur + 1) + ' / ' + ids.length;
      galleryEl.querySelector('.fm-gallery-bar a').href = imgSrc(ids[cur]);
      galleryEl.querySelectorAll('.fm-gallery-thumbs button').forEach(function (b, k) { b.classList.toggle('on', k === cur); });
      galleryEl.querySelectorAll('.fm-gallery-nav').forEach(function (b) { b.hidden = ids.length < 2; });
    };
    galleryEl.addEventListener('click', function (e) {
      const b = e.target.closest('[data-g]');
      if (!b) { if (e.target === galleryEl || e.target.classList.contains('fm-gallery-stage')) closeGallery(); return; }
      const g = b.getAttribute('data-g');
      if (g === 'close') closeGallery();
      else if (g === 'prev') { cur = (cur - 1 + ids.length) % ids.length; show(); }
      else if (g === 'next') { cur = (cur + 1) % ids.length; show(); }
      else if (g === 'go') { cur = +b.getAttribute('data-k'); show(); }
    });
    document.body.appendChild(galleryEl);
    show();
  }
  document.addEventListener('keydown', function (e) {
    if (!galleryEl) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeGallery(); }
    else if (e.key === 'ArrowLeft') galleryEl.querySelector('[data-g="prev"]').click();
    else if (e.key === 'ArrowRight') galleryEl.querySelector('[data-g="next"]').click();
  }, true);

  // ---------------- 匯入 JSON／匯出／批次定位 ----------------
  // 匯入的 JSON 欄位名稱寬鬆對應（使用者貼的是 name／link／type／city／Address／google_map），大小寫不分；
  // 一個陣列、{ places: [...] }（我們自己匯出的）、或物件裡第一個陣列都收；單一物件也算一筆。
  const ALIAS = {
    name: ['name', '店名', '名稱', 'title', '店家', 'shop', '名字'], address: ['address', '地址', 'addr', 'location', '位置'],
    source: ['source', 'link', 'url', '來源', '資料來源', '網址', '連結'], tags: ['tags', 'tag', 'type', 'category', '類型', '標籤', '分類', '種類'],
    city: ['city', '縣市', '城市', '區域', 'area', '地區'], gmap: ['google_map', 'gmap', 'googlemap', 'google_maps', 'google', 'map', 'maps', '地圖', 'google地圖'],
    lat: ['lat', 'latitude', '緯度'], lng: ['lng', 'lon', 'long', 'longitude', '經度'], note: ['note', 'notes', '備註', 'memo', 'desc', 'description', '說明'],
    rating: ['rating', '評分', 'stars', 'score'], visited: ['visited', '去過', 'done']
  };
  function pickField(row, keys) {
    const lower = {}; Object.keys(row).forEach(function (k) { lower[k.toLowerCase().replace(/[\s_-]/g, '')] = row[k]; });
    for (let i = 0; i < keys.length; i++) { const v = lower[keys[i].toLowerCase().replace(/[\s_-]/g, '')]; if (v !== undefined && v !== null && v !== '') return v; }
    return undefined;
  }
  function rowsOf(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      if (Array.isArray(data.places)) return data.places;
      const k = Object.keys(data).find(function (x) { return Array.isArray(data[x]); });
      if (k) return data[k];
      return [data];
    }
    return [];
  }
  // 回 { places: [cleanPlace…], bad: 幾筆沒有名稱 }；JSON 壞掉會 throw
  function parseImport(text) {
    let data;
    try { data = JSON.parse(String(text || '').replace(/^\uFEFF/, '').trim().replace(/,\s*([\]}])/g, '$1')); } catch (e) { throw new Error('JSON 格式不對：' + (e && e.message || e)); }
    const rows = rowsOf(data), seen = {}, out = [];
    let bad = 0;
    rows.forEach(function (r) {
      if (!r || typeof r !== 'object') { bad++; return; }
      const tagsV = pickField(r, ALIAS.tags);
      const tags = Array.isArray(tagsV) ? tagsV : typeof tagsV === 'string' ? tagsV.split(/[,，、/|;；\s]+/) : [];
      const name = pickField(r, ALIAS.name);
      if (!name) { bad++; return; }
      const visited = pickField(r, ALIAS.visited);
      out.push(cleanPlace({
        name: String(name), address: String(pickField(r, ALIAS.address) || ''), city: String(pickField(r, ALIAS.city) || ''),
        source: String(pickField(r, ALIAS.source) || ''), gmap: String(pickField(r, ALIAS.gmap) || ''), tags: tags,
        lat: pickField(r, ALIAS.lat), lng: pickField(r, ALIAS.lng), note: String(pickField(r, ALIAS.note) || ''),
        rating: pickField(r, ALIAS.rating), visited: visited === true || visited === 1 || /^(1|true|yes|是|y|去過)$/i.test(String(visited || ''))
      }, seen));
    });
    return { places: out, bad: bad };
  }
  function sampleJSON() {
    return JSON.stringify([
      { name: '開餵食堂', link: 'https://www.facebook.com/reel/1153654183472941', type: '小吃', city: '台北市', Address: '115臺北市南港區中南里中南街154號', google_map: 'https://maps.app.goo.gl/8Dn1gWXJ1L17TkwUA' },
      { name: '象山步道', type: '步道, 夜景', city: '台北市', address: '台北市信義區信義路五段150巷', lat: 25.0276, lng: 121.5712, note: '約 1 小時來回', visited: true }
    ], null, 2);
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'application/json;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  // 匯出看得見的圖層：跟匯入同一種欄位（可以再匯回來），多一個 layer 說是哪一層
  function exportJSON(maps) {
    const rows = [];
    (maps || visibleMaps()).forEach(function (m) { m.map.places.forEach(function (p) { rows.push({ layer: m.name, name: p.name, city: p.city, address: p.address, source: p.source, google_map: p.gmap, tags: p.tags, lat: p.lat, lng: p.lng, rating: p.rating || undefined, visited: p.visited || undefined, note: p.note || undefined }); }); });
    download((maps && maps.length === 1 ? maps[0].name : '圖資中心') + '.json', JSON.stringify(rows, null, 2));
  }
  function ioMenu(x, y) {
    const canAdd = mapsOf().some(function (m) { return !m.ro; });
    menuAt(x, y, [
      ['import', '匯入 JSON…', !canAdd], ['sample', '下載 JSON 範例'], null,
      ['export', '匯出看得見的圖層（JSON）', !visibleMaps().length], ['csv', '匯出看得見的圖層（CSV）', !visibleMaps().length], null,
      ['locate', '定位還沒有座標的地點（' + missingCount() + '）', !missingCount() || !!S.locating]
    ], function (a) {
      if (a === 'import') importDialog();
      else if (a === 'sample') download('圖資中心-範例.json', sampleJSON());
      else if (a === 'export') exportJSON();
      else if (a === 'csv') visibleMaps().forEach(exportCSV);
      else if (a === 'locate') locateMissing();
    });
  }
  function importDialog(target) {
    closePop();
    const maps = mapsOf().filter(function (m) { return !m.ro; });
    if (!maps.length) { toast('先新增一個圖層'); return; }
    target = target || mapById(S.lastMap) || maps[0];
    const ov = el('div', 'modal-overlay tt-dialog-overlay fm-ov');
    ov.innerHTML = '<div class="modal tt-dialog fm-dialog fm-import" role="dialog" aria-modal="true"><div class="modal-title">匯入 JSON</div><div class="tt-dialog-body">' +
      '<div class="tt-ed-row"><span class="tt-ed-l">圖層</span><select class="tt-input" data-f="map">' + maps.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === target.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select><label class="tt-btn fm-file-btn">' + ic('upload') + ' 選檔案<input type="file" accept=".json,application/json,text/plain" data-f="file" hidden></label></div>' +
      '<div class="tt-ed-row tt-ed-notes"><span class="tt-ed-l"></span><textarea class="tt-input fm-import-text" rows="9" spellcheck="false" placeholder="把 JSON 貼在這裡，或選檔案。每一筆像這樣：\n{ &quot;name&quot;: &quot;開餵食堂&quot;, &quot;Address&quot;: &quot;台北市南港區中南街154號&quot;, &quot;type&quot;: &quot;小吃&quot;, &quot;city&quot;: &quot;台北市&quot;, &quot;link&quot;: &quot;https://…&quot;, &quot;google_map&quot;: &quot;https://maps.app.goo.gl/…&quot; }\n欄位名稱不分大小寫；type 會變成標籤，link 是資料來源，google_map 是 Google 地圖連結。" data-f="text"></textarea></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l"></span><div class="fm-io-status" data-f="status">還沒有內容</div></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l"></span><label class="tt-ed-check"><input type="checkbox" data-f="locate" checked> 匯入後自動用地址定位沒有座標的地點（每筆約 1 秒）</label></div>' +
      '</div><div class="modal-actions"><button class="btn" type="button" data-e="sample">下載範例</button><span class="tt-sp"></span><button class="btn" type="button" data-e="close">取消</button><button class="btn btn-primary" type="button" data-e="ok" disabled>匯入</button></div></div>';
    document.body.appendChild(ov);
    const f = function (n) { return ov.querySelector('[data-f="' + n + '"]'); };
    let parsed = null;
    const check = function () {
      const t = f('text').value.trim();
      if (!t) { parsed = null; f('status').textContent = '還沒有內容'; f('status').className = 'fm-io-status'; ov.querySelector('[data-e="ok"]').disabled = true; return; }
      try {
        parsed = parseImport(t);
        const located = parsed.places.filter(function (p) { return p.lat !== null; }).length;
        f('status').textContent = '讀到 ' + parsed.places.length + ' 筆' + (located ? '，' + located + ' 筆已有座標' : '') + (parsed.places.length - located ? '，' + (parsed.places.length - located) + ' 筆要用地址定位' : '') + (parsed.bad ? '；' + parsed.bad + ' 筆沒有名稱會略過' : '');
        f('status').className = 'fm-io-status is-ok';
        ov.querySelector('[data-e="ok"]').disabled = !parsed.places.length;
      } catch (e) { parsed = null; f('status').textContent = e.message; f('status').className = 'fm-io-status is-err'; ov.querySelector('[data-e="ok"]').disabled = true; }
    };
    f('text').addEventListener('input', check);
    f('file').addEventListener('change', function () {
      const file = f('file').files[0]; if (!file) return;
      const rd = new FileReader(); rd.onload = function () { f('text').value = String(rd.result || ''); check(); }; rd.readAsText(file, 'utf-8');
    });
    const close = function () { ov.remove(); };
    ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    ov.addEventListener('click', function (e) {
      const b = e.target.closest('[data-e]');
      if (!b) { if (e.target === ov) close(); return; }
      const a = b.getAttribute('data-e');
      if (a === 'close') close();
      else if (a === 'sample') download('圖資中心-範例.json', sampleJSON());
      else if (a === 'ok') {
        if (!parsed || !parsed.places.length) return;
        const m = mapById(f('map').value) || target;
        const have = {}; m.map.places.forEach(function (p) { have[(p.name + '|' + p.address).toLowerCase()] = 1; });
        const ids = {}; m.map.places.forEach(function (p) { ids[p.id] = 1; });
        let added = 0, dup = 0;
        parsed.places.forEach(function (p) {
          const k = (p.name + '|' + p.address).toLowerCase();
          if (have[k]) { dup++; return; }
          have[k] = 1;
          if (ids[p.id]) p.id = uid('p');
          m.map.places.push(p); added++;
        });
        const wantLocate = f('locate').checked;
        close();
        if (!added) { toast('沒有新的地點（' + dup + ' 筆已經在圖層裡）'); return; }
        save(m); S.lastMap = m.id;
        if (S.hidden[m.id]) { delete S.hidden[m.id]; lsSet('fmHidden', JSON.stringify(S.hidden)); }
        S.search = ''; S.tags = []; S.visit = 'all'; S.city = '';
        fitted = false; paint(); paintMarkers();
        toast('匯入 ' + added + ' 筆到「' + m.name + '」' + (dup ? '，略過 ' + dup + ' 筆重複' : ''));
        if (wantLocate) locateMissing([m]);
      }
    });
    setTimeout(function () { f('text').focus(); }, 0);
  }
  // 批次定位：一筆一筆問 /api/geocode（伺服器那邊每秒最多一次），邊做邊存，可以取消；離開頁面也會停
  function locateMissing(maps) {
    if (S.locating) { toast('已經在定位中'); return; }
    if (!global.Store || !Store.geocode) return;
    const items = missingOf(maps);
    if (!items.length) { toast('沒有需要定位的地點'); return; }
    const job = { cancel: false, done: 0, ok: 0, miss: 0, total: items.length };
    S.locating = job;
    const wrap = built.querySelector('.fm-map-wrap');
    const banner = el('div', 'fm-pick-banner fm-locate-banner');
    const say = function () { banner.innerHTML = ic('map-pin') + ' 定位中 ' + job.done + ' / ' + job.total + (job.miss ? '（' + job.miss + ' 筆找不到）' : '') + '　<button type="button" class="tt-btn" data-e="cancellocate">停止</button>'; };
    say(); wrap.appendChild(banner); paintHead();
    const touched = {};
    const finish = function () {
      S.locating = null; banner.remove();
      Object.keys(touched).forEach(function (id) { const m = mapById(id); if (m) save(m); });
      if (built) { fitted = false; paint(); paintMarkers(); }
      toast('定位完成：' + job.ok + ' 筆成功' + (job.miss ? '、' + job.miss + ' 筆找不到（可以編輯那筆在地圖上點位置）' : '') + (job.cancel ? '（已停止）' : ''));
    };
    const step = function (i) {
      if (job.cancel || i >= items.length || !built || !document.contains(built)) return finish();
      const it = items[i];
      Store.geocode(it.p.address || it.p.name).then(function (r) {
        job.done++;
        if (!r.error && r.results && r.results.length && it.p.lat === null) {
          it.p.lat = r.results[0].lat; it.p.lng = r.results[0].lng; job.ok++; touched[it.m.id] = 1;
          if (job.ok % 5 === 0) { save(it.m); delete touched[it.m.id]; if (built) { paintList(); paintMarkers(); } }
        } else job.miss++;
        say();
        step(i + 1);
      });
    };
    step(0);
  }

  // 新增／編輯圖層：名稱、類型（決定用詞）、圖示、顏色、說明。名稱改了走 onRename（筆記標題），其他寫進圍欄。
  function layerDialog(m) {
    closePop();
    if (!m && !O.onCreate) return;
    const isNew = !m;
    const cur = m ? m.map : { kind: 'food', icon: KINDS.food.icon, color: KINDS.food.color, desc: '' };
    let kind = cur.kind, icon = cur.icon, color = cur.color;
    const ov = el('div', 'modal-overlay tt-dialog-overlay fm-ov');
    ov.innerHTML = '<div class="modal tt-dialog fm-dialog-sm" role="dialog" aria-modal="true"><div class="modal-title">' + (isNew ? '新增圖層' : '編輯圖層') + '</div><div class="tt-dialog-body">' +
      '<div class="tt-ed-row"><span class="tt-ed-l">名稱</span><input class="tt-input" type="text" maxlength="100" placeholder="例如：美食地圖、步道地圖、咖啡廳" data-f="title" value="' + esc(m ? m.name : '') + '"></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">類型</span><div class="fm-kinds">' + KIND_ORDER.map(function (k) { return '<button type="button" class="fm-kind' + (k === kind ? ' on' : '') + '" data-kind="' + k + '">' + ic(KINDS[k].icon) + esc(KINDS[k].label) + '<small>' + esc(KINDS[k].one) + '</small></button>'; }).join('') + '</div></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">圖示</span><div class="fm-icons">' + LAYER_ICONS.map(function (i) { return '<button type="button" class="fm-icon-b' + (i === icon ? ' on' : '') + '" data-icon="' + i + '" title="' + i + '">' + ic(i) + '</button>'; }).join('') + '</div></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">顏色</span><div class="fm-colors-row">' + COLORS.map(function (c) { return '<button type="button" class="fm-color' + (c === color ? ' on' : '') + '" data-c="' + c + '" style="background:' + c + '"></button>'; }).join('') + '</div></div>' +
      '<div class="tt-ed-row tt-ed-notes"><span class="tt-ed-l">說明</span><textarea class="tt-input" rows="2" maxlength="500" placeholder="這個圖層放什麼（選填）" data-f="desc">' + esc(cur.desc || '') + '</textarea></div>' +
      '<div class="fm-layer-preview"><i class="fm-pin" style="--c:' + color + '">' + ic(icon) + '</i><span>針會長這樣</span></div>' +
      '</div><div class="modal-actions">' + (isNew || !O.onDelete ? '' : '<button class="btn tt-ed-del" type="button" data-e="del">移到垃圾桶</button>') + '<span class="tt-sp"></span><button class="btn" type="button" data-e="close">取消</button><button class="btn btn-primary" type="button" data-e="ok">' + (isNew ? '建立' : '儲存') + '</button></div></div>';
    document.body.appendChild(ov);
    const inp = ov.querySelector('[data-f="title"]');
    const preview = function () { const p = ov.querySelector('.fm-layer-preview .fm-pin'); p.style.setProperty('--c', color); p.innerHTML = ic(icon); };
    const close = function () { ov.remove(); };
    const ok = function () {
      const t = inp.value.trim();
      if (!t) { inp.focus(); toast('圖層要有名稱'); return; }
      const desc = ov.querySelector('[data-f="desc"]').value.trim();
      close();
      if (isNew) { O.onCreate({ title: t, kind: kind, icon: icon, color: color, desc: desc }); return; }
      const changed = kind !== m.map.kind || icon !== m.map.icon || color !== m.map.color || desc !== (m.map.desc || '');
      if (changed) { m.map.kind = kind; m.map.icon = icon; m.map.color = color; m.map.desc = desc; save(m); }
      if (t !== m.name && O.onRename) O.onRename(m.note, t);
      paint(); paintMarkers();
    };
    ov.addEventListener('click', function (e) {
      let b;
      if ((b = e.target.closest('[data-kind]'))) {
        const k = b.getAttribute('data-kind');
        // 換類型時，圖示／顏色還是那一型的預設就跟著換，使用者自己挑過的不動
        if (icon === KINDS[kind].icon) icon = KINDS[k].icon;
        if (color === KINDS[kind].color) color = KINDS[k].color;
        kind = k;
        ov.querySelectorAll('.fm-kind').forEach(function (x) { x.classList.toggle('on', x === b); });
        ov.querySelectorAll('.fm-icon-b').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-icon') === icon); });
        ov.querySelectorAll('.fm-color').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-c') === color); });
        preview(); return;
      }
      if ((b = e.target.closest('[data-icon]'))) { icon = b.getAttribute('data-icon'); ov.querySelectorAll('.fm-icon-b').forEach(function (x) { x.classList.toggle('on', x === b); }); preview(); return; }
      if ((b = e.target.closest('[data-c]'))) { color = b.getAttribute('data-c'); ov.querySelectorAll('.fm-color').forEach(function (x) { x.classList.toggle('on', x === b); }); preview(); return; }
      b = e.target.closest('[data-e]');
      if (!b) { if (e.target === ov) close(); return; }
      const a = b.getAttribute('data-e');
      if (a === 'close') close(); else if (a === 'ok') ok(); else if (a === 'del') { close(); O.onDelete(m.note); }
    });
    ov.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === inp) { e.preventDefault(); ok(); } if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    setTimeout(function () { inp.focus(); }, 0);
  }

  // ---------------- 新增／編輯地點（店家／步道，看圖層類型） ----------------
  function openEditor(place, m) {
    closePop();
    const maps = mapsOf().filter(function (x) { return !x.ro; });
    if (!maps.length) { toast('先新增一個圖層'); return; }
    m = m || mapById(S.lastMap) || maps[0];
    const w = m.kind;
    const isNew = !place;
    const base = place ? JSON.parse(JSON.stringify(place)) : { id: uid('p'), name: '', address: '', source: '', tags: S.tags.slice(), lat: null, lng: null, note: '', rating: 0, visited: false, images: [], added: Date.now() };
    const allTags = tagCounts().map(function (t) { return t.name; });
    const ov = el('div', 'modal-overlay tt-dialog-overlay fm-ov');
    ov.innerHTML = '<div class="modal tt-dialog fm-dialog" role="dialog" aria-modal="true">' +
      '<div class="tt-ed-head"><span class="fm-ed-kind" style="color:' + m.map.color + '" title="' + esc(m.name) + '">' + ic(m.map.icon) + '</span><input class="tt-ed-title" type="text" maxlength="200" placeholder="' + esc(w.name) + '" value="' + esc(base.name) + '" data-f="name"><button class="tt-tb" type="button" data-e="close" title="關閉">' + ic('x') + '</button></div>' +
      '<div class="tt-dialog-body">' +
      '<div class="tt-ed-row"><span class="tt-ed-l">' + ic('map-pin') + '</span><input class="tt-input" type="text" maxlength="300" placeholder="地址（填了按「查地址」就會定位）" data-f="address" value="' + esc(base.address) + '"><button class="tt-btn" type="button" data-e="geocode">查地址</button></div>' +
      '<div class="fm-geo-results" hidden></div>' +
      '<div class="tt-ed-row fm-coord-row"><span class="tt-ed-l"></span><span class="fm-coord" data-f="coord"></span><span class="tt-sp"></span><button class="tt-btn" type="button" data-e="pick">在地圖上點位置</button><button class="tt-btn" type="button" data-e="clearpos" title="拿掉座標">清除</button></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">縣市</span><input class="tt-input fm-city-in" type="text" maxlength="40" placeholder="縣市（填地址會自動帶出）" list="fm-city-list" data-f="city" value="' + esc(base.city || '') + '"></div>' +
      '<datalist id="fm-city-list">' + TW_CITIES.map(function (c) { return '<option value="' + c + '">'; }).join('') + '</datalist>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">' + ic('book-open') + '</span><input class="tt-input" type="text" maxlength="500" placeholder="資料來源（例如：朋友推薦、IG 帳號、文章網址）" data-f="source" value="' + esc(base.source) + '"></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">' + ic('globe') + '</span><input class="tt-input" type="url" maxlength="500" placeholder="Google 地圖連結（選填；完整網址裡的座標會自動帶出）" data-f="gmap" value="' + esc(base.gmap || '') + '"></div>' +
      '<div class="tt-ed-row fm-tags-row"><span class="tt-ed-l">' + ic('tag') + '</span><div class="fm-chips" data-f="tags"><input type="text" class="fm-chip-in" placeholder="標籤，Enter 或逗號分開" list="fm-tag-list" maxlength="40"></div></div>' +
      '<datalist id="fm-tag-list">' + allTags.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist>' +
      (allTags.length ? '<div class="tt-ed-row fm-tag-sugg"><span class="tt-ed-l"></span><div>' + allTags.slice(0, 16).map(function (t) { return '<button type="button" class="fm-tag fm-tag-b" ' + tagStyle(t) + ' data-sugg="' + esc(t) + '">' + esc(t) + '</button>'; }).join('') + '</div></div>' : '') +
      '<div class="tt-ed-row"><span class="tt-ed-l">' + ic('star') + '</span><div class="fm-rate" data-f="rating">' + [1, 2, 3, 4, 5].map(function (i) { return '<button type="button" class="fm-rate-b' + (i <= base.rating ? ' on' : '') + '" data-r="' + i + '" title="' + i + ' 星">★</button>'; }).join('') + '<button type="button" class="fm-rate-clr" data-r="0" title="不評分">清除</button></div>' +
      '<label class="tt-ed-check"><input type="checkbox" data-f="visited"' + (base.visited ? ' checked' : '') + '> 去過了</label></div>' +
      '<div class="tt-ed-row fm-imgs-row"><span class="tt-ed-l">' + ic('image') + '</span><div class="fm-ed-imgs" data-f="imgs">' + base.images.map(function (v) { return '<span class="fm-ed-img" data-img="' + esc(v) + '"><img src="' + esc(imgSrc(v)) + '" alt=""><button type="button" data-rmimg="' + esc(v) + '" title="移除">' + ic('x') + '</button></span>'; }).join('') + (O.onUpload ? '<button type="button" class="fm-ed-addimg" data-e="img" title="上傳圖片（也可以把圖片拖進來或直接貼上）">' + ic('plus') + ' 圖片</button><input type="file" accept="image/*" multiple hidden data-f="imgfile">' : '') + '</div></div>' +
      (maps.length > 1 ? '<div class="tt-ed-row"><span class="tt-ed-l">圖層</span><select class="tt-input" data-f="map">' + maps.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === m.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></div>' : '') +
      '<div class="tt-ed-row tt-ed-notes"><span class="tt-ed-l">' + ic('file-text') + '</span><textarea class="tt-input" rows="3" maxlength="2000" placeholder="備註：推薦什麼、營業時間、要不要訂位…" data-f="note">' + esc(base.note) + '</textarea></div>' +
      '</div><div class="modal-actions">' + (isNew ? '' : '<button class="btn tt-ed-del" type="button" data-e="del">刪除</button>') + '<span class="tt-sp"></span><button class="btn" type="button" data-e="close">取消</button><button class="btn btn-primary" type="button" data-e="save">' + (isNew ? '新增' : '儲存') + '</button></div></div>';
    document.body.appendChild(ov);
    const q = function (sel) { return ov.querySelector(sel); };
    const f = function (name) { return q('[data-f="' + name + '"]'); };
    let tags = base.tags.slice(), rating = base.rating, lat = base.lat, lng = base.lng, approx = false, images = base.images.slice();
    const imgsBox = f('imgs');
    const addImages = function (files) {
      files = Array.prototype.filter.call(files || [], function (x) { return /^image\//.test(x.type); });
      if (!files.length || !O.onUpload) return;
      const add = imgsBox.querySelector('[data-e="img"]');
      if (add) { add.disabled = true; add.textContent = '上傳中…'; }
      Promise.resolve(O.onUpload(files)).then(function (mds) {
        (mds || []).forEach(function (md) {
          const m = /\(img:([^)#]+)\)/.exec(md || '');
          if (!m || images.length >= 12) return;
          const v = 'img:' + m[1];
          if (images.indexOf(v) >= 0) return;
          images.push(v);
          const span = el('span', 'fm-ed-img', '<img src="' + esc(imgSrc(v)) + '" alt=""><button type="button" data-rmimg="' + esc(v) + '" title="移除">' + ic('x') + '</button>');
          span.setAttribute('data-img', v);
          imgsBox.insertBefore(span, add);
        });
      }).then(function () { if (add) { add.disabled = false; add.innerHTML = ic('plus') + ' 圖片'; } });
    };
    if (f('imgfile')) f('imgfile').addEventListener('change', function () { addImages(f('imgfile').files); f('imgfile').value = ''; });
    ov.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function (t) { return t === 'Files'; })) { e.preventDefault(); ov.classList.add('is-dragover'); } });
    ov.addEventListener('dragleave', function () { ov.classList.remove('is-dragover'); });
    ov.addEventListener('drop', function (e) { ov.classList.remove('is-dragover'); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); addImages(e.dataTransfer.files); } });
    ov.addEventListener('paste', function (e) { const fs = []; Array.prototype.forEach.call(e.clipboardData && e.clipboardData.items || [], function (it) { if (it.kind === 'file') { const fl = it.getAsFile(); if (fl) fs.push(fl); } }); if (fs.length) { e.preventDefault(); addImages(fs); } });
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
      if (!addr) { toast('先填地址或名稱'); f('address').focus(); return; }
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
        if (!f('city').value.trim()) f('city').value = cityFromAddress(f('address').value || h.displayName);
        if (!f('name').value.trim() && h.name) f('name').value = h.name;
        results.hidden = true; paintCoord(); return;
      }
      if ((b = t.closest('[data-rm]'))) { const u = b.getAttribute('data-rm'); tags = tags.filter(function (x) { return x !== u; }); paintChips(); return; }
      if ((b = t.closest('[data-rmimg]'))) { const u = b.getAttribute('data-rmimg'); images = images.filter(function (x) { return x !== u; }); const sp = b.closest('.fm-ed-img'); if (sp) sp.remove(); return; }
      if ((b = t.closest('[data-sugg]'))) { const u = b.getAttribute('data-sugg'); if (tags.some(function (x) { return x.toLowerCase() === u.toLowerCase(); })) tags = tags.filter(function (x) { return x.toLowerCase() !== u.toLowerCase(); }); else addTag(u); return; }
      if ((b = t.closest('[data-r]'))) { rating = +b.getAttribute('data-r'); ov.querySelectorAll('.fm-rate-b').forEach(function (x) { x.classList.toggle('on', +x.getAttribute('data-r') <= rating); }); return; }
      b = t.closest('[data-e]');
      if (!b) { if (t === ov) close(); return; }
      const a = b.getAttribute('data-e');
      if (a === 'close') close();
      else if (a === 'geocode') geocode();
      else if (a === 'img') { if (f('imgfile')) f('imgfile').click(); }
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
        if (global.App && App.confirm) App.confirm({ title: '刪除' + w.one, message: '刪除「' + (f('name').value.trim() || base.name) + '」？', ok: '刪除', danger: true }).then(go); else go(window.confirm('刪除？'));
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
    f('address').addEventListener('input', function () { if (!f('city').value.trim()) { const c = cityFromAddress(f('address').value); if (c) f('city').value = c; } });
    f('gmap').addEventListener('change', function () { if (lat === null) { const c = coordsFromUrl(f('gmap').value); if (c) { lat = c.lat; lng = c.lng; approx = false; paintCoord(); } } });
    if (f('map')) f('map').addEventListener('change', function () { const t = mapById(f('map').value); if (!t) return; f('name').placeholder = t.kind.name; const k = ov.querySelector('.fm-ed-kind'); k.style.color = t.map.color; k.title = t.name; k.innerHTML = ic(t.map.icon); });
    ov.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); if (!results.hidden) { results.hidden = true; return; } close(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSave(); }
    });
    const close = function () { if (S.picking) endPick(); ov.remove(); };
    const doSave = function () {
      const name = f('name').value.trim();
      if (!name) { f('name').focus(); toast(w.name + '要填'); return; }
      if (chipIn.value.trim()) { addTag(chipIn.value); chipIn.value = ''; }
      const target = f('map') ? mapById(f('map').value) || m : m;
      const p = cleanPlace({ id: base.id, name: name, address: f('address').value, city: f('city').value, source: f('source').value, gmap: f('gmap').value, tags: tags, lat: lat, lng: lng, note: f('note').value, rating: rating, visited: f('visited').checked, images: images, added: base.added }, {});
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
    closePop(); closeGallery();
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

  global.FoodMap = { isNote: isNote, generate: generate, parseImport: parseImport, cityFromAddress: cityFromAddress, KINDS: KINDS, DEFAULT_LAYERS: DEFAULT_LAYERS, parse: parse, serialize: serialize, payloadOf: payloadOf, wrap: wrap, blockHTML: blockHTML, render: render, teardown: teardown, closePop: closePop, reveal: reveal, state: S, COLORS: COLORS };
})(window);
