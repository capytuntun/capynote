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
 *     preview: { title, description, image, imageId, custom, site } }
 *
 * preview.imageId 是存進系統的縮圖；custom: 1 表示那張是使用者自己上傳的（對話框「上傳縮圖」、拖
 * 進來、Ctrl+V、卡片選單），重抓預覽、換網址都不會蓋掉它。人物的自訂資料（名字、自訂別名、自訂
 * 照片、備註）是一人一篇 meta: { video, person } 的筆記、內文一個 ```person 圍欄（isPerson／
 * parsePerson）：疊在影片算出來的人物誌上面，刪影片不會跟著不見，「從所有影片拿掉」才會刪。
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
  // 人物資料：使用者自己編輯的那一份（名字、自訂別名、自訂照片、備註），一人一篇 meta: { video, person }
  // 的筆記、內文一個 ```person 圍欄——不放在影片裡，所以刪了影片也不會跟著不見；人物誌把它疊在
  // 影片算出來的資料上面（自訂照片蓋過資料庫的、自訂別名併進去）。有這篇就代表使用者接手了這個人：
  // 背景查核不再自動改她的名字。
  function isPerson(n) { return !!(n && n.meta && n.meta.person); }
  const PERSON_FENCE = /```person[^\n]*\n([\s\S]*?)\n```/;
  function parsePerson(text) {
    let raw = null;
    try { const m = PERSON_FENCE.exec(String(text || '')); raw = m ? JSON.parse(m[1]) : null; } catch (e) { raw = null; }
    raw = raw && typeof raw === 'object' ? raw : {};
    return { name: str(raw.name, 60).trim(), aliases: cleanList(raw.aliases, 20, 60), note: str(raw.note, 5000), imageId: safeId(raw.imageId), added: /^\d{4}-\d{2}-\d{2}$/.test(raw.added || '') ? raw.added : today() };
  }
  function generatePerson(p) { return '```person\n' + JSON.stringify(parsePerson('```person\n' + JSON.stringify(p || {}) + '\n```'), null, 2) + '\n```\n'; }
  function payloadOf(text) { const m = FENCE.exec(String(text || '')); return m ? m[1] : ''; }
  function blank() { return { url: '', code: '', movieTitle: '', actors: [], avatars: {}, avatarIds: {}, verified: {}, aliases: {}, works: {}, lang: '', subtitle: '', tags: [], released: '', duration: 0, maker: '', watches: [], notes: '', added: today(), preview: null }; }
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
    m.aliases = cleanMap(raw.aliases, m.actors, function (v) { const a = cleanList(v, 20, 60); return a.length ? a : null; });   // 資料庫上的別名
    m.works = cleanMap(raw.works, m.actors, function (v) { const n = Number(v); return n > 0 && n < 1e6 ? Math.floor(n) : null; });  // 資料庫上的作品數
    m.lang = str(raw.lang, 30).trim();
    m.subtitle = str(raw.subtitle, 30).trim();
    m.tags = cleanList(raw.tags, 40, 40, true);
    m.released = /^\d{4}-\d{2}-\d{2}$/.test(raw.released || '') ? raw.released : '';
    m.duration = Number.isFinite(Number(raw.duration)) && Number(raw.duration) > 0 ? Math.min(2000, Math.floor(Number(raw.duration))) : 0;
    m.maker = str(raw.maker, 120).trim();
    m.watches = (Array.isArray(raw.watches) ? raw.watches : []).filter(function (s) { return typeof s === 'string' && STAMP.test(s); }).slice(0, 5000).sort();
    m.notes = str(raw.notes, 5000);
    m.added = /^\d{4}-\d{2}-\d{2}$/.test(raw.added || '') ? raw.added : today();
    if (raw.preview && typeof raw.preview === 'object') {
      const p = raw.preview;
      m.preview = { title: str(p.title, 200), description: str(p.description, 300), image: safeUrl(p.image), imageId: safeId(p.imageId), site: str(p.site, 80) };
      // custom：縮圖是使用者自己上傳的（imageId 不是從 image 網址存來的）——沒有 image 網址也成立，
      // 重抓預覽／換網址都不碰它，只有「用網站的圖」或刪影片才拿掉
      if (p.custom && m.preview.imageId) m.preview.custom = 1;
      if (!m.preview.image && !m.preview.custom) m.preview.imageId = '';
      if (!m.preview.title && !m.preview.image && !m.preview.description && !m.preview.custom) m.preview = null;
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
  // 存進系統的縮圖 id：從網址存來的要網址還在才算（網址換了就重存），自己上傳的（custom）一律算
  function thumbId(m) { const p = m.preview; return p && p.imageId && (p.custom || p.image) ? p.imageId : ''; }
  function thumbSrc(m) { return srcOf(thumbOf(m), thumbId(m)); }
  function hasThumb(m) { return !!(thumbOf(m) || thumbId(m)); }
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
  let view = 'list';                   // list | watch | people | person | graph | stats
  let personKey = '';                  // view === 'person' 時看的是誰（小寫名字）
  let watchQuery = '';
  let query = '';
  let peopleQuery = '';
  let filter = { actor: null, tags: [], lang: null, subtitle: null };   // tags 是複選（AND），分類區可以一次點好幾個
  let sort = (function () { try { return localStorage.getItem(LS_SORT) || 'added'; } catch (e) { return 'added'; } })();
  let listMode = (function () { try { return localStorage.getItem(LS_MODE) === 'table' ? 'table' : 'cards'; } catch (e) { return 'cards'; } })();
  // 圖片預設模糊（縮圖、大頭照、關聯圖的照片），頁首「顯示圖片」按一下全部打開；每次進影片頁都回到模糊，
  // 不記住。class 掛在 <html> 上，對話框這種 body 底下的疊層也遮得到（app.css 的 .vd-blur）。
  let revealed = false;
  function applyBlur() { document.documentElement.classList.toggle('vd-blur', !!host && !revealed); }
  function setRevealed(on) {
    revealed = !!on;
    applyBlur();
    const b = host && host.querySelector('.vd-reveal');
    if (b) {
      b.classList.toggle('is-on', revealed);
      b.setAttribute('aria-pressed', String(revealed));
      b.innerHTML = ic(revealed ? 'eye-off' : 'eye') + '<span>' + (revealed ? '隱藏圖片' : '顯示圖片') + '</span>';
    }
    armIdle();
  }
  // 快速離開：頁首「離開」或 Esc 連按兩下（600 ms 內、沒有對話框／選單開著）→ 全部模糊、回首頁（O.onLeave）
  // 閒置自動模糊：圖片打開著、5 分鐘沒動（滑鼠、鍵盤、捲動）就自動遮回去
  const IDLE_MS = 5 * 60 * 1000;
  let idleTimer = null, lastEsc = 0;
  function armIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (host && revealed) idleTimer = setTimeout(function () { idleTimer = null; if (host && revealed) { setRevealed(false); toast('閒置太久，圖片已自動模糊'); } }, IDLE_MS);
  }
  function onActivity() { if (idleTimer) armIdle(); }
  function leaveNow() {
    closeMenu(); closeModal(true); closeBatch(); closePersonEdit(false);
    setRevealed(false);
    if (O && O.onLeave) O.onLeave(); else teardown();
  }
  function onGlobalKey(e) {
    if (!host || e.key !== 'Escape') return;
    if (modal || batch || menuEl || pedit) { lastEsc = 0; return; }   // 對話框開著的 Esc 是關它，不算
    const now = Date.now();
    if (now - lastEsc < 600) { lastEsc = 0; e.preventDefault(); leaveNow(); }
    else lastEsc = now;
  }
  function bindGlobal() {
    document.addEventListener('keydown', onGlobalKey);
    ['mousemove', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, onActivity, { passive: true }); });
  }
  function unbindGlobal() {
    document.removeEventListener('keydown', onGlobalKey);
    ['mousemove', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) { document.removeEventListener(ev, onActivity); });
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
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

  function notes() { return ((O && O.notes) || []).filter(function (n) { return !isWatch(n) && !isPerson(n); }); }
  function watchNotes() { return ((O && O.notes) || []).filter(isWatch); }
  function personNotes() { return ((O && O.notes) || []).filter(isPerson); }
  // 某個人（小寫名字）的自訂資料筆記，沒有回 null；profileOf 回解析好的內容（沒有筆記回 null）
  function personNoteOf(key) { return personNotes().find(function (n) { return parsePerson(n.content).name.toLowerCase() === key; }) || null; }
  function byId(id) { return notes().find(function (n) { return n.id === id; }) || null; }
  function allActors() { const s = {}; notes().forEach(function (n) { modelOf(n).actors.forEach(function (a) { s[a] = 1; }); }); return Object.keys(s).sort(); }
  function allTags() { const s = {}; notes().forEach(function (n) { modelOf(n).tags.forEach(function (a) { s[a] = 1; }); }); return Object.keys(s).sort(); }
  function allLangs() { const s = {}; LANGS.forEach(function (l) { s[l] = 1; }); notes().forEach(function (n) { const l = modelOf(n).lang; if (l) s[l] = 1; }); return Object.keys(s); }
  // 嚴格規則：人物要「查過資料庫、確定是女性」（verified，記在那個人任一部影片裡）才算存在——
  // 卡片的晶片、人物誌、關聯圖、統計都只看 verified 的；還沒驗過的只在編輯欄位裡以「查核中」出現，
  // 驗出男性或查不到就從所有影片拿掉（ensureAvatars）。
  function verifiedKeys() {
    const vk = {};
    notes().forEach(function (n) { const v = modelOf(n).verified; Object.keys(v).forEach(function (k) { vk[k.toLowerCase()] = true; }); });
    return vk;
  }
  function shownActors(m, vk) { return m.actors.filter(function (a) { return vk[a.toLowerCase()]; }); }
  // 人物誌的資料：每個出現過的人物一筆（名字以第一次出現的寫法為準），帶影片、觀看次數、照片
  // （外部網址 avatar 與存進系統的 avatarId）、查過沒有（verified）
  function peopleIndex() {
    const map = {};
    notes().forEach(function (n) {
      const m = modelOf(n);
      m.actors.forEach(function (a) {
        const k = a.toLowerCase();
        const p = map[k] || (map[k] = { key: k, name: a, videos: [], watches: 0, avatar: '', avatarId: '', verified: false, aliases: [], works: 0, last: '' });
        p.videos.push(n);
        p.watches += m.watches.length;
        if (!p.avatar && m.avatars[a]) { p.avatar = m.avatars[a]; p.avatarId = m.avatarIds[a] || ''; }
        if (m.verified[a]) p.verified = true;
        if (m.aliases[a]) m.aliases[a].forEach(function (x) { if (x.toLowerCase() !== k && p.aliases.indexOf(x) < 0) p.aliases.push(x); });
        if (m.works[a] && !p.works) p.works = m.works[a];
        const lw = lastWatch(m);
        if (lw > p.last) p.last = lw;
      });
    });
    // 使用者自己編輯的資料疊上去：自訂照片蓋過資料庫的、自訂別名併進去、備註；沒有影片了也還列著
    // （那是使用者寫的，刪影片不該連資料一起不見；「從所有影片拿掉」才會刪）
    personNotes().forEach(function (n) {
      const pr = parsePerson(n.content);
      if (!pr.name) return;
      const k = pr.name.toLowerCase();
      const p = map[k] || (map[k] = { key: k, name: pr.name, videos: [], watches: 0, avatar: '', avatarId: '', verified: true, aliases: [], works: 0, last: '' });
      p.profile = n; p.note = pr.note; p.verified = true;
      if (pr.imageId) { p.avatarId = pr.imageId; p.avatar = ''; p.custom = true; }
      pr.aliases.forEach(function (x) { if (x.toLowerCase() !== k && !p.aliases.some(function (y) { return y.toLowerCase() === x.toLowerCase(); })) p.aliases.push(x); });
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.videos.length - a.videos.length || b.watches - a.watches || a.name.localeCompare(b.name, 'zh-Hant'); });
  }
  function hasPhoto(p) { return !!(p.avatar || p.avatarId); }

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
    revealed = false;
    applyBlur();
    unbindGlobal(); bindGlobal();
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
  function dropUrls() {
    Object.keys(urlMap).forEach(function (id) { try { URL.revokeObjectURL(urlMap[id]); } catch (e) { /* ignore */ } delete urlMap[id]; });
  }
  function teardown() {
    flushSaves();
    closeModal(false);
    closeBatch();
    closePersonEdit(false);
    teardownView();
    host = null;
    revealed = false;
    applyBlur();
    unbindGlobal();
    dropUrls();                        // blob: 網址只活在這一次開頁裡（本機快取本身留著）
    avatarMiss = {}; storeMiss = {};   // 「查過沒有／存不進去」只活在這一次開頁裡
  }

  function paint() {
    if (!host) return;
    aliasMemo = null;
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
      [['list', 'list', '清單'], ['watch', 'eye', '觀察區'], ['people', 'users', '人物誌'], ['tags', 'tag', '分類'], ['graph', 'graph', '關聯圖'], ['stats', 'chart', '統計']].map(function (t) {
        const on = view === t[0] || (view === 'person' && t[0] === 'people');
        return '<button class="vd-tab' + (on ? ' is-active' : '') + '" type="button" data-view="' + t[0] + '" aria-pressed="' + on + '">' + ic(t[1]) + '<span>' + t[2] + '</span></button>';
      }).join('') + '</nav>' +
      '<button class="btn vd-reveal' + (revealed ? ' is-on' : '') + '" type="button" aria-pressed="' + revealed + '" title="圖片預設是模糊的，按一下全部顯示；再按一下遮回去">' + ic(revealed ? 'eye-off' : 'eye') + '<span>' + (revealed ? '隱藏圖片' : '顯示圖片') + '</span></button>' +
      '<button class="btn vd-panic" type="button" title="立刻全部模糊並回到首頁（Esc 連按兩下也可以）">' + ic('lock') + '<span>離開</span></button>' +
      '<button class="btn vd-batch" type="button" title="貼一份網址清單，一次新增多部（可以帶全名）">' + ic('list') + '<span>批次新增</span></button>' +
      '<button class="btn btn-primary vd-add" type="button">' + ic('plus') + '<span>新增影片</span></button></div>';
    host.appendChild(head);
    const tabs = head.querySelector('.vd-tabs');
    const body = el('div', 'vd-body');
    host.appendChild(body);
    if (view === 'graph') paintGraph(body);
    else if (view === 'stats') paintStats(body);
    else if (view === 'people') paintPeople(body);
    else if (view === 'person') paintPerson(body);
    else if (view === 'tags') paintTags(body);
    else if (view === 'watch') paintWatch(body);
    else paintList(body);
    hydrate(host);    // 有 id 的圖從本機快取填進去
    ensureStored();   // 還是外部網址的縮圖／照片在背景存進系統
    if (view === 'list' || view === 'watch' || view === 'stats') ensureAvatars(function (p, info, changed) {
      // 人物誌／關聯圖自己掛了更新；這幾頁驗出結果就重畫一次（卡片的晶片、統計的排行會變）
      if (changed || (info && !info.error)) refresh();
    });

    head.querySelector('.vd-add').addEventListener('click', function () { openModal(null); });
    head.querySelector('.vd-batch').addEventListener('click', function () { openBatch(); });
    head.querySelector('.vd-reveal').addEventListener('click', function () { setRevealed(!revealed); });
    head.querySelector('.vd-panic').addEventListener('click', function () { leaveNow(); });
    tabs.addEventListener('click', function (e) {
      const b = e.target.closest('[data-view]');
      if (b) setView(b.getAttribute('data-view'));
    });
  }
  function setView(v) { if (v === view) return; view = v; paint(); }
  function openPerson(key) { personKey = String(key || '').toLowerCase(); view = 'person'; paint(); if (host) host.scrollIntoView && window.scrollTo(0, 0); }
  function emptyFilter() { return { actor: null, tags: [], lang: null, subtitle: null }; }
  function setFilter(kind, value) {
    filter = emptyFilter();
    if (kind === 'tag') filter.tags = [value];
    else if (kind) filter[kind] = value;
    if (view !== 'list') view = 'list';
    paint();
  }
  function hasFilter() { return !!(filter.actor || filter.lang || filter.subtitle || filter.tags.length); }

  // 人物別名（存在那個人第一部影片裡）→ 每部影片搜尋時都查得到：每次重畫算一次
  let aliasMemo = null;
  function aliasMap() {
    if (aliasMemo) return aliasMemo;
    const map = {};
    notes().forEach(function (n) { const m = modelOf(n); Object.keys(m.aliases).forEach(function (k) { map[k.toLowerCase()] = (map[k.toLowerCase()] || []).concat(m.aliases[k]); }); });
    personNotes().forEach(function (n) { const pr = parsePerson(n.content); if (pr.name && pr.aliases.length) map[pr.name.toLowerCase()] = (map[pr.name.toLowerCase()] || []).concat(pr.aliases); });
    aliasMemo = map;
    return map;
  }
  function matches(n) {
    const m = modelOf(n);
    if (filter.actor && !m.actors.some(function (a) { return a.toLowerCase() === filter.actor.toLowerCase(); })) return false;
    if (filter.tags.length && !filter.tags.every(function (t) { return m.tags.some(function (a) { return a.toLowerCase() === t.toLowerCase(); }); })) return false;
    if (filter.lang && (m.lang || '').toLowerCase() !== filter.lang.toLowerCase()) return false;
    if (filter.subtitle && (m.subtitle || '').toLowerCase() !== filter.subtitle.toLowerCase()) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const am = aliasMap();
    const aliases = m.actors.reduce(function (acc, a) { return acc.concat(am[a.toLowerCase()] || []); }, []);
    const hay = [n.title, m.code, m.movieTitle, m.lang, m.subtitle, m.maker, m.released, m.notes, m.url, m.preview && m.preview.title].concat(m.actors, aliases, m.tags).join('\n').toLowerCase();
    return hay.indexOf(q) >= 0;
  }
  function lastWatch(m) { return m.watches.length ? m.watches[m.watches.length - 1] : ''; }
  function sorted(list) {
    const arr = list.slice();
    const cmp = {
      added: function (a, b) { return (b.m.added + (b.n.createdAt || 0)).localeCompare(a.m.added + (a.n.createdAt || 0)) || (b.n.createdAt || 0) - (a.n.createdAt || 0); },
      watched: function (a, b) { return lastWatch(b.m).localeCompare(lastWatch(a.m)); },
      count: function (a, b) { return b.m.watches.length - a.m.watches.length; },
      released: function (a, b) { return (b.m.released || '0').localeCompare(a.m.released || '0'); },   // 沒有發行日的排最後
      title: function (a, b) { return String(a.n.title || '').localeCompare(String(b.n.title || ''), 'zh-Hant'); }
    }[sort] || null;
    return arr.map(function (n) { return { n: n, m: modelOf(n) }; }).sort(cmp || function () { return 0; });
  }

  function paintList(body) {
    const tools = el('div', 'vd-tools');
    const fl = [];
    if (filter.actor) fl.push(['actor', '人物：' + filter.actor]);
    filter.tags.forEach(function (t) { fl.push(['tag:' + t, '#' + t]); });
    if (filter.lang) fl.push(['lang', '語言：' + filter.lang]);
    if (filter.subtitle) fl.push(['subtitle', '字幕：' + filter.subtitle]);
    tools.innerHTML =
      '<div class="search-box vd-search"><input type="search" placeholder="搜尋標題、編號、人物、標籤…" value="' + esc(query) + '" aria-label="搜尋影片"></div>' +
      '<select class="vd-sort" aria-label="排序">' +
      [['added', '最近新增'], ['watched', '最近看過'], ['count', '看最多次'], ['released', '發行日'], ['title', '標題']].map(function (s) { return '<option value="' + s[0] + '"' + (sort === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') +
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
      cardVk = verifiedKeys();
      rows.forEach(function (r) { grid.appendChild(makeCard(r.n, r.m)); });
      cardVk = null;
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
      if (!b) return;
      clearFilter(b.getAttribute('data-clear'));
      paint();
    });
  }
  // 拿掉一個篩選條件：'actor' | 'lang' | 'subtitle' | 'tag:<名字>'
  function clearFilter(key) {
    if (key.indexOf('tag:') === 0) { const t = key.slice(4).toLowerCase(); filter.tags = filter.tags.filter(function (x) { return x.toLowerCase() !== t; }); }
    else filter[key] = null;
  }
  function repaintGrid(grid) {
    aliasMemo = null;
    const rows = sorted(notes().filter(matches));
    if (grid.classList.contains('vd-tablewrap')) { fillTable(grid, rows); return; }
    grid.innerHTML = '';
    if (!rows.length) grid.appendChild(el('div', 'vd-empty', '沒有符合的影片。'));
    cardVk = verifiedKeys();
    rows.forEach(function (r) { grid.appendChild(makeCard(r.n, r.m)); });
    cardVk = null;
  }
  // 清單裡代表這部影片的那一塊（卡片或表格列）換成新的
  function refreshRow(n, m) {
    if (!host || view !== 'list') return;
    const card = host.querySelector('.vd-card[data-id="' + n.id + '"]');
    if (card) { const fresh = makeCard(n, m); card.replaceWith(fresh); hydrate(fresh); return; }
    const row = host.querySelector('.vd-row[data-id="' + n.id + '"]');
    if (row && !row.contains(document.activeElement)) { const fresh = makeRow(n, m); row.replaceWith(fresh); hydrate(fresh); }
    else if (row) { const c = row.querySelector('.vd-t-count'); if (c) c.textContent = m.watches.length; }
  }
  // 一部影片（或一篇人物資料）硬刪時，它存的縮圖／大頭照跟著刪：系統裡的那份（伺服器只認內文裡的
  // img:<id> 引用，圍欄 JSON 裡的 imageId 它看不到，所以要從這裡刪）跟本機快取的那份（app.js 的
  // onDelete／onDeleteNow 叫）
  function dropNoteImages(n) {
    if (isPerson(n)) { dropImage(parsePerson(n.content).imageId); return; }
    const m = parse(n && n.content || '');
    if (m.preview && m.preview.imageId) dropImage(m.preview.imageId);
    Object.keys(m.avatarIds).forEach(function (k) { dropImage(m.avatarIds[k]); });
  }

  // ---------------- 表格：每一格直接改，改了 600 ms 後自動存 ----------------
  // 一列一部影片：縮圖、標題、網址、編號、全名、人物、語言、字幕、hashtag、備註、看過、更多。
  // 每個 input 的 input 事件 → setField()：重新 parse 這部的 model、改那個欄位、write()、排存檔。
  // 人物與 hashtag 用同一個 chipInput（緊湊版樣式）。網址改了跟對話框一樣 700 ms 後抓預覽，
  // 把還空著的編號／全名／人物／照片／縮圖補進去（已經填的不動）。表格上有格子正在打字時，
  // refresh() 不整頁重畫（會把正在打的字跟焦點弄掉），記下來等焦點離開表格再畫。
  const COLS = [['sel', ''], ['thumb', ''], ['title', '標題'], ['url', '網址'], ['code', '編號'], ['movieTitle', '全名'], ['actors', '人物'], ['lang', '語言'], ['subtitle', '字幕'], ['tags', 'hashtag'], ['released', '發行日'], ['duration', '片長'], ['maker', '片商'], ['notes', '備註'], ['watch', '看過'], ['acts', '']];
  const rowTimers = new Map();   // note id -> 抓預覽的計時器
  const tableSel = new Set();    // 表格勾選的影片 id（整頁重畫後保留；不在畫面上的列在 syncTbar 時掉）
  function setField(n, patch, title) {
    const m = liveModel(n);
    Object.assign(m, patch || {});
    write(n, m, title);
    scheduleSave(n);
  }
  function makeTable(rows) {
    const wrap = el('div', 'vd-tablewrap');
    wrap.innerHTML =
      // 勾了列才出現的批次列：一次改語言／字幕、加 hashtag、刪除
      '<div class="vd-tbar" hidden><span class="vd-tbar-n"></span>' +
      '<label class="vd-tbar-f">語言 <input class="tt-input vd-tbar-lang" type="text" list="vd-dl-lang-t" placeholder="改成…" maxlength="30"></label>' +
      '<label class="vd-tbar-f">字幕 <input class="tt-input vd-tbar-subtitle" type="text" list="vd-dl-subtitle-t" placeholder="改成…" maxlength="30"></label>' +
      '<button class="btn vd-tbar-tag" type="button">' + ic('tag') + '<span>加 hashtag…</span></button>' +
      '<button class="btn btn-danger vd-tbar-del" type="button">' + ic('trash') + '<span>刪除</span></button>' +
      '<button class="icon-btn vd-tbar-x" type="button" title="取消選取">' + ic('x') + '</button></div>' +
      '<table class="vd-table"><colgroup>' + COLS.map(function (c) { return '<col class="vd-col-' + c[0] + '">'; }).join('') + '</colgroup>' +
      '<thead><tr>' + COLS.map(function (c) { return '<th class="vd-th-' + c[0] + '">' + (c[0] === 'sel' ? '<input type="checkbox" class="vd-t-selall" title="全選／取消全選">' : esc(c[1])) + '</th>'; }).join('') + '</tr></thead><tbody></tbody></table>' +
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
    // ---- 批次操作 ----
    const selAll = wrap.querySelector('.vd-t-selall');
    selAll.addEventListener('change', function () {
      wrap.querySelectorAll('.vd-row').forEach(function (tr) { const id = tr.getAttribute('data-id'); if (selAll.checked) tableSel.add(id); else tableSel.delete(id); tr.querySelector('.vd-t-sel').checked = selAll.checked; });
      syncTbar(wrap);
    });
    wrap.addEventListener('change', function (e) {
      const cb = e.target.closest('.vd-t-sel');
      if (!cb) return;
      const id = cb.closest('.vd-row').getAttribute('data-id');
      if (cb.checked) tableSel.add(id); else tableSel.delete(id);
      syncTbar(wrap);
    });
    const selectedNotes = function () { return notes().filter(function (n) { return tableSel.has(n.id); }); };
    const applyAll = function (fn) {
      const list = selectedNotes();
      list.forEach(function (n) { const m = liveModel(n); if (fn(m) !== false) { write(n, m); if (O.onSave) O.onSave(n); } });
      aliasMemo = null;
      fillTable(wrap, sorted(notes().filter(matches)));
      toast('已套用到 ' + list.length + ' 部');
    };
    const onEnter = function (sel, field) {
      const inp = wrap.querySelector(sel);
      inp.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        const v = inp.value.trim(); if (!v) return;
        applyAll(function (m) { m[field] = v; });
        inp.value = '';
      });
      inp.addEventListener('change', function () { const v = inp.value.trim(); if (v) { applyAll(function (m) { m[field] = v; }); inp.value = ''; } });
    };
    onEnter('.vd-tbar-lang', 'lang');
    onEnter('.vd-tbar-subtitle', 'subtitle');
    wrap.querySelector('.vd-tbar-tag').addEventListener('click', function () {
      const ask = global.App && App.prompt ? App.prompt({ title: '加 hashtag', message: '逗號分隔，可以一次加好幾個', ok: '加入' }) : Promise.resolve(window.prompt('加 hashtag（逗號分隔）'));
      Promise.resolve(ask).then(function (v) {
        if (!v) return;
        const add = cleanList(String(v).split(/[,，\s]+/), 20, 40, true);
        if (!add.length) return;
        applyAll(function (m) { m.tags = cleanList(m.tags.concat(add), 40, 40, true); });
      });
    });
    wrap.querySelector('.vd-tbar-del').addEventListener('click', function () {
      const list = selectedNotes();
      if (!list.length) return;
      const ask = global.App && App.confirm ? App.confirm({ title: '刪除影片', message: '直接刪除這 ' + list.length + ' 部？不會進垃圾桶、不留版本紀錄，無法復原。', ok: '刪除', danger: true }) : Promise.resolve(window.confirm('直接刪除 ' + list.length + ' 部？'));
      Promise.resolve(ask).then(function (yes) {
        if (!yes || !O.onDeleteNow) return;
        (async function () {
          for (let i = 0; i < list.length; i++) { try { dropNoteImages(list[i]); await O.onDeleteNow(list[i]); } catch (e) { /* onDeleteNow 已 toast */ } tableSel.delete(list[i].id); }
          toast('已刪除 ' + list.length + ' 部');
          paint();
        })();
      });
    });
    wrap.querySelector('.vd-tbar-x').addEventListener('click', function () { tableSel.clear(); wrap.querySelectorAll('.vd-t-sel').forEach(function (c) { c.checked = false; }); syncTbar(wrap); });
    syncTbar(wrap);
    return wrap;
  }
  function syncTbar(wrap) {
    const ids = new Set(Array.prototype.map.call(wrap.querySelectorAll('.vd-row'), function (tr) { return tr.getAttribute('data-id'); }));
    Array.from(tableSel).forEach(function (id) { if (!ids.has(id)) tableSel.delete(id); });
    const bar = wrap.querySelector('.vd-tbar');
    bar.hidden = !tableSel.size;
    bar.querySelector('.vd-tbar-n').textContent = '已選 ' + tableSel.size + ' 部';
    const all = wrap.querySelector('.vd-t-selall');
    all.checked = ids.size > 0 && tableSel.size === ids.size;
    all.indeterminate = tableSel.size > 0 && tableSel.size < ids.size;
  }
  function fillTable(wrap, rows) {
    const tb = wrap.querySelector('tbody');
    tb.innerHTML = '';
    if (!rows.length) tb.innerHTML = '<tr class="vd-row-empty"><td colspan="' + COLS.length + '">沒有符合的影片。</td></tr>';
    rows.forEach(function (r) { tb.appendChild(makeRow(r.n, r.m)); });
    const nEl = wrap.querySelector('.vd-table-n');
    if (nEl) nEl.textContent = rows.length + ' 部';
    if (wrap.querySelector('.vd-tbar')) syncTbar(wrap);
  }
  function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; }
  function makeRow(n, m) {
    const tr = el('tr', 'vd-row');
    tr.setAttribute('data-id', n.id);
    tr.innerHTML =
      '<td class="vd-td-sel"><input type="checkbox" class="vd-t-sel"' + (tableSel.has(n.id) ? ' checked' : '') + ' aria-label="選取"></td>' +
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
      '<td><input class="vd-t-in vd-t-released" type="date" value="' + esc(m.released) + '"></td>' +
      '<td><input class="vd-t-in vd-t-duration" type="number" min="0" max="2000" value="' + (m.duration || '') + '" placeholder="分"></td>' +
      '<td><input class="vd-t-in vd-t-maker" type="text" value="' + esc(m.maker) + '" placeholder="片商" maxlength="120" spellcheck="false"></td>' +
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
    on('.vd-t-released', 'released', true);
    on('.vd-t-maker', 'maker', true);
    q('.vd-t-duration').addEventListener('input', function (e) { setField(n, { duration: Number(e.target.value) || 0 }); });
    const notesIn = q('.vd-t-notes');
    notesIn.addEventListener('input', function () { autoGrow(notesIn); setField(n, { notes: notesIn.value }); });
    notesIn.addEventListener('focus', function () { autoGrow(notesIn); });
    notesIn.addEventListener('blur', function () { notesIn.style.height = ''; });
    const actorsChip = chipInput(q('.vd-t-actors'), m.actors, {
      key: 'actors-t', cls: 'is-actor', placeholder: '人物', suggest: allActors(), verify: verifyPerson,
      pending: function (a) { return !liveModel(n).verified[a] && !verifiedKeys()[a.toLowerCase()]; },
      onVerified: function (name, v) { const vf = Object.assign({}, liveModel(n).verified); vf[name] = 1; setField(n, { actors: v, verified: vf }); },
      onChange: function (v) { setField(n, { actors: v }); }
    });
    const tagsChip = chipInput(q('.vd-t-tags'), m.tags, { key: 'tags-t', cls: 'is-tag', prefix: '#', placeholder: '#hashtag', suggest: allTags(), onChange: function (v) { setField(n, { tags: v }); } });
    // 網址：改了就記下來、700 ms 後抓預覽補空欄位；開啟連結的箭頭跟著網址走
    const urlIn = q('.vd-t-url'), openA = q('.vd-t-open');
    urlIn.addEventListener('input', function () {
      const u = safeUrl(urlIn.value);
      const cur = liveModel(n);
      setField(n, { url: u, preview: u === cur.url ? cur.preview : null });
      openA.href = u || '#'; openA.hidden = !u;
      if (rowTimers.has(n.id)) clearTimeout(rowTimers.get(n.id));
      if (u && O.onPreview) rowTimers.set(n.id, setTimeout(function () { rowTimers.delete(n.id); rowPreview(n, u, tr, actorsChip, tagsChip); }, 700));
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
  function rowPreview(n, u, tr, actorsChip, tagsChip) {
    tr.classList.add('is-fetching');
    O.onPreview(u).then(function (info) {
      tr.classList.remove('is-fetching');
      if (!tr.isConnected || liveModel(n).url !== u) return;
      if (!info || info.error) return;
      const m = liveModel(n);
      const patch = {};
      const pv = { title: str(info.title, 200), description: str(info.description, 300), image: safeUrl(info.image), site: str(info.siteName, 80) };
      if (!pv.image) pv.image = ytThumb(u);
      if (m.preview && m.preview.custom) { pv.imageId = m.preview.imageId; pv.custom = 1; }   // 自己上傳的縮圖留著
      patch.preview = (pv.title || pv.image || pv.description || pv.custom) ? pv : null;
      const code = str(info.code, 60).trim() || codeFromUrl(u);
      const codeIn = tr.querySelector('.vd-t-code'), mtIn = tr.querySelector('.vd-t-movietitle'), titleIn = tr.querySelector('.vd-t-title');
      if (code && !m.code) { patch.code = code; codeIn.value = code; }
      const mt = str(info.movieTitle || info.title, 300).trim();
      if (mt && !m.movieTitle) { patch.movieTitle = mt; mtIn.value = mt; }
      const names = peopleNames(info);
      if (names.length && !m.actors.length) { actorsChip.set(names.slice(0, 10)); patch.actors = actorsChip.get(); }
      const av = peopleAvatars(info, patch.actors || m.actors);
      if (Object.keys(av).length) patch.avatars = Object.assign({}, m.avatars, av);
      const vf = peopleVerified(info, patch.actors || m.actors);
      if (Object.keys(vf).length) patch.verified = Object.assign({}, m.verified, vf);
      const extra = detailFields(info, m);
      if (extra.tags) tagsChip.set(extra.tags);
      ['released', 'duration', 'maker'].forEach(function (k) { if (extra[k] !== undefined) { const inp = tr.querySelector('.vd-t-' + k); if (inp) inp.value = extra[k]; } });
      Object.assign(patch, extra);
      let title;
      if (!n.title || n.title === '未命名影片') { title = mt || pv.title || code || n.title; titleIn.value = title; }
      setField(n, patch, title);
      const th = tr.querySelector('.vd-td-thumb');
      if (th) { th.innerHTML = thumbHTML(liveModel(n), 'vd-t-thumb'); hydrate(th); }
    });
  }
  // ---------------- 本機圖片快取（Cache Storage） ----------------
  // 存進系統的圖（有 id 的）在這台電腦也留一份：顯示時先從本機拿，沒有才向伺服器要一次並存起來。
  // 使用者說圖可以存在本地，但「刪除就要直接刪」：影片硬刪、換照片、拿掉人物時 cacheDrop() 連本機
  // 這份一起刪（app.js 的 onDelete → Videos.dropNoteImages）。Cache Storage 只在 https／localhost 有，
  // 沒有就退回直接向伺服器要（伺服器那邊有一年的 immutable 快取）。urlMap 是這次開頁已經拿到的
  // blob: 網址，重畫時同步可用，離開頁面時 revoke。
  const CACHE_NAME = 'capynote-vd-img';
  const urlMap = {};                     // img id -> blob: url
  const fetching = {};                   // img id -> Promise
  function cacheStore() { try { return (window.isSecureContext && window.caches) ? caches.open(CACHE_NAME) : Promise.reject(new Error('no cache')); } catch (e) { return Promise.reject(e); } }
  function cacheKey(id) { return '/api/images/' + encodeURIComponent(id); }
  function cachePut(id, blob) {
    if (!id || !blob) return Promise.resolve();
    return cacheStore().then(function (c) { return c.put(cacheKey(id), new Response(blob, { headers: { 'Content-Type': blob.type || 'image/webp' } })); }).catch(function () {});
  }
  function cacheDrop(id) {
    if (!id) return;
    if (urlMap[id]) { try { URL.revokeObjectURL(urlMap[id]); } catch (e) { /* ignore */ } delete urlMap[id]; }
    cacheStore().then(function (c) { return c.delete(cacheKey(id)); }).catch(function () {});
  }
  // 不要了的存圖：系統裡的（伺服器）跟本機快取的一起刪
  function dropImage(id) { if (!id) return; cacheDrop(id); if (O && O.onDropImage) O.onDropImage(id); }
  // 拿到這張圖的 blob: 網址：urlMap → 本機快取 → 向伺服器要一次（存進本機）。拿不到回 ''
  function imageUrl(id) {
    if (urlMap[id]) return Promise.resolve(urlMap[id]);
    if (fetching[id]) return fetching[id];
    fetching[id] = cacheStore()
      .then(function (c) { return c.match(cacheKey(id)); }, function () { return null; })
      .then(function (hit) {
        if (hit) return hit.blob();
        return fetch(cacheKey(id), { credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) throw new Error('http ' + r.status);
          return r.blob().then(function (b) { cachePut(id, b); return b; });
        });
      })
      .then(function (blob) { const u = URL.createObjectURL(blob); urlMap[id] = u; return u; })
      .catch(function () { return ''; })
      .then(function (u) { delete fetching[id]; return u; });
    return fetching[id];
  }
  // 把 root 底下帶 data-vid 的 <img> 填上圖：同步有的直接給，沒有的等 imageUrl()；拿不到就退回 data-fb（代理原網址）
  function hydrate(root) {
    if (!root) return;
    root.querySelectorAll('img[data-vid]').forEach(function (img) {
      const id = img.getAttribute('data-vid');
      img.removeAttribute('data-vid');
      if (urlMap[id]) { img.src = urlMap[id]; return; }
      imageUrl(id).then(function (u) {
        if (!img.isConnected) return;
        if (u) img.src = u;
        else if (img.dataset.fb) { img.src = img.dataset.fb; delete img.dataset.fb; }
        else img.dispatchEvent(new Event('error'));
      });
    });
  }
  // 存進系統前先在瀏覽器縮小：卡片只有 230px 寬，原圖一兩百 KB 是白傳；轉 WebP
  function shrink(blob, maxW) {
    if (!blob || !window.createImageBitmap) return Promise.resolve(blob);
    return createImageBitmap(blob).then(function (bm) {
      const scale = Math.min(1, maxW / bm.width);
      const w = Math.max(1, Math.round(bm.width * scale)), h = Math.max(1, Math.round(bm.height * scale));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(bm, 0, 0, w, h);
      bm.close && bm.close();
      return new Promise(function (res) { cv.toBlob(function (b) { res(b || blob); }, 'image/webp', 0.82); });
    }, function () { return blob; });
  }
  // ---------------- 使用者自己上傳的圖：影片縮圖、人物照片 ----------------
  // 選檔（或拖進來、貼上）→ 跟抓來的圖一樣在瀏覽器縮小、存成 hidden 上傳、放進本機快取；回 id，失敗回 null。
  // 縮圖記在 preview.imageId 加 custom: 1（重抓預覽、換網址都不碰），人物照片記在那個人的資料筆記裡。
  function storeFile(file, maxW) {
    if (!file || !/^image\//.test(file.type || '')) { toast('請選一張圖片檔'); return Promise.resolve(null); }
    if (!O || !O.onStoreImageBytes) { toast('這裡不能上傳圖片'); return Promise.resolve(null); }
    return shrink(file, maxW).then(function (small) {
      if (!small) return null;
      return O.onStoreImageBytes(small).then(function (id) {
        if (!id) return null;
        return cachePut(id, small).then(function () { return id; });
      });
    }).then(function (id) { if (!id) toast('上傳失敗'); return id; }, function () { toast('上傳失敗'); return null; });
  }
  function pickFile(cb) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.addEventListener('change', function () { if (inp.files && inp.files[0]) cb(inp.files[0]); });
    inp.click();
  }
  function imageFileOf(dt) {
    const files = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
    return files.find(function (f) { return /^image\//.test(f.type || ''); }) || null;
  }
  // 把一張自己的圖設成這部影片的縮圖：n 給了就寫進那部並存檔（卡片／表格列跟著換），沒給（新增對話框）
  // 只改 model；舊的存圖（抓來的或上一張自訂的）直接刪
  function uploadThumb(n, model, file) {
    return storeFile(file, 640).then(function (id) {
      if (!id) return false;
      const m = n ? liveModel(n) : model;
      const old = thumbId(m);
      m.preview = Object.assign(m.preview || { title: '', description: '', image: '', site: '' }, { imageId: id, custom: 1 });
      if (old && old !== id) dropImage(old);
      if (n) { write(n, m); if (O.onSave) O.onSave(n); refreshRow(n, m); }
      return true;
    });
  }
  // 不要自訂縮圖了：刪掉那張，有網站的圖就讓 ensureStored 再存一次
  function revertThumb(n, model) {
    const m = n ? liveModel(n) : model;
    const p = m.preview;
    if (!p || !p.custom) return;
    dropImage(p.imageId);
    delete p.custom; p.imageId = '';
    if (!p.title && !p.image && !p.description) m.preview = null;
    if (n) { write(n, m); if (O.onSave) O.onSave(n); refreshRow(n, m); }
    ensureStored();
  }
  // 存進系統的圖 404 了（備份還原後沒帶到、被手動刪掉）就退回代理抓原網址；原網址也壞才顯示佔位。
  // 有 id 的先不給 src（hydrate 之後從本機／伺服器補），沒 id 的直接走代理
  function imgTag(src, fallback, attrs, id) {
    const sync = id && urlMap[id];
    return '<img ' + (id ? (sync ? 'src="' + esc(sync) + '"' : 'data-vid="' + esc(id) + '"') : 'src="' + esc(src) + '"') + ' alt="" loading="lazy"' + (attrs || '') +
      (fallback && fallback !== src ? ' data-fb="' + esc(fallback) + '"' : '') +
      ' onerror="if(this.dataset.fb){this.src=this.dataset.fb;delete this.dataset.fb;}else{this.parentNode.classList.add(\'is-empty\');this.remove();}">';
  }
  function thumbHTML(m, cls, extra) {
    const t = thumbOf(m), id = thumbId(m);
    return '<div class="' + cls + (t || id ? '' : ' is-empty') + '">' +
      (t || id ? imgTag(thumbSrc(m), t ? proxied(t) : '', '', id) : '') +
      '<span class="vd-thumb-ph">' + ic('film') + '</span>' + (extra || '') + '</div>';
  }
  // 縮圖右下角的標籤：語言、字幕（點一下就依它篩選）
  function badgesHTML(m) {
    const b = [];
    if (m.lang) b.push('<button class="vd-badge is-lang" type="button" data-lang="' + esc(m.lang) + '" title="語言：' + esc(m.lang) + '">' + esc(m.lang) + '</button>');
    if (m.subtitle) b.push('<button class="vd-badge is-sub" type="button" data-subtitle="' + esc(m.subtitle) + '" title="字幕：' + esc(m.subtitle) + '">' + esc(m.subtitle) + '</button>');
    return b.length ? '<div class="vd-badges">' + b.join('') + '</div>' : '';
  }
  let cardVk = null;   // 整批畫卡片時共用一份 verifiedKeys()（每張卡各算一次會是 N² 的 parse）
  function makeCard(n, m) {
    const card = el('article', 'vd-card');
    card.setAttribute('data-id', n.id);
    card.tabIndex = 0;
    const lw = lastWatch(m);
    const actors = shownActors(m, cardVk || verifiedKeys());
    card.innerHTML =
      thumbHTML(m, 'vd-thumb', badgesHTML(m)) +
      (m.code ? '<span class="vd-code">' + esc(m.code) + '</span>' : '') +
      '<span class="vd-count" title="看過 ' + m.watches.length + ' 次">' + ic('eye') + m.watches.length + '</span>' +
      '<div class="vd-cbody">' +
      '<div class="vd-title" title="' + esc(n.title) + '">' + esc(n.title || '未命名影片') + '</div>' +
      (actors.length ? '<div class="vd-chips">' + actors.map(function (a) { return '<button class="vd-chip is-actor" type="button" data-actor="' + esc(a) + '">' + ic('user') + esc(a) + '</button>'; }).join('') + '</div>' : '') +
      (m.tags.length ? '<div class="vd-chips">' + m.tags.map(function (t) { return '<button class="vd-chip is-tag" type="button" data-tag="' + esc(t) + '">#' + esc(t) + '</button>'; }).join('') + '</div>' : '') +
      '<div class="vd-meta">' +
      (m.released || m.duration ? '<span class="vd-meta-rel">' + esc([m.released ? fmtDay(m.released) : '', m.duration ? m.duration + ' 分' : ''].filter(Boolean).join('・')) + '</span>' : '') +
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
    menuAt(x, y, [['open', '查看／編輯'], ['watch', '+1 看過'], ['copy', '複製連結', !modelOf(n).url], ['thumb', '上傳縮圖…'], null, ['del', '刪除', false, true]], function (a) {
      if (a === 'open') openModal(n);
      else if (a === 'watch') addWatch(n);
      else if (a === 'thumb') pickFile(function (f) { uploadThumb(n, null, f).then(function (ok) { if (ok) toast('縮圖已換成你上傳的'); }); });
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
  document.addEventListener('mousedown', function (e) { if (menuEl && !(e.target && e.target.closest && e.target.closest('.vd-menu'))) closeMenu(); }, true);

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
      chips.innerHTML = list.map(function (v, i) {
        const pend = o.pending && o.pending(v);
        return '<span class="vd-chip ' + (o.cls || '') + (pend ? ' is-pending' : '') + '"' + (pend ? ' title="查核中：還沒確認過的人物不會顯示在卡片、人物誌、關聯圖"' : '') + '>' +
          (o.prefix || '') + esc(v) + (pend ? '<i class="vd-chip-pend">查核中</i>' : '') +
          '<button type="button" class="vd-chip-x" data-i="' + i + '" title="移除">' + ic('x') + '</button></span>';
      }).join('');
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
    // 收進來先以「查核中」顯示，背景去查：不收的（男性、查不到、對不上）拿掉；通過的標成 verified
    // （o.onVerified），有中文名的換成中文名
    function check(s) {
      o.verify(s).then(function (r) {
        const i = list.findIndex(function (v) { return v === s; });
        if (i < 0 || !r) return;
        if (r.ok === false) { list.splice(i, 1); paintChips(); o.onChange(list.slice()); return; }
        if (r.ok !== true) { paintChips(); return; }   // 暫時查不到（網路）：留著，之後背景再查
        let name = s;
        if (r.name && r.name !== s) {
          if (list.some(function (v, j) { return j !== i && v.toLowerCase() === r.name.toLowerCase(); })) { list.splice(i, 1); name = ''; } else { list[i] = r.name; name = r.name; }
        }
        if (o.onVerified && name) o.onVerified(name, list.slice()); else o.onChange(list.slice());
        paintChips();
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
      '<div class="vd-f-row">' +
      '<label class="vd-f"><span class="vd-f-l">發行日</span><input class="tt-input vd-m-released" type="date" value="' + esc(model.released) + '"></label>' +
      '<label class="vd-f"><span class="vd-f-l">片長（分）</span><input class="tt-input vd-m-duration" type="number" min="0" max="2000" step="1" value="' + (model.duration || '') + '" placeholder="120"></label>' +
      '<label class="vd-f"><span class="vd-f-l">片商</span><input class="tt-input vd-m-maker" type="text" value="' + esc(model.maker) + '" maxlength="120" spellcheck="false"></label>' +
      '</div>' +
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
    ['input', 'change'].forEach(function (ev) {
      q('.vd-m-released').addEventListener(ev, function (e) { apply({ released: e.target.value }); });
      q('.vd-m-duration').addEventListener(ev, function (e) { apply({ duration: Number(e.target.value) || 0 }); });
      q('.vd-m-maker').addEventListener(ev, function (e) { apply({ maker: e.target.value.trim() }); });
    });
    const actorsChip = chipInput(q('.vd-m-actors'), model.actors, {
      key: 'actors', cls: 'is-actor', placeholder: '人物，Enter 加一個（可多個）', suggest: allActors(), verify: verifyPerson,
      pending: function (a) { return !model.verified[a] && !verifiedKeys()[a.toLowerCase()]; },
      onVerified: function (name, v) { const vf = Object.assign({}, model.verified); vf[name] = 1; apply({ actors: v, verified: vf }); },
      onChange: function (v) { apply({ actors: v }); }
    });
    const tagsChip = chipInput(q('.vd-m-tags'), model.tags, { key: 'tags', cls: 'is-tag', prefix: '#', placeholder: '#hashtag，Enter 加一個', suggest: allTags(), onChange: function (v) { apply({ tags: v }); } });

    // 網址：貼上／輸入後自動抓預覽（600 ms 沒再動才抓）；按「抓預覽」強制重抓
    const urlIn = q('.vd-m-url');
    // 換網址：預覽作廢，但自己上傳的縮圖留著（只留 imageId + custom）
    function keepCustom(p) { return p && p.custom ? { title: '', description: '', image: '', site: '', imageId: p.imageId, custom: 1 } : null; }
    urlIn.addEventListener('input', function () {
      const u = safeUrl(urlIn.value);
      apply({ url: u, preview: u === model.url ? model.preview : keepCustom(model.preview) });
      paintPlayer();
      if (urlTimer) clearTimeout(urlTimer);
      if (u) urlTimer = setTimeout(function () { fetchPreview(false); }, 600);
    });
    urlIn.addEventListener('paste', function () { setTimeout(function () { urlIn.dispatchEvent(new Event('input', { bubbles: true })); }, 0); });
    q('.vd-m-fetch').addEventListener('click', function () { fetchPreview(true); });
    function fetchPreview(force) {
      const u = safeUrl(urlIn.value);
      if (!u || !O.onPreview) return;
      const pv0 = model.preview;
      if (!force && pv0 && (pv0.title || pv0.image || pv0.description) && model.url === u) { paintPreview(); return; }   // 只剩自訂縮圖的殼不算有預覽
      modal.fetching = true; paintPreview();
      O.onPreview(u).then(function (info) {
        if (!modal || modal.overlay !== ov) return;
        modal.fetching = false;
        if (urlIn.value.trim() !== u && safeUrl(urlIn.value) !== u) return;   // 已經改成別的網址了
        const failed = !info || info.error;
        let pv = failed ? null : { title: str(info.title, 200), description: str(info.description, 300), image: safeUrl(info.image), site: str(info.siteName, 80) };
        if (pv && !pv.image) pv.image = ytThumb(u);
        // 自己上傳的縮圖不被重抓蓋掉：帶到新的預覽上
        if (model.preview && model.preview.custom) pv = Object.assign(pv || { title: '', description: '', image: '', site: '' }, { imageId: model.preview.imageId, custom: 1 });
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
        // 人物從伺服器補（晶片還空著才填）：只收 people 裡的——那是資料庫驗過的女性；大頭照不管
        // 晶片是誰填的，名字對得上就收
        const verifiedNames = peopleNames(info);
        if (!failed && verifiedNames.length && !actorsChip.get().length) {
          actorsChip.set(verifiedNames.slice(0, 10));
          fill.actors = actorsChip.get();
        }
        if (!failed) {
          const av = peopleAvatars(info, actorsChip.get());
          if (Object.keys(av).length) fill.avatars = Object.assign({}, model.avatars, av);
          const vf = peopleVerified(info, actorsChip.get());
          if (Object.keys(vf).length) fill.verified = Object.assign({}, model.verified, vf);
          // 資料庫的類別併進 hashtag（只加不蓋）；發行日／片長／片商 欄位還空著才填
          const extra = detailFields(info, model);
          if (extra.tags) { tagsChip.set(extra.tags); }
          ['released', 'duration', 'maker'].forEach(function (k) { if (extra[k] !== undefined) { const inp = q('.vd-m-' + k); if (inp) inp.value = extra[k]; } });
          Object.assign(fill, extra);
        }
        apply(Object.assign({ url: u, preview: pv && (pv.title || pv.image || pv.description || pv.custom) ? pv : null }, fill));
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
      const custom = !!(model.preview && model.preview.custom);
      const tools = '<div class="vd-player-tools">' +
        (model.url && !v ? '<a class="btn btn-primary vd-player-open" href="' + esc(model.url) + '" target="_blank" rel="noopener noreferrer">' + ic('external-link') + '<span>開啟連結</span></a>' : '') +
        '<button class="btn vd-player-up" type="button" title="自己選一張圖當縮圖（把圖片拖進來或 Ctrl+V 貼上也可以）">' + ic('upload') + '<span>' + (custom ? '換一張縮圖' : '上傳縮圖') + '</span></button>' +
        (custom ? '<button class="btn vd-player-rev" type="button" title="刪掉自己上傳的這張' + (model.preview.image ? '，改用網站的圖' : '') + '">' + ic('x') + '<span>' + (model.preview.image ? '改用網站的圖' : '移除自訂縮圖') + '</span></button><span class="vd-player-note">自訂縮圖</span>' : '') +
        '</div>';
      if (v) {
        box.innerHTML = '<div class="vd-player-frame"><iframe src="' + esc(v.src) + '" title="影片" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" loading="lazy"></iframe></div>' + tools;
        return;
      }
      box.innerHTML = thumbHTML(model, 'vd-player-thumb') + tools;
      hydrate(box);
    }
    // 自己上傳縮圖：按鈕選檔、拖一張圖到左欄、或對話框開著時 Ctrl+V 貼圖
    function takeThumb(file) {
      if (!file) return;
      uploadThumb(isNew ? null : note, model, file).then(function (ok) {
        if (!ok || !modal || modal.overlay !== ov) return;
        if (!isNew) apply();
        paintPlayer();
        toast('縮圖已換成你上傳的');
      });
    }
    const playerBox = q('.vd-player');
    playerBox.addEventListener('click', function (e) {
      if (e.target.closest('.vd-player-up')) pickFile(takeThumb);
      else if (e.target.closest('.vd-player-rev')) { revertThumb(isNew ? null : note, model); if (!isNew) apply(); paintPlayer(); }
    });
    const leftCol = q('.vd-m-left');
    leftCol.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { e.preventDefault(); leftCol.classList.add('is-drop'); } });
    leftCol.addEventListener('dragleave', function () { leftCol.classList.remove('is-drop'); });
    leftCol.addEventListener('drop', function (e) { leftCol.classList.remove('is-drop'); const f = imageFileOf(e.dataTransfer); if (f) { e.preventDefault(); takeThumb(f); } });
    modal.onPaste = function (e) { const f = imageFileOf(e.clipboardData); if (f) { e.preventDefault(); takeThumb(f); } };
    document.addEventListener('paste', modal.onPaste, true);
    paintPlayer(); paintPreview();
    if (!isNew) paintWatches();

    if (isNew) {
      q('.vd-m-cancel').addEventListener('click', function () { closeModal(true); });
      q('.vd-m-create').addEventListener('click', function () {
        const title = q('.vd-m-title').value.trim() || (model.preview && model.preview.title) || model.code || hostOf(model.url) || '未命名影片';
        if (!model.url && !title) return;
        const btn = q('.vd-m-create'); btn.disabled = true;
        O.onCreate({ title: title, content: generate(model) }).then(function (n) {
          if (modal && modal.overlay === ov) modal.created = true;   // 自訂縮圖已經屬於這部影片，關閉時不刪
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
    // 每一筆的時間都可以改（點一下變成 datetime-local）；「補填一筆」可以記一個過去的時間
    box.innerHTML =
      '<div class="vd-w-head"><span class="vd-w-t">' + ic('eye') + '觀看紀錄</span><span class="vd-w-n">共 ' + m.watches.length + ' 次' + (list.length ? '・最近 ' + fmtStamp(list[0]) : '') + '</span>' +
      '<button class="btn vd-w-back" type="button" title="記一個過去的時間">' + ic('clock') + '<span>補填一筆</span></button>' +
      '<button class="btn btn-primary vd-w-add" type="button">' + ic('plus') + '<span>看過一次</span></button></div>' +
      '<div class="vd-w-backrow" hidden><input class="tt-input vd-w-when" type="datetime-local" value="' + esc(nowStamp()) + '"><button class="btn btn-primary vd-w-backok" type="button">加入</button><button class="btn vd-w-backx" type="button">取消</button></div>' +
      (list.length ? '<ul class="vd-w-list">' + list.map(function (s, i) {
        const idx = m.watches.length - 1 - i;
        return '<li><button type="button" class="vd-w-time" data-i="' + idx + '" title="點一下修改時間">' + esc(fmtStamp(s)) + '</button>' +
          '<input class="tt-input vd-w-edit" type="datetime-local" data-i="' + idx + '" value="' + esc(s) + '" hidden>' +
          '<button type="button" class="icon-btn vd-w-x" data-i="' + idx + '" title="刪除這一筆">' + ic('x') + '</button></li>';
      }).join('') + '</ul>' : '<div class="vd-w-empty">還沒看過。看完就按一下「看過一次」。</div>');
    const save = function (mm) { mm.watches.sort(); write(modal.note, mm); if (O.onSave) O.onSave(modal.note); paintWatches(); refreshRow(modal.note, mm); };
    box.querySelector('.vd-w-add').addEventListener('click', function () { addWatch(modal.note); });
    const backrow = box.querySelector('.vd-w-backrow');
    box.querySelector('.vd-w-back').addEventListener('click', function () { backrow.hidden = !backrow.hidden; if (!backrow.hidden) backrow.querySelector('.vd-w-when').focus(); });
    box.querySelector('.vd-w-backx').addEventListener('click', function () { backrow.hidden = true; });
    box.querySelector('.vd-w-backok').addEventListener('click', function () {
      const v = backrow.querySelector('.vd-w-when').value.slice(0, 16);
      if (!STAMP.test(v)) { toast('時間格式不對'); return; }
      const mm = modal.model; mm.watches.push(v); save(mm);
      toast('已補一筆：' + fmtStamp(v));
    });
    box.addEventListener('click', function (e) {
      const x = e.target.closest('.vd-w-x');
      if (x) {
        const mm = modal.model;
        mm.watches.splice(Number(x.getAttribute('data-i')), 1);
        save(mm);
        return;
      }
      const t = e.target.closest('.vd-w-time');
      if (t) {
        const inp = box.querySelector('.vd-w-edit[data-i="' + t.getAttribute('data-i') + '"]');
        t.hidden = true; inp.hidden = false; inp.focus();
      }
    });
    box.addEventListener('change', function (e) {
      const inp = e.target.closest('.vd-w-edit');
      if (!inp) return;
      const v = inp.value.slice(0, 16);
      if (!STAMP.test(v)) { paintWatches(); return; }
      const mm = modal.model; mm.watches[Number(inp.getAttribute('data-i'))] = v; save(mm);
    });
    box.addEventListener('focusout', function (e) {
      const inp = e.target.closest && e.target.closest('.vd-w-edit');
      if (inp && !inp.hidden) setTimeout(function () { if (inp.isConnected) paintWatches(); }, 0);
    });
  }
  function closeModal(flush) {
    if (!modal) return;
    const m = modal; modal = null;
    document.removeEventListener('keydown', onModalKey, true);
    if (m.onPaste) document.removeEventListener('paste', m.onPaste, true);
    if (urlTimer) { clearTimeout(urlTimer); urlTimer = null; }
    m.overlay.remove();
    // 新增對話框取消了：上傳過的自訂縮圖沒有影片可以掛，直接刪掉
    if (m.isNew && !m.created && m.model.preview && m.model.preview.custom) dropImage(m.model.preview.imageId);
    if (flush && m.note && saveTimers.has(m.note.id)) { clearTimeout(saveTimers.get(m.note.id)); saveTimers.delete(m.note.id); if (O && O.onSave) O.onSave(m.note); }
  }
  function open(id) {
    const n = byId(id);
    if (n) { openModal(n); return; }
    const pn = personNotes().find(function (x) { return x.id === id; });   // #note/<人物資料> → 她的頁面
    if (pn) { const nm = parsePerson(pn.content).name; if (nm) openPerson(nm); }
  }
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
        m.actors = !noPv ? cleanList(peopleNames(info), 10, 60) : [];
        if (!noPv) { m.avatars = peopleAvatars(info, m.actors); m.verified = peopleVerified(info, m.actors); Object.assign(m, detailFields(info, m)); }
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

  // ---------------- 分類：所有 hashtag／語言／字幕 攤開來，點幾個就篩幾個（AND） ----------------
  // 條件存在同一個 filter 裡（tags 是陣列），所以切回清單分頁條件還在；右鍵 hashtag 可以改名／合併／刪除
  function tagCounts() {
    const tags = {}, langs = {}, subs = {};
    notes().forEach(function (n) {
      const m = modelOf(n);
      m.tags.forEach(function (t) { const k = t.toLowerCase(); tags[k] = tags[k] || { name: t, n: 0 }; tags[k].n++; });
      if (m.lang) { const k = m.lang.toLowerCase(); langs[k] = langs[k] || { name: m.lang, n: 0 }; langs[k].n++; }
      if (m.subtitle) { const k = m.subtitle.toLowerCase(); subs[k] = subs[k] || { name: m.subtitle, n: 0 }; subs[k].n++; }
    });
    const sortBy = function (o) { return Object.keys(o).map(function (k) { return o[k]; }).sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name, 'zh-Hant'); }); };
    return { tags: sortBy(tags), langs: sortBy(langs), subs: sortBy(subs) };
  }
  function paintTags(body) {
    const c = tagCounts();
    const wrap = el('div', 'vd-tags');
    const tile = function (kind, item) {
      const on = kind === 'tag' ? filter.tags.some(function (t) { return t.toLowerCase() === item.name.toLowerCase(); })
        : (filter[kind] || '').toLowerCase() === item.name.toLowerCase();
      return '<button class="vd-tag-tile is-' + kind + (on ? ' is-on' : '') + '" type="button" data-kind="' + kind + '" data-name="' + esc(item.name) + '">' +
        '<span class="vd-tag-tile-n">' + (kind === 'tag' ? '#' : '') + esc(item.name) + '</span><span class="vd-tag-tile-c">' + item.n + '</span></button>';
    };
    const sec = function (title, kind, items, hint) {
      return '<section class="vd-tags-sec"><h3>' + esc(title) + '<small>' + items.length + '</small>' + (hint ? '<span class="vd-tags-hint">' + esc(hint) + '</span>' : '') + '</h3>' +
        (items.length ? '<div class="vd-tag-tiles">' + items.map(function (it) { return tile(kind, it); }).join('') + '</div>' : '<div class="vd-st-none">還沒有</div>') + '</section>';
    };
    wrap.innerHTML =
      '<div class="vd-tags-bar"><span class="vd-tags-cur"></span><button class="btn vd-tags-clear" type="button"' + (hasFilter() ? '' : ' hidden') + '>' + ic('x') + '<span>清除條件</span></button>' +
      '<button class="btn btn-primary vd-tags-go" type="button"' + (hasFilter() ? '' : ' hidden') + '>' + ic('list') + '<span>在清單看</span></button></div>' +
      sec('hashtag', 'tag', c.tags, '點幾個就篩幾個（都要有）；右鍵可以改名、合併、刪除') +
      sec('語言', 'lang', c.langs) + sec('字幕', 'subtitle', c.subs) +
      '<h3 class="vd-pp-sub vd-tags-result"></h3><div class="vd-grid vd-tags-grid"></div>';
    body.appendChild(wrap);
    const grid = wrap.querySelector('.vd-tags-grid'), cur = wrap.querySelector('.vd-tags-cur'), res = wrap.querySelector('.vd-tags-result');
    function fill() {
      const parts = [];
      if (filter.actor) parts.push('人物：' + filter.actor);
      filter.tags.forEach(function (t) { parts.push('#' + t); });
      if (filter.lang) parts.push('語言：' + filter.lang);
      if (filter.subtitle) parts.push('字幕：' + filter.subtitle);
      cur.textContent = parts.length ? parts.join('　') : '點下面的分類開始篩選';
      wrap.querySelector('.vd-tags-clear').hidden = !parts.length;
      wrap.querySelector('.vd-tags-go').hidden = !parts.length;
      wrap.querySelectorAll('.vd-tag-tile').forEach(function (b) {
        const kind = b.getAttribute('data-kind'), name = b.getAttribute('data-name').toLowerCase();
        b.classList.toggle('is-on', kind === 'tag' ? filter.tags.some(function (t) { return t.toLowerCase() === name; }) : (filter[kind] || '').toLowerCase() === name);
      });
      grid.innerHTML = '';
      if (!parts.length) { res.hidden = true; return; }
      res.hidden = false;
      aliasMemo = null;
      const rows = sorted(notes().filter(matches));
      res.textContent = '符合的影片 ' + rows.length + ' 部';
      if (!rows.length) grid.appendChild(el('div', 'vd-empty', '沒有同時符合這些條件的影片。'));
      cardVk = verifiedKeys();
      rows.forEach(function (r) { grid.appendChild(makeCard(r.n, r.m)); });
      cardVk = null;
      hydrate(grid);
    }
    fill();
    wrap.addEventListener('click', function (e) {
      const b = e.target.closest('.vd-tag-tile');
      if (b) {
        const kind = b.getAttribute('data-kind'), name = b.getAttribute('data-name');
        if (kind === 'tag') {
          const i = filter.tags.findIndex(function (t) { return t.toLowerCase() === name.toLowerCase(); });
          if (i >= 0) filter.tags.splice(i, 1); else filter.tags.push(name);
        } else filter[kind] = (filter[kind] || '').toLowerCase() === name.toLowerCase() ? null : name;
        fill();
        return;
      }
      if (e.target.closest('.vd-tags-clear')) { filter = emptyFilter(); fill(); return; }
      if (e.target.closest('.vd-tags-go')) { view = 'list'; paint(); }
    });
    wrap.addEventListener('contextmenu', function (e) {
      const b = e.target.closest('.vd-tag-tile.is-tag');
      if (!b) return;
      e.preventDefault();
      tagMenu(b.getAttribute('data-name'), e.clientX, e.clientY);
    });
  }
  // hashtag 管理：改名（to 是新名字）、合併（to 是既有名字）、刪除（to 是 null）——一次套到所有影片
  function retag(from, to) {
    const fk = from.toLowerCase();
    let n = 0;
    notes().forEach(function (note) {
      const m = liveModel(note);
      const i = m.tags.findIndex(function (t) { return t.toLowerCase() === fk; });
      if (i < 0) return;
      if (to) m.tags[i] = to; else m.tags.splice(i, 1);
      m.tags = cleanList(m.tags, 40, 40, true);
      write(note, m); if (O.onSave) O.onSave(note);
      n++;
    });
    // 篩選條件裡的也跟著改
    filter.tags = cleanList(filter.tags.map(function (t) { return t.toLowerCase() === fk ? (to || '') : t; }), 40, 40, true);
    return n;
  }
  function tagMenu(name, x, y) {
    const others = tagCounts().tags.map(function (t) { return t.name; }).filter(function (t) { return t.toLowerCase() !== name.toLowerCase(); });
    menuAt(x, y, [['rename', '重新命名…'], ['merge', '合併到…', !others.length], null, ['del', '刪除這個 hashtag', false, true]], function (a) {
      const prompt = function (o) { return global.App && App.prompt ? App.prompt(o) : Promise.resolve(window.prompt(o.title)); };
      if (a === 'rename') {
        prompt({ title: '重新命名 #' + name, message: '所有影片上的這個 hashtag 都會改', ok: '改名' }).then(function (v) {
          const to = String(v || '').replace(/^#+/, '').trim().slice(0, 40);
          if (!to || to.toLowerCase() === name.toLowerCase()) return;
          toast('#' + name + ' → #' + to + '：' + retag(name, to) + ' 部影片'); paint();
        });
      } else if (a === 'merge') {
        prompt({ title: '把 #' + name + ' 合併到…', message: '輸入目標 hashtag：' + others.slice(0, 12).join('、') + (others.length > 12 ? '…' : ''), ok: '合併' }).then(function (v) {
          const to = String(v || '').replace(/^#+/, '').trim().slice(0, 40);
          if (!to || to.toLowerCase() === name.toLowerCase()) return;
          toast('#' + name + ' 併入 #' + to + '：' + retag(name, to) + ' 部影片'); paint();
        });
      } else if (a === 'del') {
        const cnt = (tagCounts().tags.find(function (t) { return t.name.toLowerCase() === name.toLowerCase(); }) || { n: 0 }).n;
        const ask = global.App && App.confirm ? App.confirm({ title: '刪除 hashtag', message: '把 #' + name + ' 從 ' + cnt + ' 部影片上拿掉？', ok: '刪除', danger: true }) : Promise.resolve(window.confirm('刪除 #' + name + '？'));
        Promise.resolve(ask).then(function (yes) { if (!yes) return; toast('已從 ' + retag(name, null) + ' 部影片拿掉 #' + name); paint(); });
      }
    });
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
  // 伺服器預覽回來的詳細頁欄位 → 要補進 model 的 patch：類別併進 hashtag（去重、只加不蓋），
  // 發行日／片長／片商 欄位空著才填。回的物件只含有變動的鍵
  function detailFields(info, m) {
    const out = {};
    if (!info || info.error) return out;
    if (Array.isArray(info.tags) && info.tags.length) {
      const merged = cleanList(m.tags.concat(info.tags), 40, 40, true);
      if (merged.length !== m.tags.length) out.tags = merged;
    }
    if (!m.released && /^\d{4}-\d{2}-\d{2}$/.test(info.released || '')) out.released = info.released;
    if (!m.duration && Number(info.duration) > 0) out.duration = Math.min(2000, Math.floor(Number(info.duration)));
    if (!m.maker && typeof info.maker === 'string' && info.maker.trim()) out.maker = info.maker.trim().slice(0, 120);
    return out;
  }
  // 伺服器預覽回來的人物只認 people（資料庫驗過的女性），不看 actors
  function peopleNames(info) {
    if (!info || info.error || !Array.isArray(info.people)) return [];
    return info.people.map(function (p) { return p && typeof p === 'object' ? String(p.name || '').trim() : ''; }).filter(Boolean);
  }
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
      // 先讓出一次：第一輪就沒事做（同步 break）的話，finally 會在 avatarJob 被指定「之前」清掉它，
      // 然後指定把已結束的 promise 留在 avatarJob 裡，之後每次 ensureAvatars 都以為還在跑而直接返回
      await null;
      try {
        while (host) {
          // 沒有影片的（只剩使用者寫的資料）不用查：查到的照片也沒有影片可以存
          const todo = peopleIndex().filter(function (p) { return p.videos.length && (!hasPhoto(p) || !p.verified) && !avatarMiss[p.key]; });
          if (!todo.length) break;
          // 沒驗過的先（它們在畫面上是隱藏的），再來是驗過但缺照片的
          todo.sort(function (a, b) { return (a.verified ? 1 : 0) - (b.verified ? 1 : 0); });
          const p = todo[0];
          let info = null;
          try { info = await O.onPerson(p.name); } catch (e) { info = null; }
          if (!host) break;
          const r = judge(p.name, info);
          if (r.ok === null) { avatarMiss[p.key] = true; if (avatarWatch) avatarWatch(p, info || { error: '查不到' }, false); continue; }
          if (r.ok === false) {
            // 嚴格：男性、查不到、對不上 → 從所有影片拿掉（還沒驗過的本來就沒顯示，拿掉不會閃）
            removePerson(p.key, p.name);
            toast(r.why.replace(/，不收$/, '') + '，已從所有影片拿掉');
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
  // 整庫改名：每部影片的人物原地換掉（新名字已經在那部裡就把舊的拿掉），照片、驗過的標記、別名、作品數
  // 跟著搬；使用者的資料筆記也改名。回有沒有改到任何一部
  function renamePerson(key, newName) {
    let changed = false;
    notes().forEach(function (n) {
      const m = liveModel(n);
      const idx = m.actors.findIndex(function (a) { return a.toLowerCase() === key; });
      if (idx < 0 || m.actors[idx] === newName) return;
      const dup = m.actors.findIndex(function (a, i) { return i !== idx && a.toLowerCase() === newName.toLowerCase(); });
      if (dup >= 0) m.actors.splice(idx, 1); else m.actors[idx] = newName;
      [m.avatars, m.avatarIds, m.verified, m.aliases, m.works].forEach(function (map) {
        Object.keys(map).forEach(function (k) {
          if (k.toLowerCase() !== key || k === newName) return;
          const v = map[k]; delete map[k];
          if (!map[newName]) map[newName] = v; else if (map === m.avatarIds) dropImage(v);   // 兩邊都有存圖：多的那張刪掉
        });
      });
      write(n, m); if (O.onSave) O.onSave(n); changed = true;
    });
    const pn = personNoteOf(key);
    if (pn) { const pr = parsePerson(pn.content); pr.name = newName; pn.content = generatePerson(pr); pn.title = newName; if (O.onSave) O.onSave(pn); changed = true; }
    return changed;
  }
  function applyPerson(p, info) {
    // 使用者自己編輯過這個人（有資料筆記）就不自動改名——她取的名字算數
    const taken = !!personNoteOf(p.key);
    const newName = (!taken && info.matched && typeof info.name === 'string' && info.name.trim() && info.name.trim() !== p.name) ? info.name.trim().slice(0, 60) : p.name;
    const image = safeUrl(info.image);
    let stored = false, marked = false;
    if (newName !== p.name) renamePerson(p.key, newName);
    notes().forEach(function (n) {
      const m = liveModel(n);
      let changed = false;
      const has = m.actors.some(function (a) { return a.toLowerCase() === newName.toLowerCase(); });
      if (!has) return;
      if (image && !stored && has) {
        if (m.avatars[newName] !== image) { m.avatars[newName] = image; dropImage(m.avatarIds[newName]); delete m.avatarIds[newName]; }
        stored = true; changed = true;
      }
      if (!marked && has) {
        m.verified[newName] = 1; marked = true; changed = true;
        // 資料庫上的別名與作品數跟著 verified 記在同一部
        const al = cleanList(Array.isArray(info.aliases) ? info.aliases : [], 20, 60);
        if (al.length) m.aliases[newName] = al;
        if (Number(info.works) > 0) m.works[newName] = Math.floor(Number(info.works));
      }
      if (changed) { write(n, m); if (O.onSave) O.onSave(n); }
    });
    if (newName !== p.name) toast('人物「' + p.name + '」改名為「' + newName + '」');
    return newName !== p.name;
  }
  // 把一個人物從所有影片拿掉（人物、照片、標記），存進系統的照片也刪；使用者寫的資料筆記一起硬刪
  function removePerson(key, name) {
    const pn = personNoteOf(key);
    if (pn) { dropImage(parsePerson(pn.content).imageId); if (O.onDeleteNow) O.onDeleteNow(pn).catch(function () {}); }
    notes().forEach(function (n) {
      const m = liveModel(n);
      const idx = m.actors.findIndex(function (a) { return a.toLowerCase() === key; });
      if (idx < 0) return;
      m.actors.splice(idx, 1);
      [m.avatars, m.avatarIds, m.verified, m.aliases, m.works].forEach(function (map) {
        Object.keys(map).forEach(function (k) {
          if (k.toLowerCase() !== key) return;
          if (map === m.avatarIds) dropImage(map[k]);
          delete map[k];
        });
      });
      write(n, m); if (O.onSave) O.onSave(n);
    });
    if (modal && modal.overlay) { const chips = modal.overlay.querySelector('.vd-m-actors'); if (chips && chips._chip) chips._chip.set(modal.model.actors); }
  }
  // 晶片輸入收到一個人物名時的檢查（chipInput 的 verify），嚴格版：資料庫查不到、名字對不上、
  // 人物頁讀不到、男性 → 一律不收；通過的回中文名。網路暫時失敗回 { ok: null }（留著，之後背景再查）
  function judge(name, info) {
    if (!info) return { ok: null };
    if (info.error) return /查不到/.test(info.error) ? { ok: false, why: '資料庫查不到「' + name + '」，無法確認，不收' } : { ok: null };
    if (info.male) return { ok: false, why: '「' + name + '」是男性人物，不收' };
    if (!info.known) return { ok: null };
    if (!info.matched) return { ok: false, why: '「' + name + '」在資料庫裡對不到人，不收' };
    const nm = typeof info.name === 'string' && info.name.trim() ? info.name.trim().slice(0, 60) : name;
    return { ok: true, name: nm };
  }
  function verifyPerson(name) {
    if (!O || !O.onPerson) return Promise.resolve({ ok: null });
    return O.onPerson(name).then(function (info) {
      const r = judge(name, info);
      if (r.ok === false) toast(r.why);
      return r;
    }, function () { return { ok: null }; });
  }

  // 把還是外部網址的縮圖／大頭照存進系統（一次一張，背景跑）：之後顯示從 /api/images 拿，不再每次抓
  let storeJob = null;
  let storeMiss = {};        // 這次開頁存不進去的網址，不再重試
  function ensureStored() {
    if (!O || !O.onStoreImage || storeJob) return;
    storeJob = (async function () {
      await null;   // 同 ensureAvatars：第一輪就 break 的話 finally 會跑在指定之前，storeJob 就卡著不再跑
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
          // 瀏覽器自己透過代理抓、縮小（縮圖 640 寬、大頭照 240 寬）、送位元組上去，順手放進本機快取；
          // 任何一步不行就退回讓伺服器自己抓原圖
          let id = null, small = null;
          try {
            if (O.onFetchImage && O.onStoreImageBytes) {
              const blob = await O.onFetchImage(task.url);
              if (blob && /^image\//.test(blob.type)) {
                small = await shrink(blob, task.kind === 'thumb' ? 640 : 240);
                if (small) id = await O.onStoreImageBytes(small);
              }
            }
            if (!id) { small = null; id = await O.onStoreImage(task.url); }
          } catch (e) { id = null; }
          if (!host) break;
          if (!id) { storeMiss[task.url] = true; continue; }
          if (small) await cachePut(id, small);
          const m = liveModel(task.n);
          if (task.kind === 'thumb') { if (m.preview && m.preview.image === task.url) m.preview.imageId = id; else { dropImage(id); continue; } }
          else { if (m.avatars[task.name] === task.url) m.avatarIds[task.name] = id; else { dropImage(id); continue; } }
          write(task.n, m); if (O.onSave) O.onSave(task.n);
          if (task.kind === 'thumb') refreshRow(task.n, m);   // 卡片改從本機／系統裡拿圖
          else if (view === 'graph' && graphView && graphView.setNodeImage) { const u = await imageUrl(id); if (u) graphView.setNodeImage('a:' + task.name.toLowerCase(), u); }
        }
      } finally { storeJob = null; }
    })();
  }

  // ---------------- 人物誌：有出現過的人物自動列出 ----------------
  function avatarHTML(p, cls) {
    return '<div class="' + cls + (hasPhoto(p) ? '' : ' is-empty') + '">' +
      (hasPhoto(p) ? imgTag(srcOf(p.avatar, p.avatarId), p.avatar ? proxied(p.avatar) : '', '', p.avatarId) : '') +
      '<span class="vd-person-ph">' + esc(p.name.slice(0, 1)) + '</span></div>';
  }
  // 重新找照片：把現在這張（資料庫的或自己上傳的）刪掉、清掉驗過的標記，背景查核會再去資料庫找一次
  function refindPhoto(p) {
    delete avatarMiss[p.key];
    notes().forEach(function (n) {
      const m = liveModel(n);
      const k = Object.keys(m.avatars).find(function (a) { return a.toLowerCase() === p.key; });
      if (!k) return;
      if (m.avatarIds[k]) dropImage(m.avatarIds[k]);
      delete m.avatars[k]; delete m.avatarIds[k]; delete m.verified[k];
      write(n, m); if (O.onSave) O.onSave(n);
    });
    const pn = personNoteOf(p.key);
    if (pn) {
      const pr = parsePerson(pn.content);
      if (pr.imageId) { dropImage(pr.imageId); pr.imageId = ''; pn.content = generatePerson(pr); if (O.onSave) O.onSave(pn); }
    }
  }
  function personCard(p) {
    const card = el('article', 'vd-person');
    card.setAttribute('data-key', p.key);
    card.tabIndex = 0;
    card.innerHTML =
      avatarHTML(p, 'vd-person-av') +
      '<div class="vd-person-name" title="' + esc(p.name + (p.aliases.length ? '（' + p.aliases.join('、') + '）' : '')) + '">' + esc(p.name) + '</div>' +
      '<div class="vd-person-meta">' + p.videos.length + ' 部・看過 ' + p.watches + ' 次</div>' +
      (p.last ? '<div class="vd-person-last">最近看：' + esc(fmtDay(p.last)) + '</div>' : '');
    card.addEventListener('click', function () { openPerson(p.key); });
    card.addEventListener('keydown', function (e) { if (e.key === 'Enter') openPerson(p.key); });
    card.addEventListener('contextmenu', function (e) { e.preventDefault(); personMenu(p, e.clientX, e.clientY); });
    return card;
  }
  function personMenu(p, x, y) {
    menuAt(x, y, [['open', '打開這個人的頁面'], ['edit', '編輯資料…'], ['videos', '在清單裡篩選她的影片'], ['photo', '重新找照片'], null, ['remove', '從所有影片拿掉', false, true]], function (a) {
      if (a === 'open') openPerson(p.key);
      else if (a === 'edit') openPersonEdit(p);
      else if (a === 'videos') setFilter('actor', p.name);
      else if (a === 'photo') {
        refindPhoto(p);
        if (view === 'people' || view === 'person') paint();
      } else if (a === 'remove') {
        removePerson(p.key, p.name);
        toast('已把「' + p.name + '」從所有影片拿掉');
        if (view === 'person') { view = 'people'; }
        if (view === 'people') paint();
      }
    });
  }
  // 一個人的頁面：大照片、名字、數字、動作；底下她所有影片的卡片（跟清單同一種卡）
  function paintPerson(body) {
    const p = peopleIndex().find(function (x) { return x.key === personKey && x.verified; });
    if (!p) { view = 'people'; paintPeople(body); return; }
    const wrap = el('div', 'vd-pp');
    const lw = p.last;
    wrap.innerHTML =
      '<div class="vd-pp-head">' +
      '<button class="btn vd-pp-back" type="button">' + ic('arrow-left') + '<span>人物誌</span></button>' +
      avatarHTML(p, 'vd-person-av vd-pp-av') +
      '<div class="vd-pp-main"><h2 class="vd-pp-name">' + esc(p.name) + '</h2>' +
      '<div class="vd-pp-meta">' + p.videos.length + ' 部影片・看過 ' + p.watches + ' 次' + (lw ? '・最近看 ' + esc(fmtDay(lw)) : '・還沒看過') + (p.works ? '・資料庫上 ' + p.works + ' 部作品' : '') + (p.custom ? '・自訂照片' : '') + '</div>' +
      (p.aliases.length ? '<div class="vd-pp-alias">別名：' + esc(p.aliases.join('、')) + '</div>' : '') +
      (p.note ? '<div class="vd-pp-note">' + esc(p.note) + '</div>' : '') +
      '<div class="vd-pp-acts">' +
      '<button class="btn vd-pp-edit" type="button">' + ic('pencil') + '<span>編輯資料</span></button>' +
      '<button class="btn vd-pp-filter" type="button">' + ic('list') + '<span>在清單裡篩選</span></button>' +
      '<button class="btn vd-pp-photo" type="button">' + ic('refresh-cw') + '<span>重新找照片</span></button>' +
      '<button class="btn btn-danger vd-pp-remove" type="button">' + ic('trash') + '<span>從所有影片拿掉</span></button>' +
      '</div></div></div>' +
      '<h3 class="vd-pp-sub">影片</h3><div class="vd-grid vd-pp-grid"></div>';
    body.appendChild(wrap);
    const grid = wrap.querySelector('.vd-pp-grid');
    cardVk = verifiedKeys();
    sorted(p.videos).forEach(function (r) { grid.appendChild(makeCard(r.n, r.m)); });
    cardVk = null;
    wrap.querySelector('.vd-pp-back').addEventListener('click', function () { setView('people'); });
    wrap.querySelector('.vd-pp-filter').addEventListener('click', function () { setFilter('actor', p.name); });
    wrap.querySelector('.vd-pp-edit').addEventListener('click', function () { openPersonEdit(p); });
    wrap.querySelector('.vd-pp-photo').addEventListener('click', function () { refindPhoto(p); paint(); });
    wrap.querySelector('.vd-pp-remove').addEventListener('click', function () {
      removePerson(p.key, p.name);
      toast('已把「' + p.name + '」從所有影片拿掉');
      setView('people');
    });
    // 照片有了／改名了就重畫這一頁
    ensureAvatars(function (q, info, changed) { if (view === 'person' && host && (changed || (q.key === personKey && info && !info.error))) paint(); });
  }
  // ---------------- 編輯人物資料：名字、自訂別名、自訂照片、備註 ----------------
  // 存成那個人自己的資料筆記（meta.person，見 isPerson）：改名會整庫改（renamePerson），照片在選檔時就
  // 先存進系統（取消就刪掉），其餘按「儲存」才寫。只有查核過的人物才進得來（人物誌只列她們）。
  let pedit = null;   // { overlay, newId }
  function closePersonEdit(keep) {
    if (!pedit) return;
    const pe = pedit; pedit = null;
    document.removeEventListener('keydown', onPersonEditKey, true);
    pe.overlay.remove();
    if (!keep && pe.newId) dropImage(pe.newId);   // 取消：這次新上傳的照片沒人用，刪掉
  }
  function onPersonEditKey(e) {
    if (e.key !== 'Escape' || !pedit || menuEl) return;
    e.preventDefault(); e.stopPropagation();
    closePersonEdit(false);
  }
  function openPersonEdit(p) {
    closeMenu(); closePersonEdit(false);
    const pn = personNoteOf(p.key);
    const pr = pn ? parsePerson(pn.content) : { name: p.name, aliases: [], note: '', imageId: '', added: today() };
    const mine = function (a) { return pr.aliases.some(function (x) { return x.toLowerCase() === a.toLowerCase(); }); };
    const dbAliases = p.aliases.filter(function (a) { return !mine(a); });   // 資料庫給的，唯讀
    const ov = el('div', 'vd-overlay');
    ov.innerHTML =
      '<div class="vd-modal vd-pe-modal" role="dialog" aria-modal="true" aria-label="編輯人物資料">' +
      '<div class="vd-m-head">' + ic('pencil') + '<span class="vd-bt-title">編輯人物資料</span>' +
      '<button class="icon-btn vd-m-close" type="button" title="關閉 (Esc)">' + ic('x') + '</button></div>' +
      '<div class="vd-pe-body">' +
      '<div class="vd-pe-left">' +
      '<button class="vd-pe-avbtn" type="button" title="換照片">' + avatarHTML(p, 'vd-person-av vd-pe-av') + '<span class="vd-pe-avhint">' + ic('upload') + '</span></button>' +
      '<button class="btn vd-pe-up" type="button">' + ic('upload') + '<span>上傳照片</span></button>' +
      '<button class="btn vd-pe-clear" type="button"' + (p.custom ? '' : ' hidden') + '>' + ic('x') + '<span>移除自訂照片</span></button>' +
      '<span class="vd-pe-hint">照片會縮小後存在系統裡，不會出現在檔案管理；拖一張圖進來也可以</span>' +
      '</div>' +
      '<div class="vd-pe-right">' +
      '<label class="vd-f"><span class="vd-f-l">名字</span><input class="tt-input vd-pe-name" type="text" value="' + esc(pr.name || p.name) + '" maxlength="60" spellcheck="false"></label>' +
      '<label class="vd-f"><span class="vd-f-l">自訂別名</span><input class="tt-input vd-pe-alias" type="text" value="' + esc(pr.aliases.join('、')) + '" placeholder="用「、」或逗號分開" maxlength="600" spellcheck="false"></label>' +
      (dbAliases.length ? '<div class="vd-f vd-f-added"><span class="vd-f-l">資料庫別名</span><span>' + esc(dbAliases.join('、')) + '</span></div>' : '') +
      '<label class="vd-f"><span class="vd-f-l">備註</span><textarea class="tt-input vd-pe-note" rows="6" placeholder="生日、身高、喜歡的作品…想記什麼都可以" maxlength="5000">' + esc(pr.note) + '</textarea></label>' +
      '<div class="vd-f vd-f-added"><span class="vd-f-l">影片</span><span>' + p.videos.length + ' 部' + (p.works ? '・資料庫上 ' + p.works + ' 部作品' : '') + '</span></div>' +
      '</div></div>' +
      '<div class="vd-m-foot"><span class="vd-m-hint">改名會套用到她的每一部影片；改過名字的人不再自動換成資料庫的名字</span><span class="vd-m-sp"></span>' +
      '<button class="btn vd-pe-cancel" type="button">取消</button>' +
      '<button class="btn btn-primary vd-pe-save" type="button">' + ic('check') + '<span>儲存</span></button></div></div>';
    document.body.appendChild(ov);
    pedit = { overlay: ov, newId: '', cleared: false };
    const q = function (s) { return ov.querySelector(s); };
    hydrate(ov);
    function showPhoto(id) {
      const box = q('.vd-pe-av');
      box.innerHTML = (id ? imgTag('', '', '', id) : '') + '<span class="vd-person-ph">' + esc(p.name.slice(0, 1)) + '</span>';
      box.classList.toggle('is-empty', !id);
      hydrate(box);
      q('.vd-pe-clear').hidden = !(id && (pedit.newId || (!pedit.cleared && pr.imageId)));
    }
    function takePhoto(file) {
      storeFile(file, 240).then(function (id) {
        if (!id) return;
        if (!pedit || pedit.overlay !== ov) { dropImage(id); return; }
        if (pedit.newId) dropImage(pedit.newId);
        pedit.newId = id; pedit.cleared = false;
        showPhoto(id);
      });
    }
    q('.vd-pe-up').addEventListener('click', function () { pickFile(takePhoto); });
    q('.vd-pe-avbtn').addEventListener('click', function () { pickFile(takePhoto); });
    q('.vd-pe-clear').addEventListener('click', function () {
      if (pedit.newId) { dropImage(pedit.newId); pedit.newId = ''; }
      pedit.cleared = true;
      // 自訂照片拿掉後顯示資料庫那張（有的話）
      showPhoto(p.custom ? '' : p.avatarId);
      if (!p.custom && p.avatar && !p.avatarId) { const box = q('.vd-pe-av'); box.innerHTML = imgTag(proxied(p.avatar), '', '', '') + '<span class="vd-person-ph">' + esc(p.name.slice(0, 1)) + '</span>'; box.classList.remove('is-empty'); }
    });
    ov.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) { e.preventDefault(); ov.classList.add('is-drop'); } });
    ov.addEventListener('dragleave', function () { ov.classList.remove('is-drop'); });
    ov.addEventListener('drop', function (e) { ov.classList.remove('is-drop'); const f = imageFileOf(e.dataTransfer); if (f) { e.preventDefault(); takePhoto(f); } });
    q('.vd-m-close').addEventListener('click', function () { closePersonEdit(false); });
    q('.vd-pe-cancel').addEventListener('click', function () { closePersonEdit(false); });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closePersonEdit(false); });
    q('.vd-pe-save').addEventListener('click', function () {
      const name = q('.vd-pe-name').value.trim().slice(0, 60) || p.name;
      const aliases = cleanList(q('.vd-pe-alias').value.split(/[、,，;；\n]/), 20, 60).filter(function (a) { return a.toLowerCase() !== name.toLowerCase(); });
      const note = q('.vd-pe-note').value.slice(0, 5000);
      const imageId = pedit.newId || (pedit.cleared ? '' : pr.imageId);
      if (pr.imageId && imageId !== pr.imageId) dropImage(pr.imageId);
      closePersonEdit(true);
      if (name !== p.name) renamePerson(p.key, name);
      if (view === 'person') personKey = name.toLowerCase();   // 建立資料筆記時 app.js 會重畫一次，先指到新名字
      const data = { name: name, aliases: aliases, note: note, imageId: imageId, added: pr.added };
      const done = function () { if (view === 'person' || view === 'people' || view === 'graph') paint(); else refresh(); toast('已儲存人物資料'); };
      const live = personNoteOf(name.toLowerCase()) || pn;
      if (live) { live.content = generatePerson(data); live.title = name; if (O.onSave) O.onSave(live); done(); }
      else if (aliases.length || note || imageId || name !== p.name) {
        if (!O.onCreate) return;
        O.onCreate({ title: name, content: generatePerson(data), meta: { video: true, person: true } }).then(done, function () { if (imageId) dropImage(imageId); });
      } else done();
    });
    document.addEventListener('keydown', onPersonEditKey, true);
    setTimeout(function () { q('.vd-pe-name').focus(); }, 30);
  }
  function paintPeople(body) {
    const all = peopleIndex();
    const people = all.filter(function (p) { return p.verified; });
    const unverified = all.length - people.length;
    const tools = el('div', 'vd-tools');
    tools.innerHTML =
      '<div class="search-box vd-search"><input type="search" placeholder="搜尋人物…" value="' + esc(peopleQuery) + '" aria-label="搜尋人物"></div>' +
      '<span class="vd-people-n">' + people.length + ' 位</span><span class="vd-people-st"></span>';
    if (all.length) body.appendChild(tools);
    const grid = el('div', 'vd-people');
    body.appendChild(grid);
    const st = tools.querySelector('.vd-people-st');
    function statusText() {
      const idx = peopleIndex();
      const pend = idx.filter(function (x) { return !x.verified && !avatarMiss[x.key]; }).length;
      const missing = idx.filter(function (x) { return x.verified && x.videos.length && !hasPhoto(x) && !avatarMiss[x.key]; }).length;
      return (pend ? '查核中 ' + pend + ' 位（確認前不顯示）' : '') + (pend && missing ? '・' : '') + (missing ? '正在找 ' + missing + ' 位的照片…' : '');
    }
    function fill() {
      grid.innerHTML = '';
      const q = peopleQuery.trim().toLowerCase();
      const rows = people.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.aliases.some(function (a) { return a.toLowerCase().indexOf(q) >= 0; }); });
      if (!rows.length) grid.appendChild(el('div', 'vd-empty', people.length ? '沒有符合的人物。' : ic('users') + '<p>' + (unverified ? '人物查核中，確認是女性的才會出現。' : '還沒有人物。影片填了人物就會自動出現在這裡，照片也會自己找。') + '</p>'));
      rows.forEach(function (p) { grid.appendChild(personCard(p)); });
      st.textContent = statusText();
    }
    fill();
    tools.querySelector('input').addEventListener('input', function (e) { peopleQuery = e.target.value; fill(); });
    ensureAvatars(function (p, info, changed) {
      if (view !== 'people' || !host) return;
      // 拿掉／改名／新驗過一個 → 名單變了，整個重畫；只是照片到了就換那一張卡
      if (changed || !p.verified) { paint(); return; }
      const fresh = peopleIndex().find(function (x) { return x.key === p.key; });
      const old = grid.querySelector('.vd-person[data-key="' + CSS.escape(p.key) + '"]');
      if (fresh && old && (fresh.avatar !== p.avatar || fresh.avatarId !== p.avatarId)) { const c = personCard(fresh); old.replaceWith(c); hydrate(c); }
      if (fresh) Object.assign(p, fresh);
      st.textContent = statusText();
    });
  }

  // ---------------- 關聯圖：影片—人物—標籤 ----------------
  function buildGraph(list) {
    const nodes = [], byIdx = {}, edges = [], seen = {};
    function node(id, kind, label, note) { if (!byIdx[id]) { byIdx[id] = { id: id, kind: kind, label: label, note: note || null, deg: 0 }; nodes.push(byIdx[id]); } return byIdx[id]; }
    function edge(a, b, kind) { const k = a + '|' + b; if (seen[k]) return; seen[k] = true; edges.push({ a: a, b: b, kind: kind }); byIdx[a].deg++; byIdx[b].deg++; }
    const vk = verifiedKeys();
    list.forEach(function (n) {
      const m = modelOf(n);
      const v = node('v:' + n.id, 'video', n.title || '未命名影片', n);
      v.watches = m.watches.length;
      shownActors(m, vk).forEach(function (a) {
        const an = node('a:' + a.toLowerCase(), 'actor', a);
        // 人物節點帶大頭照（graph.js 畫成圓形照片）：本機已有的 blob: 最快，再來存進系統的，沒有才走代理
        if (!an.image && m.avatars[a]) an.image = (m.avatarIds[a] && urlMap[m.avatarIds[a]]) || srcOf(m.avatars[a], m.avatarIds[a]);
        edge(v.id, 'a:' + a.toLowerCase(), 'actor');
      });
      m.tags.forEach(function (t) { node('t:' + t.toLowerCase(), 'tag', '#' + t); edge(v.id, 't:' + t.toLowerCase(), 'tag'); });
    });
    // 使用者自己上傳的人物照片蓋過資料庫的
    personNotes().forEach(function (n) {
      const pr = parsePerson(n.content);
      const an = pr.name && byIdx['a:' + pr.name.toLowerCase()];
      if (an && pr.imageId) an.image = urlMap[pr.imageId] || srcOf('', pr.imageId);
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
      hint: '點一下看關聯・雙擊開影片、人物頁或依 hashtag 篩選・拖曳、滾輪縮放',
      legend: [['is-video', '影片'], ['is-actor', '人物'], ['is-tag', 'hashtag']],
      emptyText: '還沒有影片，或影片都還沒填人物與 hashtag。',
      closeLabel: '回清單',
      showLabels: true,
      onOpenNode: function (n) {
        if (n.kind === 'video') { view = 'list'; paint(); openModal(byId(n.note.id) || n.note); }
        else if (n.kind === 'actor') openPerson(n.label);
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
    const vk = verifiedKeys();
    const rows = list.map(function (n) {
      const m = modelOf(n);
      total += m.watches.length;
      shownActors(m, vk).forEach(function (a) { const k = a.toLowerCase(); actors[k] = actors[k] || { name: a, videos: 0, watches: 0 }; actors[k].videos++; actors[k].watches += m.watches.length; });
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
      (m.actors.some(function (a) { return m.verified[a]; }) ? '<div class="vds-row">人物：' + m.actors.filter(function (a) { return m.verified[a]; }).map(esc).join('、') + '</div>' : '') +
      (m.tags.length ? '<div class="vds-row">' + m.tags.map(function (t) { return '<span class="vds-tag">#' + esc(t) + '</span>'; }).join(' ') + '</div>' : '') +
      (m.notes ? '<div class="vds-notes">' + esc(m.notes) + '</div>' : '') +
      '</div>';
  }

  global.Videos = {
    render: render, refresh: refresh, open: open, teardown: teardown, saved: saved,
    isNote: isNote, isWatch: isWatch, isPerson: isPerson, parse: parse, generate: generate, parseWatch: parseWatch, generateWatch: generateWatch, parsePerson: parsePerson, generatePerson: generatePerson,
    blockHTML: blockHTML, stats: stats, buildGraph: buildGraph, parseBatch: parseBatch, peopleIndex: peopleIndex, dropNoteImages: dropNoteImages,
    isOpen: function () { return !!modal; }
  };
})(window);
