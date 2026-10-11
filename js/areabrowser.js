/* areabrowser.js — 課程筆記、知識區、小說共用的簡化檔案總管。
 *
 * 資料夾方框、筆記條列跟首頁儀表板（dashboard.js）長得一模一樣：同一套 CSS class（.dash-*）、
 * 同樣的「⋮」／釘選／「⋯」、同一份勾選（批次列在側邊欄），選單也是 app.js 同一個函式。
 * 拖放也跟首頁同一套（同樣的 MIME 協定，所以跟側邊欄的樹互拖也行）：筆記、上傳的檔案、便條紙
 * （拖上緣的色帶）拖進資料夾方框或麵包屑；筆記列之間、資料夾方框之間拖曳排序；從電腦拖檔案到
 * 資料夾方框上就傳進那個資料夾。刻意沒有的：標籤雲、電子書區。一篇筆記一旦點開，
 * 分享／版本歷史／PDF／協作編輯全部照常運作——那些功能都在筆記編輯器本身，
 * 不需要這裡重做一份。
 *
 * 用法：AreaBrowser.render(container, opts) / AreaBrowser.refresh(opts)
 *   notes, folders          這個區域目前的筆記與資料夾（呼叫端先依 area 篩好）
 *   title, hint              頁首標題與說明文字
 *   emptyHint                完全沒有內容時顯示的提示
 *   onOpen(noteId)            開啟筆記
 *   onNewNote(folderId)       新增筆記，回傳 Promise
 *   onNewFolder(parentId)     新增資料夾，回傳 Promise
 *   onRenameNote(note, title) / onRenameFolder(folder, name)
 *   onFolderMenu(folder, anchor) / onMenu(note, anchor)   資料夾「⋮」、筆記「⋯」選單（跟首頁共用）
 *   onPin(note, on) / selection {has, toggle} / onSortMenu(anchor)   跟首頁共用
 *   onNavigate(folderId)      使用者自己點進／點出資料夾（呼叫端留一筆瀏覽紀錄）
 *   onDeleteNote(note) / onMoveNote(note)   檔案列、便條紙自己的按鈕用
 *   onMoveNotes(ids, folderId) / onReorderNotes(ids, folderId, targetId, after) /
 *   onPlaceFolders(ids, parentId, targetId, after)   拖放（跟首頁的 dashOpts 同名同義）
 *   onUploadFile(file, folderId, onProgress)  有給才會出現「上傳檔案」跟拖放上傳；回傳
 *                             Promise<note>——檔案在資料夾裡是一篇「檔案筆記」（meta.file），
 *                             所以改名／移動／垃圾桶／備份都走筆記既有的那一套
 *   onOpenFile(note)          點一個檔案（呼叫端開檢視器：PDF／影片直接看，其餘下載）
 * render() 會把瀏覽位置重置到最上層；refresh() 保留目前瀏覽到哪個資料夾。
 */
(function (global) {
  'use strict';

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }

  // ---- 檔案筆記：meta.file = { id, name, mime, size } ----
  function fileOf(n) { return n && n.meta && n.meta.file ? n.meta.file : null; }
  function fileKind(f) {
    const mime = String(f.mime || '').toLowerCase(), ext = (/\.([a-z0-9]+)$/i.exec(f.name || '') || [])[1] || '';
    const e = ext.toLowerCase();
    if (mime === 'application/pdf' || e === 'pdf') return { icon: 'file-text', tag: 'PDF', cls: 'pdf' };
    if (mime.indexOf('video/') === 0 || /^(mp4|webm|mov|mkv|avi|m4v)$/.test(e)) return { icon: 'film', tag: (e || 'video').toUpperCase(), cls: 'video' };
    if (/^(pptx?|key|odp)$/.test(e) || mime.indexOf('presentation') >= 0) return { icon: 'presentation', tag: (e || 'ppt').toUpperCase(), cls: 'ppt' };
    if (mime.indexOf('image/') === 0) return { icon: 'image', tag: (e || 'img').toUpperCase(), cls: 'img' };
    if (mime.indexOf('audio/') === 0) return { icon: 'film', tag: (e || 'audio').toUpperCase(), cls: 'video' };
    if (/^(md|markdown|mdown|mkd)$/.test(e) || mime.indexOf('markdown') >= 0) return { icon: 'file-text', tag: 'MD', cls: 'other' };
    return { icon: 'paperclip', tag: (e || 'file').toUpperCase().slice(0, 5), cls: 'other' };
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  // ---- 圖片縮圖與滑過預覽 ----
  // 圖片檔在清單裡直接顯示縮圖（蓋在類型圖示上，載入成功才換上去；HEIC／TIFF 這種伺服器
  // 當附件送的格式解不出來，就留著原本的圖示）。沒有伺服器端縮圖：跟檔案管理一樣直接抓
  // /api/images/<id>、loading=lazy。<img> 元素以檔案 id 快取、每次 render 只是重新掛上去，
  // 所以畫面重畫（上傳完成、改名、移動）不會讓縮圖重抓或閃一下。
  const thumbCache = new Map();   // file id -> <img>
  function attachThumb(host, f) {
    const src = '/api/images/' + encodeURIComponent(f.id);
    if (thumbCache.get(f.id) === null) return;   // 這個工作階段已經試過、解不出來：維持一般圖示，不再重抓
    let im = thumbCache.get(f.id);
    if (!im) {
      im = document.createElement('img');
      im.className = 'ab-thumb-img';
      im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.draggable = false;
      im.addEventListener('load', function () { im._ok = true; if (im.parentNode) im.parentNode.classList.add('has-thumb'); });
      im.addEventListener('error', function () {
        thumbCache.set(f.id, null);
        if (im.parentNode) im.parentNode.classList.remove('ab-thumb');   // 縮回一般圖示的大小
        im.remove();
      });
      im.src = src;
      thumbCache.set(f.id, im);
    }
    host.classList.add('ab-thumb');
    if (im._ok) host.classList.add('has-thumb');
    host.appendChild(im);
    // 滑到縮圖上浮出大一點的預覽；觸控裝置沒有 hover，點下去就是檢視器
    host.addEventListener('mouseenter', function () { if (im._ok) showPop(host, src, im); });
    host.addEventListener('mouseleave', hidePop);
  }
  let popEl = null;
  function hidePop() { if (popEl) { popEl.remove(); popEl = null; } }
  // 預覽放在這一列的「下面」（下面沒位置就放上面），不放旁邊：放旁邊會蓋住檔名，包括正在看
  // 的這一列自己的。框的大小照圖片比例算好再放，直式的圖不會留兩條大白邊。
  function showPop(host, src, im) {
    hidePop();
    if (!global.matchMedia || !global.matchMedia('(hover: hover)').matches) return;
    const MAXW = 380, MAXH = 300, PAD = 6, GAP = 6;
    const nw = im.naturalWidth || MAXW, nh = im.naturalHeight || MAXH;
    if (nw <= 80 && nh <= 80) return;                        // 本來就是小圖示，縮圖已經是全貌
    const k = Math.min(MAXW / nw, MAXH / nh, 1);
    const w = Math.max(48, Math.round(nw * k)), h = Math.max(48, Math.round(nh * k));
    const bw = w + PAD * 2 + 2, bh = h + PAD * 2 + 2;
    const r = (host.closest('.dash-note-wrap') || host).getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    let top = r.bottom + GAP;
    if (top + bh > global.innerHeight - 8) top = r.top - GAP - bh;
    if (top < 8) return;                                     // 上下都放不下（很矮的視窗）就不浮
    const pop = el('div', 'ab-thumb-pop');                   // body 的子元素：一定是 position: fixed
    const big = document.createElement('img');
    big.alt = ''; big.width = w; big.height = h; big.src = src;   // 同一個網址，瀏覽器直接拿已經載入的那份
    pop.appendChild(big);
    pop.style.left = Math.round(Math.max(8, Math.min(hr.left, global.innerWidth - bw - 8))) + 'px';
    pop.style.top = Math.round(top) + 'px';
    document.body.appendChild(pop);
    popEl = pop;
  }
  global.addEventListener('scroll', hidePop, true);

  // ---- 便條紙：meta.sticky = { color } ----
  // 跟檔案一樣是「特殊的筆記」：內文就是便條紙上的字，所以垃圾桶／還原／搜尋／備份都不用
  // 另外做。卡片永遠可以直接打字（沒有「進入編輯」這一步，跟真的便條紙一樣）：每次輸入
  // 先寫回 note.content（本機的那份），再延遲 600ms 存檔；失焦立刻存。計時器以筆記 id 記在
  // 模組裡而不是卡片上，畫面重畫（例如旁邊的上傳剛好完成）不會弄丟還沒送出的字。
  const STICKY_COLORS = ['yellow', 'green', 'pink', 'purple', 'blue', 'gray'];
  const STICKY_NAMES = { yellow: '黃色', green: '綠色', pink: '粉紅色', purple: '紫色', blue: '藍色', gray: '灰色' };
  function stickyOf(n) { return n && n.meta && n.meta.sticky ? n.meta.sticky : null; }
  function kindOf(n) { return fileOf(n) ? 'file' : stickyOf(n) ? 'sticky' : 'note'; }
  const stickyTimers = new Map();   // note id -> { t, run }
  function scheduleStickySave(note, save) {
    const old = stickyTimers.get(note.id);
    if (old) clearTimeout(old.t);
    const run = function () { stickyTimers.delete(note.id); save(note, { content: note.content }); };
    stickyTimers.set(note.id, { t: setTimeout(run, 600), run: run });
  }
  function flushStickySave(id) {
    const p = stickyTimers.get(id);
    if (p) { clearTimeout(p.t); p.run(); }
  }
  function autosize(ta) {
    if (!ta.offsetParent) return;          // 頁面還藏著的時候量不到高度，留給下一次
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }
  function autosizeAll() {
    if (!lastOpts || !lastOpts.container) return;
    Array.prototype.forEach.call(lastOpts.container.querySelectorAll('.ab-sticky-text'), autosize);
  }
  global.addEventListener('resize', autosizeAll);   // 欄寬變了，換行位置跟著變

  // 正在上傳的檔案（跨 render 保留：上傳中切資料夾、別處觸發 refresh 都不會讓進度列消失）。
  // 一次傳一個，其餘排隊——大影片同時開好幾條只會互搶頻寬。
  let uploads = [];   // { key, name, size, sent, folderId, error, bar, pct }
  let uploading = false, upSeq = 0;
  function queueUploads(files, o, folderId) {
    const into = folderId === undefined ? curFolderId : folderId;
    Array.prototype.forEach.call(files, function (f) {
      // 區域跟上傳函式在排隊當下就記住：傳到一半切去別的區域，檔案還是進原本那個資料夾
      uploads.push({ key: ++upSeq, file: f, name: f.name, size: f.size, sent: 0, folderId: into, area: o.area || null, upload: o.onUploadFile, error: null });
    });
    render(o, true);
    pump();
  }
  function pump() {
    if (uploading) return;
    const u = uploads.find(function (x) { return !x.error && !x.started; });
    if (!u) return;
    uploading = true; u.started = true;
    u.upload(u.file, u.folderId, function (sent) {
      u.sent = sent;
      const p = u.size ? Math.min(100, Math.round(sent / u.size * 100)) : 0;
      if (u.bar) u.bar.style.width = p + '%';
      if (u.pct) u.pct.textContent = p + '%';
    }).then(function (note) {
      uploads = uploads.filter(function (x) { return x !== u; });
      if (note && lastOpts && (lastOpts.area || null) === u.area && !lastOpts.notes.some(function (n) { return n.id === note.id; })) lastOpts.notes.push(note);
    }, function (e) {
      u.error = (e && e.message) || String(e);
    }).then(function () {
      uploading = false;
      if (lastOpts) render(lastOpts, true);
      pump();
    });
  }

  let curFolderId = null;   // 目前瀏覽到哪個資料夾；每次 render() 重置為最上層
  let lastOpts = null;
  // 方格／清單記憶的鍵：這個區域 + 瀏覽到的資料夾（見 dashboard.js viewKey）
  function viewKey(o) { return global.Dashboard && Dashboard.viewKey ? Dashboard.viewKey(o.area || 'area', curFolderId) : null; }

  function foldersIn(folders, parentId) {
    return folders.filter(function (f) { return (f.parentId || null) === parentId; })
      .sort(function (a, b) { return Sorting.compareFolders(a, b); });
  }
  function notesIn(notes, folderId) {
    return notes.filter(function (n) { return (n.folderId || null) === folderId; })
      .sort(function (a, b) { return Sorting.compareNotes(a, b); });
  }
  // kind：'note' 一般筆記、'file' 檔案、'sticky' 便條紙（資料夾方框上分開寫「N 筆記・M 檔案・K 便條紙」）
  function countDeep(notes, folders, folderId, kind) {
    let c = notesIn(notes, folderId).filter(function (n) { return kindOf(n) === kind; }).length;
    foldersIn(folders, folderId).forEach(function (f) { c += countDeep(notes, folders, f.id, kind); });
    return c;
  }
  function crumbPath(folders, id) {
    const path = [];
    let cur = id, guard = {};
    while (cur && !guard[cur]) {
      guard[cur] = true;
      const f = folders.find(function (x) { return x.id === cur; });
      if (!f) break;
      path.unshift(f);
      cur = f.parentId || null;
    }
    return path;
  }

  function inlineRename(host, current, cls, onDone) {
    if (host.parentNode.querySelector('.' + cls)) return;
    const input = el('input', cls);
    input.type = 'text';
    input.value = current || '';
    host.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    function finish(save) {
      if (done) return;
      done = true;
      const val = input.value.trim();
      input.replaceWith(host);
      if (save && val && val !== current) { host.textContent = val; onDone(val); }
    }
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
  }

  // user=true：使用者自己點資料夾方框或麵包屑——回報給呼叫端留一筆瀏覽紀錄（跟首頁的 onNavigate 一樣），
  // 瀏覽器的「上一頁」才會一層一層退回去。程式呼叫的 openFolder（例如跟著網址走）不回報，不然會重複留紀錄。
  // ---- 拖放：跟首頁（dashboard.js）同一套協定與樣式 ------------------------------
  // 資料放在私有的 MIME 型別上，側邊欄的樹（app.js）也認得——兩邊都是這一頁上看得到的東西，
  // 從這裡拖到樹上的資料夾、或從樹拖到這裡的資料夾方框都行。模組變數只是 dragover 時的捷徑
  // （那時還讀不到資料本身）。
  const DND = 'application/x-strikenote-notes';
  const DND_FOLDER = 'application/x-strikenote-folder';
  let dragging = null, draggingFolder = null;
  function hasType(e, t) {
    const ts = e.dataTransfer && e.dataTransfer.types;
    return !!(ts && Array.prototype.indexOf.call(ts, t) >= 0);
  }
  function isNoteDrag(e) { return !!dragging || hasType(e, DND); }
  function isFolderDrag(e) { return !!draggingFolder || hasType(e, DND_FOLDER); }
  function clearDropHints() {
    if (!lastOpts || !lastOpts.container) return;
    lastOpts.container.querySelectorAll('.drop-target, .drop-before, .drop-after')
      .forEach(function (n) { n.classList.remove('drop-target', 'drop-before', 'drop-after'); });
  }
  function draggedNoteIds(e) {
    let ids = dragging;
    try { const raw = e.dataTransfer.getData(DND); if (raw) ids = JSON.parse(raw); } catch (err) { /* 用 dragstart 記下的 */ }
    return ids || [];
  }
  function draggedFolderId(e) {
    let id = draggingFolder;
    try { id = e.dataTransfer.getData(DND_FOLDER) || id; } catch (err) { /* 用 dragstart 記下的 */ }
    return id;
  }
  // 拖一篇有勾選的筆記＝拖整批勾選的（跟首頁一樣）
  function beginNoteDrag(e, note, o) {
    let ids = [note.id];
    if (o.selection && o.selection.has(note.id) && o.selection.ids) {
      const all = o.selection.ids();
      if (all.length > 1) ids = all;
    }
    dragging = ids;
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData(DND, JSON.stringify(ids));
      e.dataTransfer.setData('text/plain', note.title || '');
    } catch (err) { /* 模組變數還在 */ }
    e.stopPropagation();
  }
  function endDrag() { dragging = null; draggingFolder = null; clearDropHints(); }
  function makeNoteDraggable(el, note, o) {
    if (!o.onMoveNotes) return;
    el.draggable = true;
    el.addEventListener('dragstart', function (e) { beginNoteDrag(e, note, o); });
    el.addEventListener('dragend', endDrag);
  }
  // 一列（筆記或檔案）當排序落點：上半＝插在它前面，下半＝後面
  function makeNoteRowDrop(wrap, note, o) {
    if (!o.onReorderNotes) return;
    wrap.addEventListener('dragover', function (e) {
      if (!isNoteDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const r = wrap.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      wrap.classList.toggle('drop-before', !after);
      wrap.classList.toggle('drop-after', after);
    });
    wrap.addEventListener('dragleave', function () { wrap.classList.remove('drop-before', 'drop-after'); });
    wrap.addEventListener('drop', function (e) {
      if (!isNoteDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const after = wrap.classList.contains('drop-after');
      clearDropHints();
      const ids = draggedNoteIds(e);
      dragging = null;
      if (ids.length && !(ids.length === 1 && ids[0] === note.id)) o.onReorderNotes(ids, curFolderId, note.id, after);
    });
  }
  // 資料夾方框：可以拖；別的資料夾拖過來時左右兩側是插入點、中間是放進去
  function makeFolderTileDnD(tile, folder, o) {
    if (!o.onPlaceFolders) return;
    tile.draggable = true;
    tile.addEventListener('dragstart', function (e) {
      draggingFolder = folder.id;
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData(DND_FOLDER, folder.id);
        e.dataTransfer.setData('text/plain', folder.name || '');
      } catch (err) { /* 模組變數還在 */ }
      e.stopPropagation();
    });
    tile.addEventListener('dragend', endDrag);
    tile.addEventListener('dragover', function (e) {
      if (!isFolderDrag(e) || draggingFolder === folder.id) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const r = tile.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      tile.classList.toggle('drop-before', x < 0.3);
      tile.classList.toggle('drop-after', x > 0.7);
      tile.classList.toggle('drop-target', x >= 0.3 && x <= 0.7);
    });
    tile.addEventListener('dragleave', function () { tile.classList.remove('drop-before', 'drop-after', 'drop-target'); });
    tile.addEventListener('drop', function (e) {
      if (!isFolderDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const before = tile.classList.contains('drop-before'), after = tile.classList.contains('drop-after');
      clearDropHints();
      const id = draggedFolderId(e);
      draggingFolder = null;
      if (!id || id === folder.id) return;
      if (before || after) o.onPlaceFolders([id], folder.parentId || null, folder.id, after);
      else o.onPlaceFolders([id], folder.id, null, true);
    });
  }
  // 放進 folderId（null＝這個區域的最上層）。麵包屑（acceptFolders）也收資料夾方框。
  function makeDropTarget(el, folderId, o, acceptFolders) {
    if (!o.onMoveNotes) return el;
    const wantsFolder = function (e) {
      return acceptFolders && o.onPlaceFolders && isFolderDrag(e) && draggingFolder !== folderId;
    };
    el.addEventListener('dragover', function (e) {
      if (!isNoteDrag(e) && !wantsFolder(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', function () { el.classList.remove('drop-target'); });
    el.addEventListener('drop', function (e) {
      if (wantsFolder(e)) {
        e.preventDefault();
        e.stopPropagation();
        clearDropHints();
        const id = draggedFolderId(e);
        draggingFolder = null;
        if (id) o.onPlaceFolders([id], folderId, null, true);
        return;
      }
      if (!isNoteDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropHints();
      const ids = draggedNoteIds(e);
      dragging = null;
      if (ids.length) o.onMoveNotes(ids, folderId);
    });
    return el;
  }

  function go(folderId, user) {
    folderId = folderId || null;
    const moved = folderId !== curFolderId;
    curFolderId = folderId;
    if (lastOpts) render(lastOpts, true);
    if (user && moved && lastOpts && lastOpts.onNavigate) lastOpts.onNavigate(folderId);
  }

  // ---- 頁首：標題 + 麵包屑 + 新增按鈕 ----------------------------------------
  function renderHead(o) {
    const head = el('header', 'dash-head');
    const main = el('div', 'dash-head-main');
    const path = crumbPath(o.folders, curFolderId);

    const nav = el('nav', 'dash-crumbs');
    nav.setAttribute('aria-label', '資料夾路徑');
    function crumb(label, iconName, folderId, isCurrent) {
      const c = el('button', 'dash-crumb' + (isCurrent ? ' is-current' : ''),
        (iconName ? ic(iconName) : '') + '<span>' + esc(label) + '</span>');
      c.type = 'button';
      c.dataset.folder = folderId || ''; c.dataset.area = o.area || '';   // 中鍵開新分頁用（app.js middleTarget）
      if (isCurrent) c.setAttribute('aria-current', 'page');
      else { c.title = '回到「' + label + '」'; c.addEventListener('click', function () { go(folderId, true); }); }
      makeDropTarget(c, folderId, o, true);
      return c;
    }
    nav.appendChild(crumb(o.title || '筆記', o.icon, null, !curFolderId));
    path.forEach(function (f, i) {
      nav.appendChild(el('span', 'dash-crumb-sep', ic('chevron-right')));
      nav.appendChild(crumb(f.name || '未命名資料夾', null, f.id, i === path.length - 1));
    });
    main.appendChild(nav);

    const subs = foldersIn(o.folders, curFolderId).length;
    const here = notesIn(o.notes, curFolderId);
    const nFiles = here.filter(fileOf).length, nSticky = here.filter(stickyOf).length, ns = here.length - nFiles - nSticky;
    const bits = [];
    if (subs) bits.push(subs + ' 個資料夾');
    bits.push(ns + ' 篇筆記');
    if (nFiles || o.onUploadFile) bits.push(nFiles + ' 個檔案');
    if (nSticky) bits.push(nSticky + ' 張便條紙');
    main.appendChild(el('div', 'dash-subtitle', esc(bits.join('・'))));
    head.appendChild(main);

    const right = el('div', 'dash-head-right');
    // 資料夾方格／清單：跟首頁同一顆（Dashboard.viewToggle），但每個位置（區域＋資料夾）各自記住
    if (global.Dashboard && Dashboard.viewToggle) right.appendChild(Dashboard.viewToggle(function () { if (lastOpts) render(lastOpts, true); }, viewKey(o)));
    // 排序：跟首頁同一顆（排序方式本身也是同一套，側邊欄、首頁、這裡一起變）
    if (o.onSortMenu && global.Sorting) {
      const s = el('button', 'btn dash-sort-btn', ic('arrow-up-down') + '<span>排序：</span>' +
        '<span class="dash-sort-mode">' + esc(Sorting.info().short) + '</span>');
      s.type = 'button';
      s.title = '排序方式（側邊欄也用同一套）';
      s.setAttribute('aria-haspopup', 'true');
      s.addEventListener('click', function (e) { e.stopPropagation(); o.onSortMenu(s); });
      right.appendChild(s);
    }
    if (o.onNewSticky) {
      const bs = el('button', 'btn', ic('sticky-note') + '<span>便條紙</span>');
      bs.type = 'button';
      bs.title = '在這個資料夾貼一張便條紙，直接打字就會自動儲存';
      bs.addEventListener('click', function () {
        o.onNewSticky(curFolderId).then(function (n) {
          if (!n) return;
          if (!o.notes.some(function (x) { return x.id === n.id; })) o.notes.push(n);
          render(o, true);
          focusSticky(n.id);
        });
      });
      right.appendChild(bs);
    }
    if (curFolderId && o.onBookUpdate && (o.folders.find(function (f) { return f.id === curFolderId; }) || {}).isBook) {
      const bb = el('button', 'btn btn-primary dash-book-btn', ic('book-open') + '<span>更新到電子書</span>');
      bb.type = 'button';
      bb.title = '用這個資料夾目前的內容重新打包公開分享連結，然後打開電子書';
      bb.addEventListener('click', function () { o.onBookUpdate(curFolderId); });
      right.appendChild(bb);
    }
    if (o.onUploadFile) {
      const bu = el('button', 'btn', ic('upload') + '<span>上傳檔案</span>');
      bu.type = 'button';
      bu.title = '把 PPTX、PDF、影片或任何檔案放進這個資料夾（也可以直接拖進頁面）';
      bu.addEventListener('click', function () {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.hidden = true;
        document.body.appendChild(inp);
        inp.addEventListener('change', function () { const fs = inp.files; inp.remove(); if (fs && fs.length) queueUploads(fs, o); });
        inp.click();
      });
      right.appendChild(bu);
    }
    if (o.onNewFolder) {
      const bf = el('button', 'btn', ic('folder-plus') + '<span>新增資料夾</span>');
      bf.type = 'button';
      bf.addEventListener('click', function () {
        o.onNewFolder(curFolderId).then(function (f) { if (f) { o.folders.push(f); render(o, true); } });
      });
      right.appendChild(bf);
    }
    if (o.onNewNote) {
      const bn = el('button', 'btn btn-primary', ic('file-plus') + '<span>新增筆記</span>');
      bn.type = 'button';
      bn.addEventListener('click', function () {
        o.onNewNote(curFolderId).then(function (n) { if (n && o.onOpen) o.onOpen(n.id); });
      });
      right.appendChild(bn);
    }
    head.appendChild(right);
    return head;
  }

  // ---- 資料夾方框 -------------------------------------------------------------
  function makeFolderTile(folder, o) {
    const deep = countDeep(o.notes, o.folders, folder.id, 'note');
    const deepFiles = countDeep(o.notes, o.folders, folder.id, 'file');
    const deepStickies = countDeep(o.notes, o.folders, folder.id, 'sticky');
    const subs = foldersIn(o.folders, folder.id).length;
    const metaBits = [deep + ' 筆記'];
    if (deepFiles) metaBits.push(deepFiles + ' 檔案');
    if (deepStickies) metaBits.push(deepStickies + ' 便條紙');
    if (subs) metaBits.push(subs + ' 子資料夾');

    // 跟首頁（dashboard.js makeFolderTile）同一個樣子：右上角一顆直式「⋮」，改名／移動／
    // 刪除都在選單裡（選單本身是 app.js 的 showFolderMenu，首頁跟這裡共用同一個）。
    const tile = el('div', 'dash-folder-tile');
    tile.dataset.id = folder.id;
    if (global.Dashboard && Dashboard.folderColor) tile.style.setProperty('--fc', Dashboard.folderColor(folder.id));
    makeDropTarget(tile, folder.id, o);
    makeFolderTileDnD(tile, folder, o);
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.title = '打開資料夾';
    const head = el('div', 'dash-folder-head');
    head.appendChild(el('span', 'dash-folder-ic', ic('folder')));
    const nameEl = el('span', 'dash-folder-name', esc(folder.name || '未命名資料夾'));
    head.appendChild(nameEl);
    tile.appendChild(head);
    tile.appendChild(el('div', 'dash-folder-meta', esc(metaBits.join('・'))));

    const acts = el('div', 'dash-folder-acts');
    if (o.onFolderMenu) {
      const m = el('button', 'dash-folder-menu', ic('more-vertical'));
      m.type = 'button';
      m.title = '更多';
      m.addEventListener('click', function (e) { e.stopPropagation(); o.onFolderMenu(folder, m); });
      acts.appendChild(m);
    }
    tile.appendChild(acts);

    tile.addEventListener('click', function () { go(folder.id, true); });
    tile.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(folder.id, true); }
      else if (e.key === 'F2') { e.preventDefault(); renameFolderTile(folder.id); }
    });
    return tile;
  }
  // 選單的「重新命名」：在方框上就地改名（跟首頁的 Dashboard.renameFolderTile 一樣）
  function renameFolderTile(id) {
    if (!lastOpts || !lastOpts.container) return false;
    const tile = Array.prototype.filter.call(lastOpts.container.querySelectorAll('.dash-folder-tile'),
      function (t) { return t.dataset.id === id; })[0];
    const folder = lastOpts.folders.filter(function (f) { return f.id === id; })[0];
    const nameEl = tile && tile.querySelector('.dash-folder-name');
    if (!folder || !nameEl || !lastOpts.onRenameFolder) return false;
    const o = lastOpts;
    inlineRename(nameEl, folder.name || '', 'dash-folder-edit', function (val) { o.onRenameFolder(folder, val); });
    return true;
  }

  // ---- 筆記條列：跟首頁（dashboard.js makeNoteRow）同一個樣子 ------------------
  // 勾選框（跟首頁、側邊欄共用同一份選取與批次列）、類型圖示與標籤、釘選記號；
  // 滑過出現 釘選／修改標題／「⋯」，「⋯」是 app.js 的 showNoteMenu，首頁跟這裡共用。
  function noteKind(n) {
    if (n.meta && n.meta.perfReport) return { icon: 'chart', label: '成效報告', cls: 'kind-perf' };
    if (n.meta && n.meta.secReport) return { icon: 'shield', label: '資安院報告', cls: 'kind-sec' };
    if (n.meta && n.meta.relMap) return { icon: 'network', label: '關聯分析', cls: 'kind-relmap' };
    if (n.meta && n.meta.drawio) return { icon: 'shapes', label: 'drawio', cls: 'kind-drawio' };
    if (n.meta && n.meta.board) return { icon: 'kanban', label: 'trello', cls: 'kind-board' };
    if (n.meta && n.meta.startpage) return { icon: 'layout-grid', label: 'start.me', cls: 'kind-start' };
    if (n.meta && n.meta.xmind) return { icon: 'mind-map', label: 'xmind', cls: 'kind-xmind' };
    if (n.meta && n.meta.timetree) return { icon: 'calendar', label: 'timetree', cls: 'kind-timetree' };
    if (n.meta && n.meta.progress) return { icon: 'list-checks', label: '課程進度', cls: 'kind-progress' };
    if (n.meta && n.meta.doc) return { icon: 'file-pen', label: '文件', cls: 'kind-doc' };
    return { icon: 'file-text', label: '', cls: '' };
  }
  function isPinned(n) { return !!(n.meta && n.meta.pinned); }
  function makeNoteRow(note, o) {
    const k = noteKind(note);
    const pinned = isPinned(note);
    const wrap = el('div', 'dash-note-wrap' + (pinned ? ' pinned' : ''));
    wrap.dataset.id = note.id;
    makeNoteDraggable(wrap, note, o);
    makeNoteRowDrop(wrap, note, o);

    if (o.selection) {
      if (o.selection.has(note.id)) wrap.className += ' selected';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'dash-note-check';
      cb.checked = o.selection.has(note.id);
      cb.title = '選取';
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () {
        o.selection.toggle(note.id, cb.checked);
        wrap.classList.toggle('selected', cb.checked);
      });
      wrap.appendChild(cb);
    }

    const row = el('div', 'dash-row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.appendChild(el('span', 'dash-row-ic ' + k.cls, ic(k.icon)));
    const titleEl = el('span', 'dash-row-title', esc(note.title || '未命名筆記'));
    row.appendChild(titleEl);
    if (pinned) row.appendChild(el('span', 'dash-row-pin', ic('pin')));
    row.appendChild((global.Dashboard && Dashboard.rowTags) ? Dashboard.rowTags(note, o.onTag) : el('span', 'dash-row-tags'));
    // 跟首頁一樣標出「開放給網站內所有人」的筆記（小說區永遠不會有，伺服器擋著）
    if ((note.access || 'restricted') === 'site') {
      const g = el('span', 'dash-row-shared', ic('globe'));
      g.title = '網站內所有人可以' + (note.accessPerm === 'edit' ? '編輯' : '檢視');
      row.appendChild(g);
    }
    if (note.publicLink) {
      const g = el('span', 'dash-row-shared dash-row-public', ic('link'));
      g.title = '有公開連結：拿到網址的人不用帳號就看得到';
      row.appendChild(g);
    }
    const meta = el('span', 'dash-row-meta');
    if (k.label) meta.appendChild(el('span', 'dash-row-kind ' + k.cls, k.label));
    meta.appendChild(el('span', 'dash-row-time', esc(relTime(note.updatedAt))));
    row.appendChild(meta);
    function open() { if (o.onOpen) o.onOpen(note.id); }
    function startRename() {
      if (!o.onRenameNote) return;
      inlineRename(titleEl, note.title || '', 'dash-row-edit', function (val) { o.onRenameNote(note, val); });
    }
    row.addEventListener('click', open);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); open(); }
      else if (e.key === 'F2') { e.preventDefault(); startRename(); }
    });
    wrap.appendChild(row);

    const acts = el('div', 'dash-row-actions');
    if (o.onPin) {
      const p = actBtn('pin', pinned ? '取消釘選' : '釘選到最上面', function () { o.onPin(note, !pinned); });
      if (pinned) p.classList.add('on');
      acts.appendChild(p);
    }
    if (o.onRenameNote) acts.appendChild(actBtn('pencil', '修改標題', startRename));
    if (o.onMenu) acts.appendChild(actBtn('more-horizontal', '更多', function (btn) { o.onMenu(note, btn); }));
    wrap.appendChild(acts);
    return wrap;
  }
  // ---- 檔案條列：一個檔案一列，點了開檢視器（PDF／影片直接看，其餘下載）------------
  function makeFileRow(note, o) {
    const f = fileOf(note), kind = fileKind(f);
    const wrap = el('div', 'dash-note-wrap ab-file-wrap');
    wrap.dataset.id = note.id;
    makeNoteDraggable(wrap, note, o);
    makeNoteRowDrop(wrap, note, o);
    if (o.selection) {
      if (o.selection.has(note.id)) wrap.className += ' selected';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'dash-note-check';
      cb.checked = o.selection.has(note.id);
      cb.title = '選取';
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () {
        o.selection.toggle(note.id, cb.checked);
        wrap.classList.toggle('selected', cb.checked);
      });
      wrap.appendChild(cb);
    }
    const row = el('div', 'dash-row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const icEl = el('span', 'dash-row-ic ab-file-ic ab-file-' + kind.cls, ic(kind.icon));
    if (kind.cls === 'img') attachThumb(icEl, f);
    row.appendChild(icEl);
    const titleEl = el('span', 'dash-row-title', esc(note.title || f.name || '未命名檔案'));
    row.appendChild(titleEl);
    const meta = el('span', 'dash-row-meta');
    meta.appendChild(el('span', 'ab-file-tag ab-file-' + kind.cls, esc(kind.tag)));
    meta.appendChild(el('span', 'ab-file-size', esc(fmtSize(f.size))));
    meta.appendChild(el('span', 'dash-row-time', esc(relTime(note.updatedAt))));
    row.appendChild(meta);
    function open() { hidePop(); if (o.onOpenFile) o.onOpenFile(note); }
    row.addEventListener('click', open);
    row.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); open(); } });
    wrap.appendChild(row);

    const acts = el('div', 'dash-row-actions');
    const dl = el('a', 'dash-row-act', ic('download'));
    dl.href = '/api/images/' + encodeURIComponent(f.id);
    dl.setAttribute('download', f.name || note.title || 'file');
    dl.title = '下載';
    dl.addEventListener('click', function (e) { e.stopPropagation(); });
    acts.appendChild(dl);
    if (o.onRenameNote) {
      acts.appendChild(actBtn('pencil', '改名（只改這裡顯示的名稱）', function () {
        inlineRename(titleEl, note.title || '', 'dash-row-edit', function (val) { o.onRenameNote(note, val); });
      }));
    }
    if (o.onMoveNote) {
      acts.appendChild(actBtn('folder-open', '移動到其他資料夾', function () {
        o.onMoveNote(note).then(function (ok) { if (ok) render(o, true); });
      }));
    }
    if (o.onDeleteNote) {
      acts.appendChild(actBtn('trash', '移到垃圾桶', function () {
        o.onDeleteNote(note).then(function (ok) {
          if (ok) { o.notes = o.notes.filter(function (n) { return n.id !== note.id; }); render(o, true); }
        });
      }));
    }
    wrap.appendChild(acts);
    return wrap;
  }
  // ---- 便條紙卡片：上緣一條色帶（滑過才出現顏色／移動／刪除），下面整張就是輸入區 --------
  function makeSticky(note, o) {
    const st = stickyOf(note) || {};
    const readOnly = note.perm === 'read' || !o.onSaveSticky;
    const card = el('div', 'ab-sticky');
    card.dataset.id = note.id;
    card.dataset.color = STICKY_COLORS.indexOf(st.color) >= 0 ? st.color : 'yellow';

    const bar = el('div', 'ab-sticky-bar');
    if (!readOnly) { makeNoteDraggable(bar, note, o); bar.title = '拖這裡可以搬到其他資料夾'; }
    if (!readOnly) {
      const dots = el('div', 'ab-sticky-colors');
      STICKY_COLORS.forEach(function (c) {
        const d = el('button', 'ab-sticky-dot' + (c === card.dataset.color ? ' on' : ''));
        d.type = 'button'; d.dataset.color = c; d.title = STICKY_NAMES[c];
        d.setAttribute('aria-label', STICKY_NAMES[c]);
        d.addEventListener('click', function () {
          if (card.dataset.color === c) return;
          card.dataset.color = c;           // 先換顏色再存：不重畫，正在打的字跟游標都不動
          Array.prototype.forEach.call(dots.children, function (x) { x.classList.toggle('on', x === d); });
          o.onSaveSticky(note, { color: c });
        });
        dots.appendChild(d);
      });
      bar.appendChild(dots);
    }
    const acts = el('div', 'ab-sticky-acts');
    function act(icon, title, fn) {
      const b = el('button', 'ab-sticky-act', ic(icon));
      b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      acts.appendChild(b);
    }
    if (!readOnly && o.onMoveNote) {
      act('folder-open', '移動到其他資料夾', function () {
        flushStickySave(note.id);
        o.onMoveNote(note).then(function (ok) { if (ok) render(o, true); });
      });
    }
    if (!readOnly && o.onDeleteNote) {
      act('trash', '移到垃圾桶', function () {
        flushStickySave(note.id);
        o.onDeleteNote(note).then(function (ok) {
          if (ok) { o.notes = o.notes.filter(function (n) { return n.id !== note.id; }); render(o, true); }
        });
      });
    }
    bar.appendChild(acts);
    card.appendChild(bar);

    const ta = el('textarea', 'ab-sticky-text');
    ta.dataset.id = note.id;
    ta.value = note.content || '';
    ta.placeholder = '寫點什麼…';
    ta.spellcheck = false;
    ta.readOnly = readOnly;
    ta.setAttribute('aria-label', '便條紙內容');
    const time = el('div', 'ab-sticky-foot', esc(relTime(note.updatedAt)));
    if (!readOnly) {
      ta.addEventListener('input', function () {
        note.content = ta.value;            // 本機的那份馬上更新：這時候重畫也是最新的字
        autosize(ta);
        time.textContent = '儲存中…';
        scheduleStickySave(note, function (n, fields) {
          Promise.resolve(o.onSaveSticky(n, fields)).then(function (ok) {
            // 卡片可能已經被重畫換掉了；這個 time 不在畫面上的話寫了也無妨
            time.textContent = ok === false ? '儲存失敗' : '已儲存';
          });
        });
      });
      ta.addEventListener('blur', function () { flushStickySave(note.id); });
      // Esc 離開這張便條紙（存檔走 blur）；不攔其他按鍵，Tab 照常移到下一個控制項
      ta.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); ta.blur(); } });
    }
    card.appendChild(ta);
    card.appendChild(time);
    // 點到卡片的空白處（字的下面、色帶）也是要打字
    card.addEventListener('mousedown', function (e) {
      if (e.target === card || e.target === time) { e.preventDefault(); ta.focus(); }
    });
    return card;
  }
  function focusSticky(id, s, e) {
    if (!lastOpts || !lastOpts.container || !id) return;
    const ta = Array.prototype.filter.call(lastOpts.container.querySelectorAll('.ab-sticky-text'),
      function (x) { return x.dataset.id === id; })[0];
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const end = ta.value.length;
    try { ta.setSelectionRange(s == null ? end : s, e == null ? end : e); } catch (err) { /* ignore */ }
    const card = ta.closest('.ab-sticky');
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
  }

  function makeUploadRow(u) {
    const wrap = el('div', 'ab-upload' + (u.error ? ' is-error' : ''));
    wrap.appendChild(el('span', 'dash-row-ic', ic(u.error ? 'alert-triangle' : 'upload')));
    const main = el('div', 'ab-upload-main');
    main.appendChild(el('div', 'ab-upload-name', esc(u.name)));
    if (u.error) {
      main.appendChild(el('div', 'ab-upload-err', esc('上傳失敗：' + u.error)));
    } else {
      const track = el('div', 'ab-upload-track');
      const p = u.size ? Math.min(100, Math.round(u.sent / u.size * 100)) : 0;
      u.bar = el('div', 'ab-upload-bar');
      u.bar.style.width = p + '%';
      track.appendChild(u.bar);
      main.appendChild(track);
    }
    wrap.appendChild(main);
    if (u.error) {
      const x = el('button', 'dash-row-act', ic('x'));
      x.type = 'button'; x.title = '關掉這一列';
      x.addEventListener('click', function () { uploads = uploads.filter(function (y) { return y !== u; }); if (lastOpts) render(lastOpts, true); });
      wrap.appendChild(x);
    } else {
      u.pct = el('span', 'ab-upload-pct', u.started ? (u.size ? Math.round(u.sent / u.size * 100) : 0) + '%' : '排隊中');
      wrap.appendChild(el('span', 'ab-file-size', esc(fmtSize(u.size))));
      wrap.appendChild(u.pct);
    }
    return wrap;
  }
  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '剛剛';
    if (min < 60) return min + ' 分鐘前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小時前';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + ' 天前';
    const mon = Math.floor(day / 30);
    if (mon < 12) return mon + ' 個月前';
    return Math.floor(mon / 12) + ' 年前';
  }
  function actBtn(icon, title, fn) {
    const b = el('button', 'dash-row-act', ic(icon));
    b.type = 'button';
    b.title = title;
    // fn 拿到按鈕本身，換區域選單要貼著它的位置開（其餘呼叫端都不需要，忽略即可）
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(b); });
    return b;
  }

  // ---- 內文：資料夾方框格線 + 筆記條列（跟 dashboard.js 一樣回傳 fragment）-----
  function sectionHead(icon, label, count) {
    return el('div', 'dash-section-head',
      ic(icon) + '<span>' + esc(label) + '</span><span class="dash-section-count">' + count + '</span>');
  }
  function emptyState(icon, text) { return el('div', 'dash-empty', ic(icon) + '<span>' + esc(text) + '</span>'); }
  // 「全選」：這一段列出來的筆記一次勾起來，再按一次全部取消；批次的移動／刪除在側邊欄的批次列。
  // 字（全選／取消全選）由 _label 算，app.js 在勾選有變的時候（逐一勾、從側邊欄勾、按 ✕ 清掉）
  // 都會叫一次，所以不會跟實際狀態對不上。
  function selAllButton(list, o) {
    const ids = list.filter(function (n) { return !n.perm || n.perm === 'owner'; }).map(function (n) { return n.id; });
    if (!o.selection || !o.selection.setMany || !ids.length) return null;
    const b = el('button', 'dash-selall');
    b.type = 'button';
    function allOn() { return ids.every(function (id) { return o.selection.has(id); }); }
    b._label = function () { b.textContent = allOn() ? '取消全選' : '全選'; };
    b._label();
    b.addEventListener('click', function (e) { e.stopPropagation(); o.selection.setMany(ids, !allOn()); });
    return b;
  }
  // 「刪除」：就在「全選」旁邊。把這一段裡勾起來的移到垃圾桶——不用把側邊欄拉出來找批次列。
  // 沒勾任何一項時是灰的；有勾就把數量寫在字後面，按下去之前就知道會動到幾項。
  // unit：'篇'（筆記）或 '個'（檔案）。字跟灰不灰同樣由 _label 算，app.js 的 syncSelAll 會叫。
  function selDelButton(list, o, unit) {
    const ids = list.filter(function (n) { return !n.perm || n.perm === 'owner'; }).map(function (n) { return n.id; });
    if (!o.selection || !o.selection.removeMany || !ids.length) return null;
    const b = el('button', 'dash-seldel', ic('trash') + '<span></span>');
    b.type = 'button';
    function picked() { return ids.filter(function (id) { return o.selection.has(id); }); }
    b._label = function () {
      const n = picked().length;
      b.disabled = !n;
      b.querySelector('span').textContent = n ? '刪除 ' + n + ' ' + unit : '刪除';
      b.title = n ? '把勾選的 ' + n + ' ' + unit + '移到垃圾桶' : '先勾選要刪除的項目';
    };
    b._label();
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      const p = picked();
      if (p.length) o.selection.removeMany(p, unit);
    });
    return b;
  }


  function renderBody(o) {
    const frag = document.createDocumentFragment();
    if (curFolderId && !o.folders.some(function (f) { return f.id === curFolderId; })) curFolderId = null;
    const subs = foldersIn(o.folders, curFolderId);
    const here = notesIn(o.notes, curFolderId);
    const ns = here.filter(function (n) { return kindOf(n) === 'note'; });
    const files = here.filter(fileOf);
    // 便條紙照建立時間排（新的在前），不照最後修改：不然一邊打字卡片一邊換位置
    const stickies = here.filter(stickyOf).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    const ups = uploads.filter(function (u) { return u.area === (o.area || null) && (u.folderId || null) === curFolderId; });

    // 便條紙貼在最上面：它就是要一進資料夾就看到的東西
    if (stickies.length) {
      const sec0 = el('section', 'dash-section');
      sec0.appendChild(sectionHead('sticky-note', '便條紙', stickies.length));
      const wall = el('div', 'ab-sticky-grid');
      stickies.forEach(function (n) { wall.appendChild(makeSticky(n, o)); });
      sec0.appendChild(wall);
      frag.appendChild(sec0);
    }

    // 電子書（知識區專屬，o.books）：所有做成電子書的資料夾，不限哪個區域——首頁那一區搬過來的。
    // 磚是首頁那一種（Dashboard.makeBookTile），章數要用全站的 notes／folders 算（o.booksCtx），
    // 不然一般區那本在這裡會變成 0 章。
    if (!curFolderId && o.books && global.Dashboard && Dashboard.makeBookTile) {
      const books = o.books.slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'zh-Hant'); });
      const secB = el('section', 'dash-section');
      secB.appendChild(sectionHead('book-open', '電子書', books.length));
      if (books.length) {
        const gridB = (global.Dashboard && Dashboard.folderGrid ? Dashboard.folderGrid(viewKey(o)) : el('div', 'dash-folder-grid'));
        books.forEach(function (f) { gridB.appendChild(Dashboard.makeBookTile(f, o.booksCtx || o)); });
        secB.appendChild(gridB);
      } else {
        secB.appendChild(emptyState('book-open', '還沒有電子書。資料夾的「⋮ → 以電子書閱讀」或左側「新增 → 電子書」把一個資料夾做成電子書，它就會放在這裡。'));
      }
      frag.appendChild(secB);
    }

    if (subs.length) {
      const sec = el('section', 'dash-section');
      sec.appendChild(sectionHead('folder', '資料夾', subs.length));
      const grid = (global.Dashboard && Dashboard.folderGrid ? Dashboard.folderGrid(viewKey(o)) : el('div', 'dash-folder-grid'));
      subs.forEach(function (f) { grid.appendChild(makeFolderTile(f, o)); });
      sec.appendChild(grid);
      frag.appendChild(sec);
    }

    // 只放檔案的資料夾（一週的投影片跟錄影）不需要一段「還沒有筆記」擋在檔案上面
    if (ns.length || !(files.length || ups.length || stickies.length)) {
      const sec2 = el('section', 'dash-section');
      const h2 = sectionHead('file-text', curFolderId ? '筆記' : '未歸類筆記', ns.length);
      const sa = selAllButton(ns, o);
      if (sa) h2.appendChild(sa);
      const sd = selDelButton(ns, o, '篇');
      if (sd) h2.appendChild(sd);
      sec2.appendChild(h2);
      const list = el('div', 'dash-list');
      if (!ns.length) list.appendChild(emptyState('file-text', o.emptyHint || (curFolderId ? '這個資料夾裡還沒有筆記。' : '還沒有筆記。')));
      ns.forEach(function (n) { list.appendChild(makeNoteRow(n, o)); });
      sec2.appendChild(list);
      frag.appendChild(sec2);
    }

    // 檔案：跟筆記放在同一個資料夾裡，分開一段列出來。有上傳功能的區域就算還沒有檔案
    // 也顯示這一段（當作拖放的落點跟提示）；沒有上傳功能的區域只在真的有檔案時才出現。
    if (o.onUploadFile || files.length || ups.length) {
      const sec3 = el('section', 'dash-section');
      const h3 = sectionHead('paperclip', '檔案', files.length);
      const fsa = selAllButton(files, o);
      if (fsa) h3.appendChild(fsa);
      const fsd = selDelButton(files, o, '個');
      if (fsd) h3.appendChild(fsd);
      sec3.appendChild(h3);
      const flist = el('div', 'dash-list');
      ups.forEach(function (u) { flist.appendChild(makeUploadRow(u)); });
      if (!files.length && !ups.length) {
        flist.appendChild(emptyState('upload', '把 PPTX、PDF、影片拖進來，或按右上角的「上傳檔案」，就會放在這個資料夾裡。'));
      }
      files.forEach(function (n) { flist.appendChild(makeFileRow(n, o)); });
      sec3.appendChild(flist);
      frag.appendChild(sec3);
    }
    return frag;
  }

  // 拖放上傳：整頁都是落點。監聽只掛一次在容器上（render 每次清的是裡面的內容）。
  function bindDrop(container) {
    if (container._abDrop) return;
    container._abDrop = true;
    let depth = 0;
    function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
    function off() {
      depth = 0; container.classList.remove('ab-dropping');
      container.querySelectorAll('.dash-folder-tile.drop-target').forEach(function (x) { x.classList.remove('drop-target'); });
    }
    container.addEventListener('dragenter', function (e) {
      if (!lastOpts || !lastOpts.onUploadFile || !hasFiles(e)) return;
      e.preventDefault(); depth++; container.classList.add('ab-dropping');
    });
    function tileAt(e) { return e.target && e.target.closest ? e.target.closest('.dash-folder-tile') : null; }
    container.addEventListener('dragover', function (e) {
      if (!lastOpts || !lastOpts.onUploadFile || !hasFiles(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      container.classList.add('ab-dropping');   // 拖到一半畫面重畫過、漏了 dragenter 也照樣亮
      const t = tileAt(e);
      container.querySelectorAll('.dash-folder-tile.drop-target').forEach(function (x) { if (x !== t) x.classList.remove('drop-target'); });
      if (t) t.classList.add('drop-target');
    });
    container.addEventListener('dragleave', function () { if (--depth <= 0) off(); });
    container.addEventListener('drop', function (e) {
      if (!lastOpts || !lastOpts.onUploadFile || !hasFiles(e)) return;
      const t = tileAt(e);
      e.preventDefault(); off();
      if (e.dataTransfer.files && e.dataTransfer.files.length) queueUploads(e.dataTransfer.files, lastOpts, t ? t.dataset.id : undefined);
    });
  }

  function render(opts, keepPos) {
    lastOpts = opts;
    if (!keepPos) curFolderId = null;
    const container = opts.container;
    hidePop();
    bindDrop(container);
    // 正在打字的便條紙：重畫會換掉整個 DOM，記下是哪一張、游標在哪，畫完放回去
    const act = document.activeElement;
    const typing = act && act.classList && act.classList.contains('ab-sticky-text') && container.contains(act)
      ? { id: act.dataset.id, s: act.selectionStart, e: act.selectionEnd } : null;
    container.innerHTML = '';
    container.appendChild(renderHead(opts));
    container.appendChild(renderBody(opts));
    autosizeAll();
    if (typing) focusSticky(typing.id, typing.s, typing.e);
  }

  global.AreaBrowser = {
    render: function (container, opts) { opts.container = container; render(opts, false); },
    refresh: function (opts) { if (lastOpts) { opts.container = lastOpts.container; render(opts, true); } },
    // 直接進到某個資料夾（#note/<id> 連到一個檔案時，背景停在它所在的資料夾）
    openFolder: function (id) { go(id || null); },
    // 側邊欄的「新增」要知道現在瀏覽到哪個資料夾，新筆記才會建在這裡
    currentFolder: function () { return curFolderId; },
    renameFolderTile: renameFolderTile,
    // app.js 的檔案檢視器用同一套分類／大小寫法，列表跟檢視器才不會各說各話
    fileKind: fileKind, fmtSize: fmtSize,
    // #note/<id> 或搜尋結果指到一張便條紙：app.js 先帶到它的資料夾，再叫這個把游標放上去
    focusSticky: function (id) { focusSticky(id); },
    reset: function () { curFolderId = null; lastOpts = null; hidePop(); thumbCache.clear(); }
  };
})(window);
