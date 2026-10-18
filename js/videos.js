/* videos.js — 個人區的影片庫（index.html #videos-page，app.js openVideos）。
 *
 * 一部影片 = 一篇 area:'novel'、meta.video 的筆記（跟小說同一個區、同一道密碼：server/api.js
 * 的 permFor()/novelUnlocked() 不認得「影片」這個字，只認 area，所以影片跟小說一樣在解鎖前
 * 連列表都不會送到瀏覽器、永遠不能分享、不會進首頁、不會進外面的關聯圖——app.js 的
 * graphNotes()/dashOpts().allNotes 本來就把 novel 整區排除）。標題是筆記的 title，其餘欄位
 * 是內文裡一個 ```video 圍欄的 JSON（跟看板／start.me／timetree 同一套「文字就是真相」）：
 *
 *   { url, code（編號）, actors: [..], lang, tags: [..], watches: ['YYYY-MM-DDTHH:MM', ..],
 *     notes, added: 'YYYY-MM-DD', preview: { title, description, image, site } }
 *
 * 觀看紀錄是手動的：卡片或對話框上按一次「+1 看過」就加一個當下的時間戳，每一筆都能刪。
 * 預覽（標題／縮圖／站名）走既有的 /api/link-preview（opts.onPreview），縮圖透過
 * /api/link-preview/image 代理（CSP 只准同源圖片）；YouTube／Google Drive 的連結在對話框裡
 * 直接用 MD.videoEmbed 嵌入播放器（CSP frame-src 只准這兩家）。
 *
 * 影片自己的關聯圖（影片—人物—標籤）用 graph.js 畫（Graph.open 的 opts.data 直接給節點與
 * 邊），統計頁純計算（人物／標籤／語言／每月觀看次數／最常看）。這兩個都只看影片，外面的
 * 關聯圖看不到這裡的任何東西。
 *
 *   Videos.render(container, opts) / refresh(opts) / open(noteId) / teardown()
 *   opts: { notes, onCreate({title, content}) → Promise<note>, onSave(note), onDelete(note),
 *           onPreview(url) → Promise<info|null>, proxy(url) → string }
 *   Videos.isNote(n), parse(text), generate(model), blockHTML(code)
 */
(function (global) {
  'use strict';

  const FENCE = /```video[^\n]*\n([\s\S]*?)\n```/;
  const LANGS = ['日文', '中文', '英文', '韓文', '無對白', '其他'];
  const SUBTITLES = ['無字幕', '繁中字幕', '簡中字幕', '英文字幕', '多語字幕', '自製字幕'];
  const LS_SORT = 'strikenote.vdSort';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ic(name) { return global.Icons ? Icons.svg(name) : ''; }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
  function safeUrl(u) {
    u = str(u, 2000).trim();
    if (!u) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    return /^https?:\/\//i.test(u) ? u : '';
  }
  function cleanList(a, max, each, strip) {
    const out = []; const seen = {};
    (Array.isArray(a) ? a : []).forEach(function (x) {
      let s = str(x, each).trim();
      if (strip) s = s.replace(/^#+/, '').trim();
      if (!s) return;
      const k = s.toLowerCase();
      if (seen[k]) return;
      seen[k] = true; out.push(s);
    });
    return out.slice(0, max);
  }
  const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function nowStamp() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function today() { return nowStamp().slice(0, 10); }
  function fmtStamp(s) { return s ? s.slice(0, 10).replace(/-/g, '/') + ' ' + s.slice(11) : ''; }
  function fmtDay(s) { return s ? s.slice(0, 10).replace(/-/g, '/') : ''; }

  function isNote(n) { return !!(n && n.meta && n.meta.video); }
  function payloadOf(text) { const m = FENCE.exec(String(text || '')); return m ? m[1] : ''; }
  function blank() { return { url: '', code: '', movieTitle: '', actors: [], lang: '', subtitle: '', tags: [], watches: [], notes: '', added: today(), preview: null }; }
  function parse(text) {
    let raw = null;
    try { raw = JSON.parse(payloadOf(text) || 'null'); } catch (e) { raw = null; }
    const m = blank();
    if (!raw || typeof raw !== 'object') return m;
    m.url = safeUrl(raw.url);
    m.code = str(raw.code, 60).trim();
    m.movieTitle = str(raw.movieTitle, 300).trim();
    m.actors = cleanList(raw.actors, 30, 60);
    m.lang = str(raw.lang, 30).trim();
    m.subtitle = str(raw.subtitle, 30).trim();
    m.tags = cleanList(raw.tags, 40, 40, true);
    m.watches = (Array.isArray(raw.watches) ? raw.watches : []).filter(function (s) { return typeof s === 'string' && STAMP.test(s); }).slice(0, 5000).sort();
    m.notes = str(raw.notes, 5000);
    m.added = /^\d{4}-\d{2}-\d{2}$/.test(raw.added || '') ? raw.added : today();
    if (raw.preview && typeof raw.preview === 'object') {
      const p = raw.preview;
      m.preview = { title: str(p.title, 200), description: str(p.description, 300), image: safeUrl(p.image), site: str(p.site, 80) };
      if (!m.preview.title && !m.preview.image && !m.preview.description) m.preview = null;
    }
    return m;
  }
  function generate(model) {
    const m = parse('```video\n' + JSON.stringify(model || {}) + '\n```');
    return '```video\n' + JSON.stringify(m, null, 2) + '\n```\n';
  }
  function modelOf(n) { return parse(n.content || ''); }

  // YouTube／Drive：嵌入用的 src（CSP 只准這兩家）；YouTube 沒抓到 og:image 時用它的縮圖網址
  function embedOf(url) { return global.MD && MD.videoEmbed ? MD.videoEmbed(url) : null; }
  function ytThumb(url) {
    const v = embedOf(url);
    if (!v || v.kind !== 'youtube') return '';
    const m = /v=([A-Za-z0-9_-]{11})/.exec(v.page);
    return m ? 'https://i.ytimg.com/vi/' + m[1] + '/hqdefault.jpg' : '';
  }
  function thumbOf(m) { return (m.preview && m.preview.image) || ytThumb(m.url) || ''; }
  function proxied(u) { return O && O.proxy ? O.proxy(u) : '/api/link-preview/image?url=' + encodeURIComponent(u); }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  // 網址最後一段長得像編號（/videos/nsps-994/、…/NSPS-994-uncensored）就取出來當編號：
  // 要整段都是編號（可帶 -xxx 後綴）才算，隨機的 slug（YouTube id 之類）不會誤判。
  function codeFromUrl(u) {
    try {
      const segs = new URL(u).pathname.split('/').filter(Boolean);
      for (let i = segs.length - 1; i >= 0 && i >= segs.length - 2; i--) {
        const m = /^([a-z]{2,6})-?(\d{2,5})(?:[-_][a-z0-9-]*)?$/i.exec(decodeURIComponent(segs[i]));
        if (m) return m[1].toUpperCase() + '-' + m[2];
      }
    } catch (e) { /* not a URL */ }
    return '';
  }

  // ---------------- 狀態 ----------------
  let O = null, host = null;
  let view = 'list';                   // list | graph | stats
  let query = '';
  let filter = { actor: null, tag: null, lang: null };
  let sort = (function () { try { return localStorage.getItem(LS_SORT) || 'added'; } catch (e) { return 'added'; } })();
  let modal = null;                    // { overlay, note, model, draft }
  let graphView = null;
  const saveTimers = new Map();        // note id -> timer
  let urlTimer = null;

  function notes() { return (O && O.notes) || []; }
  function byId(id) { return notes().find(function (n) { return n.id === id; }) || null; }
  function allActors() { const s = {}; notes().forEach(function (n) { modelOf(n).actors.forEach(function (a) { s[a] = 1; }); }); return Object.keys(s).sort(); }
  function allTags() { const s = {}; notes().forEach(function (n) { modelOf(n).tags.forEach(function (a) { s[a] = 1; }); }); return Object.keys(s).sort(); }
  function allLangs() { const s = {}; LANGS.forEach(function (l) { s[l] = 1; }); notes().forEach(function (n) { const l = modelOf(n).lang; if (l) s[l] = 1; }); return Object.keys(s); }

  function scheduleSave(note) {
    if (!O || !O.onSave) return;
    const old = saveTimers.get(note.id);
    if (old) clearTimeout(old);
    saveTimers.set(note.id, setTimeout(function () { saveTimers.delete(note.id); O.onSave(note); }, 600));
  }
  function flushSaves() {
    saveTimers.forEach(function (t, id) { clearTimeout(t); const n = byId(id); if (n && O && O.onSave) O.onSave(n); });
    saveTimers.clear();
  }
  function write(note, model, title) {
    note.content = generate(model);
    if (title !== undefined) note.title = String(title || '').trim() || model.code || model.url || '未命名影片';
  }

  // ---------------- 頁面 ----------------
  function render(container, opts) {
    O = opts || O;
    if (host && host !== container) teardownView();
    host = container;
    host.classList.add('vd-page');
    paint();
  }
  function refresh(opts) {
    if (opts) O = opts;
    if (!host || host.hidden) return;
    // 對話框開著就只重畫底下的清單（它改的是同一個 note 物件）；關聯圖／統計整頁重算
    paint();
  }
  function teardownView() {
    if (graphView) { graphView.close(); graphView = null; }
    if (host) host.innerHTML = '';
  }
  function teardown() {
    flushSaves();
    closeModal(false);
    teardownView();
    host = null;
  }

  function paint() {
    if (!host) return;
    if (graphView) { graphView.close(); graphView = null; }
    const list = notes();
    const total = list.reduce(function (s, n) { return s + modelOf(n).watches.length; }, 0);
    host.innerHTML = '';
    // 頁首跟區域頁的 .dash-head 同一個骨架：左邊標題＋數量，右邊 清單／關聯圖／統計 的分段按鈕＋新增
    const head = el('div', 'vd-head');
    head.innerHTML =
      '<div class="vd-head-main"><div class="boards-title">' + ic('film') + '<span>影片</span></div>' +
      '<div class="boards-sub">' + (list.length ? list.length + ' 部影片・共看過 ' + total + ' 次' : '還沒有影片') + '</div></div>' +
      '<div class="vd-head-right"><nav class="vd-tabs" aria-label="影片檢視">' +
      [['list', 'list', '清單'], ['graph', 'graph', '關聯圖'], ['stats', 'chart', '統計']].map(function (t) {
        return '<button class="vd-tab' + (view === t[0] ? ' is-active' : '') + '" type="button" data-view="' + t[0] + '" aria-pressed="' + (view === t[0]) + '">' + ic(t[1]) + '<span>' + t[2] + '</span></button>';
      }).join('') + '</nav>' +
      '<button class="btn btn-primary vd-add" type="button">' + ic('plus') + '<span>新增影片</span></button></div>';
    host.appendChild(head);
    const tabs = head.querySelector('.vd-tabs');
    const body = el('div', 'vd-body');
    host.appendChild(body);
    if (view === 'graph') paintGraph(body);
    else if (view === 'stats') paintStats(body);
    else paintList(body);

    head.querySelector('.vd-add').addEventListener('click', function () { openModal(null); });
    tabs.addEventListener('click', function (e) {
      const b = e.target.closest('[data-view]');
      if (b) setView(b.getAttribute('data-view'));
    });
  }
  function setView(v) { if (v === view) return; view = v; paint(); }
  function setFilter(kind, value) {
    filter = { actor: null, tag: null, lang: null };
    if (kind) filter[kind] = value;
    if (view !== 'list') view = 'list';
    paint();
  }

  function matches(n) {
    const m = modelOf(n);
    if (filter.actor && !m.actors.some(function (a) { return a.toLowerCase() === filter.actor.toLowerCase(); })) return false;
    if (filter.tag && !m.tags.some(function (a) { return a.toLowerCase() === filter.tag.toLowerCase(); })) return false;
    if (filter.lang && (m.lang || '').toLowerCase() !== filter.lang.toLowerCase()) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = [n.title, m.code, m.lang, m.notes, m.url, m.preview && m.preview.title].concat(m.actors, m.tags).join('\n').toLowerCase();
    return hay.indexOf(q) >= 0;
  }
  function lastWatch(m) { return m.watches.length ? m.watches[m.watches.length - 1] : ''; }
  function sorted(list) {
    const arr = list.slice();
    const cmp = {
      added: function (a, b) { return (b.m.added + (b.n.createdAt || 0)).localeCompare(a.m.added + (a.n.createdAt || 0)) || (b.n.createdAt || 0) - (a.n.createdAt || 0); },
      watched: function (a, b) { return lastWatch(b.m).localeCompare(lastWatch(a.m)); },
      count: function (a, b) { return b.m.watches.length - a.m.watches.length; },
      title: function (a, b) { return String(a.n.title || '').localeCompare(String(b.n.title || ''), 'zh-Hant'); }
    }[sort] || null;
    return arr.map(function (n) { return { n: n, m: modelOf(n) }; }).sort(cmp || function () { return 0; });
  }

  function paintList(body) {
    const tools = el('div', 'vd-tools');
    const fl = [];
    if (filter.actor) fl.push(['actor', '人物：' + filter.actor]);
    if (filter.tag) fl.push(['tag', '#' + filter.tag]);
    if (filter.lang) fl.push(['lang', '語言：' + filter.lang]);
    tools.innerHTML =
      '<div class="search-box vd-search"><input type="search" placeholder="搜尋標題、編號、人物、標籤…" value="' + esc(query) + '" aria-label="搜尋影片"></div>' +
      '<select class="vd-sort" aria-label="排序">' +
      [['added', '最近新增'], ['watched', '最近看過'], ['count', '看最多次'], ['title', '標題']].map(function (s) { return '<option value="' + s[0] + '"' + (sort === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') +
      '</select>' +
      fl.map(function (f) { return '<button class="vd-filter" type="button" data-clear="' + f[0] + '">' + esc(f[1]) + ic('x') + '</button>'; }).join('');
    if (notes().length) body.appendChild(tools);   // 一部影片都還沒有：搜尋與排序沒東西可搜，只留空狀態
    const grid = el('div', 'vd-grid');
    const rows = sorted(notes().filter(matches));
    if (!rows.length) {
      grid.appendChild(el('div', 'vd-empty', notes().length ? '沒有符合的影片。' : ic('film') + '<p>還沒有影片。貼上一個連結就會自動抓標題與縮圖。</p><button class="btn btn-primary vd-empty-add" type="button">' + ic('plus') + '<span>新增影片</span></button>'));
    }
    rows.forEach(function (r) { grid.appendChild(makeCard(r.n, r.m)); });
    body.appendChild(grid);
    const emptyAdd = grid.querySelector('.vd-empty-add');
    if (emptyAdd) emptyAdd.addEventListener('click', function () { openModal(null); });

    const input = tools.querySelector('input');
    input.addEventListener('input', function () { query = input.value; repaintGrid(grid); });
    tools.querySelector('.vd-sort').addEventListener('change', function (e) { sort = e.target.value; try { localStorage.setItem(LS_SORT, sort); } catch (x) { /* ignore */ } repaintGrid(grid); });
    tools.addEventListener('click', function (e) {
      const b = e.target.closest('[data-clear]');
      if (b) { filter[b.getAttribute('data-clear')] = null; paint(); }
    });
  }
  function repaintGrid(grid) {
    grid.innerHTML = '';
    const rows = sorted(notes().filter(matches));
    if (!rows.length) grid.appendChild(el('div', 'vd-empty', '沒有符合的影片。'));
    rows.forEach(function (r) { grid.appendChild(makeCard(r.n, r.m)); });
  }
  function thumbHTML(m, cls) {
    const t = thumbOf(m);
    return '<div class="' + cls + (t ? '' : ' is-empty') + '">' +
      (t ? '<img src="' + esc(proxied(t)) + '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'is-empty\');this.remove()">' : '') +
      '<span class="vd-thumb-ph">' + ic('film') + '</span></div>';
  }
  function makeCard(n, m) {
    const card = el('article', 'vd-card');
    card.setAttribute('data-id', n.id);
    card.tabIndex = 0;
    const lw = lastWatch(m);
    card.innerHTML =
      thumbHTML(m, 'vd-thumb') +
      (m.code ? '<span class="vd-code">' + esc(m.code) + '</span>' : '') +
      '<span class="vd-count" title="看過 ' + m.watches.length + ' 次">' + ic('eye') + m.watches.length + '</span>' +
      '<div class="vd-cbody">' +
      '<div class="vd-title" title="' + esc(n.title) + '">' + esc(n.title || '未命名影片') + '</div>' +
      (m.actors.length ? '<div class="vd-chips">' + m.actors.map(function (a) { return '<button class="vd-chip is-actor" type="button" data-actor="' + esc(a) + '">' + ic('user') + esc(a) + '</button>'; }).join('') + '</div>' : '') +
      (m.tags.length ? '<div class="vd-chips">' + m.tags.map(function (t) { return '<button class="vd-chip is-tag" type="button" data-tag="' + esc(t) + '">#' + esc(t) + '</button>'; }).join('') + '</div>' : '') +
      '<div class="vd-meta">' +
      (m.lang ? '<button class="vd-lang" type="button" data-lang="' + esc(m.lang) + '">' + esc(m.lang) + '</button>' : '') +
      '<span>' + (lw ? '最近看：' + fmtDay(lw) : '還沒看過') + '</span>' +
      '<span class="vd-meta-host">' + esc(hostOf(m.url)) + '</span>' +
      '</div></div>' +
      '<div class="vd-acts">' +
      '<button class="btn vd-watch" type="button" data-act="watch" title="看過一次就按一次">' + ic('plus') + '<span>看過</span></button>' +
      '<a class="icon-btn vd-open" href="' + esc(m.url || '#') + '" target="_blank" rel="noopener noreferrer" title="開啟連結"' + (m.url ? '' : ' hidden') + '>' + ic('external-link') + '</a>' +
      '<button class="icon-btn vd-more" type="button" data-act="more" title="更多">' + ic('more-horizontal') + '</button>' +
      '</div>';
    card.addEventListener('click', function (e) {
      let b;
      if ((b = e.target.closest('[data-actor]'))) { setFilter('actor', b.getAttribute('data-actor')); return; }
      if ((b = e.target.closest('[data-tag]'))) { setFilter('tag', b.getAttribute('data-tag')); return; }
      if ((b = e.target.closest('[data-lang]'))) { setFilter('lang', b.getAttribute('data-lang')); return; }
      if (e.target.closest('a')) return;
      if ((b = e.target.closest('[data-act]'))) {
        const act = b.getAttribute('data-act');
        if (act === 'watch') addWatch(n);
        else if (act === 'more') { const r = b.getBoundingClientRect(); cardMenu(n, r.left, r.bottom + 4); }
        return;
      }
      openModal(n);
    });
    card.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === card) openModal(n); });
    card.addEventListener('contextmenu', function (e) { e.preventDefault(); cardMenu(n, e.clientX, e.clientY); });
    return card;
  }
  function cardMenu(n, x, y) {
    menuAt(x, y, [['open', '查看／編輯'], ['watch', '+1 看過'], ['copy', '複製連結', !modelOf(n).url], null, ['del', '移到垃圾桶', false, true]], function (a) {
      if (a === 'open') openModal(n);
      else if (a === 'watch') addWatch(n);
      else if (a === 'copy') { const u = modelOf(n).url; if (u && navigator.clipboard) navigator.clipboard.writeText(u).then(function () { toast('已複製連結'); }); }
      else if (a === 'del' && O.onDelete) O.onDelete(n);
    });
  }
  function toast(msg) { if (global.App && App.toast) App.toast(msg); }
  // 對話框開著就改它手上那一份 model（它的 apply() 也是寫這一份）——各自 parse 一份的話，
  // 「+1 之後改標題」會把標題那邊的舊 model（watches 還是空的）寫回去，觀看紀錄就不見了。
  function liveModel(n) { return modal && modal.note === n ? modal.model : modelOf(n); }
  function addWatch(n) {
    const m = liveModel(n);
    m.watches.push(nowStamp());
    write(n, m);
    if (O.onSave) O.onSave(n);
    toast('已記一次：共看過 ' + m.watches.length + ' 次');
    if (view === 'list' && host) {
      const card = host.querySelector('.vd-card[data-id="' + n.id + '"]');
      if (card) card.replaceWith(makeCard(n, m));
    }
    if (modal && modal.note === n) paintWatches();
  }

  // ---------------- 選單（跟 xmind/timetree 的一樣：固定定位的 body 子元素） ----------------
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function menuAt(x, y, items, onPick) {
    closeMenu();
    menuEl = el('div', 'tt-menu vd-menu');
    menuEl.innerHTML = items.map(function (it) { return it ? '<button class="tt-menu-item' + (it[3] ? ' is-danger' : '') + '" type="button" data-a="' + it[0] + '"' + (it[2] ? ' disabled' : '') + '>' + esc(it[1]) + '</button>' : '<div class="tt-menu-sep"></div>'; }).join('');
    document.body.appendChild(menuEl);
    const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 4)) + 'px';
    menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 4)) + 'px';
    menuEl.addEventListener('click', function (e) { const b = e.target.closest('[data-a]'); if (!b || b.disabled) return; const a = b.getAttribute('data-a'); closeMenu(); onPick(a); });
  }
  document.addEventListener('mousedown', function (e) { if (menuEl && !e.target.closest('.vd-menu')) closeMenu(); }, true);

  // ---------------- 對話框：新增／查看／編輯一部影片 ----------------
  // 晶片輸入（人物、hashtag）：晶片區 + 一個「固定不換」的 input。第一版每次重畫都連 input 一起
  // 換掉，焦點一離開（blur）又重畫一次——Chrome 在移除有焦點的元素時發 blur，處理函式裡再改
  // innerHTML 就炸 NotFoundError，而且焦點跑掉：測試裡 hashtag 打完接著點備註，備註的字全進了
  // hashtag。現在只重畫晶片那一段，input 永遠是同一個元素。逗號也可能是用 IME／貼上進來的
  // （沒有 keydown），所以 input 事件裡看到分隔符就直接收成晶片。
  function chipInput(wrap, values, o) {
    const list = values.slice();
    const dl = o.suggest && o.suggest.length ? 'vd-dl-' + o.key : '';
    wrap.innerHTML = '<span class="vd-chip-list"></span>' +
      '<input class="vd-chip-in" type="text" placeholder="' + esc(o.placeholder || '') + '"' + (dl ? ' list="' + dl + '"' : '') + ' autocomplete="off">' +
      (dl ? '<datalist id="' + dl + '">' + o.suggest.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>' : '');
    const chips = wrap.querySelector('.vd-chip-list');
    const input = wrap.querySelector('.vd-chip-in');
    function paintChips() {
      chips.innerHTML = list.map(function (v, i) { return '<span class="vd-chip ' + (o.cls || '') + '">' + (o.prefix || '') + esc(v) + '<button type="button" class="vd-chip-x" data-i="' + i + '" title="移除">' + ic('x') + '</button></span>'; }).join('');
    }
    function add(text) {
      let changed = false;
      String(text || '').split(/[,，;；\n]/).forEach(function (s) {
        s = s.trim().replace(/^#+/, '').trim();
        if (!s) return;
        if (list.some(function (v) { return v.toLowerCase() === s.toLowerCase(); })) return;
        list.push(s); changed = true;
      });
      return changed;
    }
    function commit() {
      const changed = add(input.value);
      input.value = '';
      if (changed) { paintChips(); o.onChange(list.slice()); }
    }
    paintChips();
    wrap.addEventListener('click', function (e) {
      const x = e.target.closest('.vd-chip-x');
      if (x) { list.splice(Number(x.getAttribute('data-i')), 1); paintChips(); o.onChange(list.slice()); input.focus(); return; }
      if (e.target === wrap || e.target === chips) input.focus();
    });
    input.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'Enter' || e.key === ',' || e.key === '，' || (e.key === 'Tab' && input.value.trim())) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Backspace' && !input.value && list.length) {
        list.pop(); paintChips(); o.onChange(list.slice());
      }
    });
    input.addEventListener('input', function () {
      if (/[,，;；\n]/.test(input.value)) commit();
    });
    // datalist 選了一項也算（Chrome 對選取項發 change 不發 keydown）
    input.addEventListener('change', function () { if (input.value.trim()) commit(); });
    input.addEventListener('blur', function () { if (input.value.trim()) commit(); });
    return {
      get: function () { return list.slice(); },
      set: function (vals) {
        list.length = 0;
        (Array.isArray(vals) ? vals : []).forEach(function (v) {
          const s = String(v || '').trim();
          if (s && list.indexOf(s) < 0) list.push(s);
        });
        paintChips();
      }
    };
  }

  function openModal(note) {
    closeModal(true);
    const model = note ? modelOf(note) : blank();
    const isNew = !note;
    const ov = el('div', 'vd-overlay');
    ov.innerHTML =
      '<div class="vd-modal" role="dialog" aria-modal="true" aria-label="' + (isNew ? '新增影片' : '影片') + '">' +
      '<div class="vd-m-head">' + ic('film') +
      '<input class="vd-m-title" type="text" placeholder="標題（貼上網址會自動帶入）" value="' + esc(note ? note.title : '') + '" maxlength="300">' +
      '<button class="icon-btn vd-m-close" type="button" title="關閉 (Esc)">' + ic('x') + '</button></div>' +
      '<div class="vd-m-body">' +
      '<div class="vd-m-left"><div class="vd-player"></div>' +
      '<div class="vd-m-url-row"><label class="vd-m-l">' + ic('link') + '網址</label>' +
      '<input class="vd-m-url tt-input" type="url" placeholder="貼上影片連結…" value="' + esc(model.url) + '" autocomplete="off" spellcheck="false">' +
      '<button class="btn vd-m-fetch" type="button" title="重新抓一次標題與縮圖">' + ic('refresh-cw') + '<span>抓預覽</span></button></div>' +
      '<div class="vd-m-pv"></div>' +
      (isNew ? '' : '<div class="vd-watches"></div>') +
      '</div>' +
      '<div class="vd-m-right">' +
      '<label class="vd-f"><span class="vd-f-l">編號</span><input class="tt-input vd-m-code" type="text" value="' + esc(model.code) + '" placeholder="例如 ABC-123" maxlength="60" spellcheck="false"></label>' +
      '<label class="vd-f"><span class="vd-f-l">全名</span><input class="tt-input vd-m-movietitle" type="text" value="' + esc(model.movieTitle) + '" placeholder="影片完整標題…" maxlength="300" spellcheck="false"></label>' +
      '<div class="vd-f"><span class="vd-f-l">人物</span><div class="vd-chips vd-chips-in vd-m-actors"></div></div>' +
      '<label class="vd-f"><span class="vd-f-l">語言</span><input class="tt-input vd-m-lang" type="text" list="vd-dl-lang" value="' + esc(model.lang) + '" placeholder="日文／中文／英文…" maxlength="30"><datalist id="vd-dl-lang">' + allLangs().map(function (l) { return '<option value="' + esc(l) + '">'; }).join('') + '</datalist></label>' +
      '<label class="vd-f"><span class="vd-f-l">字幕</span><input class="tt-input vd-m-subtitle" type="text" list="vd-dl-subtitle" value="' + esc(model.subtitle) + '" placeholder="繁中字幕／無字幕…" maxlength="30"><datalist id="vd-dl-subtitle">' + SUBTITLES.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist></label>' +
      '<div class="vd-f"><span class="vd-f-l">hashtag</span><div class="vd-chips vd-chips-in vd-m-tags"></div></div>' +
      '<label class="vd-f"><span class="vd-f-l">備註</span><textarea class="tt-input vd-m-notes" rows="4" placeholder="想記的東西…" maxlength="5000">' + esc(model.notes) + '</textarea></label>' +
      '<div class="vd-f vd-f-added"><span class="vd-f-l">新增於</span><span>' + esc(fmtDay(model.added)) + (note && note.updatedAt ? '・最後修改 ' + new Date(note.updatedAt).toLocaleDateString('zh-TW') : '') + '</span></div>' +
      '</div></div>' +
      '<div class="vd-m-foot">' +
      (isNew ? '<span class="vd-m-hint">建立後隨時可以再改</span><span class="vd-m-sp"></span><button class="btn vd-m-cancel" type="button">取消</button><button class="btn btn-primary vd-m-create" type="button">建立</button>'
        : '<button class="btn btn-danger vd-m-del" type="button">' + ic('trash') + '<span>移到垃圾桶</span></button><span class="vd-m-status"></span><span class="vd-m-sp"></span><button class="btn vd-m-ok" type="button">關閉</button>') +
      '</div></div>';
    document.body.appendChild(ov);
    modal = { overlay: ov, note: note, model: model, isNew: isNew, fetching: false };
    const q = function (s) { return ov.querySelector(s); };

    function apply(fields) {
      Object.assign(model, fields || {});
      if (isNew) return;
      write(note, model, q('.vd-m-title').value);
      scheduleSave(note);
      status('儲存中…');
      syncCard();
    }
    function status(t) { const s = q('.vd-m-status'); if (s) s.textContent = t || ''; }
    function syncCard() {
      if (!host || view !== 'list' || !note) return;
      const card = host.querySelector('.vd-card[data-id="' + note.id + '"]');
      if (card) card.replaceWith(makeCard(note, model));
    }
    q('.vd-m-title').addEventListener('input', function () { apply(); });
    q('.vd-m-code').addEventListener('input', function (e) { apply({ code: e.target.value.trim() }); });
    q('.vd-m-movietitle').addEventListener('input', function (e) { apply({ movieTitle: e.target.value }); });
    q('.vd-m-lang').addEventListener('input', function (e) { apply({ lang: e.target.value.trim() }); });
    q('.vd-m-lang').addEventListener('change', function (e) { apply({ lang: e.target.value.trim() }); });
    q('.vd-m-subtitle').addEventListener('input', function (e) { apply({ subtitle: e.target.value.trim() }); });
    q('.vd-m-subtitle').addEventListener('change', function (e) { apply({ subtitle: e.target.value.trim() }); });
    q('.vd-m-notes').addEventListener('input', function (e) { apply({ notes: e.target.value }); });
    const actorsChip = chipInput(q('.vd-m-actors'), model.actors, { key: 'actors', cls: 'is-actor', placeholder: '人物，Enter 加一個（可多個）', suggest: allActors(), onChange: function (v) { apply({ actors: v }); } });
    chipInput(q('.vd-m-tags'), model.tags, { key: 'tags', cls: 'is-tag', prefix: '#', placeholder: '#hashtag，Enter 加一個', suggest: allTags(), onChange: function (v) { apply({ tags: v }); } });

    // 網址：貼上／輸入後自動抓預覽（600 ms 沒再動才抓）；按「抓預覽」強制重抓
    const urlIn = q('.vd-m-url');
    urlIn.addEventListener('input', function () {
      const u = safeUrl(urlIn.value);
      apply({ url: u, preview: u === model.url ? model.preview : null });
      paintPlayer();
      if (urlTimer) clearTimeout(urlTimer);
      if (u) urlTimer = setTimeout(function () { fetchPreview(false); }, 600);
    });
    urlIn.addEventListener('paste', function () { setTimeout(function () { urlIn.dispatchEvent(new Event('input', { bubbles: true })); }, 0); });
    q('.vd-m-fetch').addEventListener('click', function () { fetchPreview(true); });
    function fetchPreview(force) {
      const u = safeUrl(urlIn.value);
      if (!u || !O.onPreview) return;
      if (!force && model.preview && model.url === u) { paintPreview(); return; }
      modal.fetching = true; paintPreview();
      O.onPreview(u).then(function (info) {
        if (!modal || modal.overlay !== ov) return;
        modal.fetching = false;
        if (urlIn.value.trim() !== u && safeUrl(urlIn.value) !== u) return;   // 已經改成別的網址了
        const failed = !info || info.error;
        const pv = failed ? null : { title: str(info.title, 200), description: str(info.description, 300), image: safeUrl(info.image), site: str(info.siteName, 80) };
        if (pv && !pv.image) pv.image = ytThumb(u);
        const t = q('.vd-m-title');
        if (pv && pv.title && !t.value.trim()) t.value = pv.title;
        // 編號從網址補：欄位還空著就填；標題也還空著（預覽抓不到）就先用編號當標題
        // 伺服器查到的編號（外部資料庫 的正規寫法）優先，沒有才從網址切
        const code = (!failed && str(info.code, 60).trim()) || codeFromUrl(u);
        const codeIn = q('.vd-m-code');
        const fill = {};
        if (code && !codeIn.value.trim()) { codeIn.value = code; fill.code = code; }
        if (code && !t.value.trim()) t.value = code;
        // 全名：伺服器從 外部資料庫 查到的 movieTitle 優先，沒有才用頁面標題（欄位還空著才填）
        const movieTitleIn = q('.vd-m-movietitle');
        const mt = !failed ? str(info.movieTitle || info.title, 300).trim() : '';
        if (mt && !movieTitleIn.value.trim()) { movieTitleIn.value = mt; fill.movieTitle = mt; }
        // 人物從 JSON-LD 補（晶片還空著才填）
        if (!failed && info.actors && info.actors.length && !actorsChip.get().length) {
          actorsChip.set(info.actors.slice(0, 10));
          fill.actors = actorsChip.get();
        }
        apply(Object.assign({ url: u, preview: pv && (pv.title || pv.image || pv.description) ? pv : null }, fill));
        // 抓失敗就靜默，編號已從網址自動補齊；不把伺服器錯誤顯示在輸入框附近
        modal.pvError = failed || (pv && !(pv.title || pv.image || pv.description));
        paintPreview(); paintPlayer();
      });
    }
    function paintPreview() {
      const box = q('.vd-m-pv');
      if (modal.fetching) { box.innerHTML = '<span class="vd-pv-wait">抓預覽中…</span>'; return; }
      const p = model.preview;
      if (!p) { box.innerHTML = model.url ? '<span class="vd-pv-none">沒有預覽</span>' : ''; return; }
      box.innerHTML =
        (p.title ? '<div class="vd-pv-t">' + esc(p.title) + '</div>' : '') +
        (p.description ? '<div class="vd-pv-d">' + esc(p.description) + '</div>' : '') +
        '<div class="vd-pv-s">' + esc(p.site || hostOf(model.url)) + '</div>';
    }
    function paintPlayer() {
      const box = q('.vd-player');
      const v = embedOf(model.url);
      if (v) {
        box.innerHTML = '<div class="vd-player-frame"><iframe src="' + esc(v.src) + '" title="影片" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" loading="lazy"></iframe></div>';
        return;
      }
      box.innerHTML = thumbHTML(model, 'vd-player-thumb') +
        (model.url ? '<a class="btn btn-primary vd-player-open" href="' + esc(model.url) + '" target="_blank" rel="noopener noreferrer">' + ic('external-link') + '<span>開啟連結</span></a>' : '');
    }
    paintPlayer(); paintPreview();
    if (!isNew) paintWatches();

    if (isNew) {
      q('.vd-m-cancel').addEventListener('click', function () { closeModal(true); });
      q('.vd-m-create').addEventListener('click', function () {
        const title = q('.vd-m-title').value.trim() || (model.preview && model.preview.title) || model.code || hostOf(model.url) || '未命名影片';
        if (!model.url && !title) return;
        const btn = q('.vd-m-create'); btn.disabled = true;
        O.onCreate({ title: title, content: generate(model) }).then(function (n) {
          closeModal(true);
          if (n) { paint(); openModal(byId(n.id) || n); }
        }, function () { btn.disabled = false; });
      });
      setTimeout(function () { urlIn.focus(); }, 30);
    } else {
      q('.vd-m-ok').addEventListener('click', function () { closeModal(true); });
      q('.vd-m-del').addEventListener('click', function () { const n = note; closeModal(true); if (O.onDelete) O.onDelete(n); });
      setTimeout(function () { q('.vd-m-title').focus(); }, 30);
    }
    q('.vd-m-close').addEventListener('click', function () { closeModal(true); });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModal(true); });
    document.addEventListener('keydown', onModalKey, true);
  }
  function onModalKey(e) {
    if (e.key !== 'Escape' || !modal) return;
    if (menuEl) return;
    e.preventDefault(); e.stopPropagation();
    closeModal(true);
  }
  function paintWatches() {
    if (!modal || modal.isNew) return;
    const box = modal.overlay.querySelector('.vd-watches');
    if (!box) return;
    const m = modal.model;
    const list = m.watches.slice().reverse();
    box.innerHTML =
      '<div class="vd-w-head"><span class="vd-w-t">' + ic('eye') + '觀看紀錄</span><span class="vd-w-n">共 ' + m.watches.length + ' 次' + (list.length ? '・最近 ' + fmtStamp(list[0]) : '') + '</span>' +
      '<button class="btn btn-primary vd-w-add" type="button">' + ic('plus') + '<span>看過一次</span></button></div>' +
      (list.length ? '<ul class="vd-w-list">' + list.map(function (s, i) { return '<li><span>' + esc(fmtStamp(s)) + '</span><button type="button" class="icon-btn vd-w-x" data-i="' + (m.watches.length - 1 - i) + '" title="刪除這一筆">' + ic('x') + '</button></li>'; }).join('') + '</ul>' : '<div class="vd-w-empty">還沒看過。看完就按一下「看過一次」。</div>');
    box.querySelector('.vd-w-add').addEventListener('click', function () { addWatch(modal.note); });
    box.addEventListener('click', function (e) {
      const x = e.target.closest('.vd-w-x');
      if (!x) return;
      const mm = modal.model;
      mm.watches.splice(Number(x.getAttribute('data-i')), 1);
      write(modal.note, mm);
      if (O.onSave) O.onSave(modal.note);
      paintWatches();
      const card = host && host.querySelector('.vd-card[data-id="' + modal.note.id + '"]');
      if (card) card.replaceWith(makeCard(modal.note, mm));
    });
  }
  function closeModal(flush) {
    if (!modal) return;
    const m = modal; modal = null;
    document.removeEventListener('keydown', onModalKey, true);
    if (urlTimer) { clearTimeout(urlTimer); urlTimer = null; }
    m.overlay.remove();
    if (flush && m.note && saveTimers.has(m.note.id)) { clearTimeout(saveTimers.get(m.note.id)); saveTimers.delete(m.note.id); if (O && O.onSave) O.onSave(m.note); }
  }
  function open(id) { const n = byId(id); if (n) openModal(n); }
  function saved(note) {
    // app.js 存檔回來：對話框開著就把狀態列改成「已儲存」
    if (modal && modal.note && modal.note.id === note.id) { const s = modal.overlay.querySelector('.vd-m-status'); if (s) s.textContent = '已儲存'; }
  }

  // ---------------- 關聯圖：影片—人物—標籤 ----------------
  function buildGraph(list) {
    const nodes = [], byIdx = {}, edges = [], seen = {};
    function node(id, kind, label, note) { if (!byIdx[id]) { byIdx[id] = { id: id, kind: kind, label: label, note: note || null, deg: 0 }; nodes.push(byIdx[id]); } return byIdx[id]; }
    function edge(a, b, kind) { const k = a + '|' + b; if (seen[k]) return; seen[k] = true; edges.push({ a: a, b: b, kind: kind }); byIdx[a].deg++; byIdx[b].deg++; }
    list.forEach(function (n) {
      const m = modelOf(n);
      const v = node('v:' + n.id, 'video', n.title || '未命名影片', n);
      v.watches = m.watches.length;
      m.actors.forEach(function (a) { node('a:' + a.toLowerCase(), 'actor', a); edge(v.id, 'a:' + a.toLowerCase(), 'actor'); });
      m.tags.forEach(function (t) { node('t:' + t.toLowerCase(), 'tag', '#' + t); edge(v.id, 't:' + t.toLowerCase(), 'tag'); });
    });
    return { nodes: nodes, edges: edges };
  }
  function paintGraph(body) {
    const box = el('div', 'vd-graph');
    body.appendChild(box);
    if (!global.Graph) { box.textContent = '關聯圖模組沒有載入'; return; }
    graphView = Graph.open(null, {
      container: box,
      data: buildGraph(notes()),
      title: '影片關聯圖',
      hint: '點一下看關聯・雙擊開影片或依人物／hashtag 篩選・拖曳、滾輪縮放',
      legend: [['is-video', '影片'], ['is-actor', '人物'], ['is-tag', 'hashtag']],
      emptyText: '還沒有影片，或影片都還沒填人物與 hashtag。',
      closeLabel: '回清單',
      showLabels: true,
      onOpenNode: function (n) {
        if (n.kind === 'video') { view = 'list'; paint(); openModal(byId(n.note.id) || n.note); }
        else if (n.kind === 'actor') setFilter('actor', n.label);
        else if (n.kind === 'tag') setFilter('tag', n.label.replace(/^#/, ''));
      },
      onClose: function () { setView('list'); }
    });
  }

  // ---------------- 統計 ----------------
  function stats(list) {
    const actors = {}, tags = {}, langs = {}, months = {};
    let total = 0;
    const events = [];
    const now = new Date();
    const mkeys = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); const k = d.getFullYear() + '-' + pad(d.getMonth() + 1); mkeys.push(k); months[k] = 0; }
    const rows = list.map(function (n) {
      const m = modelOf(n);
      total += m.watches.length;
      m.actors.forEach(function (a) { const k = a.toLowerCase(); actors[k] = actors[k] || { name: a, videos: 0, watches: 0 }; actors[k].videos++; actors[k].watches += m.watches.length; });
      m.tags.forEach(function (t) { const k = t.toLowerCase(); tags[k] = tags[k] || { name: t, videos: 0, watches: 0 }; tags[k].videos++; tags[k].watches += m.watches.length; });
      const l = m.lang || '未填';
      langs[l] = langs[l] || { name: l, videos: 0, watches: 0 }; langs[l].videos++; langs[l].watches += m.watches.length;
      m.watches.forEach(function (s) { const k = s.slice(0, 7); if (months[k] !== undefined) months[k]++; events.push({ s: s, n: n }); });
      return { n: n, m: m };
    });
    const thisMonth = months[mkeys[mkeys.length - 1]] || 0;
    const sortBy = function (obj, key) { return Object.keys(obj).map(function (k) { return obj[k]; }).sort(function (a, b) { return b[key] - a[key] || a.name.localeCompare(b.name); }); };
    events.sort(function (a, b) { return b.s.localeCompare(a.s); });
    return {
      videos: list.length, total: total, thisMonth: thisMonth,
      actorCount: Object.keys(actors).length, tagCount: Object.keys(tags).length,
      unwatched: rows.filter(function (r) { return !r.m.watches.length; }).length,
      topVideos: rows.filter(function (r) { return r.m.watches.length; }).sort(function (a, b) { return b.m.watches.length - a.m.watches.length; }).slice(0, 10),
      actorsByVideos: sortBy(actors, 'videos').slice(0, 10), actorsByWatches: sortBy(actors, 'watches').filter(function (a) { return a.watches; }).slice(0, 10),
      tagsByVideos: sortBy(tags, 'videos').slice(0, 10), langs: sortBy(langs, 'videos'),
      months: mkeys.map(function (k) { return { key: k, label: String(Number(k.slice(5))) + '月', n: months[k] }; }),
      recent: events.slice(0, 12),
      added: rows.slice().sort(function (a, b) { return (b.n.createdAt || 0) - (a.n.createdAt || 0); }).slice(0, 6)
    };
  }
  function barList(title, rows, valueOf, labelOf, attr, unit) {
    const max = rows.reduce(function (s, r) { return Math.max(s, valueOf(r)); }, 0) || 1;
    return '<section class="vd-st-sec"><h3>' + esc(title) + '</h3>' +
      (rows.length ? '<ol class="vd-bars">' + rows.map(function (r) {
        const v = valueOf(r), a = attr(r);
        return '<li class="vd-bar-row"' + (a ? ' ' + a : '') + ' title="' + esc(labelOf(r)) + '：' + v + ' ' + unit + '">' +
          '<span class="vd-bar-l">' + esc(labelOf(r)) + '</span>' +
          '<span class="vd-bar"><i style="width:' + Math.round(v / max * 100) + '%"></i></span>' +
          '<span class="vd-bar-v">' + v + '</span></li>';
      }).join('') + '</ol>' : '<div class="vd-st-none">沒有資料</div>') + '</section>';
  }
  function paintStats(body) {
    const s = stats(notes());
    const wrap = el('div', 'vd-stats');
    const maxM = s.months.reduce(function (a, b) { return Math.max(a, b.n); }, 0) || 1;
    wrap.innerHTML =
      '<div class="vd-tiles">' +
      [['影片', s.videos, '部'], ['總觀看', s.total, '次'], ['本月觀看', s.thisMonth, '次'], ['人物', s.actorCount, '位'], ['hashtag', s.tagCount, '個'], ['還沒看的', s.unwatched, '部']].map(function (t) {
        return '<div class="vd-tile"><span class="vd-tile-l">' + t[0] + '</span><span class="vd-tile-v">' + t[1] + '<small>' + t[2] + '</small></span></div>';
      }).join('') + '</div>' +
      '<section class="vd-st-sec vd-st-wide"><h3>每月觀看次數（近 12 個月）</h3>' +
      '<div class="vd-cols">' + s.months.map(function (m) {
        return '<div class="vd-col" title="' + m.key + '：' + m.n + ' 次"><span class="vd-col-v">' + (m.n || '') + '</span><i style="height:' + Math.round(m.n / maxM * 100) + '%"></i><span class="vd-col-l">' + m.label + '</span></div>';
      }).join('') + '</div></section>' +
      '<div class="vd-st-grid">' +
      barList('最常看的影片', s.topVideos, function (r) { return r.m.watches.length; }, function (r) { return r.n.title; }, function (r) { return 'data-id="' + esc(r.n.id) + '"'; }, '次') +
      barList('人物：影片數', s.actorsByVideos, function (r) { return r.videos; }, function (r) { return r.name; }, function (r) { return 'data-actor="' + esc(r.name) + '"'; }, '部') +
      barList('人物：觀看次數', s.actorsByWatches, function (r) { return r.watches; }, function (r) { return r.name; }, function (r) { return 'data-actor="' + esc(r.name) + '"'; }, '次') +
      barList('hashtag', s.tagsByVideos, function (r) { return r.videos; }, function (r) { return '#' + r.name; }, function (r) { return 'data-tag="' + esc(r.name) + '"'; }, '部') +
      barList('語言', s.langs, function (r) { return r.videos; }, function (r) { return r.name; }, function (r) { return r.name === '未填' ? '' : 'data-lang="' + esc(r.name) + '"'; }, '部') +
      '<section class="vd-st-sec"><h3>最近觀看</h3>' + (s.recent.length ? '<ul class="vd-recent">' + s.recent.map(function (e) { return '<li data-id="' + esc(e.n.id) + '"><span class="vd-recent-t">' + esc(fmtStamp(e.s)) + '</span><span class="vd-recent-n">' + esc(e.n.title) + '</span></li>'; }).join('') + '</ul>' : '<div class="vd-st-none">還沒有觀看紀錄</div>') + '</section>' +
      '</div>';
    body.appendChild(wrap);
    wrap.addEventListener('click', function (e) {
      let b;
      if ((b = e.target.closest('[data-actor]'))) { setFilter('actor', b.getAttribute('data-actor')); return; }
      if ((b = e.target.closest('[data-tag]'))) { setFilter('tag', b.getAttribute('data-tag')); return; }
      if ((b = e.target.closest('[data-lang]'))) { setFilter('lang', b.getAttribute('data-lang')); return; }
      if ((b = e.target.closest('[data-id]'))) { const n = byId(b.getAttribute('data-id')); if (n) openModal(n); }
    });
  }

  // ---------------- 靜態：```video 圍欄在預覽／版本歷史裡的樣子 ----------------
  function blockHTML(code) {
    const m = parse('```video\n' + code + '\n```');
    return '<div class="vds-card">' +
      '<div class="vds-row">' + (m.code ? '<span class="vds-code">' + esc(m.code) + '</span>' : '') + (m.lang ? '<span class="vds-lang">' + esc(m.lang) + '</span>' : '') + '<span class="vds-n">看過 ' + m.watches.length + ' 次</span></div>' +
      (m.url ? '<div class="vds-url"><a href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer">' + esc(m.url) + '</a></div>' : '') +
      (m.actors.length ? '<div class="vds-row">人物：' + m.actors.map(esc).join('、') + '</div>' : '') +
      (m.tags.length ? '<div class="vds-row">' + m.tags.map(function (t) { return '<span class="vds-tag">#' + esc(t) + '</span>'; }).join(' ') + '</div>' : '') +
      (m.notes ? '<div class="vds-notes">' + esc(m.notes) + '</div>' : '') +
      '</div>';
  }

  global.Videos = {
    render: render, refresh: refresh, open: open, teardown: teardown, saved: saved,
    isNote: isNote, parse: parse, generate: generate, blockHTML: blockHTML, stats: stats, buildGraph: buildGraph,
    isOpen: function () { return !!modal; }
  };
})(window);
