/* videos.js — 個人區的影片庫（index.html #videos-page，app.js openVideos）。
 *
 * 一部影片 = 一篇 area:'novel'、meta.video 的筆記（跟小說同一個區、同一道密碼：server/api.js
 * 的 permFor()/novelUnlocked() 不認得「影片」這個字，只認 area，所以影片跟小說一樣在解鎖前
 * 連列表都不會送到瀏覽器、永遠不能分享、不會進首頁、不會進外面的關聯圖——app.js 的
 * graphNotes()/dashOpts().allNotes 本來就把 novel 整區排除）。標題是筆記的 title，其餘欄位
 * 是內文裡一個 ```video 圍欄的 JSON（跟看板／start.me／timetree 同一套「文字就是真相」）：
 *
 *   { url, code（編號）, movieTitle（全名）, actors: [..], avatars: { 人物名: 大頭照網址 }, lang, subtitle,
 *     tags: [..], watches: ['YYYY-MM-DDTHH:MM', ..], notes, added: 'YYYY-MM-DD',
 *     preview: { title, description, image, site } }
 *
 * 人物的大頭照存在影片裡（avatars，預覽抓回來時伺服器一起給的），人物誌／關聯圖把所有影片的
 * avatars 合起來看；還沒有照片的人物由 ensureAvatars() 逐一用名字問伺服器（opts.onPerson），
 * 找到就寫進那個人第一部影片的 avatars 並存檔——所以人物誌是「有出現的人物自動出現」，不用
 * 另外維護一份名單。查到的名字跟存的不一樣但確定是同一人（伺服器 matched）就整庫改名，這是
 * 「日文名全部改成繁體中文」的最後一道。
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
  const LS_MODE = 'strikenote.vdMode';   // 清單的顯示方式：cards | table

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
  // 觀察區的一個連結也是 meta.video 的筆記（所以小說頁、樹、關聯圖一樣看不到它），多一個 meta.watch；
  // 內文是一個 ```watch 圍欄：{ url, note, added }。刪除走影片同一條硬刪路線，不留痕跡。
  function isWatch(n) { return !!(n && n.meta && n.meta.watch); }
  const WATCH_FENCE = /```watch[^\n]*\n([\s\S]*?)\n```/;
  function parseWatch(text) {
    let raw = null;
    try { const m = WATCH_FENCE.exec(String(text || '')); raw = m ? JSON.parse(m[1]) : null; } catch (e) { raw = null; }
    raw = raw && typeof raw === 'object' ? raw : {};
    return { url: safeUrl(raw.url), note: str(raw.note, 500), added: /^\d{4}-\d{2}-\d{2}$/.test(raw.added || '') ? raw.added : today() };
  }
  function generateWatch(w) { return '```watch\n' + JSON.stringify(parseWatch('```watch\n' + JSON.stringify(w || {}) + '\n```'), null, 2) + '\n```\n'; }
  function payloadOf(text) { const m = FENCE.exec(String(text || '')); return m ? m[1] : ''; }
  function blank() { return { url: '', code: '', movieTitle: '', actors: [], avatars: {}, avatarIds: {}, verified: {}, lang: '', subtitle: '', tags: [], watches: [], notes: '', added: today(), preview: null }; }
  // 人物名 → 值 的對照表：只留「這部影片的人物」的鍵（比對不分大小寫），值由 ok() 檢查
  function cleanMap(raw, actors, ok) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).slice(0, 60).forEach(function (k) {
      const name = actors.find(function (a) { return a.toLowerCase() === String(k).trim().toLowerCase(); });
      const v = ok(raw[k]);
      if (name && v && !out[name]) out[name] = v;
    });
    return out;
  }
  const ID_RE = /^[\w.-]{1,80}$/;
  function safeId(v) { return typeof v === 'string' && ID_RE.test(v) ? v : ''; }
  // 圖片來源：存進系統了（img id）就從 /api/images 拿，沒有才透過代理去抓外部網址
  function srcOf(url, id) { return id ? '/api/images/' + encodeURIComponent(id) : (url ? proxied(url) : ''); }
  function parse(text) {
    let raw = null;
    try { raw = JSON.parse(payloadOf(text) || 'null'); } catch (e) { raw = null; }
    const m = blank();
    if (!raw || typeof raw !== 'object') return m;
    m.url = safeUrl(raw.url);
    m.code = str(raw.code, 60).trim();
    m.movieTitle = str(raw.movieTitle, 300).trim();
    m.actors = cleanList(raw.actors, 30, 60);
    m.avatars = cleanMap(raw.avatars, m.actors, safeUrl);
    m.avatarIds = cleanMap(raw.avatarIds, m.actors, safeId);           // 存進系統的大頭照（img id）
    m.verified = cleanMap(raw.verified, m.actors, function (v) { return v ? 1 : 0; });   // 查過資料庫、確定收的人物
    m.lang = str(raw.lang, 30).trim();
    m.subtitle = str(raw.subtitle, 30).trim();
    m.tags = cleanList(raw.tags, 40, 40, true);
    m.watches = (Array.isArray(raw.watches) ? raw.watches : []).filter(function (s) { return typeof s === 'string' && STAMP.test(s); }).slice(0, 5000).sort();
    m.notes = str(raw.notes, 5000);
    m.added = /^\d{4}-\d{2}-\d{2}$/.test(raw.added || '') ? raw.added : today();
    if (raw.preview && typeof raw.preview === 'object') {
      const p = raw.preview;
      m.preview = { title: str(p.title, 200), description: str(p.description, 300), image: safeUrl(p.image), imageId: safeId(p.imageId), site: str(p.site, 80) };
      if (!m.preview.image) m.preview.imageId = '';
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
  function thumbSrc(m) { return srcOf(thumbOf(m), m.preview && m.preview.image ? m.preview.imageId : ''); }
  function proxied(u) { return O && O.proxy ? O.proxy(u) : '/api/link-preview/image?url=' + encodeURIComponent(u) + '&nocache=1'; }
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
  let view = 'list';                   // list | watch | people | graph | stats
  let watchQuery = '';
  let query = '';
  let peopleQuery = '';
  let filter = { actor: null, tag: null, lang: null, subtitle: null };
  let sort = (function () { try { return localStorage.getItem(LS_SORT) || 'added'; } catch (e) { return 'added'; } })();
  let listMode = (function () { try { return localStorage.getItem(LS_MODE) === 'table' ? 'table' : 'cards'; } catch (e) { return 'cards'; } })();
  let pendingPaint = false;            // 表格有格子在打字時延後的整頁重畫
  let modal = null;                    // { overlay, note, model, draft }
  let graphView = null;
  const saveTimers = new Map();        // note id -> timer
  let urlTimer = null;

  // 「無痕開啟」：網頁本身開不了無痕視窗（瀏覽器不給任何 API），所以交給這台電腦上註冊的
  // capynote-incognito: 協定（tools/incognito/install.cmd 註冊，open-incognito.ps1 處理），它用
  // chrome --incognito <url> 開——Chrome 這個參數本來就是「已有無痕視窗就在裡面開新分頁，沒有
  // 才開新視窗」。設定存 localStorage：只對裝了腳本的這台電腦有意義，沒裝的話開關關著行為照舊。
  const LS_INCOG = 'strikenote.vdIncognito';
  function incognitoOn() { try { return localStorage.getItem(LS_INCOG) === '1'; } catch (e) { return false; } }
  function setIncognito(on) { try { localStorage.setItem(LS_INCOG, on ? '1' : '0'); } catch (e) { /* ignore */ } }
  function openIncognito(url) {
    if (!/^https?:\/\//i.test(url || '')) return false;
    // 導到自訂協定不會離開這一頁；第一次 Chrome 會問一次「要開啟 capynote-incognito 嗎」
    window.location.href = 'capynote-incognito:' + encodeURIComponent(url);
    return true;
  }

  function notes() { return ((O && O.notes) || []).filter(function (n) { return !isWatch(n); }); }
  function watchNotes() { return ((O && O.notes) || []).filter(isWatch); }
  function byId(id) { return notes().find(function (n) { return n.id === id; }) || null; }
  function allActors() { const s = {}; notes().forEach(function (n) { modelOf(n).actors.forEach(function (a) { s[a] = 1; }); }); return Object.keys(s).sort(); }
  function allTags() { const s = {}; notes().forEach(function (n) { modelOf(n).tags.forEach(function (a) { s[a] = 1; }); }); return Object.keys(s).sort(); }
  function allLangs() { const s = {}; LANGS.forEach(function (l) { s[l] = 1; }); notes().forEach(function (n) { const l = modelOf(n).lang; if (l) s[l] = 1; }); return Object.keys(s); }
  // 人物誌的資料：每個出現過的人物一筆（名字以第一次出現的寫法為準），帶影片、觀看次數、照片
  // （外部網址 avatar 與存進系統的 avatarId）、查過沒有（verified）
  function peopleIndex() {
    const map = {};
    notes().forEach(function (n) {
      const m = modelOf(n);
      m.actors.forEach(function (a) {
        const k = a.toLowerCase();
        const p = map[k] || (map[k] = { key: k, name: a, videos: [], watches: 0, avatar: '', avatarId: '', verified: false, last: '' });
        p.videos.push(n);
        p.watches += m.watches.length;
        if (!p.avatar && m.avatars[a]) { p.avatar = m.avatars[a]; p.avatarId = m.avatarIds[a] || ''; }
        if (m.verified[a]) p.verified = true;
        const lw = lastWatch(m);
        if (lw > p.last) p.last = lw;
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.videos.length - a.videos.length || b.watches - a.watches || a.name.localeCompare(b.name, 'zh-Hant'); });
  }

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
    // 表格裡正在打字：現在重畫會把字跟焦點弄掉，等焦點離開表格再畫（makeTable 的 focusout）
    if (document.activeElement && host.contains(document.activeElement) && document.activeElement.closest('.vd-table')) { pendingPaint = true; return; }
    // 對話框開著就只重畫底下的清單（它改的是同一個 note 物件）；關聯圖／統計整頁重算
    paint();
  }
  function teardownView() {
    if (graphView) { graphView.close(); graphView = null; }
    avatarWatch = null;
    if (host) host.innerHTML = '';
  }
  function teardown() {
    flushSaves();
    closeModal(false);
    closeBatch();
    teardownView();
    host = null;
    avatarMiss = {}; storeMiss = {};   // 「查過沒有／存不進去」只活在這一次開頁裡
  }

  function paint() {
    if (!host) return;
    if (graphView) { graphView.close(); graphView = null; }
    avatarWatch = null;   // 清單／統計沒有要就地更新的東西；人物誌與關聯圖會再掛自己的
    const list = notes();
    const total = list.reduce(function (s, n) { return s + modelOf(n).watches.length; }, 0);
    host.innerHTML = '';
    // 頁首跟區域頁的 .dash-head 同一個骨架：左邊標題＋數量，右邊 清單／關聯圖／統計 的分段按鈕＋新增
    const head = el('div', 'vd-head');
    head.innerHTML =
      '<div class="vd-head-main"><div class="boards-title">' + ic('film') + '<span>影片</span></div>' +
      '<div class="boards-sub">' + (list.length ? list.length + ' 部影片・共看過 ' + total + ' 次' : '還沒有影片') + (watchNotes().length ? '・觀察區 ' + watchNotes().length + ' 個連結' : '') + '</div></div>' +
      '<div class="vd-head-right"><nav class="vd-tabs" aria-label="影片檢視">' +
      [['list', 'list', '清單'], ['watch', 'eye', '觀察區'], ['people', 'users', '人物誌'], ['graph', 'graph', '關聯圖'], ['stats', 'chart', '統計']].map(function (t) {
        return '<button class="vd-tab' + (view === t[0] ? ' is-active' : '') + '" type="button" data-view="' + t[0] + '" aria-pressed="' + (view === t[0]) + '">' + ic(t[1]) + '<span>' + t[2] + '</span></button>';
      }).join('') + '</nav>' +
      '<button class="btn vd-batch" type="button" title="貼一份網址清單，一次新增多部（可以帶全名）">' + ic('list') + '<span>批次新增</span></button>' +
      '<button class="btn btn-primary vd-add" type="button">' + ic('plus') + '<span>新增影片</span></button></div>';
    host.appendChild(head);
    const tabs = head.querySelector('.vd-tabs');
    const body = el('div', 'vd-body');
    host.appendChild(body);
    if (view === 'graph') paintGraph(body);
    else if (view === 'stats') paintStats(body);
    else if (view === 'people') paintPeople(body);
    else if (view === 'watch') paintWatch(body);
    else paintList(body);
    ensureStored();   // 還是外部網址的縮圖／照片在背景存進系統

    head.querySelector('.vd-add').addEventListener('click', function () { openModal(null); });
    head.querySelector('.vd-batch').addEventListener('click', function () { openBatch(); });
    tabs.addEventListener('click', function (e) {
      const b = e.target.closest('[data-view]');
      if (b) setView(b.getAttribute('data-view'));
    });
  }
  function setView(v) { if (v === view) return; view = v; paint(); }
  function setFilter(kind, value) {
    filter = { actor: null, tag: null, lang: null, subtitle: null };
    if (kind) filter[kind] = value;
    if (view !== 'list') view = 'list';
    paint();
  }

  function matches(n) {
    const m = modelOf(n);
    if (filter.actor && !m.actors.some(function (a) { return a.toLowerCase() === filter.actor.toLowerCase(); })) return false;
    if (filter.tag && !m.tags.some(function (a) { return a.toLowerCase() === filter.tag.toLowerCase(); })) return false;
    if (filter.lang && (m.lang || '').toLowerCase() !== filter.lang.toLowerCase()) return false;
    if (filter.subtitle && (m.subtitle || '').toLowerCase() !== filter.subtitle.toLowerCase()) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = [n.title, m.code, m.movieTitle, m.lang, m.subtitle, m.notes, m.url, m.preview && m.preview.title].concat(m.actors, m.tags).join('\n').toLowerCase();
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
    if (filter.subtitle) fl.push(['subtitle', '字幕：' + filter.subtitle]);
    tools.innerHTML =
      '<div class="search-box vd-search"><input type="search" placeholder="搜尋標題、編號、人物、標籤…" value="' + esc(query) + '" aria-label="搜尋影片"></div>' +
      '<select class="vd-sort" aria-label="排序">' +
      [['added', '最近新增'], ['watched', '最近看過'], ['count', '看最多次'], ['title', '標題']].map(function (s) { return '<option value="' + s[0] + '"' + (sort === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') +
      '</select>' +
      '<button class="vd-incog' + (incognitoOn() ? ' is-on' : '') + '" type="button" aria-pressed="' + incognitoOn() + '" title="開啟連結時交給無痕視窗（已有無痕視窗就在裡面開新分頁）。要先在這台電腦執行一次 tools/incognito/install.cmd">' + ic('eye-off') + '<span>無痕開啟</span></button>' +
      fl.map(function (f) { return '<button class="vd-filter" type="button" data-clear="' + f[0] + '">' + esc(f[1]) + ic('x') + '</button>'; }).join('');
    // 卡片／表格：表格是「所有欄位都能直接改」的清單（makeTable）
    tools.insertAdjacentHTML('beforeend',
      '<nav class="vd-tabs vd-mode" aria-label="顯示方式">' +
      [['cards', 'grid', '卡片'], ['table', 'table', '表格']].map(function (t) {
        return '<button class="vd-tab' + (listMode === t[0] ? ' is-active' : '') + '" type="button" data-mode="' + t[0] + '" aria-pressed="' + (listMode === t[0]) + '">' + ic(t[1]) + '<span>' + t[2] + '</span></button>';
      }).join('') + '</nav>');
    if (notes().length) body.appendChild(tools);   // 一部影片都還沒有：搜尋與排序沒東西可搜，只留空狀態
    const rows = sorted(notes().filter(matches));
    let grid;
    if (listMode === 'table' && notes().length) {
      grid = makeTable(rows);
    } else {
      grid = el('div', 'vd-grid');
      if (!rows.length) {
        grid.appendChild(el('div', 'vd-empty', notes().length ? '沒有符合的影片。' : ic('film') + '<p>還沒有影片。貼上一個連結就會自動抓標題與縮圖。</p><button class="btn btn-primary vd-empty-add" type="button">' + ic('plus') + '<span>新增影片</span></button>'));
      }
      rows.forEach(function (r) { grid.appendChild(makeCard(r.n, r.m)); });
    }
    body.appendChild(grid);
    const emptyAdd = grid.querySelector('.vd-empty-add');
    if (emptyAdd) emptyAdd.addEventListener('click', function () { openModal(null); });

    const input = tools.querySelector('input');
    input.addEventListener('input', function () { query = input.value; repaintGrid(grid); });
    tools.querySelector('.vd-sort').addEventListener('change', function (e) { sort = e.target.value; try { localStorage.setItem(LS_SORT, sort); } catch (x) { /* ignore */ } repaintGrid(grid); });
    tools.querySelector('.vd-mode').addEventListener('click', function (e) {
      const b = e.target.closest('[data-mode]');
      if (!b || b.getAttribute('data-mode') === listMode) return;
      listMode = b.getAttribute('data-mode');
      try { localStorage.setItem(LS_MODE, listMode); } catch (x) { /* ignore */ }
      paint();
    });
    tools.querySelector('.vd-incog').addEventListener('click', function (e) {
      const on = !incognitoOn();
      setIncognito(on);
      e.currentTarget.classList.toggle('is-on', on);
      e.currentTarget.setAttribute('aria-pressed', String(on));
      toast(on ? '「開啟連結」會交給無痕視窗' : '「開啟連結」改回一般分頁');
    });
    tools.addEventListener('click', function (e) {
      const b = e.target.closest('[data-clear]');
      if (b) { filter[b.getAttribute('data-clear')] = null; paint(); }
    });
  }
  function repaintGrid(grid) {
    const rows = sorted(notes().filter(matches));
    if (grid.classList.contains('vd-tablewrap')) { fillTable(grid, rows); return; }
    grid.innerHTML = '';
    if (!rows.length) grid.appendChild(el('div', 'vd-empty', '沒有符合的影片。'));
    rows.forEach(function (r) { grid.appendChild(makeCard(r.n, r.m)); });
  }
  // 清單裡代表這部影片的那一塊（卡片或表格列）換成新的
  function refreshRow(n, m) {
    if (!host || view !== 'list') return;
    const card = host.querySelector('.vd-card[data-id="' + n.id + '"]');
    if (card) { card.replaceWith(makeCard(n, m)); return; }
    const row = host.querySelector('.vd-row[data-id="' + n.id + '"]');
    if (row && !row.contains(document.activeElement)) row.replaceWith(makeRow(n, m));
    else if (row) { const c = row.querySelector('.vd-t-count'); if (c) c.textContent = m.watches.length; }
  }

  // ---------------- 表格：每一格直接改，改了 600 ms 後自動存 ----------------
  // 一列一部影片：縮圖、標題、網址、編號、全名、人物、語言、字幕、hashtag、備註、看過、更多。
  // 每個 input 的 input 事件 → setField()：重新 parse 這部的 model、改那個欄位、write()、排存檔。
  // 人物與 hashtag 用同一個 chipInput（緊湊版樣式）。網址改了跟對話框一樣 700 ms 後抓預覽，
  // 把還空著的編號／全名／人物／照片／縮圖補進去（已經填的不動）。表格上有格子正在打字時，
  // refresh() 不整頁重畫（會把正在打的字跟焦點弄掉），記下來等焦點離開表格再畫。
  const COLS = [['thumb', ''], ['title', '標題'], ['url', '網址'], ['code', '編號'], ['movieTitle', '全名'], ['actors', '人物'], ['lang', '語言'], ['subtitle', '字幕'], ['tags', 'hashtag'], ['notes', '備註'], ['watch', '看過'], ['acts', '']];
  const rowTimers = new Map();   // note id -> 抓預覽的計時器
  function setField(n, patch, title) {
    const m = liveModel(n);
    Object.assign(m, patch || {});
    write(n, m, title);
    scheduleSave(n);
  }
  function makeTable(rows) {
    const wrap = el('div', 'vd-tablewrap');
    wrap.innerHTML =
      '<table class="vd-table"><colgroup>' + COLS.map(function (c) { return '<col class="vd-col-' + c[0] + '">'; }).join('') + '</colgroup>' +
      '<thead><tr>' + COLS.map(function (c) { return '<th class="vd-th-' + c[0] + '">' + esc(c[1]) + '</th>'; }).join('') + '</tr></thead><tbody></tbody></table>' +
      '<datalist id="vd-dl-lang-t">' + allLangs().map(function (l) { return '<option value="' + esc(l) + '">'; }).join('') + '</datalist>' +
      '<datalist id="vd-dl-subtitle-t">' + SUBTITLES.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>' +
      '<div class="vd-table-foot"><button class="btn vd-table-add" type="button">' + ic('plus') + '<span>新增一列</span></button><span class="vd-table-n"></span></div>';
    fillTable(wrap, rows);
    wrap.querySelector('.vd-table-add').addEventListener('click', function (e) {
      const btn = e.currentTarget; btn.disabled = true;
      O.onCreate({ title: '未命名影片', content: generate(blank()) }).then(function (n) {
        // onCreate 那邊已經 refreshViews → 整頁重畫；找到新的那一列，游標放到網址格
        btn.disabled = false;
        const row = n && host && host.querySelector('.vd-row[data-id="' + n.id + '"]');
        if (row) { const u = row.querySelector('.vd-t-url'); if (u) u.focus(); row.scrollIntoView({ block: 'nearest' }); }
      }, function () { btn.disabled = false; });
    });
    wrap.addEventListener('focusout', function () {
      setTimeout(function () {
        if (pendingPaint && !(document.activeElement && document.activeElement.closest('.vd-table'))) { pendingPaint = false; paint(); }
      }, 0);
    });
    return wrap;
  }
  function fillTable(wrap, rows) {
    const tb = wrap.querySelector('tbody');
    tb.innerHTML = '';
    if (!rows.length) tb.innerHTML = '<tr class="vd-row-empty"><td colspan="' + COLS.length + '">沒有符合的影片。</td></tr>';
    rows.forEach(function (r) { tb.appendChild(makeRow(r.n, r.m)); });
    const nEl = wrap.querySelector('.vd-table-n');
    if (nEl) nEl.textContent = rows.length + ' 部';
  }
  function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; }
  function makeRow(n, m) {
    const tr = el('tr', 'vd-row');
    tr.setAttribute('data-id', n.id);
    tr.innerHTML =
      '<td class="vd-td-thumb">' + thumbHTML(m, 'vd-t-thumb') + '</td>' +
      '<td><input class="vd-t-in vd-t-title" type="text" value="' + esc(n.title) + '" placeholder="標題" maxlength="300" spellcheck="false"></td>' +
      '<td class="vd-td-url"><input class="vd-t-in vd-t-url" type="url" value="' + esc(m.url) + '" placeholder="貼上連結…" spellcheck="false" autocomplete="off">' +
      '<a class="icon-btn vd-t-open vd-open" href="' + esc(m.url || '#') + '" target="_blank" rel="noopener noreferrer" title="開啟連結"' + (m.url ? '' : ' hidden') + '>' + ic('external-link') + '</a></td>' +
      '<td><input class="vd-t-in vd-t-code" type="text" value="' + esc(m.code) + '" placeholder="ABC-123" maxlength="60" spellcheck="false"></td>' +
      '<td><input class="vd-t-in vd-t-movietitle" type="text" value="' + esc(m.movieTitle) + '" placeholder="全名" maxlength="300" spellcheck="false"></td>' +
      '<td><div class="vd-chips vd-chips-in vd-t-chips vd-t-actors"></div></td>' +
      '<td><input class="vd-t-in vd-t-lang" type="text" list="vd-dl-lang-t" value="' + esc(m.lang) + '" placeholder="語言" maxlength="30"></td>' +
      '<td><input class="vd-t-in vd-t-subtitle" type="text" list="vd-dl-subtitle-t" value="' + esc(m.subtitle) + '" placeholder="字幕" maxlength="30"></td>' +
      '<td><div class="vd-chips vd-chips-in vd-t-chips vd-t-tags"></div></td>' +
      '<td><textarea class="vd-t-in vd-t-notes" rows="1" placeholder="備註" maxlength="5000">' + esc(m.notes) + '</textarea></td>' +
      '<td class="vd-td-watch"><span class="vd-t-count">' + m.watches.length + '</span><button class="icon-btn vd-t-watch" type="button" title="看過一次就按一次">' + ic('plus') + '</button></td>' +
      '<td class="vd-td-acts"><button class="icon-btn vd-t-more" type="button" title="更多">' + ic('more-horizontal') + '</button></td>';
    const q = function (s) { return tr.querySelector(s); };
    const on = function (sel, field, trim) {
      const inp = q(sel);
      const h = function () { const p = {}; p[field] = trim ? inp.value.trim() : inp.value; setField(n, p); };
      inp.addEventListener('input', h);
      inp.addEventListener('change', h);   // datalist 選項（Chrome 只發 change）
    };
    q('.vd-t-title').addEventListener('input', function (e) { setField(n, null, e.target.value); });
    on('.vd-t-code', 'code', true);
    on('.vd-t-movietitle', 'movieTitle', false);
    on('.vd-t-lang', 'lang', true);
    on('.vd-t-subtitle', 'subtitle', true);
    const notesIn = q('.vd-t-notes');
    notesIn.addEventListener('input', function () { autoGrow(notesIn); setField(n, { notes: notesIn.value }); });
    notesIn.addEventListener('focus', function () { autoGrow(notesIn); });
    notesIn.addEventListener('blur', function () { notesIn.style.height = ''; });
    const actorsChip = chipInput(q('.vd-t-actors'), m.actors, { key: 'actors-t', cls: 'is-actor', placeholder: '人物', suggest: allActors(), verify: verifyPerson, onChange: function (v) { setField(n, { actors: v }); } });
    chipInput(q('.vd-t-tags'), m.tags, { key: 'tags-t', cls: 'is-tag', prefix: '#', placeholder: '#hashtag', suggest: allTags(), onChange: function (v) { setField(n, { tags: v }); } });
    // 網址：改了就記下來、700 ms 後抓預覽補空欄位；開啟連結的箭頭跟著網址走
    const urlIn = q('.vd-t-url'), openA = q('.vd-t-open');
    urlIn.addEventListener('input', function () {
      const u = safeUrl(urlIn.value);
      const cur = liveModel(n);
      setField(n, { url: u, preview: u === cur.url ? cur.preview : null });
      openA.href = u || '#'; openA.hidden = !u;
      if (rowTimers.has(n.id)) clearTimeout(rowTimers.get(n.id));
      if (u && O.onPreview) rowTimers.set(n.id, setTimeout(function () { rowTimers.delete(n.id); rowPreview(n, u, tr, actorsChip); }, 700));
    });
    urlIn.addEventListener('paste', function () { setTimeout(function () { urlIn.dispatchEvent(new Event('input', { bubbles: true })); }, 0); });
    tr.addEventListener('click', function (e) {
      let b;
      if ((b = e.target.closest('a.vd-open'))) { if (incognitoOn() && openIncognito(b.href)) e.preventDefault(); return; }
      if (e.target.closest('.vd-t-watch')) { addWatch(n); return; }
      if ((b = e.target.closest('.vd-t-more'))) { const r = b.getBoundingClientRect(); cardMenu(n, r.left, r.bottom + 4); return; }
      if (e.target.closest('.vd-t-thumb')) { openModal(n); }
    });
    tr.addEventListener('contextmenu', function (e) { if (e.target.closest('input, textarea')) return; e.preventDefault(); cardMenu(n, e.clientX, e.clientY); });
    // Enter：往下一列的同一格（Shift+Enter 往上）；textarea 裡 Enter 照常換行
    tr.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.isComposing || e.target.tagName === 'TEXTAREA' || e.target.classList.contains('vd-chip-in')) return;
      const td = e.target.closest('td'); if (!td) return;
      const idx = Array.prototype.indexOf.call(tr.children, td);
      const next = e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling;
      if (!next || !next.children[idx]) return;
      const target = next.children[idx].querySelector('input, textarea');
      if (target) { e.preventDefault(); target.focus(); if (target.select) target.select(); }
    });
    return tr;
  }
  // 表格列的網址抓預覽：補還空著的欄位（跟對話框的 fetchPreview 同一套規則）
  function rowPreview(n, u, tr, actorsChip) {
    tr.classList.add('is-fetching');
    O.onPreview(u).then(function (info) {
      tr.classList.remove('is-fetching');
      if (!tr.isConnected || liveModel(n).url !== u) return;
      if (!info || info.error) return;
      const m = liveModel(n);
      const patch = {};
      const pv = { title: str(info.title, 200), description: str(info.description, 300), image: safeUrl(info.image), site: str(info.siteName, 80) };
      if (!pv.image) pv.image = ytThumb(u);
      patch.preview = (pv.title || pv.image || pv.description) ? pv : null;
      const code = str(info.code, 60).trim() || codeFromUrl(u);
      const codeIn = tr.querySelector('.vd-t-code'), mtIn = tr.querySelector('.vd-t-movietitle'), titleIn = tr.querySelector('.vd-t-title');
      if (code && !m.code) { patch.code = code; codeIn.value = code; }
      const mt = str(info.movieTitle || info.title, 300).trim();
      if (mt && !m.movieTitle) { patch.movieTitle = mt; mtIn.value = mt; }
      if (Array.isArray(info.actors) && info.actors.length && !m.actors.length) { actorsChip.set(info.actors.slice(0, 10)); patch.actors = actorsChip.get(); }
      const av = peopleAvatars(info, patch.actors || m.actors);
      if (Object.keys(av).length) patch.avatars = Object.assign({}, m.avatars, av);
      const vf = peopleVerified(info, patch.actors || m.actors);
      if (Object.keys(vf).length) patch.verified = Object.assign({}, m.verified, vf);
      let title;
      if (!n.title || n.title === '未命名影片') { title = mt || pv.title || code || n.title; titleIn.value = title; }
      setField(n, patch, title);
      const th = tr.querySelector('.vd-td-thumb');
      if (th) th.innerHTML = thumbHTML(liveModel(n), 'vd-t-thumb');
    });
  }
  // 存進系統的圖 404 了（備份還原後沒帶到、被手動刪掉）就退回代理抓原網址；原網址也壞才顯示佔位
  function imgTag(src, fallback, attrs) {
    return '<img src="' + esc(src) + '" alt="" loading="lazy"' + (attrs || '') +
      (fallback && fallback !== src ? ' data-fb="' + esc(fallback) + '"' : '') +
      ' onerror="if(this.dataset.fb){this.src=this.dataset.fb;delete this.dataset.fb;}else{this.parentNode.classList.add(\'is-empty\');this.remove();}">';
  }
  function thumbHTML(m, cls, extra) {
    const t = thumbOf(m);
    return '<div class="' + cls + (t ? '' : ' is-empty') + '">' +
      (t ? imgTag(thumbSrc(m), proxied(t)) : '') +
      '<span class="vd-thumb-ph">' + ic('film') + '</span>' + (extra || '') + '</div>';
  }
  // 縮圖右下角的標籤：語言、字幕（點一下就依它篩選）
  function badgesHTML(m) {
    const b = [];
    if (m.lang) b.push('<button class="vd-badge is-lang" type="button" data-lang="' + esc(m.lang) + '" title="語言：' + esc(m.lang) + '">' + esc(m.lang) + '</button>');
    if (m.subtitle) b.push('<button class="vd-badge is-sub" type="button" data-subtitle="' + esc(m.subtitle) + '" title="字幕：' + esc(m.subtitle) + '">' + esc(m.subtitle) + '</button>');
    return b.length ? '<div class="vd-badges">' + b.join('') + '</div>' : '';
  }
  function makeCard(n, m) {
    const card = el('article', 'vd-card');
    card.setAttribute('data-id', n.id);
    card.tabIndex = 0;
    const lw = lastWatch(m);
    card.innerHTML =
      thumbHTML(m, 'vd-thumb', badgesHTML(m)) +
      (m.code ? '<span class="vd-code">' + esc(m.code) + '</span>' : '') +
      '<span class="vd-count" title="看過 ' + m.watches.length + ' 次">' + ic('eye') + m.watches.length + '</span>' +
      '<div class="vd-cbody">' +
      '<div class="vd-title" title="' + esc(n.title) + '">' + esc(n.title || '未命名影片') + '</div>' +
      (m.actors.length ? '<div class="vd-chips">' + m.actors.map(function (a) { return '<button class="vd-chip is-actor" type="button" data-actor="' + esc(a) + '">' + ic('user') + esc(a) + '</button>'; }).join('') + '</div>' : '') +
      (m.tags.length ? '<div class="vd-chips">' + m.tags.map(function (t) { return '<button class="vd-chip is-tag" type="button" data-tag="' + esc(t) + '">#' + esc(t) + '</button>'; }).join('') + '</div>' : '') +
      '<div class="vd-meta">' +
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
      if ((b = e.target.closest('[data-subtitle]'))) { setFilter('subtitle', b.getAttribute('data-subtitle')); return; }
      if ((b = e.target.closest('a.vd-open'))) { if (incognitoOn() && openIncognito(b.href)) e.preventDefault(); return; }
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
    menuAt(x, y, [['open', '查看／編輯'], ['watch', '+1 看過'], ['copy', '複製連結', !modelOf(n).url], null, ['del', '刪除', false, true]], function (a) {
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
    refreshRow(n, m);
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
        if (o.verify) check(s);
      });
      return changed;
    }
    // 收進來先顯示，背景去查：不收的（男性）拿掉，有中文名的換成中文名
    function check(s) {
      o.verify(s).then(function (r) {
        const i = list.findIndex(function (v) { return v === s; });
        if (i < 0 || !r) return;
        if (r.ok === false) { list.splice(i, 1); }
        else if (r.name && r.name !== s) {
          if (list.some(function (v, j) { return j !== i && v.toLowerCase() === r.name.toLowerCase(); })) list.splice(i, 1); else list[i] = r.name;
        } else return;
        paintChips(); o.onChange(list.slice());
      });
    }
    function commit() {
      const changed = add(input.value);
      input.value = '';
      if (changed) { paintChips(); o.onChange(list.slice()); }
    }
    paintChips();
    wrap._chip = null;   // 下面 return 的物件也掛到 wrap 上（removePerson 要同步對話框的晶片）
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
    const api = {
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
    wrap._chip = api;
    return api;
  }

  // init（新增時）：{ url } 先帶進網址並抓預覽；{ fromWatch } 是觀察區的那一筆，建好影片就把它刪掉
  function openModal(note, init) {
    closeModal(true);
    init = init || {};
    const model = note ? modelOf(note) : blank();
    if (!note && init.url) model.url = safeUrl(init.url);
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
        : '<button class="btn btn-danger vd-m-del" type="button">' + ic('trash') + '<span>刪除</span></button><span class="vd-m-status"></span><span class="vd-m-sp"></span><button class="btn vd-m-ok" type="button">關閉</button>') +
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
    function syncCard() { if (note) refreshRow(note, model); }
    q('.vd-m-title').addEventListener('input', function () { apply(); });
    q('.vd-m-code').addEventListener('input', function (e) { apply({ code: e.target.value.trim() }); });
    q('.vd-m-movietitle').addEventListener('input', function (e) { apply({ movieTitle: e.target.value }); });
    q('.vd-m-lang').addEventListener('input', function (e) { apply({ lang: e.target.value.trim() }); });
    q('.vd-m-lang').addEventListener('change', function (e) { apply({ lang: e.target.value.trim() }); });
    q('.vd-m-subtitle').addEventListener('input', function (e) { apply({ subtitle: e.target.value.trim() }); });
    q('.vd-m-subtitle').addEventListener('change', function (e) { apply({ subtitle: e.target.value.trim() }); });
    q('.vd-m-notes').addEventListener('input', function (e) { apply({ notes: e.target.value }); });
    const actorsChip = chipInput(q('.vd-m-actors'), model.actors, { key: 'actors', cls: 'is-actor', placeholder: '人物，Enter 加一個（可多個）', suggest: allActors(), verify: verifyPerson, onChange: function (v) { apply({ actors: v }); } });
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
        // 人物從伺服器補（晶片還空著才填）；大頭照不管晶片是誰填的，名字對得上就收
        if (!failed && info.actors && info.actors.length && !actorsChip.get().length) {
          actorsChip.set(info.actors.slice(0, 10));
          fill.actors = actorsChip.get();
        }
        if (!failed) {
          const av = peopleAvatars(info, actorsChip.get());
          if (Object.keys(av).length) fill.avatars = Object.assign({}, model.avatars, av);
          const vf = peopleVerified(info, actorsChip.get());
          if (Object.keys(vf).length) fill.verified = Object.assign({}, model.verified, vf);
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
          // 從觀察區來的：影片建好了，那個連結就不用留著
          if (init.fromWatch && O.onDeleteNow) O.onDeleteNow(init.fromWatch).catch(function () {});
          if (n) { view = 'list'; paint(); openModal(byId(n.id) || n); }
        }, function () { btn.disabled = false; });
      });
      setTimeout(function () { urlIn.focus(); }, 30);
      if (init.url && model.url) { urlTimer = setTimeout(function () { fetchPreview(false); }, 50); }
    } else {
      q('.vd-m-ok').addEventListener('click', function () { closeModal(true); });
      q('.vd-m-del').addEventListener('click', function () { const n = note; closeModal(true); if (O.onDelete) O.onDelete(n); });
      setTimeout(function () { q('.vd-m-title').focus(); }, 30);
    }
    q('.vd-m-close').addEventListener('click', function () { closeModal(true); });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModal(true); });
    // 對話框裡的「開啟連結」（paintPlayer 每次重畫，所以掛在 overlay 上）
    ov.addEventListener('click', function (e) {
      const a = e.target.closest('a.vd-player-open');
      if (a && incognitoOn() && openIncognito(a.href)) e.preventDefault();
    });
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
      refreshRow(modal.note, mm);
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

  // ---------------- 批次新增：貼一份「全名,網址,語言,字幕」清單 ----------------
  // 一行一部，逗號分隔（全形逗號、Tab、| 也算）：`全名,網址,語言,字幕`。網址是定位點：它前面
  // 的是全名（名字裡有逗號也沒關係，前面幾段全接起來），後面依序是語言、字幕；只給網址也行。
  // 每行依序抓預覽（一次一個，不去撞伺服器），有給全名就以給的為準、沒給才用抓到的；網址已經
  // 在庫裡的跳過；抓不到預覽的照建（留網址、從網址切的編號、給的欄位），該行會標「沒有預覽」。
  let batch = null;                    // { overlay, running, cancel }
  function parseBatch(text) {
    const out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      const s = line.trim();
      if (!s || s[0] === '#') return;
      const fields = s.split(/[,，\t|]/).map(function (f) { return f.trim(); });
      let idx = -1;
      for (let i = 0; i < fields.length; i++) {
        if (/^https?:\/\/\S+$/i.test(fields[i]) || /^www\.\S+\.\S+$/i.test(fields[i])) { idx = i; break; }
      }
      if (idx < 0) { out.push({ line: s, url: '', name: '', lang: '', subtitle: '' }); return; }
      out.push({
        line: s,
        url: safeUrl(fields[idx]),
        name: fields.slice(0, idx).filter(Boolean).join('，').slice(0, 300),
        lang: (fields[idx + 1] || '').slice(0, 30),
        subtitle: (fields[idx + 2] || '').slice(0, 30)
      });
    });
    return out;
  }
  function closeBatch() {
    if (!batch) return;
    const b = batch; batch = null;
    b.cancel = true;
    document.removeEventListener('keydown', onBatchKey, true);
    b.overlay.remove();
  }
  function onBatchKey(e) {
    if (e.key !== 'Escape' || !batch) return;
    e.preventDefault(); e.stopPropagation();
    if (batch.running) batch.cancel = true; else closeBatch();
  }
  function openBatch() {
    if (batch) return;
    closeModal(true);
    const ov = el('div', 'vd-overlay');
    ov.innerHTML =
      '<div class="vd-modal vd-batch-modal" role="dialog" aria-modal="true" aria-label="批次新增影片">' +
      '<div class="vd-m-head">' + ic('list') + '<span class="vd-bt-title">批次新增影片</span>' +
      '<button class="icon-btn vd-m-close" type="button" title="關閉 (Esc)">' + ic('x') + '</button></div>' +
      '<div class="vd-bt-body">' +
      '<p class="vd-bt-help">一行一部，逗號分隔：<code>全名,網址,語言,字幕</code>。只給網址也可以（全名、人物、縮圖會自己抓）；有給全名就用你給的。已經在庫裡的網址會跳過。</p>' +
      '<textarea class="tt-input vd-bt-in" rows="8" placeholder="這是一部的全名,https://…/videos/abc-123/,日文,繁體中字\nhttps://…/videos/def-456/\n…" spellcheck="false"></textarea>' +
      '<ol class="vd-bt-list" hidden></ol>' +
      '</div>' +
      '<div class="vd-m-foot"><span class="vd-m-status vd-bt-status"></span><span class="vd-m-sp"></span>' +
      '<button class="btn vd-bt-cancel" type="button">關閉</button>' +
      '<button class="btn btn-primary vd-bt-go" type="button" disabled>' + ic('plus') + '<span>開始</span></button></div></div>';
    document.body.appendChild(ov);
    batch = { overlay: ov, running: false, cancel: false };
    const q = function (s) { return ov.querySelector(s); };
    const ta = q('.vd-bt-in'), go = q('.vd-bt-go'), list = q('.vd-bt-list'), status = q('.vd-bt-status'), cancelBtn = q('.vd-bt-cancel');
    function count() {
      const items = parseBatch(ta.value);
      const ok = items.filter(function (it) { return it.url; }).length;
      go.disabled = !ok;
      status.textContent = ok ? ok + ' 部' + (items.length - ok ? '（' + (items.length - ok) + ' 行沒有網址）' : '') : '';
    }
    ta.addEventListener('input', count);
    q('.vd-m-close').addEventListener('click', function () { closeBatch(); });
    cancelBtn.addEventListener('click', function () { if (batch && batch.running) batch.cancel = true; else closeBatch(); });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov && batch && !batch.running) closeBatch(); });
    document.addEventListener('keydown', onBatchKey, true);
    go.addEventListener('click', function () { run(); });
    setTimeout(function () { ta.focus(); }, 30);

    async function run() {
      const items = parseBatch(ta.value).filter(function (it) { return it.url; });
      if (!items.length || !batch) return;
      batch.running = true; batch.cancel = false;
      go.disabled = true; ta.disabled = true; cancelBtn.textContent = '停止';
      list.hidden = false;
      list.innerHTML = items.map(function (it, i) {
        const meta = [it.lang, it.subtitle].filter(Boolean).join('・');
        return '<li data-i="' + i + '"><span class="vd-bt-st">等待</span><span class="vd-bt-url" title="' + esc(it.url) + '">' + esc(it.url) + '</span>' +
          (it.name ? '<span class="vd-bt-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' : '') +
          (meta ? '<span class="vd-bt-meta">' + esc(meta) + '</span>' : '') + '</li>';
      }).join('');
      const seen = {};
      notes().forEach(function (n) { const u = modelOf(n).url; if (u) seen[u.replace(/\/+$/, '').toLowerCase()] = true; });
      let made = 0, skipped = 0, failed = 0, stopped = false;
      for (let i = 0; i < items.length; i++) {
        if (!batch || batch.cancel) { stopped = true; break; }
        const it = items[i];
        const row = list.querySelector('li[data-i="' + i + '"]');
        const st = row.querySelector('.vd-bt-st');
        const key = it.url.replace(/\/+$/, '').toLowerCase();
        if (seen[key]) { st.textContent = '已存在'; row.className = 'is-skip'; skipped++; continue; }
        seen[key] = true;
        st.textContent = '抓取中…'; row.className = 'is-busy';
        status.textContent = (i + 1) + ' / ' + items.length;
        let info = null;
        if (O.onPreview) { try { info = await O.onPreview(it.url); } catch (e) { info = null; } }
        if (!batch || batch.cancel) { st.textContent = '已停止'; row.className = ''; stopped = true; break; }
        const noPv = !info || info.error;
        const m = blank();
        m.url = it.url;
        m.code = (!noPv && str(info.code, 60).trim()) || codeFromUrl(it.url);
        m.movieTitle = it.name || (!noPv ? str(info.movieTitle || info.title, 300).trim() : '');
        m.lang = it.lang;
        m.subtitle = it.subtitle;
        m.actors = !noPv && Array.isArray(info.actors) ? cleanList(info.actors, 10, 60) : [];
        if (!noPv) { m.avatars = peopleAvatars(info, m.actors); m.verified = peopleVerified(info, m.actors); }
        if (!noPv) {
          const pv = { title: str(info.title, 200), description: str(info.description, 300), image: safeUrl(info.image), site: str(info.siteName, 80) };
          if (!pv.image) pv.image = ytThumb(it.url);
          m.preview = (pv.title || pv.image || pv.description) ? pv : null;
        }
        const title = it.name || (m.preview && m.preview.title) || m.code || hostOf(it.url) || '未命名影片';
        try {
          await O.onCreate({ title: title, content: generate(m) });
          made++;
          st.textContent = noPv ? '已建立（沒有預覽）' : '已建立';
          row.className = noPv ? 'is-warn' : 'is-done';
        } catch (e) {
          failed++; st.textContent = '建立失敗'; row.className = 'is-fail';
        }
      }
      if (!batch) return;
      batch.running = false; batch.cancel = false;
      cancelBtn.textContent = '關閉';
      status.textContent = (stopped ? '已停止：' : '完成：') + '新增 ' + made + ' 部' +
        (skipped ? '、跳過 ' + skipped + ' 部已存在' : '') + (failed ? '、失敗 ' + failed + ' 部' : '');
      paint();
      if (made) toast('批次新增 ' + made + ' 部影片');
    }
  }

  // ---------------- 觀察區：只記連結 ----------------
  // 貼上連結（可一次多行）Enter 就記下來；每一列：網址、備註（直接改）、記下的日期；開啟（照無痕
  // 設定）、加入影片（開新增對話框、網址帶進去，建好就把這個連結拿掉）、刪除（直接硬刪，不問）。
  function paintWatch(body) {
    const wrap = el('div', 'vd-watch');
    const items = watchNotes().map(function (n) { return { n: n, w: parseWatch(n.content) }; })
      .sort(function (a, b) { return b.w.added.localeCompare(a.w.added) || (b.n.createdAt || 0) - (a.n.createdAt || 0); });
    wrap.innerHTML =
      '<div class="vd-wl-add"><textarea class="tt-input vd-wl-in" rows="1" placeholder="貼上連結，Enter 記下來（可以一次貼多行）" spellcheck="false"></textarea>' +
      '<button class="btn btn-primary vd-wl-go" type="button">' + ic('plus') + '<span>記下來</span></button></div>' +
      (items.length ? '<div class="vd-tools"><div class="search-box vd-search"><input type="search" placeholder="搜尋連結、備註…" value="' + esc(watchQuery) + '" aria-label="搜尋觀察區"></div>' +
        '<span class="vd-people-n">' + items.length + ' 個連結</span>' +
        '<button class="vd-incog' + (incognitoOn() ? ' is-on' : '') + '" type="button" aria-pressed="' + incognitoOn() + '" title="開啟連結時交給無痕視窗">' + ic('eye-off') + '<span>無痕開啟</span></button></div>' : '') +
      '<ul class="vd-wl"></ul>';
    body.appendChild(wrap);
    const ul = wrap.querySelector('.vd-wl');
    function fill() {
      ul.innerHTML = '';
      const q = watchQuery.trim().toLowerCase();
      const rows = items.filter(function (it) { return !q || (it.w.url + '\n' + it.w.note + '\n' + it.n.title).toLowerCase().indexOf(q) >= 0; });
      if (!rows.length) { ul.innerHTML = '<li class="vd-empty">' + (items.length ? '沒有符合的連結。' : ic('eye') + '<p>觀察區是空的。貼上連結就會記下來，之後想收藏再「加入影片」。</p>') + '</li>'; return; }
      rows.forEach(function (it) { ul.appendChild(watchRow(it.n, it.w)); });
    }
    fill();
    const ta = wrap.querySelector('.vd-wl-in'), go = wrap.querySelector('.vd-wl-go');
    function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; }
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addWatchLinks(ta.value); ta.value = ''; grow(); } });
    ta.addEventListener('paste', function () { setTimeout(grow, 0); });
    go.addEventListener('click', function () { addWatchLinks(ta.value); ta.value = ''; grow(); ta.focus(); });
    const s = wrap.querySelector('.vd-search input');
    if (s) s.addEventListener('input', function () { watchQuery = s.value; fill(); });
    const incog = wrap.querySelector('.vd-incog');
    if (incog) incog.addEventListener('click', function (e) {
      const on = !incognitoOn(); setIncognito(on);
      e.currentTarget.classList.toggle('is-on', on); e.currentTarget.setAttribute('aria-pressed', String(on));
      toast(on ? '「開啟連結」會交給無痕視窗' : '「開啟連結」改回一般分頁');
    });
    setTimeout(function () { if (host && view === 'watch') ta.focus(); }, 30);
  }
  function watchRow(n, w) {
    const li = el('li', 'vd-wl-row');
    li.setAttribute('data-id', n.id);
    let path = '';
    try { const u = new URL(w.url); path = (u.pathname + u.search).replace(/\/$/, ''); } catch (e) { path = ''; }
    li.innerHTML =
      '<div class="vd-wl-main"><a class="vd-wl-url vd-open" href="' + esc(w.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(w.url) + '">' +
      '<b>' + esc(hostOf(w.url)) + '</b><span>' + esc(path) + '</span></a>' +
      '<input class="vd-wl-note" type="text" value="' + esc(w.note) + '" placeholder="備註…" maxlength="500"></div>' +
      '<span class="vd-wl-date">' + esc(fmtDay(w.added)) + '</span>' +
      '<div class="vd-wl-acts">' +
      '<a class="icon-btn vd-open" href="' + esc(w.url) + '" target="_blank" rel="noopener noreferrer" title="開啟連結">' + ic('external-link') + '</a>' +
      '<button class="btn vd-wl-tovideo" type="button" title="用這個連結新增一部影片">' + ic('film') + '<span>加入影片</span></button>' +
      '<button class="icon-btn vd-wl-del" type="button" title="刪除（直接刪，不會問）">' + ic('trash') + '</button></div>';
    const noteIn = li.querySelector('.vd-wl-note');
    noteIn.addEventListener('input', function () {
      const cur = parseWatch(n.content);
      cur.note = noteIn.value;
      n.content = generateWatch(cur);
      n.title = (cur.note.trim() || cur.url).slice(0, 300);
      scheduleSave(n);
    });
    li.addEventListener('click', function (e) {
      let b;
      if ((b = e.target.closest('a.vd-open'))) { if (incognitoOn() && openIncognito(b.href)) e.preventDefault(); return; }
      if (e.target.closest('.vd-wl-tovideo')) { openModal(null, { url: w.url, fromWatch: n }); return; }
      if (e.target.closest('.vd-wl-del')) {
        li.classList.add('is-gone');
        if (O.onDeleteNow) O.onDeleteNow(n).then(function () { toast('已刪除連結'); }, function () { li.classList.remove('is-gone'); });
      }
    });
    return li;
  }
  // 一段文字裡的每個網址各記一筆；已經在觀察區或影片庫裡的跳過
  function addWatchLinks(text) {
    const urls = [];
    String(text || '').split(/[\s,，|]+/).forEach(function (t) {
      const u = safeUrl(t);
      // 要像個網址：主機名得有一個點（safeUrl 會替任何字補 https://，「不是網址」也會過）
      let ok = false;
      try { ok = !!u && /\.[a-z0-9-]{2,}$/i.test(new URL(u).hostname); } catch (e) { ok = false; }
      if (ok && urls.indexOf(u) < 0) urls.push(u);
    });
    if (!urls.length) { toast('沒有看到網址'); return; }
    const have = {};
    watchNotes().forEach(function (n) { have[parseWatch(n.content).url.replace(/\/+$/, '').toLowerCase()] = 'watch'; });
    notes().forEach(function (n) { const u = modelOf(n).url; if (u) have[u.replace(/\/+$/, '').toLowerCase()] = 'video'; });
    let made = 0, dup = 0;
    (async function () {
      for (let i = 0; i < urls.length; i++) {
        const k = urls[i].replace(/\/+$/, '').toLowerCase();
        if (have[k]) { dup++; continue; }
        have[k] = 'watch';
        try { await O.onCreate({ title: urls[i].slice(0, 300), content: generateWatch({ url: urls[i], added: today() }), meta: { watch: true } }); made++; } catch (e) { /* onCreate 已經 toast */ }
      }
      if (made || dup) toast((made ? '記下 ' + made + ' 個連結' : '') + (dup ? (made ? '，' : '') + dup + ' 個已經有了' : ''));
    })();
  }

  // ---------------- 人物的大頭照 ----------------
  // 伺服器預覽回來的 people: [{name, image}] → 這部影片的 avatars（只收名字在人物清單裡的）
  function peopleAvatars(info, actors) {
    const out = {};
    if (!info || !Array.isArray(info.people)) return out;
    info.people.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      const name = actors.find(function (a) { return a.toLowerCase() === String(p.name || '').trim().toLowerCase(); });
      const u = safeUrl(p.image);
      if (name && u && !out[name]) out[name] = u;
    });
    return out;
  }
  // 伺服器給的人物都是查過資料庫、確定收的：標成 verified，人物誌就不用再查一次
  function peopleVerified(info, actors) {
    const out = {};
    if (!info || !Array.isArray(info.people)) return out;
    info.people.forEach(function (p) {
      const name = p && actors.find(function (a) { return a.toLowerCase() === String(p.name || '').trim().toLowerCase(); });
      if (name) out[name] = 1;
    });
    return out;
  }
  // 還沒有照片的人物，一次一個用名字問伺服器（O.onPerson）。找到就把照片寫進那個人第一部影片
  // 的 avatars 並存檔；伺服器確定是同一人（matched）且中文名不同就整庫改名。這次開頁查過沒結果
  // 的記在 avatarMiss，不再重複問（離開頁面就忘，不是快取）。onEach(person, info, renamed) 讓
  // 人物誌／關聯圖就地更新那一格。
  // 每個人物查過一次資料庫（verified 記在那個人第一部影片裡，之後不再查）：男性整個拿掉（所有影片
  // 的人物、照片），女性補照片、改成中文名。這次開頁查過沒結果的記在 avatarMiss，不再重複問。
  let avatarJob = null;
  let avatarWatch = null;   // 目前畫面要被通知的那個 onEach：每次重畫都換新的，背景工作一直叫最新的
  let avatarMiss = {};
  function ensureAvatars(onEach) {
    avatarWatch = onEach || null;
    ensureStored();
    if (!O || !O.onPerson || avatarJob) return;
    avatarJob = (async function () {
      try {
        while (host) {
          const todo = peopleIndex().filter(function (p) { return (!p.avatar || !p.verified) && !avatarMiss[p.key]; });
          if (!todo.length) break;
          // 沒照片的先，驗過身分但缺照片的跟沒驗過的一樣要問
          todo.sort(function (a, b) { return (a.avatar ? 1 : 0) - (b.avatar ? 1 : 0); });
          const p = todo[0];
          let info = null;
          try { info = await O.onPerson(p.name); } catch (e) { info = null; }
          if (!host) break;
          if (!info || info.error) { avatarMiss[p.key] = true; if (avatarWatch) avatarWatch(p, info || { error: '查不到' }, false); continue; }
          if (info.male) {
            removePerson(p.key, p.name);
            toast('「' + p.name + '」是男性人物，已從所有影片拿掉');
            if (avatarWatch) avatarWatch(p, info, true);
            continue;
          }
          const renamed = applyPerson(p, info);
          if (!info.image) avatarMiss[renamed ? String(info.name).toLowerCase() : p.key] = true;
          if (avatarWatch) avatarWatch(p, info, renamed);
          ensureStored();
        }
      } finally { avatarJob = null; }
    })();
  }
  function applyPerson(p, info) {
    const newName = (info.matched && typeof info.name === 'string' && info.name.trim() && info.name.trim() !== p.name) ? info.name.trim().slice(0, 60) : p.name;
    const image = safeUrl(info.image);
    let stored = false, marked = false;
    notes().forEach(function (n) {
      const m = liveModel(n);
      const idx = m.actors.findIndex(function (a) { return a.toLowerCase() === p.key; });
      if (idx < 0) return;
      let changed = false;
      if (newName !== p.name) {
        // 改名：已經有這個新名字就把舊的拿掉，否則原地換掉；照片、驗過的標記跟著搬
        const dup = m.actors.findIndex(function (a, i) { return i !== idx && a.toLowerCase() === newName.toLowerCase(); });
        if (dup >= 0) m.actors.splice(idx, 1); else m.actors[idx] = newName;
        [m.avatars, m.avatarIds, m.verified].forEach(function (map) {
          Object.keys(map).forEach(function (k) { if (k.toLowerCase() === p.key) { const v = map[k]; delete map[k]; if (!map[newName]) map[newName] = v; } });
        });
        changed = true;
      }
      const has = m.actors.some(function (a) { return a.toLowerCase() === newName.toLowerCase(); });
      if (image && !stored && has) {
        if (m.avatars[newName] !== image) { m.avatars[newName] = image; delete m.avatarIds[newName]; }
        stored = true; changed = true;
      }
      if (!marked && has) { m.verified[newName] = 1; marked = true; changed = true; }
      if (changed) { write(n, m); if (O.onSave) O.onSave(n); }
    });
    if (newName !== p.name) toast('人物「' + p.name + '」改名為「' + newName + '」');
    return newName !== p.name;
  }
  // 把一個人物從所有影片拿掉（人物、照片、標記），存進系統的照片也刪
  function removePerson(key, name) {
    notes().forEach(function (n) {
      const m = liveModel(n);
      const idx = m.actors.findIndex(function (a) { return a.toLowerCase() === key; });
      if (idx < 0) return;
      m.actors.splice(idx, 1);
      [m.avatars, m.avatarIds, m.verified].forEach(function (map) {
        Object.keys(map).forEach(function (k) {
          if (k.toLowerCase() !== key) return;
          if (map === m.avatarIds && O.onDropImage) O.onDropImage(map[k]);
          delete map[k];
        });
      });
      write(n, m); if (O.onSave) O.onSave(n);
    });
    if (modal && modal.overlay) { const chips = modal.overlay.querySelector('.vd-m-actors'); if (chips && chips._chip) chips._chip.set(modal.model.actors); }
  }
  // 晶片輸入收到一個人物名時的檢查（chipInput 的 verify）：男性不收、有中文名就換成中文名
  function verifyPerson(name) {
    if (!O || !O.onPerson) return Promise.resolve({ ok: true });
    return O.onPerson(name).then(function (info) {
      if (!info || info.error) return { ok: true };
      if (info.male) { toast('「' + name + '」是男性人物，不收'); return { ok: false }; }
      const nm = info.matched && typeof info.name === 'string' && info.name.trim() ? info.name.trim().slice(0, 60) : name;
      return { ok: true, name: nm };
    }, function () { return { ok: true }; });
  }

  // 把還是外部網址的縮圖／大頭照存進系統（一次一張，背景跑）：之後顯示從 /api/images 拿，不再每次抓
  let storeJob = null;
  let storeMiss = {};        // 這次開頁存不進去的網址，不再重試
  function ensureStored() {
    if (!O || !O.onStoreImage || storeJob) return;
    storeJob = (async function () {
      try {
        while (host) {
          let task = null;
          const list = notes();
          for (let i = 0; i < list.length && !task; i++) {
            const m = modelOf(list[i]);
            if (m.preview && m.preview.image && !m.preview.imageId && !storeMiss[m.preview.image]) task = { n: list[i], url: m.preview.image, kind: 'thumb' };
            else Object.keys(m.avatars).some(function (a) {
              if (m.avatarIds[a] || storeMiss[m.avatars[a]]) return false;
              task = { n: list[i], url: m.avatars[a], kind: 'avatar', name: a }; return true;
            });
          }
          if (!task) break;
          let id = null;
          try { id = await O.onStoreImage(task.url); } catch (e) { id = null; }
          if (!host) break;
          if (!id) { storeMiss[task.url] = true; continue; }
          const m = liveModel(task.n);
          if (task.kind === 'thumb') { if (m.preview && m.preview.image === task.url) m.preview.imageId = id; else { if (O.onDropImage) O.onDropImage(id); continue; } }
          else { if (m.avatars[task.name] === task.url) m.avatarIds[task.name] = id; else { if (O.onDropImage) O.onDropImage(id); continue; } }
          write(task.n, m); if (O.onSave) O.onSave(task.n);
          if (task.kind === 'thumb') refreshRow(task.n, m);   // 卡片改從系統裡拿圖
        }
      } finally { storeJob = null; }
    })();
  }

  // ---------------- 人物誌：有出現過的人物自動列出 ----------------
  function personCard(p) {
    const card = el('article', 'vd-person');
    card.setAttribute('data-key', p.key);
    card.tabIndex = 0;
    card.innerHTML =
      '<div class="vd-person-av' + (p.avatar ? '' : ' is-empty') + '">' +
      (p.avatar ? imgTag(srcOf(p.avatar, p.avatarId), proxied(p.avatar)) : '') +
      '<span class="vd-person-ph">' + esc(p.name.slice(0, 1)) + '</span></div>' +
      '<div class="vd-person-name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
      '<div class="vd-person-meta">' + p.videos.length + ' 部・看過 ' + p.watches + ' 次</div>' +
      (p.last ? '<div class="vd-person-last">最近看：' + esc(fmtDay(p.last)) + '</div>' : '');
    card.addEventListener('click', function () { setFilter('actor', p.name); });
    card.addEventListener('keydown', function (e) { if (e.key === 'Enter') setFilter('actor', p.name); });
    card.addEventListener('contextmenu', function (e) { e.preventDefault(); personMenu(p, e.clientX, e.clientY); });
    return card;
  }
  function personMenu(p, x, y) {
    menuAt(x, y, [['videos', '看這個人的影片'], ['photo', '重新找照片'], null, ['remove', '從所有影片拿掉', false, true]], function (a) {
      if (a === 'videos') setFilter('actor', p.name);
      else if (a === 'photo') {
        delete avatarMiss[p.key];
        notes().forEach(function (n) {
          const m = liveModel(n);
          const k = Object.keys(m.avatars).find(function (a) { return a.toLowerCase() === p.key; });
          if (!k) return;
          if (m.avatarIds[k] && O.onDropImage) O.onDropImage(m.avatarIds[k]);   // 舊照片從系統裡刪掉
          delete m.avatars[k]; delete m.avatarIds[k]; delete m.verified[k];
          write(n, m); if (O.onSave) O.onSave(n);
        });
        if (view === 'people') paint();
      } else if (a === 'remove') {
        removePerson(p.key, p.name);
        toast('已把「' + p.name + '」從所有影片拿掉');
        if (view === 'people') paint();
      }
    });
  }
  function paintPeople(body) {
    const people = peopleIndex();
    const tools = el('div', 'vd-tools');
    tools.innerHTML =
      '<div class="search-box vd-search"><input type="search" placeholder="搜尋人物…" value="' + esc(peopleQuery) + '" aria-label="搜尋人物"></div>' +
      '<span class="vd-people-n">' + people.length + ' 位</span><span class="vd-people-st"></span>';
    if (people.length) body.appendChild(tools);
    const grid = el('div', 'vd-people');
    body.appendChild(grid);
    const st = tools.querySelector('.vd-people-st');
    function fill() {
      grid.innerHTML = '';
      const q = peopleQuery.trim().toLowerCase();
      const rows = people.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) >= 0; });
      if (!rows.length) grid.appendChild(el('div', 'vd-empty', people.length ? '沒有符合的人物。' : ic('users') + '<p>還沒有人物。影片填了人物就會自動出現在這裡，照片也會自己找。</p>'));
      rows.forEach(function (p) { grid.appendChild(personCard(p)); });
      const missing = people.filter(function (p) { return !p.avatar && !avatarMiss[p.key]; }).length;
      st.textContent = missing ? '正在找 ' + missing + ' 位的照片…' : '';
    }
    fill();
    tools.querySelector('input').addEventListener('input', function (e) { peopleQuery = e.target.value; fill(); });
    ensureAvatars(function (p, info, renamed) {
      if (view !== 'people' || !host) return;
      // 就地換那一張卡；改了名就整個重算（鍵變了）
      if (renamed) { paint(); return; }
      const fresh = peopleIndex().find(function (x) { return x.key === p.key; });
      const old = grid.querySelector('.vd-person[data-key="' + CSS.escape(p.key) + '"]');
      if (fresh && old && fresh.avatar !== p.avatar) old.replaceWith(personCard(fresh));
      if (fresh) Object.assign(p, fresh);
      const missing = peopleIndex().filter(function (x) { return !x.avatar && !avatarMiss[x.key]; }).length;
      st.textContent = missing ? '正在找 ' + missing + ' 位的照片…' : '';
    });
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
      m.actors.forEach(function (a) {
        const an = node('a:' + a.toLowerCase(), 'actor', a);
        // 人物節點帶大頭照（graph.js 畫成圓形照片）：存進系統的優先，沒有才走代理
        if (!an.image && m.avatars[a]) an.image = srcOf(m.avatars[a], m.avatarIds[a]);
        edge(v.id, 'a:' + a.toLowerCase(), 'actor');
      });
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
    // 還沒有照片的人物在背景找，找到一張就把那顆節點換成照片（不重畫、不重排）
    ensureAvatars(function (p, info, renamed) {
      if (view !== 'graph' || !graphView) return;
      if (renamed) { paint(); return; }
      if (info.image && graphView.setNodeImage) graphView.setNodeImage('a:' + p.key, proxied(safeUrl(info.image)));
    });
  }

  // ---------------- 統計 ----------------
  function stats(list) {
    const actors = {}, tags = {}, langs = {}, subs = {}, months = {};
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
      const sb = m.subtitle || '未填';
      subs[sb] = subs[sb] || { name: sb, videos: 0, watches: 0 }; subs[sb].videos++; subs[sb].watches += m.watches.length;
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
      tagsByVideos: sortBy(tags, 'videos').slice(0, 10), langs: sortBy(langs, 'videos'), subtitles: sortBy(subs, 'videos'),
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
      barList('字幕', s.subtitles, function (r) { return r.videos; }, function (r) { return r.name; }, function (r) { return r.name === '未填' ? '' : 'data-subtitle="' + esc(r.name) + '"'; }, '部') +
      '<section class="vd-st-sec"><h3>最近觀看</h3>' + (s.recent.length ? '<ul class="vd-recent">' + s.recent.map(function (e) { return '<li data-id="' + esc(e.n.id) + '"><span class="vd-recent-t">' + esc(fmtStamp(e.s)) + '</span><span class="vd-recent-n">' + esc(e.n.title) + '</span></li>'; }).join('') + '</ul>' : '<div class="vd-st-none">還沒有觀看紀錄</div>') + '</section>' +
      '</div>';
    body.appendChild(wrap);
    wrap.addEventListener('click', function (e) {
      let b;
      if ((b = e.target.closest('[data-actor]'))) { setFilter('actor', b.getAttribute('data-actor')); return; }
      if ((b = e.target.closest('[data-tag]'))) { setFilter('tag', b.getAttribute('data-tag')); return; }
      if ((b = e.target.closest('[data-lang]'))) { setFilter('lang', b.getAttribute('data-lang')); return; }
      if ((b = e.target.closest('[data-subtitle]'))) { setFilter('subtitle', b.getAttribute('data-subtitle')); return; }
      if ((b = e.target.closest('[data-id]'))) { const n = byId(b.getAttribute('data-id')); if (n) openModal(n); }
    });
  }

  // ---------------- 靜態：```video 圍欄在預覽／版本歷史裡的樣子 ----------------
  function blockHTML(code) {
    const m = parse('```video\n' + code + '\n```');
    return '<div class="vds-card">' +
      '<div class="vds-row">' + (m.code ? '<span class="vds-code">' + esc(m.code) + '</span>' : '') + (m.lang ? '<span class="vds-lang">' + esc(m.lang) + '</span>' : '') + (m.subtitle ? '<span class="vds-lang">' + esc(m.subtitle) + '</span>' : '') + '<span class="vds-n">看過 ' + m.watches.length + ' 次</span></div>' +
      (m.url ? '<div class="vds-url"><a href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer">' + esc(m.url) + '</a></div>' : '') +
      (m.actors.length ? '<div class="vds-row">人物：' + m.actors.map(esc).join('、') + '</div>' : '') +
      (m.tags.length ? '<div class="vds-row">' + m.tags.map(function (t) { return '<span class="vds-tag">#' + esc(t) + '</span>'; }).join(' ') + '</div>' : '') +
      (m.notes ? '<div class="vds-notes">' + esc(m.notes) + '</div>' : '') +
      '</div>';
  }

  global.Videos = {
    render: render, refresh: refresh, open: open, teardown: teardown, saved: saved,
    isNote: isNote, isWatch: isWatch, parse: parse, generate: generate, parseWatch: parseWatch, generateWatch: generateWatch,
    blockHTML: blockHTML, stats: stats, buildGraph: buildGraph, parseBatch: parseBatch, peopleIndex: peopleIndex,
    isOpen: function () { return !!modal; }
  };
})(window);
