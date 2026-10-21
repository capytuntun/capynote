/* app.js — UI orchestration: tree, editor, view modes, paste, export */
(function () {
  'use strict';

  const $ = function (sel) { return document.querySelector(sel); };
  const LS = {
    get: function (k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  const state = {
    folders: [],
    notes: [],
    currentId: null,
    mode: LS.get('mode', 'split'),
    expanded: {},
    current: null
  };

  try { state.expanded = JSON.parse(LS.get('expanded', '{}')) || {}; } catch (e) { state.expanded = {}; }

  // ---- Elements ----------------------------------------------------------
  const treeEl = $('#tree');
  const editorEl = $('#editor');
  const previewEl = $('#preview');
  const previewScrollEl = $('#preview-scroll');
  const tocEl = $('#preview-toc');
  const titleEl = $('#note-title');
  const panesEl = $('#panes');
  const emptyEl = $('#empty-state');
  const wrapEl = $('#editor-wrap');
  const statusInfo = $('#status-info');
  const statusSave = $('#status-save');
  const statusCursors = $('#status-cursors');
  let multi = null;   // js/multicursor.js：多行（多游標）編輯
  const ctxMenu = $('#ctx-menu');
  const backlinksEl = $('#backlinks');
  const searchInput = $('#search-input');
  const searchResultsEl = $('#search-results');
  const searchClearEl = $('#search-clear');
  const shareBtn = $('#share-btn');
  const historyBtn = $('#history-btn');
  const presenceEl = $('#presence');
  const editorAreaEl = $('#editor-area');
  const notePathEl = $('#note-path');
  const selected = new Set();   // 批次選取的筆記 id（和儀表板共用）
  const selectedFolders = new Set();   // 批次選取的資料夾 id（只有側邊欄能勾）

  // ---- Note links --------------------------------------------------------
  function normTitle(t) { return String(t || '').trim().toLowerCase(); }
  function findNoteByTitle(title) {
    const k = normTitle(title);
    return state.notes.filter(function (n) { return normTitle(n.title) === k; })[0] || null;
  }
  // markdown.js resolves [[…]] through this; editor.js autocompletes through it.
  MD.setNoteLookup(findNoteByTitle);
  // 樹狀清單／搜尋結果用的筆記圖示：分享來的看權限，自己的看筆記種類。
  // 樹上顯示的名字。隨筆多半沒有標題（伺服器補的「未命名筆記」），整排都叫同一個名字沒有用，
  // 改拿內文第一行（去掉 Markdown 的標記）當名字。
  function treeLabel(note) {
    if (note.area === 'quick' && (!note.title || note.title === '未命名筆記')) {
      const line = String(note.content || '').split('\n').map(function (l) {
        return l.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s*|\d+\.\s+)/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
      }).filter(Boolean)[0];
      return line ? line.slice(0, 40) : '（空白隨筆）';
    }
    return note.title || '未命名筆記';
  }
  function noteIcon(note) {
    if (note.perm && note.perm !== 'owner') return note.perm === 'edit' ? 'pen-line' : 'lock';
    if (isFileNote(note)) return (window.AreaBrowser && AreaBrowser.fileKind) ? AreaBrowser.fileKind(note.meta.file).icon : 'paperclip';
    if (note.meta && note.meta.relMap) return 'network';
    if (note.meta && note.meta.drawio) return 'shapes';
    if (note.meta && note.meta.board) return 'kanban';
    if (note.meta && note.meta.startpage) return 'layout-grid';
    if (note.meta && note.meta.xmind) return 'mind-map';
    if (note.meta && note.meta.timetree) return 'calendar';
    if (note.meta && note.meta.progress) return 'list-checks';
    if (note.meta && note.meta.foodmap) return 'map-pin';
    if (note.meta && note.meta.doc) return 'file-pen';
    if (note.meta && note.meta.video) return 'film';
    if (note.area === 'quick') return 'pin';
    if (note.meta && note.meta.perfReport) return 'chart';
    if (note.meta && note.meta.secReport) return 'shield';
    return 'file-text';
  }
  if (window.Editor) Editor.setNoteProvider(function (query) {
    const q = normTitle(query);
    return state.notes
      .filter(function (n) { return n.id !== state.currentId && normTitle(n.title).indexOf(q) >= 0; })
      .sort(function (a, b) {
        // Prefix matches first, then most recently touched.
        const ap = normTitle(a.title).indexOf(q) === 0, bp = normTitle(b.title).indexOf(q) === 0;
        if (ap !== bp) return ap ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
  });

  // ---- Init --------------------------------------------------------------
  function init() {
    applyTheme(LS.get('theme', 'light'));
    setMode(state.mode);
    setTocCollapsed(LS.get('tocCollapsed', '0') === '1');
    bindEvents();
    // Nothing loads until the session is confirmed by the server.
    Auth.init(function (user) {
      loadData().then(function () {
        // Notes from before the server existed are stranded in IndexedDB — offer
        // to bring them across rather than silently leave them behind.
        if (window.Migrate) Migrate.maybeOffer(user, function () { loadData(); });
      }).catch(function (e) {
        alert('無法載入筆記：' + (e && e.message || e));
      });
    });
  }

  function loadData() {
    return Promise.all([Store.getFolders(), Store.getNotes()]).then(function (res) {
      state.folders = res[0];
      state.notes = res[1];
      renderTree();
      // 網址帶 #trash、#folder/<id>、#note/<id> 或 #book/<id>（複製連結）優先；否則回到上次開的筆記
      const wantNote = noteIdFromHash();
      const wantBook = bookIdFromHash();
      const wantFolder = folderIdFromHash();
      const last = wantNote || LS.get('lastNote', null);
      if (location.hash === '#trash') {
        openTrash();
      } else if (location.hash === '#files') {
        openFiles();
      } else if (tagFromHash()) {
        const wantTag = tagFromHash();   // showEmpty 會把 hash 清掉，先記下來
        showEmpty();
        if (window.Dashboard && Dashboard.setTag) Dashboard.setTag(wantTag);
      } else if (areaFromHash() && areaFromHash().area !== 'novel') {
        // #course、#course/<資料夾>（知識區同理）：重新整理停在原本那一層
        openArea(areaFromHash().area, { folderId: areaFromHash().folderId, keepHash: true });
      } else if (location.hash === '#videos') {
        openVideos({ keepHash: true });   // 個人區的影片頁：openVideos 自己會先問密碼
      } else if (location.hash === '#quick') {
        openQuick();
      } else if (location.hash === '#board') {
        openBoards();
      } else if (location.hash === '#start') {
        openStart();
      } else if (location.hash === '#xmind') {
        openXmind();
      } else if (location.hash === '#timetree') {
        openTimeTree();
      } else if (location.hash === '#progress') {
        openProgress();
      } else if (location.hash === '#foodmap') {
        openFoodMap();
      } else if (areaFromHash() && areaFromHash().area === 'novel') {
        // 一定要先問過密碼才能進去，重新整理也一樣——openArea('novel') 本身就會擋下來彈窗。
        // 還沒解鎖時小說的資料夾不在 state.folders 裡，所以資料夾 id 直接從網址拿
        const nm = location.hash.match(AREA_HASH);
        openArea('novel', { folderId: nm[2] ? decodeURIComponent(nm[2]) : null, keepHash: true });
      } else if (wantFolder && state.folders.some(function (f) { return f.id === wantFolder; })) {
        // 在資料夾裡重新整理：留在那個資料夾，網址不動
        showEmpty(true);
        if (window.Dashboard) Dashboard.openFolder(wantFolder);
      } else if (wantBook && state.folders.some(function (f) { return f.id === wantBook; })) {
        openBook(wantBook);
      } else if (wantNote && isStickyNote(state.notes.find(function (n) { return n.id === wantNote; })) &&
                 goToSticky(state.notes.find(function (n) { return n.id === wantNote; }))) {
        // 便條紙的連結：goToSticky 已經把畫面帶到它的資料夾了
      } else if (wantNote && isFileNote(state.notes.find(function (n) { return n.id === wantNote; }))) {
        // 連結指到一個上傳的檔案：背景先停在它所在的區域／資料夾，再把檢視器疊上去
        const fn = state.notes.find(function (n) { return n.id === wantNote; });
        if (fn.area && fn.area !== 'novel' && AREA_INFO[fn.area] && AREA_INFO[fn.area].wrap) {
          // 網址留著 #note/<檔案>（重新整理還是這個檔案），背景停在它的資料夾
          openArea(fn.area, { folderId: fn.folderId || null, keepHash: true });
        } else showEmpty();
        openFileViewer(fn);
      } else if (last && state.notes.some(function (n) { return n.id === last; })) {
        openNote(last);
      } else {
        if (wantNote || wantBook) toast('找不到這篇筆記，或你沒有存取權');
        showEmpty();
      }
      progressOverdueNotice();
    });
  }

  // ---- Tree rendering ----------------------------------------------------
  // 排序方式與手動順序跟首頁共用（js/sorting.js）
  // 側邊欄的樹跟著「目前所在的區域」走（treeArea）：在首頁、垃圾桶、電子書或一般筆記裡是
  // null＝所有筆記；進了課程筆記／知識區／小說／隨筆，或打開這些區域裡的一篇筆記，樹就換成
  // 那個區域自己的資料夾與筆記。一次只顯示一個區域，所以拖放、批次選取、在此新增都只會碰到
  // 同一個區域的東西——不同區域的項目永遠不會同時出現在樹上。首頁儀表板不看這個變數，它自己
  // 永遠只篩 !x.area（見 dashOpts），所以別的區域的筆記不會混進首頁。
  // childFolders/childNotes 的第三個參數可以指定區域（placeItems 用被拖的那一項自己的區域，
  // 不靠畫面狀態）；不給就是 treeArea。
  let treeArea = null;
  function childFolders(parentId, mode, area) {
    const a = area === undefined ? treeArea : (area || null);
    return state.folders
      .filter(function (f) { return (f.area || null) === a && (f.parentId || null) === parentId; })
      .sort(function (a1, b1) { return Sorting.compareFolders(a1, b1, mode); });
  }
  const isMine = n => !n.perm || n.perm === 'owner';
  function childNotes(folderId, mode, area) {
    const a = area === undefined ? treeArea : (area || null);
    return state.notes
      // 便條紙不是文件，只活在它的資料夾頁面上；上傳的檔案是資料夾的內容，照樣列出來
      .filter(function (n) { return (n.area || null) === a && isMine(n) && !isStickyNote(n) && !isVideoNote(n) && (n.folderId || null) === folderId; })
      .sort(function (a1, b1) { return Sorting.compareNotes(a1, b1, mode); });
  }
  // 換區域時清掉批次選取：選到的東西已經不在畫面上了，留著只會讓「刪除／移動」動到看不見的項目
  function setTreeArea(area) {
    area = area || null;
    if (area !== treeArea) {
      treeArea = area;
      selected.clear();
      selectedFolders.clear();
    }
    // 樹顯示哪個區域，側邊欄那一列就亮著——包括正在編輯那個區域裡的一篇筆記的時候
    ['course', 'knowledge', 'novel', 'quick', 'board', 'start', 'xmind', 'timetree', 'progress', 'foodmap'].forEach(function (a) { setNavActive(a + '-open-btn', a === area); });
    renderTree();
  }
  // 新東西要建在哪個區域：有目標資料夾就跟資料夾（伺服器的 resolveArea 也是這樣要求的），
  // 沒有就是側邊欄現在所在的區域。隨筆沒有資料夾也不從側邊欄新增，當成一般區域。
  function areaForNew(folderId) {
    if (folderId) {
      const f = state.folders.find(function (x) { return x.id === folderId; });
      return f ? (f.area || null) : null;
    }
    return treeArea && treeArea !== 'quick' && treeArea !== 'board' && treeArea !== 'start' && treeArea !== 'xmind' && treeArea !== 'timetree' && treeArea !== 'progress' && treeArea !== 'foodmap' ? treeArea : null;   // 看板、起始頁、心智圖、行事曆、課程進度、美食地圖只從自己的頁面建立
  }
  function withArea(folderId, opts) {
    const a = areaForNew(folderId);
    return a ? Object.assign({}, opts, { area: a }) : opts;
  }
  // 四個獨立區域各自的筆記／資料夾（永遠是自己的，不含分享來的）。
  function areaNotes(area) { return state.notes.filter(function (n) { return n.area === area && isMine(n); }); }
  function areaFolders(area) { return state.folders.filter(function (f) { return f.area === area; }); }
  // Notes shared with me live in their owner's folder tree, not mine, so they get
  // their own section instead of being filed under a folder id I do not have.
  function sharedNotes() {
    return state.notes.filter(function (n) { return !isMine(n); })
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  function renderTree() {
    // Notes changed (created / deleted / renamed / moved), so any open result
    // list is now stale — recompute it against the current notes.
    if (search.query.trim()) runSearch(search.query);
    treeEl.innerHTML = '';
    // 在某個區域裡：樹的最上面標出這是哪個區域的內容，免得跟「所有筆記」的樹搞混
    if (treeArea) {
      const info = treeArea === 'quick' ? { title: '隨筆', icon: 'pin' } : treeArea === 'board' ? { title: 'trello', icon: 'kanban' } : treeArea === 'start' ? { title: 'start.me', icon: 'layout-grid' } : treeArea === 'xmind' ? { title: 'xmind', icon: 'mind-map' } : treeArea === 'timetree' ? { title: 'timetree', icon: 'calendar' } : treeArea === 'progress' ? { title: '課程進度', icon: 'list-checks' } : treeArea === 'foodmap' ? { title: '圖資中心', icon: 'map-pin' } : AREA_INFO[treeArea];
      const head = document.createElement('div');
      head.className = 'tree-section tree-area-head';
      head.innerHTML = Icons.svg(info.icon) + '<span>' + MD.escapeHtml(info.title) + '</span>';
      treeEl.appendChild(head);
    }
    treeEl.appendChild(buildLevel(null));
    if (!childFolders(null).length && !childNotes(null).length) {
      const hint = document.createElement('div');
      hint.className = 'tree-hint';
      hint.textContent = treeArea === 'quick' ? '還沒有隨筆。'
        : treeArea === 'board' ? '還沒有看板。'
        : treeArea === 'start' ? '還沒有起始頁。'
        : treeArea === 'xmind' ? '還沒有心智圖。'
        : treeArea === 'timetree' ? '還沒有行事曆。'
        : treeArea === 'progress' ? '還沒有課程。'
        : treeArea === 'foodmap' ? '還沒有圖層。'
        : treeArea ? '這個區域還沒有資料夾或筆記。'
        : '尚無筆記，點上方「＋ 筆記」開始。';
      treeEl.appendChild(hint);
    }
    // 別人分享給我的筆記不屬於我的任何區域，只跟「所有筆記」的樹放在一起
    const shared = treeArea ? [] : sharedNotes();
    if (shared.length) {
      const head = document.createElement('div');
      head.className = 'tree-section';
      head.textContent = '分享給我的（' + shared.length + '）';
      treeEl.appendChild(head);
      shared.forEach(function (n) { treeEl.appendChild(buildNoteRow(n)); });
    }
    pruneSelection();   // 同步批次列（丟掉已不存在的選取）
  }

  function buildLevel(parentId) {
    const frag = document.createDocumentFragment();
    childFolders(parentId).forEach(function (f) { frag.appendChild(buildFolder(f)); });
    childNotes(parentId).forEach(function (n) { frag.appendChild(buildNoteRow(n)); });
    return frag;
  }

  function buildFolder(folder) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-folder';
    const open = !!state.expanded[folder.id];

    const row = document.createElement('div');
    const picked = selectedFolders.has(folder.id);
    row.className = 'tree-row folder-row selectable' + (picked ? ' selected' : '');
    row.draggable = true;
    row.dataset.type = 'folder';
    row.dataset.id = folder.id;
    // 勾選框疊在圖示欄上（見 app.css 的 .tree-check）；資料夾一定是自己的，所以每個都能勾
    row.innerHTML =
      '<span class="twisty">' + Icons.svg(open ? 'chevron-down' : 'chevron-right') + '</span>' +
      '<span class="lead"><span class="ic ic-folder">' + Icons.svg('folder') + '</span>' +
      '<input type="checkbox" class="tree-check" title="選取"' + (picked ? ' checked' : '') + '></span>' +
      '<span class="label">' + MD.escapeHtml(folder.name) + '</span>';
    const cb = row.querySelector('.tree-check');
    // 點框只切換選取：不展開／收合資料夾，連點也不進入改名
    cb.addEventListener('click', function (e) { e.stopPropagation(); });
    cb.addEventListener('dblclick', function (e) { e.stopPropagation(); });
    cb.addEventListener('change', function () {
      if (cb.checked) selectedFolders.add(folder.id); else selectedFolders.delete(folder.id);
      row.classList.toggle('selected', cb.checked);
      updateBatchBar();
    });

    // hover actions: add subfolder / add note inside this folder
    const actions = document.createElement('span');
    actions.className = 'row-actions';
    const bFolder = document.createElement('button');
    bFolder.className = 'row-act'; bFolder.title = '新增子資料夾'; bFolder.innerHTML = Icons.svg('folder-plus');
    const bNote = document.createElement('button');
    bNote.className = 'row-act'; bNote.title = '在此新增筆記'; bNote.innerHTML = Icons.svg('file-plus');
    const bBook = document.createElement('button');
    bBook.className = 'row-act'; bBook.title = '以電子書閱讀這個資料夾'; bBook.innerHTML = Icons.svg('book-open');
    bFolder.addEventListener('click', function (e) { e.stopPropagation(); newFolder(folder.id); });
    bNote.addEventListener('click', function (e) { e.stopPropagation(); newNote(folder.id); });
    bBook.addEventListener('click', function (e) { e.stopPropagation(); openBook(folder.id); });
    actions.appendChild(bFolder);
    actions.appendChild(bNote);
    // 電子書是首頁那一區的功能（folders.is_book 會把資料夾列進首頁的「電子書」），區域的資料夾不給
    if (!folder.area) actions.appendChild(bBook);
    row.appendChild(actions);

    row.addEventListener('click', function () { toggleFolder(folder.id); });
    row.addEventListener('dblclick', function (e) { e.stopPropagation(); startRename('folder', folder.id); });
    row.addEventListener('contextmenu', function (e) { showCtx(e, 'folder', folder); });
    attachDrag(row, 'folder', folder.id);
    attachDrop(row, 'folder', folder);
    wrap.appendChild(row);

    if (open) {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      kids.appendChild(buildLevel(folder.id));
      wrap.appendChild(kids);
    }
    return wrap;
  }

  function buildNoteRow(note) {
    const row = document.createElement('div');
    const mine = isMine(note);
    row.className = 'tree-row note-row' + (note.id === state.currentId ? ' active' : '') +
      (mine ? ' selectable' : ' shared-row') + (selected.has(note.id) ? ' selected' : '');
    row.draggable = mine;   // dragging a shared note into my folders would do nothing
    row.dataset.type = 'note';
    row.dataset.id = note.id;
    // 只有自己的筆記才有勾選框（批次移動／刪除都需要擁有權）。空的箭頭欄讓圖示和資料夾對齊，
    // 勾選框和資料夾列一樣疊在圖示欄上
    const checkHtml = mine
      ? '<input type="checkbox" class="tree-check" title="選取"' + (selected.has(note.id) ? ' checked' : '') + '>'
      : '';
    row.innerHTML = '<span class="twisty"></span>' +
      '<span class="lead"><span class="ic">' + Icons.svg(noteIcon(note)) + '</span>' + checkHtml + '</span>' +
      '<span class="label">' + MD.escapeHtml(treeLabel(note)) + '</span>' +
      (mine ? '' : '<span class="share-by">' + MD.escapeHtml(note.sharedBy || '') + '</span>');
    const cb = row.querySelector('.tree-check');
    if (cb) {
      // 點框只切換選取，不要順便打開筆記
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () {
        if (cb.checked) selected.add(note.id); else selected.delete(note.id);
        row.classList.toggle('selected', cb.checked);
        syncDashCheck(note.id, cb.checked);   // 反映到儀表板「所有筆記」
        updateBatchBar();
        syncSelAll();
      });
    }
    row.addEventListener('click', function () {
      // 隨筆在它自己那一頁是用 Keep 式的對話框開的，從側邊欄點也一樣，不進整頁編輯器
      if (note.area === 'quick' && window.QuickNotes && QuickNotes.open && quickWrapEl && !quickWrapEl.hidden && QuickNotes.open(note.id)) return;
      openNote(note.id);
    });
    row.addEventListener('contextmenu', function (e) { showCtx(e, 'note', note); });
    attachDrag(row, 'note', note.id);
    if (mine) attachDrop(row, 'note', note);
    return row;
  }

  function toggleFolder(id) {
    state.expanded[id] = !state.expanded[id];
    LS.set('expanded', JSON.stringify(state.expanded));
    renderTree();
  }

  // ---- Drag & drop: move into a folder, or reorder -----------------------
  // A folder row answers in thirds: the top and bottom thirds put a dragged
  // folder before / after it among its siblings, the middle moves it inside
  // (a dragged note always goes inside). A note row answers in halves, for notes
  // only. The empty tree area below the rows is the top level (see below).
  // js/dashboard.js starts its own drags with these same two MIME types. The tree
  // publishes them as well, and reads them back below, so a drag started on one
  // surface can be dropped on the other: the sidebar is a drawer floating *over*
  // the dashboard, so tree rows and folder tiles are on screen at the same time
  // and dragging between them is the obvious gesture. Carrying real data also
  // keeps the drag working in browsers that refuse to begin one whose data store
  // is empty (only Chrome is lenient about that).
  const DND_NOTES = 'application/x-strikenote-notes';
  const DND_FOLDER = 'application/x-strikenote-folder';
  let dragData = null;   // { type: 'note' | 'folder', ids: [...] }, when the drag started here
  // What kind of thing is being dragged — from the module var when this surface
  // started it, otherwise from the types the drag carries. Only `types` is
  // readable during dragover; the ids have to wait for the drop (dragPayload).
  function dragKind(e) {
    if (dragData) return dragData.type;
    const t = e.dataTransfer && e.dataTransfer.types;
    if (!t) return null;
    if (Array.prototype.indexOf.call(t, DND_NOTES) >= 0) return 'note';
    if (Array.prototype.indexOf.call(t, DND_FOLDER) >= 0) return 'folder';
    return null;
  }
  function dragPayload(e) {
    if (dragData) return dragData;
    try {
      const notes = e.dataTransfer.getData(DND_NOTES);
      if (notes) return { type: 'note', ids: JSON.parse(notes) };
      const folder = e.dataTransfer.getData(DND_FOLDER);
      if (folder) return { type: 'folder', ids: [folder] };
    } catch (err) { /* unreadable data store: treat it as nothing being dragged */ }
    return null;
  }
  function attachDrag(el, type, id) {
    el.addEventListener('dragstart', function (e) {
      // Dragging one of several ticked notes takes them all, as on the dashboard.
      const ids = type === 'note' && selected.has(id) && selected.size > 1 ? Array.from(selected) : [id];
      dragData = { type: type, ids: ids };
      e.dataTransfer.effectAllowed = 'move';
      try {
        if (type === 'note') e.dataTransfer.setData(DND_NOTES, JSON.stringify(ids));
        else e.dataTransfer.setData(DND_FOLDER, id);
        // A plain-text fallback keeps the cursor from showing "no drop" in
        // browsers that ignore unknown MIME types during dragover.
        e.dataTransfer.setData('text/plain', (el.querySelector('.label') || el).textContent || '');
      } catch (err) { /* older browsers restrict setData; the module var still works */ }
      e.stopPropagation();
    });
    el.addEventListener('dragend', function () { dragData = null; clearDropHints(); });
  }
  function dropZone(e, row, rowType) {
    const kind = dragKind(e);
    if (!kind) return null;
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (rowType === 'folder') {
      if (kind === 'note') return 'into';
      return y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'into';
    }
    if (kind !== 'note') return null;
    return y < 0.5 ? 'before' : 'after';
  }
  function attachDrop(el, rowType, item) {
    el.addEventListener('dragover', function (e) {
      const zone = dropZone(e, el, rowType);
      if (!zone) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      el.classList.toggle('drop-target', zone === 'into');
      el.classList.toggle('drop-before', zone === 'before');
      el.classList.toggle('drop-after', zone === 'after');
    });
    el.addEventListener('dragleave', function () { el.classList.remove('drop-target', 'drop-before', 'drop-after'); });
    el.addEventListener('drop', function (e) {
      const zone = dropZone(e, el, rowType);
      if (!zone) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropHints();
      const data = dragPayload(e);
      dragData = null;
      if (!data || !data.ids.length) return;
      if (zone === 'into') moveItem(data, item.id);
      else if (rowType === 'folder') placeItems('folder', data.ids, item.parentId || null, item.id, zone === 'after');
      else placeItems('note', data.ids, item.folderId || null, item.id, zone === 'after');
    });
  }
  function clearDropHints() {
    document.querySelectorAll('.drop-target, .drop-before, .drop-after').forEach(function (n) {
      n.classList.remove('drop-target', 'drop-before', 'drop-after');
    });
  }

  function isDescendant(folderId, maybeAncestorId) {
    // true if folderId is the same as, or nested inside, maybeAncestorId
    let cur = folderId;
    while (cur) {
      if (cur === maybeAncestorId) return true;
      const f = state.folders.find(function (x) { return x.id === cur; });
      cur = f ? f.parentId : null;
    }
    return false;
  }

  function moveItem(data, targetFolderId) {
    if (!data) return;
    const target = targetFolderId || null;
    if (data.type === 'note') {
      const ids = data.ids.filter(function (id) {
        const n = state.notes.find(function (x) { return x.id === id; });
        return n && isMine(n) && (n.folderId || null) !== target;
      });
      if (ids.length) placeItems('note', ids, target, null, true);
    } else if (data.type === 'folder') {
      const id = data.ids[0];
      const f = state.folders.find(function (x) { return x.id === id; });
      if (f && (f.parentId || null) !== target) placeItems('folder', [id], target, null, true);
    }
  }

  // Put `ids` into level `parentId`, before / after `targetId`, or at the end when
  // targetId is null (a plain move into a folder). The level's whole new order is
  // applied locally at once and saved in one request (PUT /api/order), which also
  // moves anything that came from another folder.
  //
  // Dropping between two rows only means something in manual order, so doing it
  // in another mode switches to manual, starting from the order that was on
  // screen. A plain move keeps the mode and appends to the folder's *manual*
  // order, so an arrangement made earlier is not replaced by whatever order
  // happens to be showing.
  function placeItems(kind, ids, parentId, targetId, after) {
    const target = parentId || null;
    const mine = ids.filter(function (id) {
      if (kind === 'folder') return state.folders.some(function (f) { return f.id === id; });
      const n = state.notes.find(function (x) { return x.id === id; });
      return n && isMine(n);
    });
    if (!mine.length) return;
    if (kind === 'folder' && mine.some(function (id) { return id === target || isDescendant(target, id); })) {
      toast('資料夾不能移到自己或自己的子資料夾裡');
      return;
    }
    // 區域看「被拖的那一項」自己，不看畫面狀態；目標資料夾必須是同一個區域的（伺服器的
    // saveOrder 也會擋）——放進別的區域的資料夾，那一項在兩邊的樹上都會看不到。
    const pool = kind === 'note' ? state.notes : state.folders;
    const first = pool.find(function (x) { return x.id === mine[0]; });
    const area = (first && first.area) || null;
    const targetFolder = target ? state.folders.find(function (f) { return f.id === target; }) : null;
    const mixed = mine.some(function (id) { const x = pool.find(function (y) { return y.id === id; }); return ((x && x.area) || null) !== area; });
    if (mixed || (targetFolder && (targetFolder.area || null) !== area)) {
      toast('不能移到別的區域的資料夾；要換區域請用筆記的「換區域…」');
      return;
    }
    const reordering = targetId != null;
    const toManual = reordering && Sorting.mode() !== 'manual';
    const base = reordering ? Sorting.mode() : 'manual';
    const level = (kind === 'note' ? childNotes(target, base, area) : childFolders(target, base, area))
      .map(function (x) { return x.id; });
    const order = Sorting.reorder(level, mine, targetId, after);
    const items = kind === 'note' ? state.notes : state.folders;
    order.forEach(function (id, i) {
      const item = items.find(function (x) { return x.id === id; });
      if (!item) return;
      item.position = i + 1;
      if (kind === 'folder') { item.parentId = target; return; }
      item.folderId = target;
      // The open note is its own object until its first save swaps it into
      // state.notes, and its autosave sends folderId: without this the next save
      // would move the note straight back.
      if (state.current && state.current.id === id && state.current !== item) {
        state.current.folderId = target;
        state.current.position = item.position;
      }
    });
    if (kind === 'note' && mine.length > 1) { selected.clear(); updateBatchBar(); }
    if (kind === 'note' && state.current && mine.indexOf(state.current.id) >= 0) updateNotePath(state.current);
    if (toManual) {
      Sorting.set('manual');   // its onChange listener refreshes the views
      toast('已切換為手動排序');
    } else {
      refreshViews();
    }
    return Store.saveOrder(kind, target, order).catch(function (e) {
      toast('順序沒有存到伺服器：' + (e && e.message || e));
    });
  }

  // ---- 批次選取：勾選筆記後整批移動到資料夾或刪除 -----------------------
  function updateBatchBar() {
    const bar = document.getElementById('batch-bar');
    if (!bar) return;
    const nNotes = selected.size, nFolders = selectedFolders.size;
    bar.hidden = nNotes + nFolders === 0;
    // 一旦有選取，所有勾選框都露出來方便繼續勾（app.css 的 .tree.selecting）
    treeEl.classList.toggle('selecting', nNotes + nFolders > 0);
    // 批次列在抽屜裡：從首頁勾選筆記時抽屜多半是收起的，得拉出來才看得到移動／刪除鈕
    if (nNotes + nFolders > 0 && !isSidebarOpen()) setSidebarOpen(true);
    const c = bar.querySelector('.batch-count');
    if (!c) return;
    // 側邊欄很窄、旁邊還有移動／刪除鈕，「已選 1 個資料夾」就會被截斷：只有筆記時照舊寫「篇」，
    // 有資料夾就一律寫「項」，細項放在滑過的提示
    c.textContent = '已選 ' + (nFolders ? (nNotes + nFolders) + ' 項' : nNotes + ' 篇');
    c.title = nFolders ? nFolders + ' 個資料夾' + (nNotes ? '、' + nNotes + ' 篇筆記' : '') : '';
  }
  function clearSelection() {
    selected.forEach(function (id) { syncDashCheck(id, false); });
    selected.clear();
    selectedFolders.clear();
    syncSelAll();
    treeEl.querySelectorAll('.tree-row.selected').forEach(function (r) {
      r.classList.remove('selected');
      const cb = r.querySelector('.tree-check'); if (cb) cb.checked = false;
    });
    updateBatchBar();
  }
  // 丟掉已不存在（或非自己）的筆記、已不存在的資料夾，避免選取殘留
  function pruneSelection() {
    const valid = {};
    state.notes.forEach(function (n) { if (isMine(n)) valid[n.id] = true; });
    state.folders.forEach(function (f) { valid[f.id] = true; });
    Array.from(selected).forEach(function (id) { if (!valid[id]) selected.delete(id); });
    Array.from(selectedFolders).forEach(function (id) { if (!valid[id]) selectedFolders.delete(id); });
    updateBatchBar();
  }
  // 側邊欄該列的勾選狀態同步（供儀表板那邊改動時反映）
  function syncTreeCheck(id, on) {
    const row = treeEl.querySelector('.note-row[data-id="' + id + '"]');
    if (!row) return;
    row.classList.toggle('selected', on);
    const c = row.querySelector('.tree-check'); if (c) c.checked = on;
  }
  // 儀表板「所有筆記」那邊該筆記的勾選狀態同步（供側邊欄改動時反映）
  function syncDashCheck(id, on) {
    // 首頁，以及課程筆記／知識區／小說的頁面（同一套 .dash-note-wrap）
    document.querySelectorAll('#dashboard .dash-note-wrap, .area-wrap .dash-note-wrap').forEach(function (w) {
      if (w.dataset.id !== id) return;
      w.classList.toggle('selected', on);
      const c = w.querySelector('.dash-note-check'); if (c) c.checked = on;
    });
  }
  // 給儀表板用的選取 API（讓「所有筆記」也能勾選、共用同一份選取與批次列）
  const selectionApi = {
    has: function (id) { return selected.has(id); },
    ids: function () { return Array.from(selected); },
    toggle: function (id, on) {
      if (on) selected.add(id); else selected.delete(id);
      syncTreeCheck(id, on);   // 反映到側邊欄
      updateBatchBar();
      syncSelAll();
    },
    // 「全選／取消全選」：一次勾（或取消）一整批，頁面上的勾選框、側邊欄、批次列一起更新
    setMany: function (ids, on) {
      ids.forEach(function (id) {
        if (on) selected.add(id); else selected.delete(id);
        syncTreeCheck(id, on);
        syncDashCheck(id, on);
      });
      updateBatchBar();
      syncSelAll();
    },
    // 「全選」旁邊的「刪除」：把這幾項移到垃圾桶（先問一次）。unit：'篇'（筆記）或 '個'（檔案）
    removeMany: function (ids, unit) {
      const list = ids.filter(function (id) { return selected.has(id); });
      if (!list.length) return;
      const what = unit === '個' ? ' 個檔案' : ' 篇筆記';
      showConfirm({
        title: '移至垃圾桶',
        message: '把勾選的 ' + list.length + what + '移到垃圾桶？\n保留期內可以從側邊欄的「垃圾桶」復原。',
        ok: '移至垃圾桶'
      }).then(function (yes) {
        if (!yes) return;
        removeNotesAndFolders(list, []).then(function (r) {
          toast((r.notes ? '已移至垃圾桶 ' + r.notes + (unit === '個' ? ' 個檔案' : ' 篇筆記') : '') +
            (r.failed ? (r.notes ? '，' : '') + r.failed + ' 項沒有刪成功' : ''));
        });
      });
    }
  };
  // 頁面上每顆「全選」與它旁邊的「刪除」（dashboard.js／areabrowser.js 的 .dash-selall／.dash-seldel）
  // 依目前的勾選重寫自己的字（刪除鈕還有灰不灰）
  function syncSelAll() {
    document.querySelectorAll('.dash-selall, .dash-seldel').forEach(function (b) { if (b._label) b._label(); });
  }
  // 批次動作後同時刷新側邊欄與（若正在顯示的）儀表板 / 四個獨立區域頁面
  function refreshViews() {
    renderTree();
    if (!emptyEl.hidden && window.Dashboard) Dashboard.refresh(dashOpts());
    if (trashWrapEl && !trashWrapEl.hidden && window.Trash) Trash.render(trashPageEl, trashOpts());
    if (courseWrapEl && !courseWrapEl.hidden && window.AreaBrowser) AreaBrowser.refresh(areaOpts('course'));
    if (knowledgeWrapEl && !knowledgeWrapEl.hidden && window.AreaBrowser) AreaBrowser.refresh(areaOpts('knowledge'));
    if (novelWrapEl && !novelWrapEl.hidden) {
      // 個人區：正在看影片分頁就重畫影片頁，不然是小說的瀏覽器
      if (videosPageEl && !videosPageEl.hidden) { if (window.Videos) Videos.refresh(videosOpts()); }
      else if (window.AreaBrowser) AreaBrowser.refresh(areaOpts('novel'));
    }
    if (quickWrapEl && !quickWrapEl.hidden && window.QuickNotes) QuickNotes.refresh(quickOpts());
    if (boardsWrapEl && !boardsWrapEl.hidden && window.Board) Board.renderIndex(boardsPageEl, boardsOpts());
    if (xmindWrapEl && !xmindWrapEl.hidden && window.XMind) XMind.renderIndex(xmindPageEl, xmindOpts());
    renderTimeTree();
    renderProgress();
    renderFoodMap();
    renderStart();
  }
  // 儀表板需要的資料與回呼，集中一處，render / refresh 共用
  function dashOpts() {
    return {
      // 一般區域專用：跟側邊欄樹同一條規則，過濾掉四個獨立區域的筆記／資料夾。
      notes: state.notes.filter(function (n) { return !n.area; }),
      // 標籤區與 #tag 篩選看所有區域（小說除外；便條紙沒標題不列）：看板、起始頁、文件的標籤才有地方看
      allNotes: state.notes.filter(function (n) { return n.area !== 'novel' && !isStickyNote(n); }),
      folders: state.folders.filter(function (f) { return !f.area; }),
      onOpen: openNote, onBook: openBook, onBookRemove: unmarkBook, onBookUpdate: updateBook,
      onPin: pinNote, onRename: renameNoteTo, onMenu: showNoteMenu,
      onFolderMenu: showFolderMenu, onFolderRename: renameFolderTo,
      onMoveNotes: moveNotesToFolder,
      // 拖拉排序（js/sorting.js）：筆記列之間、資料夾方框之間，順序跟側邊欄共用
      onReorderNotes: function (ids, folderId, targetId, after) { placeItems('note', ids, folderId, targetId, after); },
      onPlaceFolders: function (ids, parentId, targetId, after) { placeItems('folder', ids, parentId, targetId, after); },
      onSortMenu: showSortMenu,
      // 使用者點進／點出資料夾：留一筆 #folder/<id>（回到所有筆記則是空的 hash）
      onNavigate: function (folderId) { setHash(folderId ? 'folder/' + encodeURIComponent(folderId) : ''); },
      selection: selectionApi
    };
  }

  // ---- 四個獨立區域（課程筆記、隨筆、知識區、小說）--------------------
  // 課程筆記／知識區／小說用同一個簡化檔案總管（js/areabrowser.js）；隨筆是它
  // 自己的 Keep 風格卡片牆（js/quicknotes.js）。三個共用瀏覽器的區域共用同一套
  // 回呼邏輯（新增／改名／刪除／移動），差別只在 area 這個字串跟顯示用的標題。
  const AREA_INFO = {
    course: { title: '課程筆記', icon: 'award', wrap: null, page: null },
    knowledge: { title: '知識區', icon: 'book-open', wrap: null, page: null },
    novel: { title: '小說', icon: 'lock', wrap: null, page: null }
  };
  // wrap/page 要等 DOM 元素都取好才填——上面宣告時 courseWrapEl 等還沒定義。
  function initAreaInfo() {
    AREA_INFO.course.wrap = courseWrapEl; AREA_INFO.course.page = coursePageEl;
    AREA_INFO.knowledge.wrap = knowledgeWrapEl; AREA_INFO.knowledge.page = knowledgePageEl;
    AREA_INFO.novel.wrap = novelWrapEl; AREA_INFO.novel.page = novelPageEl;
  }

  // ---- 檔案檢視器（課程筆記資料夾裡上傳的 PPTX／PDF／影片） -------------------
  // 檔案筆記的內文只是一行引用，沒有東西可編輯，所以不進編輯器：在目前畫面上疊一層
  // position: fixed 的檢視器（body 的子元素一律 fixed，見 CLAUDE.md 的 app shell 規則）。
  // 能不能在瀏覽器裡看，跟 server.js 的 INLINE_UPLOAD 同一份名單——其餘型別伺服器一律當
  // 附件送，塞進 <video>/<iframe> 也放不出來，所以只給下載。影片可以拖時間軸是因為
  // 伺服器支援 Range。
  function isFileNote(n) { return !!(n && n.meta && n.meta.file && n.meta.file.id); }
  // 便條紙（meta.sticky）一樣不進編輯器：它住在課程筆記的資料夾頁面上，直接在卡片上打字。
  function isStickyNote(n) { return !!(n && n.meta && n.meta.sticky); }
  // 影片（meta.video，個人區）：沒有編輯器，住在個人區的「影片」頁（js/videos.js），點了是對話框。
  // 小說的瀏覽器與側邊欄的樹都不列它——它只在影片頁出現。
  function isVideoNote(n) { return !!(n && n.meta && n.meta.video); }
  function stickyTitle(text) {
    const line = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean)[0] || '';
    return line.slice(0, 60) || '便條紙';
  }
  // 從連結、搜尋結果點到一張便條紙：帶到它所在的區域／資料夾，把游標放到那張上面
  function goToSticky(note) {
    if (!note.area || note.area === 'novel' || !AREA_INFO[note.area] || !AREA_INFO[note.area].wrap || !window.AreaBrowser) return false;
    saveNow();
    // 從連結／重新整理（網址是 #note/<便條紙>）進來就改寫那一筆，不然「上一頁」會一直被帶回這裡
    openArea(note.area, { folderId: note.folderId || null, replaceHash: noteIdFromHash() === note.id });
    AreaBrowser.focusSticky(note.id);
    return true;
  }
  let fileViewerEl = null;
  function closeFileViewer() {
    const ov = fileViewerEl;
    if (!ov) return;
    fileViewerEl = null;
    // 先停掉再移除：拿掉 src 才會真的中斷還在抓的影片串流
    ov.querySelectorAll('video, audio').forEach(function (m) {
      try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) {}
    });
    document.removeEventListener('keydown', ov._onKey, true);
    ov.remove();
  }
  function openFileViewer(note) {
    if (!isFileNote(note)) return;
    closeFileViewer();
    const f = note.meta.file;
    const kind = window.AreaBrowser ? AreaBrowser.fileKind(f) : { icon: 'paperclip', tag: 'FILE', cls: 'other' };
    const url = '/api/images/' + encodeURIComponent(f.id);
    const mime = String(f.mime || '').toLowerCase();
    const name = note.title || f.name || '檔案';

    const ov = document.createElement('div');
    ov.className = 'fv-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', name);

    const bar = document.createElement('div');
    bar.className = 'fv-bar';
    bar.innerHTML = '<span class="fv-ic ab-file-ic ab-file-' + kind.cls + '">' + Icons.svg(kind.icon) + '</span>' +
      '<span class="fv-name"></span><span class="fv-meta"></span>';
    bar.querySelector('.fv-name').textContent = name;
    bar.querySelector('.fv-meta').textContent = kind.tag +
      (f.size && window.AreaBrowser ? '・' + AreaBrowser.fmtSize(f.size) : '');
    function link(cls, icon, label, attrs) {
      const a = document.createElement('a');
      a.className = 'fv-btn ' + cls;
      a.href = url;
      Object.keys(attrs).forEach(function (k) { a.setAttribute(k, attrs[k]); });
      a.innerHTML = Icons.svg(icon) + '<span>' + label + '</span>';
      return a;
    }
    const stage = document.createElement('div');
    stage.className = 'fv-stage';
    let inline = true;         // 有沒有在檢視器裡放出可看的東西
    let rawViewable = true;    // 這型別能不能在新分頁直接看原始檔（md 是當附件送的，不行）
    // Markdown（text/markdown 或副檔名 .md）：抓文字、用跟預覽同一套 MD.render 直接渲染成
    // 可讀頁面，而不是只給「無法預覽請下載」。伺服器把 .md 當 octet-stream 附件送，但同源
    // fetch 照樣讀得到內文；渲染後也跑一次 resolveImages，讓內文若有站內 img:/pdf: 也顯示。
    const isMd = mime === 'text/markdown' || mime === 'text/x-markdown' ||
      /\.(md|markdown|mdown|mkd)$/i.test(f.name || name);
    if (isMd) {
      rawViewable = false;
      const doc = document.createElement('div');
      doc.className = 'fv-md markdown-body';
      doc.textContent = '載入中…';
      stage.appendChild(doc);
      fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (text) {
          if (fileViewerEl !== ov) return;   // 已經關掉或換了別的檔
          doc.innerHTML = MD.render(text);
          if (MD.resolveImages) MD.resolveImages(doc);
        })
        .catch(function (e) { if (fileViewerEl === ov) doc.textContent = '無法載入：' + (e && e.message || e); });
    } else if (mime === 'application/pdf') {
      const fr = document.createElement('iframe');
      fr.className = 'fv-frame'; fr.title = name; fr.src = url;
      stage.appendChild(fr);
    } else if (/^video\/(mp4|webm|ogg)$/.test(mime)) {
      const v = document.createElement('video');
      v.className = 'fv-video'; v.controls = true; v.preload = 'metadata';
      v.setAttribute('playsinline', ''); v.src = url;
      stage.appendChild(v);
    } else if (/^audio\/(mpeg|mp4|ogg|wav|webm|x-m4a|aac)$/.test(mime)) {
      const au = document.createElement('audio');
      au.className = 'fv-audio'; au.controls = true; au.preload = 'metadata'; au.src = url;
      stage.appendChild(au);
    } else if (/^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(mime)) {
      const im = document.createElement('img');
      im.className = 'fv-img'; im.alt = name; im.src = url;
      stage.appendChild(im);
    } else {
      // PPTX、MOV／MKV、壓縮檔……瀏覽器自己開不了：給個清楚的下載入口，不要留一片黑
      inline = false; rawViewable = false;
      const box = document.createElement('div');
      box.className = 'fv-nopreview';
      box.innerHTML = '<span class="fv-big ab-file-ic ab-file-' + kind.cls + '">' + Icons.svg(kind.icon) + '</span>' +
        '<div class="fv-np-name"></div><div class="fv-np-hint">這種檔案無法在瀏覽器內預覽，請下載後開啟。</div>';
      box.querySelector('.fv-np-name').textContent = f.name || name;
      box.appendChild(link('fv-btn-primary', 'download', '下載檔案', { download: f.name || name }));
      stage.appendChild(box);
    }
    if (inline && rawViewable) bar.appendChild(link('', 'external-link', '新分頁開啟', { target: '_blank', rel: 'noopener' }));
    bar.appendChild(link('', 'download', '下載', { download: f.name || name }));
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'fv-btn fv-close'; close.title = '關閉（Esc）';
    close.innerHTML = Icons.svg('x');
    close.addEventListener('click', closeFileViewer);
    bar.appendChild(close);

    // 點檔案以外的空白處關閉（點到影片／PDF 本身不算）
    stage.addEventListener('mousedown', function (e) { if (e.target === stage) closeFileViewer(); });
    // capture：App.confirm 之類的也在 capture 聽 Esc，後開的先收到，才不會一次關兩層
    ov._onKey = function (e) {
      if (e.key !== 'Escape' || fileViewerEl !== ov) return;
      e.preventDefault(); e.stopPropagation();
      closeFileViewer();
    };
    document.addEventListener('keydown', ov._onKey, true);

    ov.appendChild(bar);
    ov.appendChild(stage);
    document.body.appendChild(ov);
    fileViewerEl = ov;
    close.focus();
  }

  function areaOpts(area) {
    const info = AREA_INFO[area];
    return {
      area: area,
      title: info.title, icon: info.icon,
      // 影片（meta.video）住在個人區自己的影片頁，不混進小說的資料夾清單
      notes: areaNotes(area).filter(function (n) { return !isVideoNote(n); }), folders: areaFolders(area),
      onOpen: openNote,
      onTag: function (tag) { browseTag(tag); },
      // 電子書區住在知識區（從首頁搬過來）：列出所有 is_book 的資料夾，不限區域；磚的章數用全站算
      books: area === 'knowledge' ? state.folders.filter(function (f) { return f.isBook; }) : null,
      booksCtx: area === 'knowledge' ? { notes: state.notes, folders: state.folders, onBook: openBook, onBookRemove: unmarkBook } : null,
      onBookUpdate: area === 'knowledge' ? updateBook : null,
      // 資料夾方框的「⋮」、筆記列的釘選／「⋯」、勾選、排序：跟首頁（dashOpts）是同一套函式，
      // 兩邊長得一樣、選單內容也一樣（showFolderMenu/showNoteMenu 自己依區域增減幾項）
      onFolderMenu: showFolderMenu, onMenu: showNoteMenu, onPin: pinNote,
      onSortMenu: showSortMenu, selection: selectionApi,
      onNavigate: function (folderId) { setHash(areaHash(area, folderId)); },
      // 拖放：跟首頁同一組（placeItems 會擋跨區域、擋資料夾拖進自己的子資料夾）
      onMoveNotes: moveNotesToFolder,
      onReorderNotes: function (ids, folderId, targetId, after) { placeItems('note', ids, folderId, targetId, after); },
      onPlaceFolders: function (ids, parentId, targetId, after) { placeItems('folder', ids, parentId, targetId, after); },
      // 課程筆記可以把 PPTX／PDF／影片直接放進資料夾：檔案本體走 Store.uploadFile（大檔自動
      // 分塊），在資料夾裡則是一篇 meta.file 的「檔案筆記」，內文就是那個檔案的引用——所以
      // 改名、移動、垃圾桶、還原、備份、檔案管理的「使用中」判斷全部沿用筆記既有的機制。
      onUploadFile: area === 'course' ? function (file, folderId, onProgress) {
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
        const isImg = !isPdf && (file.type || '').indexOf('image/') === 0;
        const mime = isPdf ? 'application/pdf' : (file.type || 'application/octet-stream');
        return Store.uploadFile(file, onProgress, mime).then(function (id) {
          const name = cleanName(file.name, isPdf ? 'PDF' : '檔案');
          const ref = isImg ? '![' + name + '](img:' + id + ')'
            : isPdf ? '![' + name.replace(/\.pdf$/i, '') + '](pdf:' + id + ')'
            : '[' + name + '](file:' + id + ')';
          return Store.createNote(name, folderId, {
            area: area, content: ref + '\n',
            meta: { file: { id: id, name: file.name, mime: mime, size: file.size } }
          });
        }).then(function (n) { state.notes.push(n); return n; });
      } : null,
      onOpenFile: openFileViewer,
      // 便條紙（課程筆記才有）：一篇 meta.sticky 的筆記，內文就是便條紙上的字，在資料夾頁面上
      // 直接打字、自動儲存（js/areabrowser.js makeSticky）。標題取第一行，只是給垃圾桶、搜尋
      // 這些列出標題的地方認得出是哪一張——卡片本身不顯示標題，所以不會像隨筆當初那樣
      // 「第一行出現兩次」。
      onNewSticky: area === 'course' ? function (folderId) {
        return Store.createNote('便條紙', folderId, { area: area, content: '', meta: { sticky: { color: 'yellow' } } }).then(function (n) {
          state.notes.push(n); return n;
        }, function (e) { toast('新增失敗：' + (e && e.message || e)); return null; });
      } : null,
      onSaveSticky: area === 'course' ? function (note, fields) {
        const next = Object.assign({}, note);
        if (fields.content !== undefined) {
          next.content = fields.content;
          next.title = stickyTitle(fields.content);
        }
        if (fields.color !== undefined) {
          // 顏色馬上寫回本機那份：不然「換顏色→立刻打字」時，第二個存檔帶的還是舊的 meta，
          // 會在伺服器上把顏色蓋回去
          note.meta = Object.assign({}, note.meta, { sticky: Object.assign({}, note.meta && note.meta.sticky, { color: fields.color }) });
          next.meta = note.meta;
        }
        return Store.updateNote(next).then(function (n) {
          // 只收伺服器那邊才知道的欄位。content 跟 meta 不回寫：使用者這時候可能又多打了幾個字
          // 或又換了顏色，本機那份才是最新的
          note.title = n.title; note.rev = n.rev; note.updatedAt = n.updatedAt;
          return true;
        }, function (e) { toast('儲存失敗：' + (e && e.message || e)); return false; });
      } : null,
      onNewNote: function (folderId) {
        return Store.createNote('未命名筆記', folderId, { area: area }).then(function (n) {
          state.notes.push(n); renderTree(); return n;
        }, function (e) { toast('新增失敗：' + (e && e.message || e)); return null; });
      },
      onNewFolder: function (parentId) {
        return Store.createFolder('新資料夾', parentId, area).then(function (f) {
          state.folders.push(f); return f;
        }, function (e) { toast('新增失敗：' + (e && e.message || e)); return null; });
      },
      onRenameNote: function (note, title) { renameNoteTo(note, title); },
      onRenameFolder: function (folder, name) { renameFolderTo(folder, name); },
      onDeleteNote: function (note) {
        return Store.deleteNote(note.id).then(function () {
          state.notes = state.notes.filter(function (n) { return n.id !== note.id; });
          renderTree();
          return true;
        }, function (e) { toast('刪除失敗：' + (e && e.message || e)); return false; });
      },
      onMoveNote: moveNoteInArea,
    };
  }
  // 區域裡沒有拖放（首頁靠拖放搬東西），所以選單多一項「移動到…」。清單只列同一個區域的資料夾；
  // 移資料夾時連它自己的子資料夾也不列，免得把自己搬進自己裡面。回傳 Promise<boolean>。
  function moveNoteInArea(note) {
    return showFolderPicker('移動「' + (note.title || '筆記') + '」', { folders: areaFolders(note.area) }).then(function (r) {
      if (!r) return false;
      return Promise.resolve(placeItems('note', [note.id], r.folderId || null, null, true)).then(function () { return true; });
    });
  }
  function moveFolderInArea(folder) {
    const inside = descendantFolderIds(folder.id);
    return showFolderPicker('移動「' + (folder.name || '資料夾') + '」', {
      folders: areaFolders(folder.area).filter(function (f) { return inside.indexOf(f.id) < 0; })
    }).then(function (r) {
      if (!r) return false;
      return Promise.resolve(placeItems('folder', [folder.id], r.folderId || null, null, true)).then(function () { return true; });
    });
  }

  function quickOpts() {
    function refreshQuick() { if (quickWrapEl && !quickWrapEl.hidden) QuickNotes.refresh(quickOpts()); }
    return {
      notes: areaNotes('quick'),
      // Keep 的輸入卡：標題另外一欄，沒填就是空字串（伺服器補「未命名筆記」，卡片上
      // 不顯示）；顏色／釘選／封存在輸入時就能設，一起帶進 meta。
      onCreate: function (d) {
        Store.createNote(d.title || '', null, { area: 'quick', content: d.content || '', meta: d.meta || {} }).then(function (n) {
          state.notes.push(n);
          refreshQuick();
        }, function (e) { toast('新增失敗：' + (e && e.message || e)); });
      },
      // fields = { title?, content? }：對話框裡改標題、改內文，或卡片上直接勾勾選框
      onEdit: function (note, fields) {
        Store.updateNote(Object.assign({}, note, fields)).then(function (n) {
          note.title = n.title; note.content = n.content; note.rev = n.rev; note.updatedAt = n.updatedAt;
          refreshQuick();
        }, function (e) { toast('儲存失敗：' + (e && e.message || e)); });
      },
      onDuplicate: function (note) {
        const meta = {};
        if (note.meta && note.meta.color) meta.color = note.meta.color;
        Store.createNote(note.title === '未命名筆記' ? '' : (note.title || ''), null, { area: 'quick', content: note.content || '', meta: meta }).then(function (n) {
          state.notes.push(n);
          refreshQuick();
          toast('已建立副本');
        }, function (e) { toast('建立副本失敗：' + (e && e.message || e)); });
      },
      // 圖片走跟編輯器同一條上傳路（uploadFiles），回來的是 Markdown 參照字串
      onUpload: function (files) {
        return uploadFiles(files).catch(function (e) { toast('上傳失敗：' + (e && e.message || e)); return []; });
      },
      onClosed: refreshQuick,
      // 卡片裡的 [[wiki 連結]] 與 #標籤（跟預覽同一套處理）
      onOpenNote: function (a) { handleNoteLink(a); },
      onTag: function (tag) { browseTag(tag); },
      onPatch: function (note, patch) {
        const meta = Object.assign({}, note.meta || {});
        if (patch.pinned !== undefined) meta.pinned = patch.pinned || undefined;
        if (patch.archived !== undefined) meta.archived = patch.archived || undefined;
        if (patch.color !== undefined) meta.color = patch.color || undefined;
        note.meta = meta;
        Store.updateNote(Object.assign({}, note, { meta: meta })).then(function (n) {
          note.meta = n.meta;
          if (quickWrapEl && !quickWrapEl.hidden) QuickNotes.refresh(quickOpts());
        }, function (e) { toast('儲存失敗：' + (e && e.message || e)); });
      },
      onDelete: function (note) {
        Store.deleteNote(note.id).then(function () {
          state.notes = state.notes.filter(function (n) { return n.id !== note.id; });
          if (quickWrapEl && !quickWrapEl.hidden) QuickNotes.refresh(quickOpts());
        }, function (e) { toast('刪除失敗：' + (e && e.message || e)); });
      }
    };
  }

  function closeAreaViews() {
    ['course', 'knowledge', 'novel'].forEach(function (a) {
      const info = AREA_INFO[a];
      if (info.wrap) info.wrap.hidden = true;
      setNavActive(a + '-open-btn', false);
    });
    // 影片頁（個人區的分頁）：把對話框收掉、還沒送出的存檔送出
    if (window.Videos && videosPageEl && !videosPageEl.hidden) Videos.teardown();
    if (quickWrapEl) quickWrapEl.hidden = true;
    setNavActive('quick-open-btn', false);
    if (boardsWrapEl) boardsWrapEl.hidden = true;
    setNavActive('board-open-btn', false);
    if (startWrapEl) { startWrapEl.hidden = true; if (window.StartPage) StartPage.closePop(); }
    setNavActive('start-open-btn', false);
    if (xmindWrapEl) xmindWrapEl.hidden = true;
    setNavActive('xmind-open-btn', false);
    if (timetreeWrapEl) { timetreeWrapEl.hidden = true; if (window.TimeTree) TimeTree.teardown(); }
    setNavActive('timetree-open-btn', false);
    if (progressWrapEl) { progressWrapEl.hidden = true; if (window.Progress) Progress.teardown(); }
    setNavActive('progress-open-btn', false);
    if (foodmapWrapEl) { foodmapWrapEl.hidden = true; if (window.FoodMap) FoodMap.teardown(); }
    setNavActive('foodmap-open-btn', false);
  }

  // 進入一個區域頁面前的共用收尾：跟 openTrash／openBook 同一套「收起其他檢視」。
  function leaveOtherViews() {
    saveNow();
    closeStream();
    LS.set('lastNote', '');
    noteBar(false);
    if (notePathEl) notePathEl.textContent = '';
    state.currentId = null; state.current = null;
    editorNoteId = null;
    emptyEl.hidden = true;
    wrapEl.hidden = true;
    if (secWrapEl) secWrapEl.hidden = true;
    if (perfWrapEl) perfWrapEl.hidden = true;
    closeBookView();
    closeTrashView();
    closeFilesView();
    closeRelMapView();
    closeDrawioView();
    closeKanbanView();
    closeDocView();
    closeXmindView();
    closeGraphView();
  }

  // ---- drawio 頁（#drawio-wrap）：整頁的繪圖工具，見 js/drawio.js ----
  // 跟下面的關聯分析同一套：DrawIO.open() 回傳把手，離開這一頁時 close()，它會把還沒
  // 送出的改動存掉再拆 DOM。
  const drawioWrapEl = $('#drawio-wrap');
  let drawioView = null;
  // 圖表開著的時候，最上面那一列（資料夾／標題、版本、分享、PDF）就是一般筆記的那一組
  // 元件、同一個位置。但整頁工具不佔用 state.current（見 editorNoteId 的說明），那幾個
  // 元件原本的處理函式又都是看 state.current——所以沒有開著的筆記時，改問這個。
  // { id, note(), readOnly, titleInput(v), commitTitle(), history(), pdf() }
  let toolBar = null;
  // 最上面那一列從「某個整頁工具」的手上收回來（drawio、看板共用；kind 對不上就不是它的，不動）
  function dropToolBar(kind) {
    if (!toolBar || (kind && toolBar.kind !== kind)) return;
    toolBar.commitTitle();   // 標題打到一半就切走：先存
    flushPublish(toolBar.id);
    toolBar = null;
    const app = document.getElementById('app');
    if (app) app.classList.remove('tool-open');
    titleEl.placeholder = '未命名筆記';
    titleEl.readOnly = false;
  }
  function closeDrawioView() {
    dropToolBar('drawio');
    if (drawioView) { const v = drawioView; drawioView = null; v.close(); }
    if (drawioWrapEl) drawioWrapEl.hidden = true;
  }

  // ---- 看板（js/board.js）：#board 是所有看板的列表頁（#boards-wrap），一個看板開在 #kanban-wrap 整頁 ----
  // 看板是 area 'board' 的筆記（meta.board），沒有資料夾，只從列表頁建立。開一個看板跟 drawio
  // 同一套：最上面那一列是它的標題列（toolBar），標題與內容共用一條寫入路徑。
  const boardsWrapEl = $('#boards-wrap'), boardsPageEl = $('#boards-page');
  const kanbanWrapEl = $('#kanban-wrap');
  let kanbanView = null, kanbanNoteId = null;
  function closeKanbanView() {
    if (kanbanNoteId) { const id = kanbanNoteId; kanbanNoteId = null; setTimeout(function () { flushPublish(id); }, 0); }
    dropToolBar('board');
    if (kanbanView) { const v = kanbanView; kanbanView = null; v.close(); }
    if (kanbanWrapEl) kanbanWrapEl.hidden = true;
  }
  function boardsOpts() {
    return {
      boards: state.notes.filter(function (n) { return n.area === 'board' && isMine(n) && window.Board && Board.isNote(n); }),
      onOpen: function (id) { openNote(id); },
      onCreate: function (d) {
        return Store.createNote(d.title, null, { area: 'board', content: Board.generate(d.bg), meta: { board: true } }).then(function (n) {
          state.notes.push(n);
          openNote(n.id);
        }, function (e) { toast('建立失敗：' + (e && e.message || e)); });
      },
      onTags: editTags,
      onRename: function (n) {
        showPrompt({ title: '重新命名看板', placeholder: '看板標題', value: n.title, ok: '確定' }).then(function (t) {
          t = String(t || '').trim();
          if (!t || t === n.title) return;
          Store.updateNote(Object.assign({}, n, { title: t })).then(function (r) {
            Object.assign(n, { title: r.title, rev: r.rev, updatedAt: r.updatedAt });
            refreshViews();
          }, function (e) { toast('儲存失敗：' + (e && e.message || e)); });
        });
      },
      onPatch: function (n, content) {
        Store.updateNote(Object.assign({}, n, { content: content })).then(function (r) {
          Object.assign(n, { content: r.content, rev: r.rev, updatedAt: r.updatedAt });
          refreshViews();
        }, function (e) { toast('儲存失敗：' + (e && e.message || e)); });
      },
      onDelete: function (n) {
        showConfirm({ title: '移到垃圾桶', message: '把看板「' + n.title + '」移到垃圾桶？可以從垃圾桶還原。', ok: '移到垃圾桶', danger: true }).then(function (yes) {
          if (!yes) return;
          Store.deleteNote(n.id).then(function () {
            state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
            refreshViews();
            toast('已移到垃圾桶');
          }, function (e) { toast('刪除失敗：' + (e && e.message || e)); });
        });
      }
    };
  }
  function openBoards() {
    if (!boardsWrapEl || !window.Board) return;
    leaveOtherViews();
    closeAreaViews();
    boardsWrapEl.hidden = false;
    boardsWrapEl.scrollTop = 0;
    setNavActive('board-open-btn', true);
    autoOpenSidebar();
    setHash('board');
    Board.renderIndex(boardsPageEl, boardsOpts());
    setTreeArea('board');
  }
  // ---- 起始頁（js/startpage.js）：#start 一個畫面，上面是分頁（每一頁都是 area 'start'、meta.startpage 的筆記）----
  // 跟看板一樣只從自己的頁面建立；存檔是每一頁一條單一寫入路徑（同時只有一個請求、其餘併成一次補送）。
  const startWrapEl = $('#start-wrap'), startPageEl = $('#start-page');
  let startCurrent = LS.get('startPage') || null;
  const startSavers = {};
  function startSave(n, content) {
    const live = state.notes.find(function (x) { return x.id === n.id; }) || n;
    live.content = content;
    if (live !== n) n.content = content;
    const s = startSavers[n.id] || (startSavers[n.id] = { saving: false, again: false });
    const run = function () {
      s.saving = true;
      const cur = state.notes.find(function (x) { return x.id === n.id; }) || n;
      Store.updateNote({ id: cur.id, title: cur.title, content: cur.content, folderId: cur.folderId, meta: cur.meta })
        .then(function (r) { cur.rev = r.rev; cur.updatedAt = r.updatedAt; noteSaved(cur); }, function (e) { toast('儲存失敗：' + (e && e.message || e)); })
        .then(function () { s.saving = false; if (s.again) { s.again = false; run(); } });
    };
    if (s.saving) s.again = true; else run();
  }
  function startOpts() {
    return {
      pages: state.notes.filter(function (n) { return n.area === 'start' && isMine(n) && window.StartPage && StartPage.isNote(n); }),
      current: startCurrent,
      readOnly: function (n) { return n.perm === 'read'; },
      onSelect: function (id) { startCurrent = id; LS.set('startPage', id); renderStart(); },
      onTags: editTags,
      onCreate: function (d) {
        Store.createNote(d.title, null, { area: 'start', content: StartPage.generate(d.bg), meta: { startpage: true } }).then(function (n) {
          state.notes.push(n);
          startCurrent = n.id; LS.set('startPage', n.id);
          renderStart(); renderTree();
        }, function (e) { toast('建立失敗：' + (e && e.message || e)); });
      },
      onRename: function (n, title) {
        Store.updateNote(Object.assign({}, n, { title: title })).then(function (r) {
          Object.assign(n, { title: r.title, rev: r.rev, updatedAt: r.updatedAt });
          refreshViews();
        }, function (e) { toast('儲存失敗：' + (e && e.message || e)); });
      },
      onChange: startSave,
      onDelete: function (n) {
        showConfirm({ title: '移到垃圾桶', message: '把起始頁「' + n.title + '」移到垃圾桶？可以從垃圾桶還原。', ok: '移到垃圾桶', danger: true }).then(function (yes) {
          if (!yes) return;
          Store.deleteNote(n.id).then(function () {
            state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
            if (startCurrent === n.id) { startCurrent = null; LS.set('startPage', ''); }
            refreshViews();
            toast('已移到垃圾桶');
          }, function (e) { toast('刪除失敗：' + (e && e.message || e)); });
        });
      }
    };
  }
  function renderStart() {
    if (startWrapEl && !startWrapEl.hidden && window.StartPage) StartPage.render(startPageEl, startOpts());
  }
  function openStart(o) {
    if (!startWrapEl || !window.StartPage) return;
    leaveOtherViews();
    closeAreaViews();
    if (o && o.pageId) { startCurrent = o.pageId; LS.set('startPage', o.pageId); }
    startWrapEl.hidden = false;
    startWrapEl.scrollTop = 0;
    setNavActive('start-open-btn', true);
    autoOpenSidebar();   // 使用者要抽屜留著；只有打開某個 trello 看板或文件才收
    setHash('start');
    setTreeArea('start');
    renderStart();
  }
  // ---- 心智圖（js/xmind.js）：#xmind 是所有心智圖的列表頁（#xmind-wrap），一張圖開在 #xmind-edit-wrap 整頁 ----
  // 心智圖是 area 'xmind' 的筆記（meta.xmind），沒有資料夾，只從列表頁建立。開一張圖跟文件／看板同一套：
  // 最上面那一列是它的標題列（toolBar kind 'xmind'），標題與內容共用一條寫入路徑。
  const xmindWrapEl = $('#xmind-wrap'), xmindPageEl = $('#xmind-page');
  const xmindEditWrapEl = $('#xmind-edit-wrap');
  let xmindView = null, xmindNoteId = null;
  function closeXmindView() {
    if (xmindNoteId) { const id = xmindNoteId; xmindNoteId = null; setTimeout(function () { flushPublish(id); }, 0); }
    dropToolBar('xmind');
    if (xmindView) { const v = xmindView; xmindView = null; v.close(); }
    if (xmindEditWrapEl) xmindEditWrapEl.hidden = true;
  }
  function xmindOpts() {
    return {
      maps: state.notes.filter(function (n) { return n.area === 'xmind' && isMine(n) && window.XMind && XMind.isNote(n); }),
      onOpen: function (id) { openNote(id); },
      onCreate: function (d) {
        return Store.createNote(d.title, null, { area: 'xmind', content: XMind.generate(d.title), meta: { xmind: true } }).then(function (n) {
          state.notes.push(n);
          openNote(n.id);
        }, function (e) { toast('建立失敗：' + (e && e.message || e)); });
      },
      onTags: editTags,
      onRename: function (n) {
        showPrompt({ title: '重新命名心智圖', placeholder: '標題', value: n.title, ok: '確定' }).then(function (t) {
          t = String(t || '').trim();
          if (!t || t === n.title) return;
          Store.updateNote(Object.assign({}, n, { title: t })).then(function (r) {
            Object.assign(n, { title: r.title, rev: r.rev, updatedAt: r.updatedAt });
            refreshViews();
          }, function (e) { toast('儲存失敗：' + (e && e.message || e)); });
        });
      },
      onDelete: function (n) {
        showConfirm({ title: '移到垃圾桶', message: '把心智圖「' + n.title + '」移到垃圾桶？可以從垃圾桶還原。', ok: '移到垃圾桶', danger: true }).then(function (yes) {
          if (!yes) return;
          Store.deleteNote(n.id).then(function () {
            state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
            refreshViews();
            toast('已移到垃圾桶');
          }, function (e) { toast('刪除失敗：' + (e && e.message || e)); });
        });
      }
    };
  }
  function openXmind() {
    if (!xmindWrapEl || !window.XMind) return;
    leaveOtherViews();
    closeAreaViews();
    xmindWrapEl.hidden = false;
    xmindWrapEl.scrollTop = 0;
    setNavActive('xmind-open-btn', true);
    autoOpenSidebar();
    setHash('xmind');
    XMind.renderIndex(xmindPageEl, xmindOpts());
    setTreeArea('xmind');
  }
  function openXmindNote(note) {
    if (!xmindEditWrapEl || !window.XMind) return;
    leaveOtherViews();
    closeAreaViews();
    xmindEditWrapEl.hidden = false;
    setSidebarOpen(false);
    xmindNoteId = note.id;
    setTreeArea(isMine(note) ? (note.area || null) : null);
    LS.set('lastNote', note.id);
    setHash('note/' + note.id);
    function syncState(n) {
      const idx = state.notes.findIndex(function (x) { return x.id === n.id; });
      if (idx >= 0) { state.notes[idx].rev = n.rev; state.notes[idx].updatedAt = n.updatedAt; }
      note.rev = n.rev; note.updatedAt = n.updatedAt;
    }
    function live() { return state.notes.find(function (x) { return x.id === note.id; }) || note; }
    let saving = null, again = false;
    function flushSave() {
      if (saving) { again = true; return saving; }
      const run = function () {
        const n = live();
        return Store.updateNote({ id: n.id, title: n.title, content: n.content, folderId: n.folderId, meta: n.meta })
          .then(function (r) { syncState(r); noteSaved(live()); })
          .then(function () { if (again) { again = false; return run(); } });
      };
      saving = run().then(function () { saving = null; }, function (e) {
        saving = null; again = false;
        toast('儲存失敗：' + (e && e.message || e));
        throw e;
      });
      return saving;
    }
    function setLocal(patch) {
      const n = live();
      Object.assign(n, patch);
      if (n !== note) Object.assign(note, patch);
      return flushSave();
    }
    const readOnly = note.perm === 'read';
    const title = (note.title === '未命名筆記' || note.title === '未命名心智圖') ? '' : (note.title || '');
    const view = XMind.open(note.content || '', {
      container: xmindEditWrapEl,
      readOnly: readOnly,
      banner: readOnly ? '唯讀 — 由 ' + (note.sharedBy || '其他使用者') + ' 分享給你' : '',
      getTitle: function () { return live().title; },
      onChange: function (text) { return setLocal({ content: text }); },
      onOpenLink: function (u) { const m = /^#note\/(.+)$/.exec(u); if (m) openNote(decodeURIComponent(m[1])); }
    });
    xmindView = view;
    let titleTimer = null, pendingTitle = null;
    function commitTitle() {
      clearTimeout(titleTimer); titleTimer = null;
      if (pendingTitle === null) return;
      const t = pendingTitle.trim();
      pendingTitle = null;
      if ((t || '未命名心智圖') === live().title) return;
      setLocal({ title: t || '未命名心智圖' }).catch(function () {});
      renderTree();
    }
    toolBar = {
      kind: 'xmind',
      id: note.id,
      readOnly: readOnly,
      note: live,
      titleInput: function (v) {
        if (readOnly) return;
        pendingTitle = v;
        clearTimeout(titleTimer);
        titleTimer = setTimeout(commitTitle, SAVE_DELAY);
      },
      commitTitle: commitTitle,
      history: function () {
        if (!window.Versions) return;
        commitTitle();
        view.flush().then(function () {
          if (xmindView !== view) return;
          Versions.openNote(live(), {
            onRestored: function (fresh) {
              const i = state.notes.findIndex(function (n) { return n.id === fresh.id; });
              if (i >= 0) state.notes[i] = Object.assign(state.notes[i], fresh);
              renderTree();
              if (xmindView === view) view.setContent(fresh.content || '');
            }
          });
        });
      },
      // PDF：內容是一段 ```xmind 圍欄，照一般筆記的路（MD.render → XMind.blockHTML 的靜態 SVG）交給 PDF
      pdf: function () {
        commitTitle();
        view.flush().then(function () {
          const n = live();
          const box = document.createElement('div');
          box.className = 'markdown-body';
          box.innerHTML = MD.render(n.content || '');
          return PDF.showPreview(n, box, {
            meta: n.meta,
            onMeta: function (meta) {
              if (readOnly) return;
              setLocal({ meta: Object.assign({}, live().meta, meta, { xmind: true }) }).catch(function () {});
            }
          });
        }).catch(function (err) { alert('產生列印預覽失敗：' + (err && err.message || err)); });
      }
    };
    noteBar(true);
    document.getElementById('app').classList.add('tool-open');
    titleEl.placeholder = '未命名心智圖';
    titleEl.value = title;
    titleEl.readOnly = readOnly;
    if (shareBtn) shareBtn.hidden = !isMine(note);
    updateNotePath(note);
  }
  // ---- 行事曆（js/timetree.js）：#timetree 一個畫面，照 TimeTree；每一本行事曆是一篇 area 'timetree'、meta.timetree 的筆記 ----
  // 跟起始頁一樣只從自己的頁面建立；存檔是每一本一條單一寫入路徑（同時只有一個請求、其餘併成一次補送）。
  const timetreeWrapEl = $('#timetree-wrap'), timetreePageEl = $('#timetree-page');
  const ttSavers = {};
  function ttSave(n, content) {
    const live = state.notes.find(function (x) { return x.id === n.id; }) || n;
    live.content = content;
    if (live !== n) n.content = content;
    const s = ttSavers[n.id] || (ttSavers[n.id] = { saving: false, again: false });
    const run = function () {
      s.saving = true;
      const cur = state.notes.find(function (x) { return x.id === n.id; }) || n;
      Store.updateNote({ id: cur.id, title: cur.title, content: cur.content, folderId: cur.folderId, meta: cur.meta })
        .then(function (r) { cur.rev = r.rev; cur.updatedAt = r.updatedAt; noteSaved(cur); }, function (e) { toast('儲存失敗：' + (e && e.message || e)); })
        .then(function () { s.saving = false; if (s.again) { s.again = false; run(); } });
    };
    if (s.saving) s.again = true; else run();
  }
  function ttOpts() {
    return {
      calendars: state.notes.filter(function (n) { return n.area === 'timetree' && window.TimeTree && TimeTree.isNote(n); }),
      readOnly: function (n) { return n.perm === 'read'; },
      onCreate: function (d) {
        Store.createNote(d.title, null, { area: 'timetree', content: TimeTree.generate(d.color), meta: { timetree: true } }).then(function (n) {
          state.notes.push(n);
          renderTimeTree(); renderTree();
        }, function (e) { toast('建立失敗：' + (e && e.message || e)); });
      },
      onRename: function (n) {
        showPrompt({ title: '重新命名行事曆', placeholder: '名稱', value: n.title, ok: '確定' }).then(function (t) {
          t = String(t || '').trim();
          if (!t || t === n.title) return;
          Store.updateNote(Object.assign({}, n, { title: t })).then(function (r) {
            Object.assign(n, { title: r.title, rev: r.rev, updatedAt: r.updatedAt });
            refreshViews();
          }, function (e) { toast('儲存失敗：' + (e && e.message || e)); });
        });
      },
      onChange: ttSave,
      onTags: editTags,
      onUpload: function (files) { return uploadFiles(files).catch(function (e) { toast('上傳失敗：' + (e && e.message || e)); return []; }); },
      onDelete: function (n) {
        showConfirm({ title: '移到垃圾桶', message: '把行事曆「' + n.title + '」和裡面的行程移到垃圾桶？可以從垃圾桶還原。', ok: '移到垃圾桶', danger: true }).then(function (yes) {
          if (!yes) return;
          Store.deleteNote(n.id).then(function () {
            state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
            refreshViews();
            toast('已移到垃圾桶');
          }, function (e) { toast('刪除失敗：' + (e && e.message || e)); });
        });
      }
    };
  }
  function renderTimeTree() {
    if (timetreeWrapEl && !timetreeWrapEl.hidden && window.TimeTree) TimeTree.render(timetreePageEl, ttOpts());
  }
  function openTimeTree(o) {
    if (!timetreeWrapEl || !window.TimeTree) return;
    leaveOtherViews();
    closeAreaViews();
    if (o && o.calId) { delete TimeTree.state.hidden[o.calId]; LS.set('ttHidden', JSON.stringify(TimeTree.state.hidden)); }
    timetreeWrapEl.hidden = false;
    setNavActive('timetree-open-btn', true);
    setSidebarOpen(false);   // 使用者要的：點開 timetree 就收起左邊
    setHash('timetree');
    setTreeArea('timetree');
    renderTimeTree();
  }
  // ---- 課程進度（js/progress.js）：#progress 一個畫面；每一門課程是一篇 area 'progress'、meta.progress 的筆記 ----
  // 綁兩邊：章節的筆記建在「課程筆記」（area 'course'）的資料夾裡；有預計完成日的章節寫進 timetree 的「課程管理」行事曆
  // （一本 meta.timetree + meta.courseCal 的筆記，第一次開這一頁時自動建立）。存檔走 ttSave（每篇筆記一條單一寫入路徑，
  // 課程跟行事曆都是）。
  const progressWrapEl = $('#progress-wrap'), progressPageEl = $('#progress-page');
  function courseCalNote() {
    return state.notes.find(function (n) { return n.area === 'timetree' && n.meta && n.meta.timetree && n.meta.courseCal && isMine(n); }) || null;
  }
  let courseCalPending = null;
  function ensureCourseCal() {
    const have = courseCalNote();
    if (have) return Promise.resolve(have);
    if (courseCalPending) return courseCalPending;
    courseCalPending = Store.createNote('課程管理', null, { area: 'timetree', content: TimeTree.generate('#d9962a'), meta: { timetree: true, courseCal: true } })
      .then(function (n) { state.notes.push(n); renderTree(); return n; })
      .finally(function () { courseCalPending = null; });
    return courseCalPending;
  }
  function progressOpts() {
    return {
      courses: state.notes.filter(function (n) { return n.area === 'progress' && isMine(n) && window.Progress && Progress.isNote(n); }),
      calendar: courseCalNote(),
      courseFolders: state.folders.filter(function (f) { return f.area === 'course'; }),
      courseNotes: state.notes.filter(function (n) { return n.area === 'course' && isMine(n) && !isFileNote(n) && !isStickyNote(n); }),
      allNotes: state.notes,
      readOnly: function (n) { return n.perm === 'read'; },
      onChange: ttSave,
      onTags: editTags,
      onOpenNote: openNote,
      onOpenFolder: function (id) { openArea('course', { folderId: id }); },
      onOpenCalendar: function () { const c = courseCalNote(); openTimeTree(c ? { calId: c.id } : undefined); },
      onCreateFolder: function (name) {
        return Store.createFolder(name, null, 'course').then(function (f) { state.folders.push(f); renderTree(); return f; });
      },
      onNewNote: function (folderId, title) {
        return Store.createNote(title, folderId, { area: 'course' }).then(function (n) { state.notes.push(n); renderTree(); return n; });
      },
      onCreate: function (d) {
        Store.createNote(d.title, null, { area: 'progress', content: Progress.wrap(Progress.serialize(d.course)), meta: { progress: true } }).then(function (n) {
          state.notes.push(n);
          renderTree();
          if (progressWrapEl && !progressWrapEl.hidden) Progress.afterCreate(n.id, progressOpts()); else renderProgress();
        }, function (e) { toast('建立失敗：' + (e && e.message || e)); });
      },
      onRename: function (n) {
        showPrompt({ title: '重新命名課程', placeholder: '課程名稱', value: n.title, ok: '確定' }).then(function (t) {
          t = String(t || '').trim();
          if (!t || t === n.title) return;
          Store.updateNote(Object.assign({}, n, { title: t })).then(function (r) {
            Object.assign(n, { title: r.title, rev: r.rev, updatedAt: r.updatedAt });
            refreshViews();
          }, function (e) { toast('儲存失敗：' + (e && e.message || e)); });
        });
      },
      onDelete: function (n, beforeDelete) {
        showConfirm({ title: '移到垃圾桶', message: '把課程「' + n.title + '」移到垃圾桶？行事曆上它的章節行程會一起拿掉；課程筆記不會動。可以從垃圾桶還原。', ok: '移到垃圾桶', danger: true }).then(function (yes) {
          if (!yes) return;
          if (beforeDelete) beforeDelete();
          Store.deleteNote(n.id).then(function () {
            state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
            refreshViews();
            toast('已移到垃圾桶');
          }, function (e) { toast('刪除失敗：' + (e && e.message || e)); });
        });
      }
    };
  }
  function renderProgress() {
    if (progressWrapEl && !progressWrapEl.hidden && window.Progress) Progress.render(progressPageEl, progressOpts());
  }
  function openProgress(o) {
    if (!progressWrapEl || !window.Progress) return;
    leaveOtherViews();
    closeAreaViews();
    if (o && o.courseId) { Progress.state.selected = o.courseId; LS.set('pgCourse', o.courseId); }
    progressWrapEl.hidden = false;
    setNavActive('progress-open-btn', true);
    setSidebarOpen(false);   // 跟 timetree 一樣：頁面自己有左欄
    setHash('progress');
    setTreeArea('progress');
    renderProgress();
    // 預設的「課程管理」行事曆：沒有就建一本，建好再畫一次（章節的行程才有地方放）
    if (!courseCalNote() && window.TimeTree) ensureCourseCal().then(function () { renderProgress(); }, function (e) { toast('建立「課程管理」行事曆失敗：' + (e && e.message || e)); });
  }
  // 進站時提醒逾期的章節（一個工作階段提醒一次）
  function progressOverdueNotice() {
    if (!window.Progress || sessionStorage.getItem('pgNoticed')) return;
    let n = 0, names = [];
    state.notes.forEach(function (x) { if (x.area !== 'progress' || !Progress.isNote(x) || !isMine(x)) return; const st = Progress.stats(Progress.parse(Progress.payloadOf(x.content) || '')); if (st.overdue.length) { n += st.overdue.length; names.push(x.title); } });
    if (!n) return;
    try { sessionStorage.setItem('pgNoticed', '1'); } catch (e) { /* */ }
    toast('課程進度：' + names.join('、') + ' 有 ' + n + ' 個章節逾期，到課程進度重新規劃');
  }
  // ---- 圖資中心（js/foodmap.js，原本的美食地圖）：#foodmap 一個畫面；每一個圖層是一篇 area 'foodmap'、meta.foodmap 的筆記 ----
  // 底圖是 OpenStreetMap（vendor/leaflet），地址定位走伺服器的 /api/geocode。存檔走 ttSave（每篇一條單一寫入路徑）。
  const foodmapWrapEl = $('#foodmap-wrap'), foodmapPageEl = $('#foodmap-page');
  function fmOpts() {
    return {
      maps: state.notes.filter(function (n) { return n.area === 'foodmap' && window.FoodMap && FoodMap.isNote(n); }),
      readOnly: function (n) { return n.perm === 'read'; },
      // d：{ title, kind, icon, color, desc, auto }；回 promise，頁面第一次開時用它一層一層建預設圖層
      onCreate: function (d) {
        return Store.createNote(d.title, null, { area: 'foodmap', content: FoodMap.generate(d), meta: { foodmap: true } }).then(function (n) {
          state.notes.push(n);
          renderFoodMap(); renderTree();
          if (!d.auto) toast('已新增圖層「' + n.title + '」');
          return n;
        }, function (e) { toast('建立失敗：' + (e && e.message || e)); throw e; });
      },
      // 圖層對話框改了名稱：標題先寫進 state 裡的那篇，再走 ttSave 的單一寫入路徑——同一個對話框可能同時改了名稱
      // 跟顏色（onChange），兩條各自 PUT 的話後到的那個會把另一個的值蓋回去（名稱又變回舊的，測試抓到過）。
      onRename: function (n, t) {
        t = String(t || '').trim();
        if (!t || t === n.title) return Promise.resolve();
        const live = state.notes.find(function (x) { return x.id === n.id; }) || n;
        live.title = t;
        if (live !== n) n.title = t;
        ttSave(live, live.content);
        refreshViews();
        return Promise.resolve();
      },
      onChange: ttSave,
      onTags: editTags,
      onUpload: function (files) { return uploadFiles(files).catch(function (e) { toast('上傳失敗：' + (e && e.message || e)); return []; }); },
      onDelete: function (n) {
        showConfirm({ title: '移到垃圾桶', message: '把圖層「' + n.title + '」和裡面的地點移到垃圾桶？可以從垃圾桶還原。', ok: '移到垃圾桶', danger: true }).then(function (yes) {
          if (!yes) return;
          Store.deleteNote(n.id).then(function () {
            state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
            refreshViews();
            toast('已移到垃圾桶');
          }, function (e) { toast('刪除失敗：' + (e && e.message || e)); });
        });
      }
    };
  }
  function renderFoodMap() {
    if (foodmapWrapEl && !foodmapWrapEl.hidden && window.FoodMap) FoodMap.render(foodmapPageEl, fmOpts());
  }
  function openFoodMap(o) {
    if (!foodmapWrapEl || !window.FoodMap) return;
    leaveOtherViews();
    closeAreaViews();
    if (o && o.mapId) FoodMap.reveal(o.mapId);
    foodmapWrapEl.hidden = false;
    setNavActive('foodmap-open-btn', true);
    setSidebarOpen(false);   // 跟 timetree 一樣：頁面自己有左欄
    setHash('foodmap');
    setTreeArea('foodmap');
    renderFoodMap();
  }
  // ---- 文件（js/doc.js）：所見即所得的編輯器，整頁；內容是 HTML。最上面那一列是它的標題列（toolBar，
  // 跟 drawio／看板同一套），單一寫入路徑同上。----
  const docWrapEl = $('#doc-wrap');
  let docView = null, docNoteId = null;
  function closeDocView() {
    if (docNoteId) { const id = docNoteId; docNoteId = null; setTimeout(function () { flushPublish(id); }, 0); }
    dropToolBar('doc');
    if (docView) { const v = docView; docView = null; v.close(); }
    if (docWrapEl) docWrapEl.hidden = true;
  }
  function openDocNote(note) {
    if (!docWrapEl || !window.Doc) return;
    leaveOtherViews();
    closeAreaViews();
    docWrapEl.hidden = false;
    setSidebarOpen(false);   // 使用者要的：點開文件就收起左邊
    docNoteId = note.id;
    setTreeArea(isMine(note) ? (note.area || null) : null);
    LS.set('lastNote', note.id);
    setHash('note/' + note.id);
    function syncState(n) {
      const idx = state.notes.findIndex(function (x) { return x.id === n.id; });
      if (idx >= 0) { state.notes[idx].rev = n.rev; state.notes[idx].updatedAt = n.updatedAt; }
      note.rev = n.rev; note.updatedAt = n.updatedAt;
    }
    function live() { return state.notes.find(function (x) { return x.id === note.id; }) || note; }
    let saving = null, again = false;
    function flushSave() {
      if (saving) { again = true; return saving; }
      const run = function () {
        const n = live();
        return Store.updateNote({ id: n.id, title: n.title, content: n.content, folderId: n.folderId, meta: n.meta })
          .then(function (r) { syncState(r); noteSaved(live()); })
          .then(function () { if (again) { again = false; return run(); } });
      };
      saving = run().then(function () { saving = null; }, function (e) {
        saving = null; again = false;
        toast('儲存失敗：' + (e && e.message || e));
        throw e;
      });
      return saving;
    }
    function setLocal(patch) {
      const n = live();
      Object.assign(n, patch);
      if (n !== note) Object.assign(note, patch);
      return flushSave();
    }
    const readOnly = note.perm === 'read';
    const title = (note.title === '未命名筆記' || note.title === '未命名文件') ? '' : (note.title || '');
    const view = Doc.open(note.content || '', {
      container: docWrapEl,
      readOnly: readOnly,
      banner: readOnly ? '唯讀 — 由 ' + (note.sharedBy || '其他使用者') + ' 分享給你' : '',
      margins: (note.meta && note.meta.docMargins) || null,
      // 尺規上拖出來的左右邊界：存在 meta（bookkeeping，不動 rev）
      onMargins: function (m) { setLocal({ meta: Object.assign({}, live().meta, { docMargins: m }) }).catch(function () {}); },
      // 頁面設定（紙張、上下邊界、頁首頁尾、頁碼與起始頁碼）：同樣是 meta
      page: (note.meta && note.meta.docPage) || null,
      onPage: function (pg) { if (readOnly) return; setLocal({ meta: Object.assign({}, live().meta, { docPage: pg }) }).catch(function () {}); },
      getTitle: function () { return live().title; },
      onChange: function (html) { return setLocal({ content: html }); },
      // 圖片走跟編輯器同一條上傳路（uploadFiles），回來的是 Markdown 參照，這裡只要 id 與名稱
      onUpload: function (files) {
        return uploadFiles(files).then(function (mds) {
          return mds.map(function (md) {
            const m = /^!\[([^\]]*)\]\(img:([^)#]+)\)/.exec(md || '');
            return m ? { id: m[2], alt: m[1] } : null;
          }).filter(Boolean);
        });
      }
    });
    docView = view;
    let titleTimer = null, pendingTitle = null;
    function commitTitle() {
      clearTimeout(titleTimer); titleTimer = null;
      if (pendingTitle === null) return;
      const t = pendingTitle.trim();
      pendingTitle = null;
      if ((t || '未命名文件') === live().title) return;
      setLocal({ title: t || '未命名文件' }).catch(function () {});
      renderTree();
    }
    toolBar = {
      kind: 'doc',
      id: note.id,
      readOnly: readOnly,
      note: live,
      titleInput: function (v) {
        if (readOnly) return;
        pendingTitle = v;
        clearTimeout(titleTimer);
        titleTimer = setTimeout(commitTitle, SAVE_DELAY);
      },
      commitTitle: commitTitle,
      history: function () {
        if (!window.Versions) return;
        commitTitle();
        view.flush().then(function () {
          if (docView !== view) return;
          Versions.openNote(live(), {
            onRestored: function (fresh) {
              const i = state.notes.findIndex(function (n) { return n.id === fresh.id; });
              if (i >= 0) state.notes[i] = Object.assign(state.notes[i], fresh);
              renderTree();
              if (docView === view) view.setContent(fresh.content || '');
            }
          });
        });
      },
      // PDF：文件自己的列印預覽（Google 文件下載 PDF 的樣子：沒有封面，頁首頁尾與頁碼照頁面設定）
      pdf: function () {
        commitTitle();
        view.exportPDF().catch(function (err) { alert('產生列印預覽失敗：' + (err && err.message || err)); });
      }
    };
    noteBar(true);
    document.getElementById('app').classList.add('tool-open');
    titleEl.placeholder = '未命名文件';
    titleEl.value = title;
    titleEl.readOnly = readOnly;
    if (shareBtn) shareBtn.hidden = !isMine(note);
    updateNotePath(note);
  }
  function openKanbanNote(note) {
    if (!kanbanWrapEl || !window.Board) return;
    leaveOtherViews();
    closeAreaViews();
    kanbanWrapEl.hidden = false;
    setSidebarOpen(false);   // 看板要整個寬度
    kanbanNoteId = note.id;
    setTreeArea(isMine(note) ? (note.area || null) : null);
    LS.set('lastNote', note.id);
    setHash('note/' + note.id);
    function syncState(n) {
      const idx = state.notes.findIndex(function (x) { return x.id === n.id; });
      if (idx >= 0) { state.notes[idx].rev = n.rev; state.notes[idx].updatedAt = n.updatedAt; }
      note.rev = n.rev; note.updatedAt = n.updatedAt;
    }
    function live() { return state.notes.find(function (x) { return x.id === note.id; }) || note; }
    // 單一寫入路徑（見 openRelMapNote 的說明）：標題與看板內容合成一個請求，同時只有一個在路上
    let saving = null, again = false;
    function flushSave() {
      if (saving) { again = true; return saving; }
      const run = function () {
        const n = live();
        return Store.updateNote({ id: n.id, title: n.title, content: n.content, folderId: n.folderId, meta: n.meta })
          .then(function (r) { syncState(r); noteSaved(live()); })
          .then(function () { if (again) { again = false; return run(); } });
      };
      saving = run().then(function () { saving = null; }, function (e) {
        saving = null; again = false;
        toast('儲存失敗：' + (e && e.message || e));
        throw e;
      });
      return saving;
    }
    function setLocal(patch) {
      const n = live();
      Object.assign(n, patch);
      if (n !== note) Object.assign(note, patch);
      return flushSave();
    }
    const readOnly = note.perm === 'read';
    const title = (note.title === '未命名筆記' || note.title === '未命名看板') ? '' : (note.title || '');
    const view = Board.open(note, {
      container: kanbanWrapEl,
      readOnly: readOnly,
      title: function () { return live().title; },
      // 看板標題列上改名：跟最上面那一列同一條寫入路徑，兩邊一起更新
      onTitle: function (t) {
        setLocal({ title: t }).catch(function () {});
        titleEl.value = t;
        fitNoteTitle();
        renderTree();
      },
      onChange: function (content) { return setLocal({ content: content }); }
    });
    kanbanView = view;
    let titleTimer = null, pendingTitle = null;
    function commitTitle() {
      clearTimeout(titleTimer); titleTimer = null;
      if (pendingTitle === null) return;
      const t = pendingTitle.trim();
      pendingTitle = null;
      if ((t || '未命名看板') === live().title) return;
      setLocal({ title: t || '未命名看板' }).catch(function () {});
      if (kanbanView === view) view.renderHead();
      renderTree();
    }
    toolBar = {
      kind: 'board',
      id: note.id,
      readOnly: readOnly,
      note: live,
      titleInput: function (v) {
        if (readOnly) return;
        pendingTitle = v;
        clearTimeout(titleTimer);
        titleTimer = setTimeout(commitTitle, SAVE_DELAY);
      },
      commitTitle: commitTitle,
      history: function () {
        if (!window.Versions) return;
        commitTitle();
        Versions.openNote(live(), {
          onRestored: function (fresh) {
            const i = state.notes.findIndex(function (n) { return n.id === fresh.id; });
            if (i >= 0) state.notes[i] = Object.assign(state.notes[i], fresh);
            if (MD.invalidateRelNote) MD.invalidateRelNote(fresh.id);
            renderTree();
            if (kanbanView === view) view.reload(live());
          }
        });
      },
      // PDF：內容就是一個 ```board 圍欄，照一般筆記的路畫成靜態看板再交給 PDF
      pdf: function () {
        commitTitle();
        const n = live();
        const box = document.createElement('div');
        box.className = 'markdown-body';
        box.innerHTML = MD.render(n.content || '');
        PDF.showPreview(n, box, {
          meta: n.meta,
          onMeta: function (meta) {
            if (readOnly) return;
            setLocal({ meta: Object.assign({}, live().meta, meta, { board: true }) }).catch(function () {});
          }
        }).catch(function (err) { alert('產生列印預覽失敗：' + (err && err.message || err)); });
      }
    };
    noteBar(true);
    document.getElementById('app').classList.add('tool-open');
    titleEl.placeholder = '未命名看板';
    titleEl.value = title;
    titleEl.readOnly = readOnly;
    if (shareBtn) shareBtn.hidden = !isMine(note);
    updateNotePath(note);
  }
  function showDrawioPage() {
    leaveOtherViews();
    closeAreaViews();
    drawioWrapEl.hidden = false;
    setSidebarOpen(false);   // 編輯器要整個寬度
  }

  // ---- 關聯分析頁（#relmap-wrap）：整頁的畫布編輯器，見 js/relmap.js ----
  // relmapView 是 RelMap.open() 回傳的把手；離開這一頃（切到任何其他檢視）時先
  // close()，它會把還沒送出的改動 flush 掉再拆 DOM。
  const relmapWrapEl = $('#relmap-wrap');
  let relmapView = null;
  let relmapNoteId = null;   // 開著的關聯分析筆記（離開時要把公開連結更新掉）
  function closeRelMapView() {
    if (relmapNoteId) { const id = relmapNoteId; relmapNoteId = null; setTimeout(function () { flushPublish(id); }, 0); }
    if (relmapView) { const v = relmapView; relmapView = null; v.close(); }
    if (relmapWrapEl) relmapWrapEl.hidden = true;
  }
  function showRelMapPage() {
    leaveOtherViews();
    closeAreaViews();
    relmapWrapEl.hidden = false;
    setSidebarOpen(false);   // 畫布要整個寬度
  }

  // ---- 關聯圖頁（#graph-wrap）：整頁的力導向圖，見 js/graph.js ----
  // 跟上面的關聯分析同一套：Graph.open() 回傳把手，離開時 close() 停掉動畫、拆事件。
  // graphView 先設成 null 再 close()，所以「返回」→ showEmpty() → closeGraphView()
  // 不會繞回來重入。
  const graphWrapEl = $('#graph-wrap');
  let graphView = null;
  function closeGraphView() {
    if (graphView) { const v = graphView; graphView = null; v.close(); }
    if (graphWrapEl) graphWrapEl.hidden = true;
    setNavActive('graph-open-btn', false);
  }
  function openGraphPage() {
    if (!window.Graph || !graphWrapEl) return;
    // 從哪裡進來的，「返回」就回哪裡：從一篇筆記按小視窗的放大鈕（或側邊欄）進來，
    // 返回要回到那篇筆記，不是把人丟回首頁。一定要在 leaveOtherViews() 之前記下來——
    // 它會把 state.currentId 清成 null。
    const from = state.currentId;
    leaveOtherViews();
    closeAreaViews();
    graphWrapEl.hidden = false;
    setSidebarOpen(false);   // 圖要整個寬度
    setNavActive('graph-open-btn', true);
    // 隨筆沒有標題、彼此也不會互連，進圖只是一堆「未命名筆記」的孤點；小說是
    // 刻意隔開的區域，也不該混進一般筆記的關聯圖。課程筆記／知識區是有標題、
    // 會互相 [[連結]] 的正經筆記，留著。
    graphView = Graph.open(graphNotes(), {
      container: graphWrapEl,
      showLabels: LS.get('graphLabels', '1') === '1',
      onLabels: function (on) { LS.set('graphLabels', on ? '1' : '0'); },
      onOpenNote: function (note) { openNote(note.id); },
      onOpenTag: function (tag) { browseTag(tag); },
      onClose: function () {
        // 那篇筆記可能在圖裡被刪掉／看不到了，找不到就退回首頁
        if (from && state.notes.some(function (n) { return n.id === from; })) openNote(from);
        else showEmpty();
      }
    });
  }
  // 進關聯圖的那份筆記清單。
  function graphNotes() {
    return state.notes.filter(function (n) {
      return n.area !== 'quick' && n.area !== 'novel' && n.area !== 'board' && n.area !== 'start' && n.area !== 'xmind' && n.area !== 'timetree' && n.area !== 'progress' && n.area !== 'foodmap' && !isFileNote(n) && !isStickyNote(n);
    });
  }

  // 區域頁的網址：#course 是最上層，#course/<資料夾 id> 是裡面某個資料夾（knowledge、novel 同理）。
  // 跟首頁的 #folder/<id> 同一個用意：點進資料夾、打開筆記都各留一筆瀏覽紀錄，「上一頁」一路退得回去。
  const AREA_HASH = /^#(course|knowledge|novel)(?:\/([^\/?#]+))?$/;
  function areaHash(area, folderId) { return area + (folderId ? '/' + encodeURIComponent(folderId) : ''); }
  function areaFromHash() {
    const m = location.hash.match(AREA_HASH);
    if (!m) return null;
    let fid = m[2] ? decodeURIComponent(m[2]) : null;
    // 資料夾已經刪了（或不是這個區域的）：退回那個區域的最上層
    if (fid && !state.folders.some(function (f) { return f.id === fid && f.area === m[1]; })) fid = null;
    return { area: m[1], folderId: fid };
  }
  function replaceHash(h) {
    try { history.replaceState(null, '', location.pathname + location.search + (h ? '#' + h : '')); } catch (e) { /* ignore */ }
  }
  // 現在畫面上是哪個區域頁（課程筆記／知識區／小說），沒有就是 null
  function visibleAreaPage() {
    return ['course', 'knowledge', 'novel'].filter(function (x) { return AREA_INFO[x].wrap && !AREA_INFO[x].wrap.hidden; })[0] || null;
  }
  // 從區域頁打開那個區域裡的一篇筆記：先把「目前這一筆」瀏覽紀錄改成筆記所在的資料夾，再 push 筆記。
  // 不管是從資料夾頁點進來、從側邊欄的樹點、還是停在最上層直接點，「上一頁」都回到筆記所屬的資料夾。
  function anchorBackToFolder(fromArea, note) {
    if (!fromArea || !note || note.area !== fromArea || !isMine(note)) return;
    replaceHash(areaHash(fromArea, note.folderId || null));
  }
  // o.folderId：直接進到那個資料夾；o.keepHash：跟著網址走（上一頁、重新整理），不再動網址；
  // o.replaceHash：改寫目前這一筆紀錄而不是新增一筆（從 #note/<便條紙／檔案> 的連結進來時用）。
  function openArea(area, o) {
    o = o || {};
    const info = AREA_INFO[area];
    if (!info || !info.wrap || !window.AreaBrowser) return;
    if (area === 'novel' && !novelIsUnlocked) {
      // 取消就退回首頁，不要留著一片空白（例如帶著 #novel 重新整理又按取消）。
      promptNovelPassword().then(function (ok) { if (ok) openArea('novel', o); else showEmpty(); });
      return;
    }
    leaveOtherViews();
    closeAreaViews();
    info.wrap.hidden = false;
    info.wrap.scrollTop = 0;
    if (area === 'novel') {
      // 個人區：切到「小說」分頁（影片頁藏起來，見 openVideos）
      if (window.Videos && videosPageEl && !videosPageEl.hidden) Videos.teardown();
      if (videosPageEl) videosPageEl.hidden = true;
      novelPageEl.hidden = false;
      paTab('novel');
    }
    setNavActive(area + '-open-btn', true);
    autoOpenSidebar();
    const h = areaHash(area, o.folderId);
    if (o.replaceHash) replaceHash(h);
    else if (!o.keepHash) setHash(h);
    AreaBrowser.render(info.page, areaOpts(area));
    if (window.Dashboard && Dashboard.freshen) Dashboard.freshen(info.page);
    if (o.folderId) AreaBrowser.openFolder(o.folderId);
    setTreeArea(area);
  }
  function openQuick() {
    if (!quickWrapEl || !window.QuickNotes) return;
    leaveOtherViews();
    closeAreaViews();
    quickWrapEl.hidden = false;
    quickWrapEl.scrollTop = 0;
    setNavActive('quick-open-btn', true);
    autoOpenSidebar();
    setHash('quick');
    QuickNotes.render(quickPageEl, quickOpts());
    setTreeArea('quick');
  }

  // ---- 個人區 → 影片（js/videos.js）----
  // 跟小說共用同一個 #novel-wrap、同一道密碼（promptNovelPassword）與同一個 area:'novel'
  // （伺服器的 permFor/novelUnlocked 只認 area，所以影片跟小說一樣：解鎖前連列表都不會送到
  // 瀏覽器、不能分享、不進首頁、不進外面的關聯圖）。wrap 最上面一排 .pa-tabs 切換
  // 小說／影片；路由 #videos；一部影片的 #note/<id> 也落在這一頁、對話框疊上去。
  function paTab(which) {
    if (!paTabsEl) return;
    paTabsEl.querySelectorAll('[data-pa]').forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-pa') === which); });
  }
  function openVideos(o) {
    o = o || {};
    if (!novelWrapEl || !videosPageEl || !window.Videos) return;
    if (!novelIsUnlocked) {
      promptNovelPassword().then(function (ok) { if (ok) openVideos(o); else showEmpty(); });
      return;
    }
    leaveOtherViews();
    closeAreaViews();
    novelWrapEl.hidden = false;
    novelWrapEl.scrollTop = 0;
    novelPageEl.hidden = true;
    videosPageEl.hidden = false;
    paTab('videos');
    setNavActive('novel-open-btn', true);
    autoOpenSidebar();
    if (o.replaceHash) replaceHash('videos');
    else if (!o.keepHash) setHash('videos');
    Videos.render(videosPageEl, videosOpts());
    if (window.Dashboard && Dashboard.freshen) Dashboard.freshen(videosPageEl);
    setTreeArea('novel');
    if (o.open) Videos.open(o.open);
  }
  // 一部影片一次只有一個存檔在路上，其餘併成一次補送（跟 startSave 同一套）
  const videoSavers = {};
  function videoSave(n) {
    const s = videoSavers[n.id] || (videoSavers[n.id] = { saving: false, again: false });
    const run = function () {
      s.saving = true;
      const cur = state.notes.find(function (x) { return x.id === n.id; }) || n;
      Store.updateNote({ id: cur.id, title: cur.title, content: cur.content, folderId: cur.folderId, meta: cur.meta })
        .then(function (r) { cur.rev = r.rev; cur.updatedAt = r.updatedAt; if (window.Videos) Videos.saved(cur); }, function (e) { toast('儲存失敗：' + (e && e.message || e)); })
        .then(function () { s.saving = false; if (s.again) { s.again = false; run(); } });
    };
    if (s.saving) s.again = true; else run();
  }
  function videosOpts() {
    return {
      notes: state.notes.filter(function (n) { return n.area === 'novel' && isMine(n) && isVideoNote(n); }),
      // d.meta：觀察區的連結是 { video: true, watch: true }（同一個區、同一道密碼、同一條硬刪路線）
      onCreate: function (d) {
        return Store.createNote(d.title, null, { area: 'novel', content: d.content, meta: Object.assign({ video: true }, d.meta || {}) }).then(function (n) {
          state.notes.push(n);
          refreshViews();
          return n;
        }, function (e) { toast('建立失敗：' + (e && e.message || e)); throw e; });
      },
      onSave: videoSave,
      // 影片是硬刪：不進垃圾桶、版本／分享跟著掉、兩邊的預覽快取都忘掉——使用者要「不留任何痕跡」
      onDelete: function (n) {
        showConfirm({ title: '刪除影片', message: '直接刪除「' + n.title + '」？不會進垃圾桶、不留版本紀錄，無法復原。', ok: '刪除', danger: true }).then(function (yes) {
          if (!yes) return;
          Store.deleteNote(n.id, true).then(function () {
            try { Store.forgetLinkPreview(Videos.parse(n.content).url); } catch (e) { /* ignore */ }
            try { Videos.dropNoteImages(n); } catch (e) { /* ignore */ }   // 本機快取裡這部的圖也刪
            state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
            refreshViews();
            toast('已刪除');
          }, function (e) { toast('刪除失敗：' + (e && e.message || e)); });
        });
      },
      // 快速離開（頁首「離開」／Esc 兩下）：回首頁，showEmpty 會把影片頁拆掉
      onLeave: function () { goHome(); },
      // 觀察區的連結、表格批次刪除：不問、直接硬刪
      onDeleteNow: function (n) {
        try { Videos.dropNoteImages(n); } catch (e) { /* ignore */ }
        return Store.deleteNote(n.id, true).then(function () {
          state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
          refreshViews();
        }, function (e) { toast('刪除失敗：' + (e && e.message || e)); throw e; });
      },
      // 預覽走既有的 /api/link-preview（伺服器那邊有 SSRF 防護），縮圖透過它的代理（CSP 只准同源圖片）
      // 失敗時把原因（{ error }）一起交回去，對話框才說得出是對方擋、逾時還是網址不對
      // 影片完全不留快取：預覽 JSON 與縮圖都帶 nocache=1（伺服器不讀不寫、回 no-store），頁面快取也不用
      onPreview: function (url) {
        return Store.getLinkPreview(url, true).then(function (info) { return info || { error: '無法取得這個網頁' }; }, function (e) { return { error: e && e.message || '無法取得這個網頁' }; });
      },
      // 人物誌／關聯圖的大頭照：用名字問伺服器（它去外部資料庫找），找不到回 { error }
      onPerson: function (name) {
        return Store.lookupPerson(name).then(function (info) { return info || { error: '查不到' }; }, function (e) { return { error: e && e.message || '查不到' }; });
      },
      // 縮圖／大頭照存進系統：回 img id（之後從 /api/images/<id> 拿，不再每次去抓）；失敗回 null
      // 瀏覽器那邊先透過代理抓、縮小，再把位元組送上來（onStoreImageBytes）；縮不了就退回讓伺服器自己抓
      onStoreImage: function (u) {
        return Store.storeLinkImage(u).then(function (r) { return r && r.id ? r.id : null; }, function () { return null; });
      },
      onStoreImageBytes: function (blob) {
        return Store.storeLinkImageBytes(blob).then(function (r) { return r && r.id ? r.id : null; }, function () { return null; });
      },
      onFetchImage: function (u) {
        return fetch('/api/link-preview/image?url=' + encodeURIComponent(u) + '&nocache=1', { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.blob() : null; }, function () { return null; });
      },
      // 不要了的存圖（換照片、人物整個拿掉）直接刪，不留在系統裡
      onDropImage: function (id) { return Store.deleteImage(id).then(function () { return true; }, function () { return false; }); },
      proxy: function (u) { return '/api/link-preview/image?url=' + encodeURIComponent(u) + '&nocache=1'; }
    };
  }

  // 小說的第二層密碼：彈窗重新輸入目前帳號的密碼，通過才把 novelIsUnlocked 打開、
  // 重抓一次筆記／資料夾列表（這時伺服器才會把 area:'novel' 的項目也一起送回來）。
  // 這個彈窗只存在這一頁的生命週期——重新整理一律要再輸入一次，見 novelIsUnlocked
  // 宣告處的說明。
  function promptNovelPassword() {
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-title">' + (Icons ? Icons.svg('lock') : '') + '<span>再次確認密碼</span></div>' +
        '<div class="modal-body">請輸入密碼</div>' +
        '<input class="modal-input" type="password" autocomplete="current-password">' +
        '<div class="modal-error" hidden></div>' +
        '<div class="modal-actions">' +
        '<button class="btn modal-cancel" type="button">取消</button>' +
        '<button class="btn btn-primary modal-ok" type="button">確認</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      const field = overlay.querySelector('.modal-input');
      const err = overlay.querySelector('.modal-error');
      let busy = false;
      function close(val) {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(val);
      }
      function submit() {
        if (busy || !field.value) return;
        busy = true;
        err.hidden = true;
        Store.unlockNovel(field.value).then(function () {
          novelIsUnlocked = true;
          return Store.getNotes().then(function (notes) { state.notes = notes; });
        }).then(function () {
          return Store.getFolders().then(function (folders) { state.folders = folders; });
        }).then(function () {
          close(true);
        }, function (e) {
          busy = false;
          err.textContent = (e && e.message) || '密碼不正確';
          err.hidden = false;
          field.value = '';
          field.focus();
        });
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        else if (e.key === 'Enter') { e.preventDefault(); submit(); }
      }
      overlay.querySelector('.modal-cancel').addEventListener('click', function () { close(false); });
      overlay.querySelector('.modal-ok').addEventListener('click', submit);
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', onKey, true);
      setTimeout(function () { field.focus(); }, 30);
    });
  }

  // Drag-and-drop filing from the dashboard (onto a folder tile or a crumb).
  // `folderId` may be null, meaning the top level. Notes already there are
  // skipped; the rest are appended to that folder's order in one request.
  function moveNotesToFolder(ids, folderId) {
    const target = folderId || null;
    const moving = ids.filter(function (id) {
      const n = state.notes.find(function (x) { return x.id === id; });
      return n && isMine(n) && (n.folderId || null) !== target;
    });
    if (!moving.length) return;
    selected.clear();
    updateBatchBar();
    placeItems('note', moving, target, null, true);
    const where = target
      ? '「' + ((state.folders.find(function (f) { return f.id === target; }) || {}).name || '資料夾') + '」'
      : '最上層';
    toast('已搬移 ' + moving.length + ' 篇筆記到' + where);
  }

  // 往上找：這個資料夾本身或它的某個上層是否也被勾了
  function insideSelectedFolder(folderId) {
    let cur = folderId;
    while (cur) {
      if (selectedFolders.has(cur)) return true;
      const f = state.folders.find(function (x) { return x.id === cur; });
      cur = f ? f.parentId : null;
    }
    return false;
  }

  // 先把筆記移到垃圾桶，全部成功才刪資料夾。notes.folder_id 沒有外鍵：資料夾先刪掉的話，
  // 沒進垃圾桶的筆記會指向不存在的資料夾，側邊欄和儀表板都再也看不到它。
  // 資料夾之間也沒有外鍵，子資料夾要由呼叫端（descendantFolderIds）一併列進 folderIds。
  function removeNotesAndFolders(noteIds, folderIds) {
    const trashed = {};
    let failed = 0;
    return Promise.all(noteIds.map(function (id) {
      return Store.deleteNote(id).then(function () { trashed[id] = true; }, function () { failed++; });
    })).then(function () {
      if (failed) { failed += folderIds.length; return []; }
      return Promise.all(folderIds.map(function (id) {
        return Store.deleteFolder(id).then(function () { return id; }, function () { failed++; return null; });
      }));
    }).then(function (done) {
      const goneFolders = done.filter(Boolean);
      state.notes = state.notes.filter(function (n) { return !trashed[n.id]; });
      state.folders = state.folders.filter(function (f) { return goneFolders.indexOf(f.id) < 0; });
      if (state.currentId && trashed[state.currentId]) showEmpty();
      refreshViews();   // renderTree 的 pruneSelection 會把已刪掉的從選取移除，失敗的留著可以再試
      return { notes: Object.keys(trashed).length, folders: goneFolders.length, failed: failed };
    });
  }

  function batchDelete() {
    const folderIds = [];
    selectedFolders.forEach(function (id) {
      descendantFolderIds(id).forEach(function (f) { if (folderIds.indexOf(f) < 0) folderIds.push(f); });
    });
    const noteIds = Array.from(selected);
    state.notes.forEach(function (n) {
      if (folderIds.indexOf(n.folderId) >= 0 && noteIds.indexOf(n.id) < 0) noteIds.push(n.id);
    });
    if (!noteIds.length && !folderIds.length) return;
    const withSubs = folderIds.length > selectedFolders.size;
    const ask = !folderIds.length
      ? {
        title: '移至垃圾桶',
        message: '把所選的 ' + noteIds.length + ' 篇筆記移到垃圾桶？\n保留期內可以從側邊欄的「垃圾桶」復原。',
        ok: '移至垃圾桶'
      }
      : {
        title: '刪除所選項目',
        message: '刪除 ' + folderIds.length + ' 個資料夾' + (withSubs ? '（含子資料夾）' : '') +
          (noteIds.length ? '，並把 ' + noteIds.length + ' 篇筆記移到垃圾桶？' : '？') +
          '\n資料夾本身會直接刪除' +
          (noteIds.length ? '；筆記保留期內可以從「垃圾桶」復原（復原後放在最上層）。' : '，無法復原。'),
        ok: '刪除', danger: true
      };
    showConfirm(ask).then(function (ok) {
      if (!ok) return;
      removeNotesAndFolders(noteIds, folderIds).then(function (r) {
        const parts = [];
        if (r.folders) parts.push('已刪除 ' + r.folders + ' 個資料夾');
        if (r.notes) parts.push((r.folders ? '' : '已') + '移至垃圾桶 ' + r.notes + ' 篇筆記');
        if (r.failed) parts.push(r.failed + ' 項沒有刪成功' + (r.folders ? '' : '，資料夾都保留'));
        toast(parts.join('，'));
      });
    });
  }

  function batchMove() {
    // 被勾選資料夾裡面的東西跟著資料夾走，不另外搬，否則會被拆出來攤平到目標資料夾
    const notes = Array.from(selected)
      .map(function (id) { return state.notes.find(function (x) { return x.id === id; }); })
      .filter(function (n) { return n && isMine(n) && !insideSelectedFolder(n.folderId); });
    const folders = Array.from(selectedFolders)
      .map(function (id) { return state.folders.find(function (x) { return x.id === id; }); })
      .filter(function (f) { return f && !insideSelectedFolder(f.parentId); });
    if (!notes.length && !folders.length) return;
    const what = [];
    if (folders.length) what.push(folders.length + ' 個資料夾');
    if (notes.length) what.push(notes.length + ' 篇筆記');
    showFolderPicker('移動 ' + what.join('、') + '到…', { folders: state.folders.filter(function (f) { return (f.area || null) === treeArea; }) }).then(function (res) {
      if (!res) return;                                  // 取消
      const target = res.folderId || null;
      const jobs = [];
      let cyclic = 0;
      notes.forEach(function (n) {
        if ((n.folderId || null) === target) return;
        n.folderId = target;
        jobs.push(Store.updateNote(n).catch(function () {}));
      });
      folders.forEach(function (f) {
        if (target && isDescendant(target, f.id)) { cyclic++; return; }   // 不能搬進自己或自己的子資料夾
        if ((f.parentId || null) === target) return;
        f.parentId = target;
        jobs.push(Store.updateFolder(f).catch(function () {}));
      });
      Promise.all(jobs).then(function () {
        selected.clear();
        selectedFolders.clear();
        refreshViews();
        if (cyclic) toast(cyclic + ' 個資料夾不能移到自己或自己的子資料夾裡，已略過');
      });
    });
  }

  // 資料夾完整路徑名（給選單顯示，例：外層 / 內層）
  function folderFullName(id) {
    const parts = [];
    let cur = id, guard = 0;
    while (cur && guard++ < 50) {
      const f = state.folders.find(function (x) { return x.id === cur; });
      if (!f) break;
      parts.unshift(f.name || '');
      cur = f.parentId || null;
    }
    return parts.join(' / ');
  }
  // 選資料夾對話框：resolve({folderId}) 或 resolve(null)（取消）
  function showFolderPicker(title, o) {
    o = o || {};
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const modal = document.createElement('div');
      modal.className = 'modal';
      const opts = o.noRoot ? [] : ['<option value="">（最上層）</option>'];
      (o.folders || state.folders).slice().sort(function (a, b) {
        return folderFullName(a.id).localeCompare(folderFullName(b.id), 'zh-Hant');
      }).forEach(function (f) {
        opts.push('<option value="' + f.id + '">' + MD.escapeHtml(folderFullName(f.id)) + '</option>');
      });
      modal.innerHTML =
        '<div class="modal-title">' + MD.escapeHtml(title || '移動到資料夾') + '</div>' +
        '<div class="modal-body"><select class="folder-picker">' + opts.join('') + '</select></div>' +
        '<div class="modal-actions">' +
        '<button class="btn modal-cancel" type="button">取消</button>' +
        '<button class="btn btn-primary modal-ok" type="button">' + MD.escapeHtml(o.ok || '移動') + '</button>' +
        '</div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const sel = modal.querySelector('.folder-picker');
      function close(val) { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(null); } }
      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(null); });
      modal.querySelector('.modal-cancel').addEventListener('click', function () { close(null); });
      modal.querySelector('.modal-ok').addEventListener('click', function () { close({ folderId: sel.value || null }); });
      setTimeout(function () { sel.focus(); }, 30);
    });
  }

  // Allow dropping onto empty tree area => move to root
  treeEl.addEventListener('dragover', function (e) { if (dragKind(e)) { e.preventDefault(); } });
  treeEl.addEventListener('drop', function (e) {
    if (!dragKind(e) || e.target !== treeEl) return;
    e.preventDefault();
    const data = dragPayload(e);
    dragData = null;
    if (data && data.ids.length) moveItem(data, null);
  });

  // ---- Note open / editor ------------------------------------------------
  const secWrapEl = $('#sec-wrap');
  const perfWrapEl = $('#perf-wrap');
  const bookWrapEl = $('#book-wrap');
  const trashWrapEl = $('#trash-wrap');
  const trashPageEl = $('#trash-page');
  // 四個獨立區域（js/areas.js）：課程筆記、知識區、小說共用 AreaBrowser；
  // 隨筆是它自己的 Keep 風格卡片牆（js/quicknotes.js）。
  const courseWrapEl = $('#course-wrap'), coursePageEl = $('#course-page');
  const knowledgeWrapEl = $('#knowledge-wrap'), knowledgePageEl = $('#knowledge-page');
  const quickWrapEl = $('#quick-wrap'), quickPageEl = $('#quick-page');
  const novelWrapEl = $('#novel-wrap'), novelPageEl = $('#novel-page');
  // 個人區（#novel-wrap）上面一排分頁：小說（AreaBrowser 畫在 #novel-page）／影片（js/videos.js
  // 畫在 #videos-page）。兩個共用同一道密碼與同一個 area:'novel'，見 openVideos。
  const videosPageEl = $('#videos-page');
  const paTabsEl = novelWrapEl ? novelWrapEl.querySelector('.pa-tabs') : null;
  // 只存在瀏覽器這一頁的生命週期裡，重新整理就重置——小說每次重新載入頁面都要
  // 再輸入一次密碼，即使伺服器那邊的解鎖狀態還沒過期（見 CLAUDE.md 的小說區段落）。
  let novelIsUnlocked = false;
  // 切換頂列的「筆記模式」：開一般筆記時顯示標題與編輯按鈕，回首頁時只留 logo + 帳號。
  function noteBar(on) {
    const app = document.getElementById('app');
    if (app) app.classList.toggle('note-open', !!on);
  }

  // 筆記所在的資料夾路徑：往上層走到根，組成「a/b」（無資料夾時回空字串）。
  function folderPath(folderId) {
    const parts = [];
    let cur = folderId || null, guard = 0;
    while (cur && guard++ < 50) {
      const f = state.folders.find(function (x) { return x.id === cur; });
      if (!f) break;
      parts.unshift(f.name || '');
      cur = f.parentId || null;
    }
    return parts.join('/');
  }
  // 標題前面的「📁 資料夾 / 」，排版比照 HackMD：資料夾圖示＋較淡的資料夾名，接一個
  // 兩側留空白的「/」，後面才是粗體的筆記標題。圖示、路徑、「/」分成三格：路徑太長時
  // 只截路徑本身（app.css 的 .note-path-text），圖示和「/」永遠看得到，整串讀起來
  // 才還是「資料夾 / 筆記」。
  function updateNotePath(note) {
    if (notePathEl) {
      const path = note ? folderPath(note.folderId) : '';
      notePathEl.textContent = '';
      if (path) {
        const ic = document.createElement('span');
        ic.className = 'note-path-ic';
        ic.innerHTML = Icons.svg('folder');
        const text = document.createElement('span');
        text.className = 'note-path-text';
        text.textContent = path;
        const sep = document.createElement('span');
        sep.className = 'note-path-sep';
        sep.textContent = '/';
        notePathEl.appendChild(ic);
        notePathEl.appendChild(text);
        notePathEl.appendChild(sep);
      }
      const f = note && note.folderId && state.folders.find(function (x) { return x.id === note.folderId; });
      notePathEl.title = f ? '回到「' + (f.name || '未命名資料夾') + '」' : '';
    }
    fitNoteTitle();
  }
  // 點標題前的「資料夾/」前綴：回到首頁並直接走進那個資料夾
  function goToFolder(folderId) {
    const gf = state.folders.find(function (f) { return f.id === folderId; });
    if (gf && gf.area && AREA_INFO[gf.area] && window.AreaBrowser) {
      // 區域裡的資料夾在那個區域自己的頁面上，首頁儀表板看不到它
      saveNow();
      LS.set('lastNote', '');
      openArea(gf.area, { folderId: folderId });
      return;
    }
    saveNow();
    LS.set('lastNote', '');
    showEmpty(true);        // render() 會回到最上層，再 navigate 進目標資料夾
    setHash('folder/' + encodeURIComponent(folderId));   // 上一頁會回到剛才那篇筆記
    renderTree();
    if (window.Dashboard && Dashboard.openFolder) Dashboard.openFolder(folderId);
  }
  // 資料夾頁的「更新到電子書」：這本書現有的公開分享連結全部用最新內容重新打包
  // （連結是快照，不會自己更新），然後打開閱讀器。閱讀器本身永遠是最新內容，
  // 所以沒有連結時只是把書打開、告訴使用者沒什麼要更新。
  function updateBook(folderId) {
    openBook(folderId);
    if (!window.Book || !Book.renderStandalone) return;
    Store.getBookLinks(folderId).then(function (links) {
      if (!links.length) { toast('這本電子書沒有公開分享連結；閱讀器顯示的就是最新內容'); return; }
      const book = Book.current();
      if (!book) return;
      return Book.renderStandalone().then(function (html) {
        return Promise.all(links.map(function (lk) {
          return Store.updateBookLink(lk.token, {
            title: book.title || '未命名電子書', html: html, chapters: book.chapters.length
          });
        }));
      }).then(function () { toast('已用最新內容更新 ' + links.length + ' 個分享連結'); });
    }).catch(function (e) { toast('更新電子書失敗：' + (e && e.message || e)); });
  }
  // 標題輸入框依內容伸縮：它跟資料夾路徑前綴排在同一個絕對置中的容器裡，寬度
  // 貼著文字，「測試資料夾/測試筆記」才會看起來是一整串置中的字，而不是路徑在
  // 左、標題在一個固定寬度的框裡各自為政。量測用同字型的隱形 span。
  let titleMeasure = null;
  function fitNoteTitle() {
    if (!titleEl) return;
    if (!titleMeasure) {
      titleMeasure = document.createElement('span');
      titleMeasure.className = 'note-title-measure';
      titleMeasure.setAttribute('aria-hidden', 'true');
      (titleEl.parentNode || document.body).appendChild(titleMeasure);
    }
    titleMeasure.textContent = titleEl.value || titleEl.placeholder || '';
    titleEl.style.width = Math.ceil(titleMeasure.getBoundingClientRect().width + 8) + 'px';
    fitTopbar();
  }

  // 頂列夠不夠寬是量出來的，不是照視窗寬度猜的：標題絕對定位貼死在正中線（對齊分割檢視的
  // 分隔線），左邊的模式切換鈕、右邊的版本／分享／PDF 都不會讓步，視窗一窄就可能疊到標題
  // 上。逐級收：先收純裝飾（水豚、線上人數），再把標題截短（資料夾路徑先讓，見 capTitle），還不夠才把按鈕
  // 文字收成純圖示，最後才不得已把標題整個藏起來。資料夾路徑很長的筆記在一般筆電寬度下
  // 原本會直接跳到收按鈕文字——「分割／編輯／預覽／版本／分享」少了字不好認，截掉一段
  // 路徑卻幾乎沒有損失。每一級收完都重量一次，空間夠了（視窗變寬回去）也要能一路放寬回來。
  const TITLE_MIN = 240;   // 標題截到比這還窄就不截了，改收按鈕文字
  function fitTopbar() {
    const topbar = $('#topbar');
    const modeSwitch = topbar && topbar.querySelector('.mode-switch');
    const titleWrap = topbar && topbar.querySelector('.note-title-wrap');
    const rightCluster = $('#history-btn');
    if (!topbar || !modeSwitch || !titleWrap || !rightCluster) return;
    // 左邊擋住標題的東西：平常是模式切換鈕；圖表沒有那一組（#app.tool-open 收掉了），
    // 那就是 logo 那一群——收掉的元素量出來全是 0，拿它當邊界等於左邊沒有東西
    const leftCluster = modeSwitch.getClientRects().length ? modeSwitch : (topbar.querySelector('.topbar-left') || modeSwitch);
    // 標題置中在正中線，所以它能用的寬度是「正中線到兩側按鈕群，較近那邊的距離」乘二。
    // 放得下就不設上限；放不下但還有 TITLE_MIN 就設成剛好那麼寬，路徑會先被截成「…/」。
    function capTitle() {
      titleWrap.style.maxWidth = '';
      if (!titleWrap.getClientRects().length) return;
      const gap = 12;
      const bar = topbar.getBoundingClientRect();
      const mid = bar.left + bar.width / 2;
      const room = 2 * Math.min(mid - leftCluster.getBoundingClientRect().right - gap,
        rightCluster.getBoundingClientRect().left - gap - mid);
      if (room >= TITLE_MIN && titleWrap.getBoundingClientRect().width > room) {
        titleWrap.style.maxWidth = Math.floor(room) + 'px';
      }
    }
    function fits() {
      // 頂列本身的內容有沒有真的超出它自己的寬度——標題藏起來之後（lvl3+）就只看這個，
      // 不然藏起來的標題還在原來的位置，位置比對永遠算「疊到」，沒辦法再往下一級判斷。
      if (topbar.scrollWidth > topbar.clientWidth + 1) return false;
      if (!titleWrap.getClientRects().length) return true;   // 沒開筆記，標題根本沒畫出來
      if (getComputedStyle(titleWrap).visibility === 'hidden') return true;
      const gap = 12;
      const t = titleWrap.getBoundingClientRect();
      return t.left - gap >= leftCluster.getBoundingClientRect().right &&
        t.right + gap <= rightCluster.getBoundingClientRect().left;
    }
    topbar.classList.remove('topbar-lvl1', 'topbar-lvl2', 'topbar-lvl3', 'topbar-lvl4', 'topbar-lvl5');
    titleWrap.style.maxWidth = '';
    if (fits()) return;
    topbar.classList.add('topbar-lvl1');
    if (fits()) return;
    capTitle();
    if (fits()) return;
    topbar.classList.add('topbar-lvl2');
    capTitle();   // 按鈕文字收掉後兩側多出空間，重算一次，標題能少截一點
    if (fits()) return;
    titleWrap.style.maxWidth = '';
    topbar.classList.add('topbar-lvl3');
    if (fits()) return;
    topbar.classList.add('topbar-lvl4');
    if (fits()) return;
    topbar.classList.add('topbar-lvl5');
  }
  // 內建字體載入後字寬會變，重量一次
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitNoteTitle(); });

  // keepHash：跟著網址切過來的（上一頁退回 #folder/<id>、重新整理）不要再改網址，
  // 否則會多塞一筆紀錄、把「下一頁」清掉。
  function showEmpty(keepHash) {
    closeStream();
    noteBar(false);
    if (notePathEl) notePathEl.textContent = '';
    state.currentId = null; state.current = null;
    editorNoteId = null;
    if (keepHash !== true) setHash('');
    emptyEl.hidden = false;
    wrapEl.hidden = true;
    if (secWrapEl) secWrapEl.hidden = true;
    if (perfWrapEl) perfWrapEl.hidden = true;
    closeBookView();
    closeTrashView();
    closeFilesView();
    closeAreaViews();
    closeRelMapView();
    closeDrawioView();
    closeKanbanView();
    closeDocView();
    closeXmindView();
    closeGraphView();
    setTreeArea(null);    // 首頁＝所有筆記，側邊欄的樹也回到一般區域
    if (window.Dashboard) {
      Dashboard.render(dashOpts());
    }
    autoOpenSidebar();    // 首頁預設打開抽屜；開啟筆記時才收回
  }

  // ---- 電子書模式 ---------------------------------------------------------
  // 把一個資料夾當成一本書：裡面的筆記是章節、子資料夾是分部。閱讀介面與
  // 「出版成單檔 HTML」都在 book.js；這裡只負責把其他檢視收起來、把書打開。
  function closeBookView() {
    if (!bookWrapEl) return;
    if (!bookWrapEl.hidden && window.Book && Book.close) Book.close();
    bookWrapEl.hidden = true;
  }
  // ---- 垃圾桶頁（#trash）------------------------------------------------------
  // 跟首頁、電子書一樣是主區域的一個檢視：收起其他檢視、打開 #trash-wrap，內容由
  // trash.js 畫。復原／永久刪除後只重抓筆記清單、重畫側邊欄，不走 loadData——
  // 它會依網址重開這一頁，也可能重開上一篇筆記。
  function trashOpts() {
    return {
      folders: state.folders,
      onHome: goHome,
      onChanged: function () {
        Store.getNotes().then(function (notes) { state.notes = notes; renderTree(); });
      }
    };
  }
  function setNavActive(id, on) {
    const b = document.getElementById(id);
    if (b) b.classList.toggle('is-active', !!on);
  }
  function closeTrashView() {
    if (!trashWrapEl) return;
    trashWrapEl.hidden = true;
    setNavActive('trash-open-btn', false);
  }
  // ---- 檔案管理頁（#files-wrap）：整頁，跟垃圾桶同一套。ImageLib.open 回傳把手，切走時 close() 拆 DOM ----
  const filesWrapEl = $('#files-wrap');
  let filesView = null;
  function closeFilesView() {
    if (filesView) { const v = filesView; filesView = null; v.close(); }
    if (filesWrapEl) filesWrapEl.hidden = true;
    setNavActive('images-open-btn', false);
  }
  function openFiles() {
    if (!window.ImageLib || !filesWrapEl) return;
    if (filesView && !filesWrapEl.hidden) return;   // 已經開著
    saveNow();
    closeStream();
    LS.set('lastNote', '');
    noteBar(false);
    if (notePathEl) notePathEl.textContent = '';
    state.currentId = null; state.current = null;
    editorNoteId = null;
    emptyEl.hidden = true;
    wrapEl.hidden = true;
    if (secWrapEl) secWrapEl.hidden = true;
    if (perfWrapEl) perfWrapEl.hidden = true;
    closeBookView();
    closeTrashView();
    closeAreaViews();
    closeRelMapView();
    closeDrawioView();
    closeKanbanView();
    closeDocView();
    closeXmindView();
    closeGraphView();
    closeFilesView();
    filesWrapEl.hidden = false;
    setNavActive('images-open-btn', true);
    autoOpenSidebar();
    setHash('files');
    setTreeArea(null);
    const view = ImageLib.open({
      container: filesWrapEl,
      folders: state.folders,
      onOpenNote: function (id) { openNote(id); },
      onClose: function () { if (filesView === view) { filesView = null; showEmpty(); } }
    });
    filesView = view;
  }
  function openTrash() {
    if (!window.Trash || !trashWrapEl) return;
    saveNow();
    closeStream();
    LS.set('lastNote', '');
    noteBar(false);
    if (notePathEl) notePathEl.textContent = '';
    state.currentId = null; state.current = null;
    editorNoteId = null;
    emptyEl.hidden = true;
    wrapEl.hidden = true;
    if (secWrapEl) secWrapEl.hidden = true;
    if (perfWrapEl) perfWrapEl.hidden = true;
    closeBookView();
    closeAreaViews();
    closeRelMapView();
    closeDrawioView();
    closeKanbanView();
    closeDocView();
    closeXmindView();
    closeGraphView();
    closeFilesView();
    trashWrapEl.hidden = false;
    trashWrapEl.scrollTop = 0;
    setNavActive('trash-open-btn', true);
    autoOpenSidebar();    // 跟首頁一樣開著抽屜，點頁面內容也不會收回
    setHash('trash');
    Trash.render(trashPageEl, trashOpts());
    if (window.Dashboard && Dashboard.freshen) Dashboard.freshen(trashPageEl);
    setTreeArea(null);
  }

  function openBook(folderId) {
    if (!window.Book || !bookWrapEl) return;
    saveNow();
    closeStream();
    LS.set('lastNote', '');
    noteBar(false);
    if (notePathEl) notePathEl.textContent = '';
    state.currentId = null; state.current = null;
    editorNoteId = null;
    emptyEl.hidden = true;
    wrapEl.hidden = true;
    if (secWrapEl) secWrapEl.hidden = true;
    if (perfWrapEl) perfWrapEl.hidden = true;
    closeTrashView();
    closeAreaViews();
    closeRelMapView();
    closeDrawioView();
    closeKanbanView();
    closeDocView();
    closeXmindView();
    closeGraphView();
    setTreeArea(null);
    bookWrapEl.hidden = false;
    setSidebarOpen(false);
    setHash('book/' + folderId);
    Book.open({
      container: bookWrapEl,
      folderId: folderId,
      notes: state.notes,
      folders: state.folders,
      onOpenNote: function (id) { openNote(id); },
      onClose: function () { goHome(); },
      // Restoring a book version rewrites several chapter notes on the server,
      // so the in-memory copies are stale. loadData re-opens the book on its own
      // because the URL hash is still #book/<id>.
      onRestored: function () { loadData(); }
    });
    renderTree();
    markBook(folderId);
  }
  // 用電子書模式開過的資料夾就留在書櫃（folders.is_book），之後從側邊欄的
  // 「電子書」直接找得到，不用每次再從整個資料夾清單裡挑。
  function markBook(folderId) {
    const f = state.folders.find(function (x) { return x.id === folderId; });
    if (!f || f.isBook) return;
    f.isBook = true;
    Store.updateFolder(f).then(function (saved) {
      // 舊版伺服器（還沒重啟、沒有 folders.is_book）會回 200 但不帶 isBook：
      // 標記只留在記憶體，重整就不見。與其默默吞掉，不如直接說要重啟。
      if (saved && saved.isBook === undefined) {
        toast('伺服器還在跑舊版程式，電子書標記存不進去——請重新啟動 node server/server.js');
      }
    }).catch(function () { f.isBook = false; });
  }

  // 回到首頁：先存好目前這篇，再顯示儀表板
  function goHome() {
    saveNow();
    LS.set('lastNote', '');
    showEmpty();
    renderTree();
  }

  // 點擊 #標籤：回到首頁並列出帶有該標籤的所有筆記
  function browseTag(tag) {
    if (!tag) return;
    saveNow();
    LS.set('lastNote', '');
    showEmpty();
    renderTree();
    if (window.Dashboard && Dashboard.setTag) Dashboard.setTag(tag);
  }

  // A note shared read-only must not look editable. The server would reject the
  // write anyway; this stops you wasting effort typing into a note you can't save.
  function applyReadOnly(note) {
    const ro = note.perm === 'read';
    editorEl.readOnly = ro;
    titleEl.readOnly = ro;
    wrapEl.classList.toggle('read-only', ro);
    let banner = document.getElementById('ro-banner');
    if (ro) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'ro-banner';
        banner.className = 'ro-banner';
        wrapEl.insertBefore(banner, wrapEl.firstChild);
      }
      banner.innerHTML = Icons.svg('lock') + ' 唯讀 — 由 ' + MD.escapeHtml(note.sharedBy || '其他使用者') + ' 分享給你';
      banner.hidden = false;
    } else if (banner) {
      banner.hidden = true;
    }
  }

  function openNote(id) {
    // 檔案筆記（meta.file：課程筆記資料夾裡上傳的 PPTX／PDF／影片）沒有編輯器可開，只是在
    // 目前畫面上疊一個檢視器。一定要在 closeStream() 之前判斷——從搜尋或
    // 連結點到一個檔案，不該把正開著的那篇筆記的協作連線關掉。
    const known = state.notes.find(function (n) { return n.id === id; });
    if (isFileNote(known)) { openFileViewer(known); return; }
    if (isStickyNote(known) && goToSticky(known)) return;
    // 影片（個人區）：到影片頁、把那一部的對話框打開。從 #note/<影片> 的連結進來就改寫那一筆紀錄
    if (isVideoNote(known)) { saveNow(); openVideos({ open: id, replaceHash: noteIdFromHash() === id }); return; }
    // 隨筆沒有整頁編輯器：到它那一頁、用 Keep 式的對話框打開（新分頁的 #note/<隨筆>、搜尋結果都走這裡）
    if (known && known.area === 'quick' && window.QuickNotes && QuickNotes.open) {
      if (!quickWrapEl || quickWrapEl.hidden) { saveNow(); openQuick(); }
      QuickNotes.open(id);
      return;
    }
    closeStream();   // stop listening to the note we're leaving
    // 從這一刻起 #note-title/#editor 裝的還是上一篇，但 state.current 馬上要換人——
    // 在「真的把新內容載進編輯器」之前，不准 saveNow 動它（見 editorNoteId）。
    editorNoteId = null;
    if (multi) multi.clear();
    // 小說筆記在 state.notes 裡卻打不開，八成是 server/api.js 的一小時解鎖過期了
    // （見 novelIsUnlocked 宣告處）——跟一般「筆記不見了」分開處理，讓使用者知道
    // 只是要再輸入一次密碼，不是筆記真的不見。
    const wasNovel = state.notes.some(function (n) { return n.id === id && n.area === 'novel'; });
    const fromArea = visibleAreaPage();   // 要在畫面被切換掉之前記下來
    Store.getNote(id).then(function (note) {
      if (!note) { showEmpty(); return; }
      // 關聯分析（meta.relMap）是疊在目前畫面上的工具，不是像一般筆記那樣「開啟」
      // 它——不動 state.currentId、不收起首頁，取消或存檔都只是把疊層收掉，見
      // openRelMapNote 開頭的說明。一定要在任何畫面狀態被改掉之前判斷。
      if (window.RelMap && RelMap.isRelNote(note)) { anchorBackToFolder(fromArea, note); openRelMapNote(note); return; }
      // drawio 圖表（meta.drawio）同理：它有自己的整頁編輯器，markdown 編輯器不接手
      if (window.DrawIO && DrawIO.isNote(note)) { anchorBackToFolder(fromArea, note); openDrawioNote(note); return; }
      // 看板（meta.board）同理：整頁的看板（js/board.js）
      if (window.Board && Board.isNote(note)) { openKanbanNote(note); return; }
      // 起始頁（meta.startpage）：到起始頁的畫面、切到那一頁
      if (window.StartPage && StartPage.isNote(note)) { openStart({ pageId: note.id }); return; }
      // 文件（meta.doc）：所見即所得的整頁編輯器
      if (window.Doc && Doc.isNote(note)) { anchorBackToFolder(fromArea, note); openDocNote(note); return; }
      // 心智圖（meta.xmind）：整頁的 XMind 式編輯器（js/xmind.js）
      if (window.XMind && XMind.isNote(note)) { openXmindNote(note); return; }
      // 行事曆（meta.timetree）：到行事曆的畫面、把那一本顯示出來
      if (window.TimeTree && TimeTree.isNote(note)) { openTimeTree({ calId: note.id }); return; }
      // 課程進度（meta.progress）：到課程進度的畫面、選到那一門
      if (window.Progress && Progress.isNote(note)) { openProgress({ courseId: note.id }); return; }
      // 美食地圖（meta.foodmap）：到地圖的畫面、把那張顯示出來
      if (window.FoodMap && FoodMap.isNote(note)) { openFoodMap({ mapId: note.id }); return; }
      // 不在 state.notes 裡的檔案筆記（理論上不會發生）：同樣只疊檢視器，背景沒東西就回首頁
      if (isFileNote(note)) { if (!state.currentId) showEmpty(); openFileViewer(note); return; }
      state.currentId = id;
      state.current = note;
      // Seed the collaboration baseline: this is the version we're now in sync with.
      note._syncRev = note.rev || 0;
      note._syncContent = note.content || '';
      LS.set('lastNote', id);
      anchorBackToFolder(fromArea, note);
      setHash('note/' + id);
      tocOpen.clear();         // 目錄的展開狀態是每篇筆記各自的
      emptyEl.hidden = true;
      closeBookView();
      closeTrashView();
      closeFilesView();
      closeAreaViews();
      closeRelMapView();
      closeDrawioView();
      closeKanbanView();
      closeDocView();
      closeXmindView();
      closeGraphView();
      // 區域裡的筆記：側邊欄留在那個區域的樹（別人分享來的不屬於我的任何區域）
      setTreeArea(isMine(note) ? (note.area || null) : null);
      setSidebarOpen(false);   // 從抽屜點開筆記後收回，把整個寬度留給筆記

      // 儲存後同步樹狀標題 / 記憶體中的筆記（給步驟式與表格式編輯器共用）。
      const onSaved = function (n) {
        const idx = state.notes.findIndex(function (x) { return x.id === n.id; });
        if (idx >= 0) { state.notes[idx].title = n.title; state.notes[idx].content = n.content; }
        const row = treeEl.querySelector('.note-row[data-id="' + n.id + '"] .label');
        if (row) row.textContent = n.title || '未命名筆記';
      };

      // 資安院筆記：右側整個是步驟式編輯器，沒有 md 編輯器。
      if (window.SecEditor && SecEditor.isSecNote(note)) {
        noteBar(false);   // 步驟式編輯器有自己的工具列，頂列只留 logo + 帳號
        wrapEl.hidden = true;
        if (perfWrapEl) perfWrapEl.hidden = true;
        secWrapEl.hidden = false;
        SecEditor.open(note, { onSaved: onSaved });
        renderTree();
        return;
      }

      // 成效報告筆記：右側整個是表格式編輯器。
      if (window.PerfReport && PerfReport.isPerfNote(note)) {
        noteBar(false);
        wrapEl.hidden = true;
        if (secWrapEl) secWrapEl.hidden = true;
        perfWrapEl.hidden = false;
        PerfReport.open(note, { onSaved: onSaved });
        renderTree();
        return;
      }

      noteBar(true);      // 一般 md 筆記：標題與編輯按鈕併入頂列 bar
      if (secWrapEl) secWrapEl.hidden = true;
      if (perfWrapEl) perfWrapEl.hidden = true;
      wrapEl.hidden = false;
      editorNoteId = note.id;   // 編輯器從這裡開始真的裝著這一篇
      titleEl.value = note.title || '';
      fitNoteTitle();
      editorEl.value = note.content || '';
      // Setting .value leaves the caret at the end, so the focus() below would
      // scroll the editor to the bottom while the preview opens at the top.
      // Start every note at the top on both sides instead.
      try { editorEl.setSelectionRange(0, 0); } catch (e) {}
      editorEl.scrollTop = 0;
      if (previewScrollEl) previewScrollEl.scrollTop = 0;
      applyReadOnly(note);
      updateNotePath(note);   // 標題前綴顯示所在資料夾（如 pp/）
      // Only the owner may (re)share; recipients just see the collaborators.
      if (shareBtn) shareBtn.hidden = !isMine(note);
      if (editorEl._hlRefresh) editorEl._hlRefresh();
      // 重新套用目前的檢視模式
      setMode(state.mode);
      renderPreview();
      updateStatus();
      renderTree();
      startStream(note);   // go live: receive others' edits + presence
      if (note.perm !== 'read') editorEl.focus();
    }).catch(function () {
      showEmpty();
      if (wasNovel) {
        novelIsUnlocked = false;
        toast('個人區的解鎖已過期，請再輸入一次密碼');
      }
    });
  }

  let previewTimer = null;
  function renderPreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreviewNow, 120);
  }
  function renderPreviewNow() {
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    previewEl.innerHTML = MD.render(editorEl.value);
    // LineSync before resolveImages: it rewrites paragraph/list-item innerHTML,
    // and resolveImages sets img.src asynchronously — the other way round the
    // src lands on a discarded <img> and pictures stay blank until a re-render.
    if (window.LineSync) LineSync.rebuild(editorEl.value);
    MD.resolveImages(previewEl);
    if (state.current && state.current.meta) MD.applyColWidths(previewEl, state.current.meta.tableWidths);
    restoreInlineTocState();
    // Mind maps are edited in place in the preview, and the preview is rebuilt
    // from scratch here, so the selection has to be re-applied every time.
    if (window.MindMap && MindMap.restorePreview) MindMap.restorePreview();
    buildPreviewTOC();
    renderBacklinks();
    scrollAnchorsDirty = true;
  }

  // ---- 左右捲動對齊 -----------------------------------------------------
  // 純比例同步會讓「左邊已到第三章、右邊還在第二章」：圖片、表格、程式碼在
  // 兩邊的高度差太多。改以標題為錨點：把編輯區每個 # 標題的像素位置對上預覽區
  // 對應的 <h1>~<h6>，同一節裡的程式碼區塊、圖片、表格也一併配對，
  // 錨點之間再按比例內插。什麼都對不上時等同純比例。
  let scrollAnchorsDirty = true;
  let scrollAnchors = null;   // [{ e: 編輯區 y, p: 預覽區 y }]，兩欄皆遞增

  // 編輯區裡可以當錨點的區塊（依出現順序）：
  //   h     ATX 標題（含層級）        pre   ``` / ~~~ 圍欄起點
  //   img   以 ![ 開頭的圖片行        table 一段 | 表格的第一行
  // 圍欄內的內容一律跳過。
  function editorBlocks() {
    const v = editorEl.value;
    const out = [];
    let pos = 0, fence = '', inTable = false;
    v.split('\n').forEach(function (line) {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        if (!fence) { fence = f[1][0]; out.push({ type: 'pre', pos: pos }); }
        else if (f[1][0] === fence) fence = '';
        inTable = false;
      } else if (!fence) {
        const h = line.match(/^\s{0,3}(#{1,6})\s/);
        const isTable = /^\s*\|/.test(line);
        if (h) out.push({ type: 'h', pos: pos, level: h[1].length });
        else if (/^\s*!\[/.test(line)) out.push({ type: 'img', pos: pos });
        else if (isTable && !inTable) out.push({ type: 'table', pos: pos });
        inTable = isTable;
      }
      pos += line.length + 1;
    });
    return out;
  }

  // 預覽區裡對應的元素（同樣依文件順序）
  function previewBlocks() {
    const out = [];
    previewEl.querySelectorAll('h1,h2,h3,h4,h5,h6,.code-block,img,.pdf-embed,table').forEach(function (el) {
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) out.push({ type: 'h', el: el, level: parseInt(tag.charAt(1), 10) });
      else if (tag === 'TABLE') out.push({ type: 'table', el: el });
      else if (tag === 'IMG' || el.classList.contains('pdf-embed')) out.push({ type: 'img', el: el });
      else out.push({ type: 'pre', el: el });
    });
    return out;
  }

  // 一次量出多個字元位置在 textarea 內容裡的像素高度（用共筆游標的量測鏡）
  function measureEditorYs(positions) {
    if (!ensureMirror()) return null;
    syncMirrorStyle();
    const v = editorEl.value;
    const frag = document.createDocumentFragment();
    const marks = [];
    let last = 0;
    positions.forEach(function (p) {
      frag.appendChild(document.createTextNode(v.slice(last, p)));
      const m = document.createElement('span');
      m.textContent = '​';
      marks.push(m);
      frag.appendChild(m);
      last = p;
    });
    frag.appendChild(document.createTextNode(v.slice(last)));
    caretMirror.textContent = '';
    caretMirror.appendChild(frag);
    const ys = marks.map(function (m) { return m.offsetTop; });
    caretMirror.textContent = '';
    return ys;
  }

  // 兩邊的區塊清單以標題切成一段一段，同一段裡同類型的區塊數量相同才逐一配對；
  // 數量不同（HTML 圖片、清單裡的程式碼…）就只放棄那一段的那一類，不影響其他段。
  function pairBlocks(eb, pb) {
    const pairs = [];
    const eHeads = eb.map(function (b, i) { return b.type === 'h' ? i : -1; }).filter(function (i) { return i >= 0; });
    const pHeads = pb.map(function (b, i) { return b.type === 'h' ? i : -1; }).filter(function (i) { return i >= 0; });
    let n = Math.min(eHeads.length, pHeads.length);
    for (let k = 0; k < n; k++) {
      // 標題層級對不上（setext 標題、引用裡的標題…）就從這裡起只剩比例
      if (eb[eHeads[k]].level !== pb[pHeads[k]].level) { n = k; break; }
    }
    // 段落邊界：[0, 第一個標題, …, 第 n 個標題, 結尾]
    const eBounds = [0].concat(eHeads.slice(0, n), [eb.length]);
    const pBounds = [0].concat(pHeads.slice(0, n), [pb.length]);
    for (let seg = 0; seg + 1 < eBounds.length; seg++) {
      const es = eb.slice(eBounds[seg], eBounds[seg + 1]);
      const ps = pb.slice(pBounds[seg], pBounds[seg + 1]);
      ['h', 'pre', 'img', 'table'].forEach(function (type) {
        const a = es.filter(function (b) { return b.type === type; });
        const b = ps.filter(function (b) { return b.type === type; });
        if (!a.length || a.length !== b.length) return;
        for (let i = 0; i < a.length; i++) pairs.push({ pos: a[i].pos, el: b[i].el });
      });
    }
    pairs.sort(function (x, y) { return x.pos - y.pos; });
    return pairs;
  }

  function buildScrollAnchors() {
    scrollAnchorsDirty = false;
    const eMax = editorEl.scrollHeight - editorEl.clientHeight;
    const pMax = previewScrollEl.scrollHeight - previewScrollEl.clientHeight;
    const list = [{ e: 0, p: 0 }];
    const pairs = pairBlocks(editorBlocks(), previewBlocks());
    const ys = pairs.length ? measureEditorYs(pairs.map(function (x) { return x.pos; })) : null;
    if (ys) {
      const base = previewScrollEl.getBoundingClientRect().top - previewScrollEl.scrollTop;
      for (let i = 0; i < pairs.length; i++) {
        const a = { e: ys[i], p: pairs[i].el.getBoundingClientRect().top - base };
        const prev = list[list.length - 1];
        // 最後一屏內的錨點不需要，且錨點在兩邊都必須嚴格遞增
        if (a.e >= eMax || a.p >= pMax || a.e <= prev.e || a.p <= prev.p) continue;
        list.push(a);
      }
    }
    list.push({ e: eMax, p: pMax });
    scrollAnchors = list;
  }

  // 把某一側的 scrollTop 換算成另一側應有的 scrollTop
  function mapScrollTop(fromEditor, y) {
    if (scrollAnchorsDirty || !scrollAnchors) buildScrollAnchors();
    const k1 = fromEditor ? 'e' : 'p', k2 = fromEditor ? 'p' : 'e';
    const A = scrollAnchors;
    let i = 1;
    while (i < A.length - 1 && A[i][k1] <= y) i++;
    const a = A[i - 1], b = A[i];
    const span = b[k1] - a[k1];
    const t = span > 0 ? Math.max(0, Math.min(1, (y - a[k1]) / span)) : 0;
    return a[k2] + t * (b[k2] - a[k2]);
  }

  // ---- Backlinks ---------------------------------------------------------
  // Which other notes point at the open one — the other half of a two-way link.
  function renderBacklinks() {
    if (!backlinksEl) return;
    backlinksEl.innerHTML = '';
    if (!state.current) { backlinksEl.hidden = true; return; }
    const target = normTitle(titleEl.value || state.current.title);
    const refs = state.notes.filter(function (n) {
      if (n.id === state.currentId) return false;
      return MD.extractLinks(n.content).some(function (t) { return normTitle(t) === target; });
    });
    if (!refs.length) { backlinksEl.hidden = true; return; }
    backlinksEl.hidden = false;
    const head = document.createElement('div');
    head.className = 'backlinks-title';
    head.innerHTML = Icons.svg('link') + ' 反向連結（' + refs.length + '）';
    backlinksEl.appendChild(head);
    refs.forEach(function (n) {
      const a = document.createElement('button');
      a.className = 'backlink';
      a.textContent = n.title || '未命名筆記';
      a.addEventListener('click', function () { saveNow(); openNote(n.id); });
      backlinksEl.appendChild(a);
    });
  }

  // Follow a [[link]] from the preview; unresolved ones create the note first.
  function handleNoteLink(a) {
    const id = a.getAttribute('data-note-id');
    if (id) { saveNow(); openNote(id); return; }
    const title = a.getAttribute('data-note-title');
    if (!title) return;
    saveNow();
    // 沒帶 id 的連結（隨筆對話框的籤片這類自己拼的）：先用標題找，找得到就開，不要另建一篇
    const hit = state.notes.find(function (n) { return isMine(n) && normTitle(n.title) === normTitle(title); });
    if (hit) { openNote(hit.id); return; }
    // 跟目前這篇同一個資料夾、同一個區域：少了 area，伺服器會因為資料夾的區域對不上而拒絕
    const here = state.current && isMine(state.current) ? state.current : null;
    Store.createNote(title, here ? here.folderId : null, here && here.area ? { area: here.area } : undefined).then(function (n) {
      state.notes.push(n);
      renderTree();
      openNote(n.id);
    });
  }

  // ---- Version history ----------------------------------------------------
  //
  // The unsaved buffer is flushed first: opening history on a note whose last
  // few keystrokes have not reached the server yet would show a "current
  // version" that is not what is on screen.
  function openHistory() {
    if (!state.current && toolBar) { toolBar.history(); return; }   // 開著的是圖表
    if (!state.current || !window.Versions) return;
    saveNow();
    Versions.openNote(state.current, {
      onRestored: function (fresh) {
        const i = state.notes.findIndex(function (n) { return n.id === fresh.id; });
        if (i >= 0) state.notes[i] = Object.assign(state.notes[i], fresh);
        renderTree();
        openNote(fresh.id);
      }
    });
  }

  // ---- To-do items and mind maps in the preview --------------------------
  //
  // Both write back into the textarea and then fire the same synthetic `input`
  // event a keystroke would, so autosave, the highlight backdrop and the preview
  // re-render all happen through the existing path rather than a second one.
  function applyEditorText(text) {
    const start = editorEl.selectionStart, end = editorEl.selectionEnd;
    const top = editorEl.scrollTop;
    editorEl.value = text;
    editorEl.selectionStart = Math.min(start, text.length);
    editorEl.selectionEnd = Math.min(end, text.length);
    editorEl.scrollTop = top;
    editorEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Walk the source counting task lines, skipping fenced code so a `- [ ]`
  // inside a code sample is never mistaken for the checkbox that was clicked.
  // markdown.js numbers the checkboxes in the same document order.
  function eachTaskLine(text, fn) {
    const lines = text.split('\n');
    let inFence = false, seq = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s{0,3}(?:```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = lines[i].match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\][\s\S]*)$/);
      if (!m) continue;
      if (fn(seq++, i, m, lines) === false) break;
    }
    return lines;
  }

  function toggleTask(index, checked) {
    let hit = false;
    const lines = eachTaskLine(editorEl.value, function (seq, i, m, ls) {
      if (seq !== index) return;
      ls[i] = m[1] + (checked ? 'x' : ' ') + m[3];
      hit = true;
      return false;
    });
    // If the counts ever disagree the safest thing is to change nothing and let
    // the next render put the checkbox back where the source says it is.
    if (!hit) { renderPreviewNow(); return; }
    applyEditorText(lines.join('\n'));
  }

  // 圖片黑框：預覽裡滑到圖片上出現的「▢ 黑框」鈕，切換這張圖的 #frame 標記。
  // 對應方式跟待辦清單一樣——預覽裡第 N 張站內圖片就是原始碼裡第 N 個 ![…](img:…)，
  // 序號在這裡算（DOM 才知道按的是哪一張），改寫原始碼交給 MD.toggleImageFrame。
  // 走 applyEditorText 是重點：它會發一個 input 事件，自動存檔、重新渲染、共同編輯的
  // 合併全部照原本的路徑跑，這顆鈕不需要自己碰任何一個。
  function toggleImageFrame(btn) {
    const cur = state.current;
    if (!cur || cur.perm === 'read') return;
    const wrap = btn.closest('.img-wrap');
    const img = wrap && wrap.querySelector('img[data-img-id]');
    if (!img) return;
    const all = Array.prototype.slice.call(previewEl.querySelectorAll('img[data-img-id]'));
    const index = all.indexOf(img);
    if (index < 0) return;
    const next = MD.toggleImageFrame(editorEl.value, index);
    // 數不對的時候寧可什麼都不改，讓下一次渲染以原始碼為準（同 toggleTask）
    if (next === editorEl.value) { renderPreviewNow(); return; }
    applyEditorText(next);
  }

  // Replace the body of the nth ```<fence> block (mindmap or relmap) in the source.
  function replaceFenceBlock(fence, index, outline) {
    const lines = editorEl.value.split('\n');
    let seq = -1;
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(new RegExp('^(\\s{0,3})(```+|~~~+)\\s*' + fence + '\\s*$'));
      if (!open) continue;
      let end = i + 1;
      while (end < lines.length && !new RegExp('^\\s{0,3}' + open[2][0] + '{3,}\\s*$').test(lines[end])) end++;
      if (++seq !== index) { i = end; continue; }
      const body = outline.split('\n');
      lines.splice(i + 1, end - i - 1, ...body);
      applyEditorText(lines.join('\n'));
      return true;
    }
    return false;
  }
  function replaceMindmapBlock(index, outline) { return replaceFenceBlock('mindmap', index, outline); }
  function replaceRelMapBlock(index, outline) { return replaceFenceBlock('relmap', index, outline); }

  function openMindMapBlock(block) {
    if (!block || !window.MindMap || !MindMap.open) return;
    if (state.current && state.current.perm === 'read') {
      toast('這篇筆記你只有唯讀權限');
      return;
    }
    const all = previewEl.querySelectorAll('.mindmap-block');
    const index = Array.prototype.indexOf.call(all, block);
    if (index < 0) return;
    MindMap.open(block.getAttribute('data-mindmap') || '', function (outline) {
      if (!replaceMindmapBlock(index, outline)) toast('找不到對應的心智圖區塊，請重試');
    });
  }

  // 跟 replaceFenceBlock 同一個演算法，只是對一段文字而不是編輯器——關聯分析頁開著
  // 的時候筆記本身是關著的，回寫要直接改伺服器上的內容。
  function replaceFenceInText(text, fence, index, body) {
    const lines = String(text || '').split('\n');
    let seq = -1;
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(new RegExp('^(\\s{0,3})(```+|~~~+)\\s*' + fence + '\\s*$'));
      if (!open) continue;
      let end = i + 1;
      while (end < lines.length && !new RegExp('^\\s{0,3}' + open[2][0] + '{3,}\\s*$').test(lines[end])) end++;
      if (++seq !== index) { i = end; continue; }
      lines.splice(i + 1, end - i - 1, ...body.split('\n'));
      return lines.join('\n');
    }
    return null;
  }
  // 一般筆記裡的 ```relmap 區塊按「全螢幕」：整頁的畫布編輯器（同一頁 #relmap-wrap），
  // 筆記先存好關起來；按「返回」時把最後的 DSL 寫回那一個區塊，再把筆記打開。
  function openRelMapBlock(block) {
    if (!block || !window.RelMap || !RelMap.open || !relmapWrapEl) return;
    if (state.current && state.current.perm === 'read') {
      toast('這篇筆記你只有唯讀權限');
      return;
    }
    const all = previewEl.querySelectorAll('.relmap-block');
    const index = Array.prototype.indexOf.call(all, block);
    if (index < 0) return;
    const noteId = state.currentId;
    const dsl = block.getAttribute('data-relmap') || '';
    showRelMapPage();
    let latest = null;
    const view = RelMap.open(dsl, {
      container: relmapWrapEl,
      onChange: function (d) { latest = d; },
      onClose: function () {
        const mine = relmapView === view;
        relmapView = null;
        relmapWrapEl.hidden = true;
        const back = function () { if (mine) openNote(noteId); };
        if (latest === null) { back(); return; }
        // 使用者已經先把同一篇筆記點開了（從側邊欄）：直接改編輯器裡的那個區塊，走一般
        // 的存檔路，不要再從伺服器繞一圈蓋回舊內容。
        if (state.currentId === noteId && !wrapEl.hidden) {
          if (!replaceRelMapBlock(index, latest)) toast('找不到對應的關聯分析區塊，這次的修改沒有寫回');
          return;
        }
        Store.getNote(noteId).then(function (n) {
          const t = n ? replaceFenceInText(n.content || '', 'relmap', index, latest) : null;
          if (t === null) { toast('找不到對應的關聯分析區塊，這次的修改沒有寫回'); back(); return; }
          return Store.updateNote(Object.assign({}, n, { content: t })).then(back);
        }).catch(function (e) { toast('儲存失敗：' + (e && e.message || e)); back(); });
      }
    });
    relmapView = view;
  }
  // 關聯分析是「多一種筆記」（meta.relMap）：整篇筆記就是一張圖，打開就是整頁的畫布
  // 編輯器（跟資安院報告／成效報告一開筆記就是專用編輯器同一個道理），每次改動自動
  // 存檔，「返回」回首頁。標題在頁面頂列直接改。
  function openRelMapNote(note) {
    relmapNoteId = note.id;
    if (!relmapWrapEl) return;
    showRelMapPage();
    setTreeArea(isMine(note) ? (note.area || null) : null);
    LS.set('lastNote', note.id);
    setHash('note/' + note.id);
    function syncState(n) {
      const idx = state.notes.findIndex(function (x) { return x.id === n.id; });
      if (idx >= 0) { state.notes[idx].rev = n.rev; state.notes[idx].updatedAt = n.updatedAt; }
      note.rev = n.rev; note.updatedAt = n.updatedAt;
    }
    // 這一頁有兩個存檔入口——上方的標題欄跟畫布的自動存檔——但**只能有一個寫入路徑**。
    // 原本兩邊各自 `Store.updateNote(Object.assign({}, note, {…}))`，於是：
    //   1. 每個 PUT 都把「整篇筆記」送上去，而改名那一邊手上的 content 是打開這一頁時
    //      那一份（onChange 只有在伺服器回覆之後才把新 DSL 寫回 note）。動過圖之後、
    //      回覆還沒回來就改名，改名那個 PUT 後到，整張圖就倒退回打開時的樣子——在
    //      Cloudflare Tunnel 那種延遲下這個窗口有好幾百毫秒，改個名字就洗掉一整段工作。
    //   2. 兩個 PUT 會同時在路上，先送的後到同樣會蓋回去。
    //   3. 從側邊欄／首頁改名會重建 state.notes，這裡抓著的 note 就成了孤兒，之後每次
    //      自動存檔都把舊標題寫回去。
    // 所以：改動先寫進記憶體（live() 永遠去 state.notes 拿現在那一篇），送出時才把
    // 當下的 title+content 一起帶走，而且同一時間只有一個請求在路上，其餘的併成一次
    // 補送（跟 markdown 編輯器的 _saving/_saveAgain 同一套規則）。
    function live() {
      return state.notes.find(function (x) { return x.id === note.id; }) || note;
    }
    let saving = false, again = false;
    function flushSave() {
      if (saving) { again = true; return; }
      saving = true;
      const n = live();
      Store.updateNote({ id: n.id, title: n.title, content: n.content, folderId: n.folderId, meta: n.meta })
        .then(function (r) { syncState(r); noteSaved(live()); }, function (e) { toast('儲存失敗：' + (e && e.message || e)); })
        .then(function () {
          saving = false;
          if (again) { again = false; flushSave(); }
        });
    }
    function setLocal(patch) {
      const n = live();
      Object.assign(n, patch);
      if (n !== note) Object.assign(note, patch);
      flushSave();
    }
    const view = RelMap.open(note.content || '', {
      container: relmapWrapEl,
      title: note.title === '未命名筆記' ? '' : (note.title || ''),
      onTitle: function (t) {
        setLocal({ title: t || '未命名關聯分析' });
        renderTree();
      },
      onChange: function (dsl) {
        setLocal({ content: '```relmap\n' + dsl + '\n```\n' });
      },
      onClose: function () {
        const mine = relmapView === view;
        relmapView = null;
        relmapWrapEl.hidden = true;
        if (!mine) return;
        LS.set('lastNote', '');
        // 返回：區域裡的關聯分析回到它那個區域的資料夾，不是首頁
        if (isMine(note) && note.area && AREA_INFO[note.area] && AREA_INFO[note.area].wrap && window.AreaBrowser) {
          openArea(note.area, { folderId: note.folderId || null });
        } else showEmpty();
      }
    });
    relmapView = view;
  }

  // 一篇 meta.drawio 的筆記：整頁的繪圖工具（js/drawio.js）。存檔規則跟上面的
  // openRelMapNote 一模一樣，而且理由也一樣——標題欄與自動存檔是兩個入口，只能有一條
  // 寫入路徑、同一時間只有一個請求在路上、每次都從 state.notes 取現在那一篇。那個
  // 「改名把內容洗回舊版」的 bug 不要在這裡再發生一次。
  function openDrawioNote(note) {
    if (!drawioWrapEl || !window.DrawIO) return;
    showDrawioPage();
    setTreeArea(isMine(note) ? (note.area || null) : null);
    LS.set('lastNote', note.id);
    setHash('note/' + note.id);
    function syncState(n) {
      const idx = state.notes.findIndex(function (x) { return x.id === n.id; });
      if (idx >= 0) { state.notes[idx].rev = n.rev; state.notes[idx].updatedAt = n.updatedAt; }
      note.rev = n.rev; note.updatedAt = n.updatedAt;
    }
    function live() {
      return state.notes.find(function (x) { return x.id === note.id; }) || note;
    }
    let saving = null, again = false;
    function flushSave() {
      if (saving) { again = true; return saving; }
      const run = function () {
        const n = live();
        return Store.updateNote({ id: n.id, title: n.title, content: n.content, folderId: n.folderId, meta: n.meta })
          .then(function (r) {
            syncState(r);
            // 別篇筆記嵌了這張圖的話，下次渲染要拿新的
            if (MD.invalidateRelNote) MD.invalidateRelNote(note.id);
            noteSaved(live());
          })
          .then(function () { if (again) { again = false; return run(); } });
      };
      saving = run().then(function () { saving = null; }, function (e) {
        saving = null; again = false;
        toast('儲存失敗：' + (e && e.message || e));
        throw e;
      });
      return saving;
    }
    function setLocal(patch) {
      const n = live();
      Object.assign(n, patch);
      if (n !== note) Object.assign(note, patch);
      return flushSave();
    }
    const readOnly = note.perm === 'read';
    const title = (note.title === '未命名筆記' || note.title === '未命名圖表') ? '' : (note.title || '');
    // 只有讀取權限（別人分享給我看的）：不開編輯器，只顯示那張圖
    const view = readOnly
      ? DrawIO.view(note.content || '', {
        container: drawioWrapEl, title: title,
        banner: '唯讀 — 由 ' + (note.sharedBy || '其他使用者') + ' 分享給你'
      })
      : DrawIO.open(note.content || '', {
        container: drawioWrapEl,
        getTitle: function () { return live().title; },   // 匯出的檔名
        onChange: function (content) { return setLocal({ content: content }); }
      });
    drawioView = view;

    // ---- 最上面那一列：跟一般筆記同一組元件（見 toolBar 宣告處）----
    // 標題邊打邊存（跟筆記一樣停手半秒），走的是上面同一條 setLocal——標題跟圖只能有一個
    // 寫入的人。還沒送出的字記在這裡，不是到時候再去讀輸入框：切到別篇筆記時輸入框會先被
    // 換成那一篇的標題。
    let titleTimer = null, pendingTitle = null;
    function commitTitle() {
      clearTimeout(titleTimer); titleTimer = null;
      if (pendingTitle === null) return;
      const t = pendingTitle.trim();
      pendingTitle = null;
      if ((t || '未命名圖表') === live().title) return;
      setLocal({ title: t || '未命名圖表' }).catch(function () {});
      renderTree();
    }
    toolBar = {
      kind: 'drawio',
      id: note.id,
      readOnly: readOnly,
      note: live,
      titleInput: function (v) {
        if (readOnly) return;
        pendingTitle = v;
        clearTimeout(titleTimer);
        titleTimer = setTimeout(commitTitle, SAVE_DELAY);
      },
      commitTitle: commitTitle,
      history: function () {
        if (!window.Versions) return;
        commitTitle();
        // 版本紀錄要看到現在畫面上這張：先把還沒存的送出去
        view.flush().then(function () {
          if (drawioView !== view) return;
          Versions.openNote(live(), {
            onRestored: function (fresh) {
              const i = state.notes.findIndex(function (n) { return n.id === fresh.id; });
              if (i >= 0) state.notes[i] = Object.assign(state.notes[i], fresh);
              if (MD.invalidateRelNote) MD.invalidateRelNote(fresh.id);
              renderTree();
              // 開著的編輯器裡還是還原前的圖：不存檔直接拆掉，再用還原後的內容重開
              if (drawioView) { const v = drawioView; drawioView = null; v.discard(); }
              openNote(fresh.id);
            }
          });
        });
      },
      // PDF：圖表的內容就是一個 ```drawio 圍欄，照一般筆記的路把它畫出來再交給 PDF
      pdf: function () {
        commitTitle();
        view.flush().then(function () {
          const n = live();
          const box = document.createElement('div');
          box.className = 'markdown-body';
          box.innerHTML = MD.render(n.content || '');
          return PDF.showPreview(n, box, {
            meta: n.meta,
            onMeta: function (meta) {
              if (readOnly) return;
              // 封面欄位存在 meta 裡；不管回來的是什麼，這篇都還是一張圖表
              setLocal({ meta: Object.assign({}, live().meta, meta, { drawio: true }) }).catch(function () {});
            }
          });
        }).catch(function (err) { alert('產生列印預覽失敗：' + (err && err.message || err)); });
      }
    };
    noteBar(true);
    document.getElementById('app').classList.add('tool-open');
    titleEl.placeholder = '未命名圖表';
    titleEl.value = title;
    titleEl.readOnly = readOnly;
    if (shareBtn) shareBtn.hidden = !isMine(note);   // 只有擁有者能分享，跟筆記一樣
    updateNotePath(note);                            // 標題前面的「資料夾 /」，裡面會重量標題寬度
  }

  // ---- Table of contents: beside the preview -----------------------------
  function setTocCollapsed(v) {
    document.querySelectorAll('.pane-preview').forEach(function (pane) {
      pane.classList.toggle('toc-hidden', !!v);
    });
    LS.set('tocCollapsed', v ? '1' : '0');
  }
  function buildPreviewTOC() { buildTOC(tocEl, previewEl, previewScrollEl); }
  function buildTOC(tocEl, contentEl, scrollEl) {
    if (!tocEl || !contentEl) return;
    const pane = tocEl.closest('.pane');
    const heads = contentEl.querySelectorAll('h1, h2, h3');
    tocEl.innerHTML = '';
    if (!heads.length) { if (pane) pane.classList.add('no-toc'); return; }
    if (pane) pane.classList.remove('no-toc');
    const title = document.createElement('div');
    title.className = 'toc-title';
    const label = document.createElement('span');
    label.textContent = '目錄';
    const collapse = document.createElement('button');
    collapse.className = 'toc-collapse';
    collapse.title = '收合目錄';
    collapse.textContent = '«';
    collapse.addEventListener('click', function () { setTocCollapsed(true); });
    title.appendChild(label);
    title.appendChild(collapse);
    tocEl.appendChild(title);
    // 預設只列到最上層（通常是 #）：底下的 ## / ### 收起來，點右邊的箭頭才展開。
    // 展開狀態記在 tocOpen（以上層標題的 id 為鍵，與內文 [toc] 共用），
    // 重新渲染時保留，換筆記時清空。
    function makeLink(h) {
      const a = document.createElement('a');
      a.className = 'toc-' + h.tagName.toLowerCase();
      a.textContent = h.textContent;
      a.href = '#';
      a._target = h;
      a.addEventListener('click', function (e) {
        e.preventDefault();
        const t = tocTargetOf(a);
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return a;
    }
    // 只有從 # 開始的筆記才會只剩 #；若整篇最淺的標題是 ##，就以 ## 為上層。
    let top = 6;
    heads.forEach(function (h) {
      const lv = parseInt(h.tagName.charAt(1), 10);
      if (lv < top) top = lv;
    });
    let group = null;   // 目前的上層群組：{ wrap, kids, twisty }
    heads.forEach(function (h) {
      const lv = parseInt(h.tagName.charAt(1), 10);
      const a = makeLink(h);
      if (lv > top) {
        if (group) group.kids.appendChild(a);
        else tocEl.appendChild(a);        // 前面沒有上層標題可掛，直接列出
        return;
      }
      // 上層標題：一列 = 連結 + 展開箭頭；子項放在下面的 .toc-children
      const key = h.id || h.textContent;   // 與內文 [toc] 用同一組鍵，兩邊同步展開
      const wrap = document.createElement('div');
      wrap.className = 'toc-group' + (tocOpen.has(key) ? ' open' : '');
      const rowEl = document.createElement('div');
      rowEl.className = 'toc-row';
      const tw = document.createElement('button');
      tw.type = 'button';
      tw.className = 'toc-twisty';
      tw.title = '展開／收合子標題';
      tw.innerHTML = Icons.svg('chevron-right');
      tw.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        const open = wrap.classList.toggle('open');
        if (open) tocOpen.add(key); else tocOpen.delete(key);
        updateTocActive();
      });
      rowEl.appendChild(a);
      rowEl.appendChild(tw);
      const kids = document.createElement('div');
      kids.className = 'toc-children';
      wrap.appendChild(rowEl);
      wrap.appendChild(kids);
      tocEl.appendChild(wrap);
      group = { wrap: wrap, kids: kids, twisty: tw };
    });
    // 底下沒有子標題的，不需要箭頭
    tocEl.querySelectorAll('.toc-group').forEach(function (g) {
      if (!g.querySelector('.toc-children a')) { g.classList.add('leaf'); const t = g.querySelector('.toc-twisty'); if (t) t.remove(); }
    });
    updateTocActive();
  }
  // 哪些 ## 段落的子標題是展開的（側邊目錄與內文 [toc] 共用，以標題 id 為鍵）。
  // 換筆記時清空——展開狀態屬於某一篇筆記，不該跟著跑到下一篇。
  const tocOpen = new Set();
  // 內文 [toc] 每次重新渲染都會重建，這裡把展開狀態貼回去
  function restoreInlineTocState() {
    previewEl.querySelectorAll('.md-toc .md-toc-toggle').forEach(function (b) {
      if (tocOpen.has(b.getAttribute('data-toc'))) b.closest('li').classList.add('open');
    });
  }
  function tocTargetOf(a) {
    return a._target && a._target.isConnected ? a._target : null;
  }
  function updateTocActive(nav, scrollEl) {
    if (!nav || !nav.nodeType) {
      updateTocActive(tocEl, previewScrollEl);
      return;
    }
    if (!scrollEl || !scrollEl.offsetParent) return;
    const links = Array.prototype.slice.call(nav.querySelectorAll('a'));
    if (!links.length) return;
    const containerTop = scrollEl.getBoundingClientRect().top;
    let active = links[0];
    links.forEach(function (a) {
      const t = tocTargetOf(a);
      if (t && t.getBoundingClientRect().top - containerTop <= 40) active = a;
    });
    // 目前段落是收合中的 ###：改反白它所屬的 ##
    let shown = active;
    if (active && active.offsetParent === null) {
      const g = active.closest('.toc-group');
      const parent = g && g.querySelector('.toc-row > a');
      if (parent) shown = parent;
    }
    links.forEach(function (a) { a.classList.toggle('active', a === shown); });
  }

  // ---- Live collaboration (Server-Sent Events) --------------------------
  // A note carries two extra fields while open: `_syncRev` / `_syncContent` —
  // the revision and exact text this client last agreed with the server on. They
  // are the common ancestor every merge is measured against.
  let noteStream = null;   // closer fn for the current note's event stream

  // ---- 公開連結的自動更新 -------------------------------------------------
  // 連結上是一頁打包好的 HTML（server/api.js 的 note_links），筆記改了它不會自己變。
  // 有公開連結的筆記（note.publicLink：伺服器在清單與單篇讀取時標的）每次存檔成功之後排一次
  // 重新打包——停手 PUBLISH_DELAY 之後做，切到別篇時馬上做。打包會把每張圖內嵌成 data URL、
  // 整頁送上去，所以不是每個字做一次，是一段編輯做一次。同一篇同時只有一次在跑，跑的時候
  // 又有新存檔就記下來，跑完再來一次（跟存檔的 _saveAgain 同一個規則）。
  const PUBLISH_DELAY = 8000;
  const publishTimers = {};    // noteId -> timer
  const publishing = {};       // noteId -> true | 'again'
  function liveNote(id) {
    if (state.current && state.current.id === id) return state.current;
    return state.notes.find(function (x) { return x.id === id; }) || null;
  }
  function noteSaved(n) {
    if (!n || !n.publicLink || !isMine(n)) return;
    clearTimeout(publishTimers[n.id]);
    publishTimers[n.id] = setTimeout(function () { republish(n.id); }, PUBLISH_DELAY);
  }
  function flushPublish(id) {
    if (!id || !publishTimers[id]) return;
    clearTimeout(publishTimers[id]);
    delete publishTimers[id];
    republish(id);
  }
  function republish(id) {
    delete publishTimers[id];
    if (publishing[id]) { publishing[id] = 'again'; return; }
    const n = liveNote(id);
    if (!n || !window.Book || !Book.renderNoteStandalone) return;
    publishing[id] = true;
    Store.getNoteLinks(id).then(function (links) {
      const alive = links.filter(function (l) { return !l.expired; });
      if (!alive.length) { markPublic(id, false); return; }
      // 只更新「自動更新」開著的連結；關掉的那些停在本人最後一次按「更新內容」的那一版。
      // 一個都沒有就不用打包了（打包會把每張圖內嵌進去，不便宜）
      const auto = alive.filter(function (l) { return l.autoUpdate !== false; });
      if (!auto.length) return;
      const rev = Math.max(n.rev || 0, n._syncRev || 0);
      return Book.renderNoteStandalone(n).then(function (html) {
        let p = Promise.resolve();
        auto.forEach(function (l) {
          p = p.then(function () { return Store.updateNoteLink(l.token, { title: n.title || '未命名筆記', html: html, rev: rev }); });
        });
        return p;
      });
    }).catch(function (e) {
      console.warn('[公開連結] 自動更新失敗：' + (e && e.message || e));
    }).then(function () {
      const again = publishing[id] === 'again';
      delete publishing[id];
      if (again) republish(id);
    });
  }
  // 清單上「有公開連結」的標記跟著對話框裡的動作走，不用等下一次重新載入
  function markPublic(id, on) {
    let changed = false;
    [liveNote(id), state.notes.find(function (x) { return x.id === id; })].forEach(function (n) {
      if (n && !!n.publicLink !== !!on) { n.publicLink = on || undefined; changed = true; }
    });
    if (changed) refreshViews();
  }

  function closeStream() {
    flushPublish(state.currentId);   // 離開這篇：還沒更新到公開連結的改動現在送
    if (noteStream) { noteStream(); noteStream = null; }
    renderPresence([]);
    clearRemoteCarets();
    lastSentPos = -1;
  }

  // Map a caret offset from the pre-merge text onto the merged text. Merge.mapOffset
  // follows the actual changes (by line, then word by word inside a changed line); the
  // prefix/suffix version below it is only a fallback, and it was the whole story until
  // edits both above and below the caret (two other people typing) threw the caret
  // back to the first edit — the next keystrokes then landed in someone else's words.
  function mapCaret(oldV, newV, caret) {
    if (window.Merge && Merge.mapOffset) return Merge.mapOffset(oldV, newV, caret);
    const max = Math.min(oldV.length, newV.length);
    let p = 0;
    while (p < max && oldV[p] === newV[p]) p++;
    if (caret <= p) return caret;
    let s = 0;
    while (s < max - p && oldV[oldV.length - 1 - s] === newV[newV.length - 1 - s]) s++;
    if (caret >= oldV.length - s) return caret + (newV.length - oldV.length);
    return Math.min(newV.length - s, p);
  }

  function applyMergedToEditor(merged) {
    const oldV = editorEl.value;
    if (merged === oldV) return;
    const focused = document.activeElement === editorEl;
    const caret = editorEl.selectionStart, caretEnd = editorEl.selectionEnd;
    const scroll = editorEl.scrollTop;
    editorEl.value = merged;
    shiftRemoteCarets(merged);
    if (multi) multi.remap(oldV, merged);   // 多行編輯的其他游標也跟著搬
    if (focused) {
      // both ends, so a selection someone is about to format survives a merge elsewhere
      const c = mapCaret(oldV, merged, caret);
      const ce = caretEnd === caret ? c : Math.max(c, mapCaret(oldV, merged, caretEnd));
      try { editorEl.setSelectionRange(c, ce); } catch (e) {}
    }
    editorEl.scrollTop = scroll;
    if (editorEl._hlRefresh) editorEl._hlRefresh();
    scheduleCaretRender();
  }

  // Reconcile an authoritative server version (from an SSE push or a save reply)
  // with whatever is in the editor right now. Non-conflicting local edits survive.
  function applyRemoteUpdate(payload) {
    const cur = state.current;
    if (!cur || !payload || payload.rev == null) return;
    if (payload.rev <= (cur._syncRev || 0)) return;    // our own echo, or stale

    const base = cur._syncContent || '';
    const theirs = String(payload.content || '');
    const merged = (window.Merge ? Merge.merge3(base, editorEl.value, theirs) : theirs);

    cur._syncRev = payload.rev;
    cur._syncContent = theirs;          // the server's text is the new ancestor

    if (merged !== editorEl.value) {
      applyMergedToEditor(merged);
      cur.content = merged;
      const idx = state.notes.findIndex(function (n) { return n.id === cur.id; });
      if (idx >= 0) state.notes[idx].content = merged;
      renderPreview();
      updateStatus();
      // If we merged in local edits the server hasn't seen, push them back.
      if (merged !== theirs && cur.perm !== 'read') scheduleSave();
    } else {
      cur.content = merged;
    }

    // Adopt a remote title change unless the user is busy renaming.
    if (payload.title != null && document.activeElement !== titleEl && payload.title !== titleEl.value) {
      titleEl.value = payload.title;
      fitNoteTitle();
      cur.title = payload.title;
      updateTitleInTree();
    }
  }

  // Render the avatars of other people viewing this note (self excluded).
  // How many other people have this note open right now (see scheduleSave).
  let collaborators = 0;
  function renderPresence(users) {
    const me = (window.Auth && Auth.user && Auth.user()) ? Auth.user().username : null;
    const others = (users || []).filter(function (u) { return u !== me; });
    collaborators = others.length;
    if (!presenceEl) return;
    presenceEl.innerHTML = '';
    others.slice(0, 5).forEach(function (u) {
      const dot = document.createElement('span');
      dot.className = 'presence-dot';
      dot.textContent = (u || '?').charAt(0).toUpperCase();
      dot.title = u + '  正在編輯';
      dot.style.background = presenceColor(u);
      presenceEl.appendChild(dot);
    });
    if (others.length > 5) {
      const more = document.createElement('span');
      more.className = 'presence-more';
      more.textContent = '+' + (others.length - 5);
      presenceEl.appendChild(more);
    }
    presenceEl.classList.toggle('has-people', others.length > 0);
  }
  // Stable per-name colour so the same collaborator keeps the same avatar hue.
  function presenceColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return 'hsl(' + h + ', 55%, 45%)';
  }

  // ---- Remote carets -----------------------------------------------------
  // Show every other editor's caret (a coloured line with their name) inside the
  // markdown textarea. Positions are measured with a hidden mirror div that copies
  // the textarea's exact text metrics, then offset by the current scroll.
  const remoteCarets = {};     // username -> { pos, el }
  let caretText = null;        // the text those offsets refer to (see shiftRemoteCarets)
  let caretMirror = null;
  let caretRAF = null;

  function ensureMirror() {
    if (caretMirror || !editorAreaEl) return caretMirror;
    caretMirror = document.createElement('div');
    caretMirror.className = 'caret-mirror';
    caretMirror.setAttribute('aria-hidden', 'true');
    editorAreaEl.appendChild(caretMirror);
    return caretMirror;
  }

  // Copy the metrics that decide where text wraps, so the mirror lays out
  // identically to the textarea. --sbw matches the reserved scrollbar gutter.
  function syncMirrorStyle() {
    if (!caretMirror) return;
    const cs = getComputedStyle(editorEl);
    const sbw = (editorEl.offsetWidth - editorEl.clientWidth) || 0;
    const st = caretMirror.style;
    // Copy longhands (the `font` shorthand reads back empty in most browsers).
    st.fontFamily = cs.fontFamily;
    st.fontSize = cs.fontSize;
    st.fontWeight = cs.fontWeight;
    st.fontStyle = cs.fontStyle;
    st.lineHeight = cs.lineHeight;
    st.letterSpacing = cs.letterSpacing;
    st.tabSize = cs.tabSize;
    st.paddingTop = cs.paddingTop;
    st.paddingBottom = cs.paddingBottom;
    st.paddingLeft = cs.paddingLeft;
    st.paddingRight = (parseFloat(cs.paddingRight) + sbw) + 'px';
  }

  // Pixel position (relative to #editor-area, scroll already applied) of a caret
  // offset in the textarea. Returns null if it cannot be measured.
  function measureCaret(pos) {
    if (!ensureMirror()) return null;
    syncMirrorStyle();
    const v = editorEl.value;
    pos = Math.max(0, Math.min(pos, v.length));
    caretMirror.textContent = v.slice(0, pos);
    const marker = document.createElement('span');
    marker.textContent = '​';
    caretMirror.appendChild(marker);
    const x = marker.offsetLeft;
    const y = marker.offsetTop - editorEl.scrollTop;
    caretMirror.removeChild(marker);
    return { x: x, y: y };
  }

  function caretLineHeight() {
    const lh = parseFloat(getComputedStyle(editorEl).lineHeight);
    return isFinite(lh) ? lh : 24;
  }

  function renderRemoteCarets() {
    caretRAF = null;
    if (wrapEl.hidden) return;               // markdown editor not on screen
    const h = caretLineHeight();
    const areaH = editorAreaEl ? editorAreaEl.clientHeight : 0;
    Object.keys(remoteCarets).forEach(function (name) {
      const rc = remoteCarets[name];
      const p = measureCaret(rc.pos);
      if (!p) { rc.el.style.display = 'none'; return; }
      // Hide when scrolled out of view (with a little slack for the label).
      if (p.y < -h || p.y > areaH + h) { rc.el.style.display = 'none'; return; }
      rc.el.style.display = 'block';
      rc.el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
      rc.el.style.height = h + 'px';
      // Flip the name tag below the caret when it would be clipped at the top.
      rc.el.classList.toggle('label-below', p.y < 18);
    });
  }
  function scheduleCaretRender() {
    if (caretRAF == null) caretRAF = requestAnimationFrame(renderRemoteCarets);
  }

  function onRemoteCursor(payload) {
    if (!payload || !payload.by) return;
    const me = (window.Auth && Auth.user && Auth.user()) ? Auth.user().username : null;
    if (payload.by === me) return;           // never draw my own caret
    let rc = remoteCarets[payload.by];
    if (!rc) {
      const el = document.createElement('div');
      el.className = 'remote-caret';
      el.style.setProperty('--caret-color', presenceColor(payload.by));
      const label = document.createElement('span');
      label.className = 'remote-caret-label';
      label.textContent = payload.by;
      el.appendChild(label);
      if (editorAreaEl) editorAreaEl.appendChild(el);
      rc = remoteCarets[payload.by] = { pos: 0, el: el };
    }
    rc.pos = payload.pos || 0;
    if (caretText == null) caretText = editorEl.value;
    scheduleCaretRender();
  }

  function removeRemoteCaret(name) {
    const rc = remoteCarets[name];
    if (!rc) return;
    if (rc.el && rc.el.parentNode) rc.el.parentNode.removeChild(rc.el);
    delete remoteCarets[name];
  }
  function clearRemoteCarets() {
    Object.keys(remoteCarets).forEach(removeRemoteCaret);
    caretText = null;
  }
  // Remote carets are offsets into MY text. When my text changes — my own typing, or a
  // merge coming in — every caret after the change has to move with the text it sits
  // in. Before this they stayed put by offset: someone parked at the end of line 5
  // slid into line 4 as I typed above them, and stayed wrong until they moved again.
  function shiftRemoteCarets(newV) {
    const oldV = caretText;
    caretText = newV;
    if (oldV == null || oldV === newV) return;
    Object.keys(remoteCarets).forEach(function (name) {
      remoteCarets[name].pos = mapCaret(oldV, newV, remoteCarets[name].pos);
    });
    scheduleCaretRender();
  }
  // Drop carets for anyone who has left (per the presence list).
  function pruneRemoteCarets(users) {
    const me = (window.Auth && Auth.user && Auth.user()) ? Auth.user().username : null;
    const live = {};
    (users || []).forEach(function (u) { if (u !== me) live[u] = true; });
    Object.keys(remoteCarets).forEach(function (name) { if (!live[name]) removeRemoteCaret(name); });
  }

  // Broadcast my own caret, throttled so a burst of keystrokes sends at most ~1/120ms.
  let cursorTimer = null, cursorPending = false, lastSentPos = -1;
  function sendMyCursor() {
    if (!state.current || !noteStream) return;
    const pos = editorEl.selectionStart;
    if (pos === lastSentPos) return;
    lastSentPos = pos;
    if (Store.sendCursor) Store.sendCursor(state.current.id, pos, editorEl.selectionEnd).catch(function () {});
  }
  // Force-send my caret (used when someone joins, so a newcomer sees me even if
  // I'm not currently moving — the caret is transient and otherwise never resent).
  function announceCursor() {
    if (!state.current || !noteStream || !Store.sendCursor) return;
    lastSentPos = -1;
    Store.sendCursor(state.current.id, editorEl.selectionStart, editorEl.selectionEnd).catch(function () {});
  }
  function scheduleSendCursor() {
    if (!noteStream) return;
    if (cursorTimer) { cursorPending = true; return; }
    sendMyCursor();
    cursorTimer = setTimeout(function () {
      cursorTimer = null;
      if (cursorPending) { cursorPending = false; sendMyCursor(); }
    }, 120);
  }

  // Open the live stream for the note now showing in the markdown editor.
  function startStream(note) {
    closeStream();
    if (!note || !Store.openNoteStream) return;
    lastSentPos = -1;
    noteStream = Store.openNoteStream(note.id, {
      onUpdate: function (payload) {
        const cur = state.current;
        if (!cur || cur.id !== note.id) return;
        // Our own save is still out, so merging now would measure from the wrong
        // base — including the echo of that very save, which can arrive before its
        // reply. Keep the newest one; afterSave() applies it once the reply is in.
        if (cur._saving != null) {
          if (!cur._heldRemote || payload.rev > cur._heldRemote.rev) cur._heldRemote = payload;
          return;
        }
        applyRemoteUpdate(payload);
      },
      onPresence: function (users) {
        if (state.current && state.current.id !== note.id) return;
        renderPresence(users);
        pruneRemoteCarets(users);
        // Someone joined/left → re-announce my caret so newcomers see me right away.
        announceCursor();
      },
      onCursor: function (payload) { if (state.current && state.current.id === note.id) onRemoteCursor(payload); }
    });
  }

  let saveTimer = null;
  // 這個 md 編輯器（#note-title + #editor）現在裝的是哪一篇。saveNow() 會把這兩個輸入框
  // 的內容寫進 state.current，所以「state.current 是這一篇」跟「編輯器裡裝的是這一篇」
  // 必須同時成立才能存——資安院報告／成效報告／關聯分析有自己的編輯器，openNote() 走到
  // 它們的分支就直接 return，根本沒碰過 #note-title，裡面留的還是上一篇的標題與內文。
  // 少了這個檢查，任何一次 saveNow（打字排的計時器、goHome()、leaveOtherViews()…）就會
  // 把上一篇的標題和內文蓋到新報告上——使用者回報過：新增的資安院報告，名字變成剛剛
  // 在課程筆記裡看的那篇筆記的名字。
  let editorNoteId = null;
  // Alone, a save half a second after the last keystroke is plenty. With someone else in
  // the note, that half second is also how late they see each word, so it drops to
  // 150 ms — still one save per burst of typing, and still only one in flight at a time
  // (saveNow queues the rest), so the server sees a few small saves a second at most.
  const SAVE_DELAY = 500, SAVE_DELAY_SHARED = 150;
  function scheduleSave() {
    if (state.current && state.current.perm === 'read') return;
    statusSave.textContent = '編輯中…';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, collaborators ? SAVE_DELAY_SHARED : SAVE_DELAY);
  }
  // One save per note at a time. While a PUT is on its way the server may or may
  // not have applied it yet, so `_syncContent` stops being a common ancestor of
  // what a second save would carry and what the server holds. Sending one anyway
  // made the server — and this client, when the first reply came back — merge our
  // own in-flight edit in a second time: click Code, paste a command before that
  // autosave returns (routine over a slow Cloudflare Tunnel), and the block's
  // closing ``` came out twice. A save that finds one in flight is queued instead,
  // and goes out once the reply has moved the base forward.
  function saveNow() {
    const cur = state.current;
    if (!cur || cur.perm === 'read') return;
    if (cur.id !== editorNoteId) return;   // 編輯器裡裝的不是這一篇，見 editorNoteId
    // Record the text on the note even when queuing: if the user switches notes
    // before the reply, the queued save still carries this note's latest text.
    cur.title = titleEl.value || '未命名筆記';
    cur.content = editorEl.value;
    // Keep the in-memory list in step immediately — link resolution, backlinks
    // and search all read from it and must not see a stale copy.
    const idx = state.notes.findIndex(function (n) { return n.id === cur.id; });
    if (idx >= 0) state.notes[idx] = cur;
    if (cur._saving != null) { cur._saveAgain = true; return; }
    sendSave(cur);
  }
  function sendSave(cur) {
    // Tell the server which revision this edit is based on, so it can merge in
    // anyone else's concurrent changes rather than clobbering them.
    cur.baseRev = cur._syncRev || 0;
    cur.baseContent = cur._syncContent || '';
    const sent = cur._saving = cur.content;
    Store.updateNote(cur).then(function (saved) {
      cur._saving = null;
      // The server now holds `sent`, so that — not the older _syncContent — is the
      // common ancestor of the reply and whatever has been typed since it went out.
      cur._syncContent = sent;
      if (state.current === cur) {
        statusSave.textContent = '已儲存 ✓';
        // The reply is authoritative and may carry a merge of someone else's edit.
        applyRemoteUpdate({ rev: saved.rev, content: saved.content, title: saved.title });
        updateTitleInTree();
        updateStatus();
      } else {
        cur._syncRev = saved.rev;
        if (!cur._saveAgain) cur.content = saved.content;
      }
      noteSaved(cur);   // 有公開連結的話，停手之後把新內容更新上去
      afterSave(cur);
    }).catch(function (e) {
      cur._saving = null;
      if (state.current === cur) statusSave.textContent = '⚠ 未儲存：' + (e && e.message || e);
      afterSave(cur);
    });
  }
  function afterSave(cur) {
    // Live updates that arrived while the save was out were held back (see
    // startStream); merge them now, against the base the reply just set.
    const held = cur._heldRemote;
    cur._heldRemote = null;
    if (held && state.current === cur) applyRemoteUpdate(held);
    if (cur._saveAgain) {
      cur._saveAgain = false;
      if (state.current === cur) saveNow(); else sendSave(cur);
    }
  }
  function updateTitleInTree() {
    const row = treeEl.querySelector('.note-row[data-id="' + state.currentId + '"] .label');
    if (row) row.textContent = state.current.title || '未命名筆記';
  }

  function updateStatus() {
    const text = editorEl.value || '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    statusInfo.textContent = text.length + ' 字元 · ' + words + ' 詞';
  }

  // ---- 彩蛋：打字時，標題旁的小水豚會跳舞，停手約 1.4 秒後坐下 ----------
  let capyTimer = null;
  function danceCapybara() {
    const capy = $('#capybara');
    if (!capy) return;
    capy.classList.add('dancing');
    if (capyTimer) clearTimeout(capyTimer);
    capyTimer = setTimeout(function () { capy.classList.remove('dancing'); }, 1400);
  }

  // ---- View modes --------------------------------------------------------
  const MODES = { split: 1, edit: 1, preview: 1 };
  function setMode(mode) {
    if (!MODES[mode]) mode = 'split';
    state.mode = mode;
    LS.set('mode', mode);
    panesEl.classList.remove('mode-split', 'mode-edit', 'mode-preview');
    panesEl.classList.add('mode-' + mode);
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    if (mode === 'preview') renderPreview();
  }

  // ---- Paste files -------------------------------------------------------
  // Any file on the clipboard — a screenshot, a copied PDF or other file — is
  // uploaded and inserted where the caret was at paste time (see insertFiles).
  function handlePaste(e) {
    const items = (e.clipboardData || {}).items;
    if (!items) return;
    const files = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') continue;
      const f = items[i].getAsFile();
      if (f) files.push(f);
    }
    if (!files.length) return;
    e.preventDefault();
    insertFiles(files, { pasted: true });
  }

  // `at` (optional): { s, e, noteId } captured before an async upload, so the
  // insert lands where the user acted, not wherever the caret/note ended up by
  // the time the upload finished. Returns false (and skips the insert) if the
  // note was switched away from in the meantime, rather than splicing the text
  // into whatever note now happens to be open.
  function insertAtCursor(text, at) {
    if (at && at.noteId !== state.currentId) {
      toast('檔案已上傳，但筆記已切換，未插入內容');
      return false;
    }
    const start = at ? at.s : editorEl.selectionStart, end = at ? at.e : editorEl.selectionEnd;
    const v = editorEl.value;
    editorEl.value = v.slice(0, start) + text + v.slice(end);
    const pos = start + text.length;
    editorEl.selectionStart = editorEl.selectionEnd = pos;
    updateStatus();
    return true;
  }

  // ---- Formatting toolbar ------------------------------------------------
  function getSel() {
    return { s: editorEl.selectionStart, e: editorEl.selectionEnd, v: editorEl.value };
  }
  function setRange(newValue, selStart, selEnd) {
    editorEl.value = newValue;
    editorEl.selectionStart = selStart;
    editorEl.selectionEnd = (selEnd == null ? selStart : selEnd);
    editorEl.focus();
    editorEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function insertAround(before, after, placeholder) {
    const g = getSel();
    const sel = g.v.slice(g.s, g.e);
    const mid = sel || placeholder || '';
    const nv = g.v.slice(0, g.s) + before + mid + after + g.v.slice(g.e);
    const start = g.s + before.length;
    setRange(nv, start, start + mid.length);
  }
  function insertBlockAround(before, after, placeholder) {
    const g = getSel();
    const pad0 = (g.s > 0 && g.v[g.s - 1] !== '\n') ? '\n' : '';
    const pad1 = (g.e < g.v.length && g.v[g.e] !== '\n') ? '\n' : '';
    const b = pad0 + before, a = after + pad1;
    const sel = g.v.slice(g.s, g.e);
    const mid = sel || placeholder || '';
    const nv = g.v.slice(0, g.s) + b + mid + a + g.v.slice(g.e);
    const start = g.s + b.length;
    setRange(nv, start, start + mid.length);
  }
  function setLinePrefix(prefix, ordered) {
    const g = getSel();
    const lineStart = g.v.lastIndexOf('\n', g.s - 1) + 1;
    let lineEnd = g.v.indexOf('\n', g.e);
    if (lineEnd < 0) lineEnd = g.v.length;
    const block = g.v.slice(lineStart, lineEnd);
    const newBlock = block.split('\n').map(function (l, i) {
      return (ordered ? (i + 1) + '. ' : prefix) + l;
    }).join('\n');
    const nv = g.v.slice(0, lineStart) + newBlock + g.v.slice(lineEnd);
    // Multi-line: keep the whole block selected so a second click applies to the
    // same lines. Single line: just shift the caret past the prefix. Selecting
    // that one line (the old behaviour) meant the very next key typed replaced it.
    if (block.indexOf('\n') >= 0) { setRange(nv, lineStart, lineStart + newBlock.length); return; }
    const delta = newBlock.length - block.length;
    setRange(nv, g.s + delta, g.e + delta);
  }
  function applyFormat(fmt) {
    switch (fmt) {
      case 'bold': return insertAround('**', '**', '粗體');
      case 'italic': return insertAround('*', '*', '斜體');
      case 'strike': return insertAround('~~', '~~', '刪除線');
      case 'code': return insertAround('`', '`', '程式碼');
      case 'link': return insertAround('[', '](url)', '文字');
      case 'notelink': return insertAround('[[', ']]', '筆記標題');
      case 'image': return insertAround('![', '](url)', '替代文字');
      case 'h1': return setLinePrefix('# ');
      case 'h2': return setLinePrefix('## ');
      case 'h3': return setLinePrefix('### ');
      case 'quote': return setLinePrefix('> ');
      case 'ul': return setLinePrefix('- ');
      case 'task': return setLinePrefix('- [ ] ');
      case 'ol': return setLinePrefix(null, true);
      case 'codeblock': return insertBlockAround('```=\n', '\n```', '');   // = 預設顯示行號
      case 'callout': return insertBlockAround('> [!NOTE]\n> ', '', '內容');
      case 'table':
        if (window.TableTool) return TableTool.showInsertPicker(editorEl, $('#edit-toolbar button[data-fmt="table"]'));
        return insertBlockAround('| 欄位 A | 欄位 B |\n| --- | --- |\n| 內容 | 內容 |', '', '');
      case 'hr': return insertBlockAround('---', '', '');
      case 'template': return showTemplatePicker($('#edit-toolbar button[data-fmt="template"]'));
      case 'file': return pickFiles(editorEl);
    }
  }

  // ---- 插入範本 -----------------------------------------------------------
  // 內建「機器」「AD Set」加上使用者自訂的範本（templates.js）。從工具列的
  // 「範本」鈕選，或在編輯器裡輸入 /機器指令名稱。
  function showTemplatePicker(anchor) {
    if (!window.Templates || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const list = Templates.all();
    const pop = document.createElement('div');
    pop.className = 'tpl-popup';
    pop.innerHTML = '<div class="tpl-popup-head">範本</div>';
    const body = document.createElement('div');
    body.className = 'tpl-popup-list';
    list.forEach(function (t) {
      const row = document.createElement('div');
      row.className = 'tpl-item';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'tpl-pick';
      pick.innerHTML = Icons.svg(t.icon || 'template') +
        '<span class="tpl-name">' + MD.escapeHtml(t.name) + '</span>' +
        (t.cmd ? '<span class="tpl-cmd">/' + MD.escapeHtml(t.cmd) + '</span>' : '');
      pick.addEventListener('click', function () { close(); insertTemplateText(t.text); });
      row.appendChild(pick);
      if (!t.builtin) {
        const ed = document.createElement('button');
        ed.type = 'button'; ed.className = 'tpl-act'; ed.title = '編輯範本';
        ed.innerHTML = Icons.svg('pencil');
        ed.addEventListener('click', function (e) { e.stopPropagation(); close(); showTemplateEditor(t); });
        const rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'tpl-act danger'; rm.title = '刪除範本';
        rm.innerHTML = Icons.svg('trash');
        rm.addEventListener('click', function (e) {
          e.stopPropagation();
          close();
          showConfirm({ title: '刪除範本', message: '確定刪除範本「' + t.name + '」？', ok: '刪除', danger: true })
            .then(function (ok) {
              if (!ok) return;
              Templates.remove(t.id); Templates.syncEditor(); toast('已刪除範本');
            });
        });
        row.appendChild(ed);
        row.appendChild(rm);
      }
      body.appendChild(row);
    });
    pop.appendChild(body);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tpl-add';
    add.innerHTML = Icons.svg('plus') + '<span>新增範本…</span>';
    add.addEventListener('click', function () { close(); showTemplateEditor(null); });
    pop.appendChild(add);

    document.body.appendChild(pop);
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8) + 'px';

    function close() {
      pop.remove();
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function onOutside(e) { if (!pop.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    setTimeout(function () {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  // 新增／編輯自訂範本。tpl 為 null 表示新增；有選取內容時可一鍵帶入。
  function showTemplateEditor(tpl) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal tpl-modal';
    const sel = getSel();
    const picked = sel.v.slice(sel.s, sel.e);
    modal.innerHTML =
      '<div class="modal-title">' + Icons.svg('template') + ' ' + (tpl ? '編輯範本' : '新增範本') + '</div>' +
      '<div class="oscp-hint">範本會出現在工具列的「範本」選單；名稱含英數字時也會自動有一個 <code>/指令</code>。' +
      '在內容裡寫 <code>$CURSOR</code> 可指定插入後游標停的位置。</div>' +
      '<div class="oscp-field"><label>名稱</label><input class="tpl-name-input" type="text" placeholder="例如：Web 應用測試"></div>' +
      '<div class="oscp-field"><label>內容（Markdown）</label>' +
      '<textarea class="tpl-text-input" spellcheck="false" placeholder="## $CURSOR&#10;&#10;### 步驟&#10;"></textarea></div>' +
      '<div class="modal-actions">' +
      (picked ? '<button class="btn tpl-from-sel" type="button">帶入目前選取內容</button>' : '') +
      '<button class="btn modal-cancel" type="button">取消</button>' +
      '<button class="btn btn-primary tpl-save" type="button">儲存</button>' +
      '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const nameEl = modal.querySelector('.tpl-name-input');
    const textEl = modal.querySelector('.tpl-text-input');
    if (tpl) { nameEl.value = tpl.name; textEl.value = tpl.text; }
    const fromSel = modal.querySelector('.tpl-from-sel');
    if (fromSel) fromSel.addEventListener('click', function () { textEl.value = picked; textEl.focus(); });

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    modal.querySelector('.modal-cancel').addEventListener('click', close);
    modal.querySelector('.tpl-save').addEventListener('click', function () {
      const name = nameEl.value.trim();
      if (!name) { nameEl.focus(); return; }
      Templates.save({ id: tpl ? tpl.id : '', name: name, text: textEl.value });
      Templates.syncEditor();
      close();
      toast(tpl ? '已更新範本' : '已新增範本');
    });
    setTimeout(function () { nameEl.focus(); }, 30);
  }

  function insertTemplateText(tpl) {
    if (!tpl) return;
    editorEl.focus();
    const g = getSel();
    const idx = tpl.indexOf('$CURSOR');
    const clean = tpl.replace('$CURSOR', '');
    const pad0 = (g.s > 0 && g.v[g.s - 1] !== '\n') ? '\n' : '';
    const pad1 = (g.e < g.v.length && g.v[g.e] !== '\n') ? '\n' : '';
    const text = pad0 + clean + pad1;
    const nv = g.v.slice(0, g.s) + text + g.v.slice(g.e);
    const cur = g.s + pad0.length + (idx < 0 ? clean.length : idx);
    setRange(nv, cur, cur);
  }

  // ---- Upload files ------------------------------------------------------
  // Every way a file gets into a note — paste, drop, the toolbar's 檔案 button,
  // /file — ends up here. Each file is uploaded and
  // turned into the Markdown that shows it: an image is embedded, a PDF is either
  // embedded or a file link (the last choice made with the 檔案｜預覽 switch),
  // and anything else is a download link.
  function cleanName(name, fallback) {
    return String(name || '').replace(/[\[\]\r\n]/g, '').trim() || fallback;
  }
  function uploadFiles(files, how) {
    const list = Array.prototype.slice.call(files || []);
    const pasted = !!(how && how.pasted);
    return Promise.all(list.map(function (f) {
      const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
      const isImg = !isPdf && (f.type || '').indexOf('image/') === 0;
      return Store.putImage(f, f.name, isPdf ? 'application/pdf' : undefined).then(function (id) {
        if (isImg) {
          // A clipboard screenshot is always called image.png — that says nothing.
          const alt = pasted ? '貼上的圖片' : cleanName(f.name, '圖片').replace(/\.[^.]+$/, '');
          return '![' + alt + '](img:' + id + ')';
        }
        const name = cleanName(f.name, isPdf ? 'PDF' : '附件');
        if (isPdf) {
          return LS.get('pdfDisplay', 'preview') === 'file'
            ? '[' + name + '](pdf:' + id + ')'
            : '![' + name.replace(/\.pdf$/i, '') + '](pdf:' + id + ')';
        }
        return '[' + name + '](file:' + id + ')';
      });
    }));
  }
  // The caret is captured when the files arrive, not when the upload finishes:
  // by then the user may have typed elsewhere or opened another note.
  function insertFiles(files, how) {
    const list = Array.prototype.slice.call(files || []);
    if (!list.length) return false;
    const at = { s: editorEl.selectionStart, e: editorEl.selectionEnd, noteId: state.currentId };
    // 大檔案或慢速上傳時畫面看起來跟卡住一樣，狀態列一定要有字
    statusSave.textContent = list.length > 1 ? '上傳 ' + list.length + ' 個檔案中…' : '上傳檔案中…';
    uploadFiles(list, how).then(function (mds) {
      if (at.noteId === state.currentId) editorEl.focus();
      if (!insertAtCursor('\n' + mds.join('\n') + '\n', at)) return;
      if (editorEl._hlRefresh) editorEl._hlRefresh();
      scheduleSave();
      renderPreviewNow();
    }).catch(function (err) {
      if (at.noteId === state.currentId) statusSave.textContent = '⚠ 上傳失敗：' + (err && err.message || err);
      toast('上傳失敗：' + (err && err.message || err));
    });
    return true;
  }
  // 檔案挑選器。
  function pickFiles() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.addEventListener('change', function () {
      const files = Array.prototype.slice.call(inp.files || []);
      if (!files.length) return;
      insertFiles(files);
    });
    inp.click();
  }
  // 嵌入一張畫過的圖：選一篇筆記，插入 ![標題](<scheme>:<id>)。存的是 id 不是圖的副本，
  // 所以原圖之後改了，引用它的筆記下次渲染就是新的。關聯分析（relmap:）與 drawio
  // （drawio:）共用這一支。
  function pickEmbed(o) {
    const maps = state.notes.filter(function (n) { return o.match(n) && !n.trashed; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    if (!maps.length) { toast(o.none); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML =
      '<div class="modal-title">' + MD.escapeHtml(o.title) + '</div>' +
      '<div class="modal-body"><select class="folder-picker">' +
      maps.map(function (n) {
        return '<option value="' + MD.escapeHtml(n.id) + '">' + MD.escapeHtml(n.title || o.untitled) + '</option>';
      }).join('') +
      '</select></div>' +
      '<div class="modal-actions">' +
      '<button class="btn modal-cancel" type="button">取消</button>' +
      '<button class="btn btn-primary modal-ok" type="button">嵌入</button>' +
      '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const sel = modal.querySelector('.folder-picker');
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    modal.querySelector('.modal-cancel').addEventListener('click', close);
    modal.querySelector('.modal-ok').addEventListener('click', function () {
      const id = sel.value;
      const hit = maps.find(function (n) { return n.id === id; });
      close();
      if (!hit) return;
      const name = cleanName(hit.title, o.name);
      insertAtCursor('\n![' + name + '](' + o.scheme + ':' + id + ')\n',
        { s: editorEl.selectionStart, e: editorEl.selectionEnd, noteId: state.currentId });
      if (editorEl._hlRefresh) editorEl._hlRefresh();
      scheduleSave();
      renderPreviewNow();
    });
    setTimeout(function () { sel.focus(); }, 30);
  }
  function pickRelMapEmbed() {
    pickEmbed({
      scheme: 'relmap', title: '嵌入關聯分析', name: '關聯分析', untitled: '未命名關聯分析',
      none: '還沒有任何關聯分析——側邊欄「新增 → 關聯分析」先畫一張',
      match: function (n) { return window.RelMap && RelMap.isRelNote(n); }
    });
  }
  function pickDrawioEmbed() {
    pickEmbed({
      scheme: 'drawio', title: '嵌入 drawio 圖表', name: '圖表', untitled: '未命名圖表',
      none: '還沒有任何 drawio 圖表——側邊欄「新增 → drawio」先畫一張',
      match: function (n) { return window.DrawIO && DrawIO.isNote(n); }
    });
  }

  // ---- Copy to clipboard (works on file://) ------------------------------
  function copyText(text, btn) {
    function done() {
      const old = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', old === '已複製' ? '複製' : old);
      btn.textContent = '已複製';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = '複製'; btn.classList.remove('copied'); }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.focus(); t.select();
    try { document.execCommand('copy'); } catch (e) {}
    t.remove();
  }

  // ---- Modal confirm dialog ----------------------------------------------
  // Same shape as showConfirm but with a text field. Resolves to the string, or
  // to null if the person cancelled — an empty string is a legitimate answer
  // (it is how a version name gets cleared), so the two cannot be conflated.
  function showPrompt(opts) {
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-title">' + MD.escapeHtml(opts.title || '') + '</div>' +
        (opts.message ? '<div class="modal-body">' + MD.escapeHtml(opts.message) + '</div>' : '') +
        '<input class="modal-input" type="text">' +
        '<div class="modal-actions">' +
        '<button class="btn modal-cancel">' + MD.escapeHtml(opts.cancel || '取消') + '</button>' +
        '<button class="btn btn-primary modal-ok">' + MD.escapeHtml(opts.ok || '確定') + '</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      const field = overlay.querySelector('.modal-input');
      field.value = opts.value || '';
      if (opts.placeholder) field.placeholder = opts.placeholder;
      function close(val) {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        else if (e.key === 'Enter') { e.preventDefault(); close(field.value); }
      }
      overlay.querySelector('.modal-cancel').addEventListener('click', function () { close(null); });
      overlay.querySelector('.modal-ok').addEventListener('click', function () { close(field.value); });
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', onKey, true);
      setTimeout(function () { field.focus(); field.select(); }, 30);
    });
  }

  function showConfirm(opts) {
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const msg = MD.escapeHtml(opts.message || '').replace(/\n/g, '<br>');
      overlay.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-title">' + MD.escapeHtml(opts.title || '確認') + '</div>' +
        '<div class="modal-body">' + msg + '</div>' +
        '<div class="modal-actions">' +
        '<button class="btn modal-cancel">' + MD.escapeHtml(opts.cancel || '取消') + '</button>' +
        '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + ' modal-ok">' +
        MD.escapeHtml(opts.ok || '確定') + '</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      function close(val) {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        else if (e.key === 'Enter') { e.preventDefault(); close(true); }
      }
      overlay.querySelector('.modal-cancel').addEventListener('click', function () { close(false); });
      overlay.querySelector('.modal-ok').addEventListener('click', function () { close(true); });
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', onKey, true);
      setTimeout(function () { overlay.querySelector('.modal-ok').focus(); }, 30);
    });
  }

  // ---- Drag & drop image upload ------------------------------------------
  function hasFiles(e) {
    const t = e.dataTransfer && e.dataTransfer.types;
    return t && Array.prototype.indexOf.call(t, 'Files') >= 0;
  }

  function handleEditorDrop(e) {
    if (!hasFiles(e)) return;      // let internal tree drags fall through
    e.preventDefault();
    e.stopPropagation();
    editorEl.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files && files.length) insertFiles(files);
  }

  // ---- 筆記列動作（儀表板）／連結／提示 -----------------------------------
  // 只改 meta（釘選等）：先抓最新版本再存，避免用記憶體裡較舊的內文蓋掉別人的編輯。
  function patchNoteMeta(id, patch) {
    return Store.getNote(id).then(function (fresh) {
      if (!fresh) throw new Error('找不到筆記');
      fresh.meta = Object.assign({}, fresh.meta || {}, patch);
      fresh.baseRev = fresh.rev;
      fresh.baseContent = fresh.content;
      return Store.updateNote(fresh).then(function (saved) {
        const n = state.notes.find(function (x) { return x.id === id; });
        if (n) { n.meta = fresh.meta; n.rev = saved.rev; n.updatedAt = saved.updatedAt; }
        if (state.current && state.current.id === id) state.current.meta = fresh.meta;
        return saved;
      });
    });
  }
  function pinNote(note, on) {
    patchNoteMeta(note.id, { pinned: !!on })
      .then(function () { refreshViews(); toast(on ? '已釘選到最上面' : '已取消釘選'); })
      .catch(function (e) { toast('儲存失敗：' + (e && e.message || e)); });
  }
  function noteLink(id) { return location.origin + location.pathname + '#note/' + encodeURIComponent(id); }
  function copyNoteLink(note) {
    const url = noteLink(note.id);
    function done() { toast('已複製連結（需登入且有權限的人才能開啟）'); }
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('無法自動複製，連結：' + url); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback);
    else fallback();
  }
  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  // 儀表板筆記列的「⋯」：貼著按鈕右下角打開
  // 「標籤…」：任何種類的筆記都能加標籤（存在 meta.tags，跟內文裡的 #標籤一起算，見 MD.noteTags）。
  // 一個輸入框，空白或逗號分開；寫回去的是 meta（伺服器當成 bookkeeping，不動 rev、不廣播）。
  function parseTags(text) {
    const out = [], seen = {};
    String(text || '').split(/[\s,，、;；]+/).forEach(function (t) {
      t = t.replace(/^#+/, '').trim().slice(0, 40);
      if (!t) return;
      const k = t.toLowerCase();
      if (!seen[k]) { seen[k] = true; out.push(t); }
    });
    return out.slice(0, 20);
  }
  function editTags(note) {
    const live = state.notes.find(function (x) { return x.id === note.id; }) || note;
    const cur = (live.meta && Array.isArray(live.meta.tags)) ? live.meta.tags : [];
    showPrompt({ title: '標籤', placeholder: '例如：OSCP AD 待辦（空白或逗號分開）', value: cur.join(' '), ok: '儲存' }).then(function (v) {
      if (v === null || v === undefined) return;
      const tags = parseTags(v);
      const meta = Object.assign({}, live.meta || {});
      if (tags.length) meta.tags = tags; else delete meta.tags;
      // 正開在編輯器裡的那一篇：內容用畫面上的，不然會把還沒存的字洗掉
      const src = (state.current && state.current.id === live.id) ? state.current : live;
      Store.updateNote({ id: live.id, title: src.title, content: src.content, folderId: src.folderId, meta: meta }).then(function (r) {
        live.meta = meta; live.rev = r.rev; live.updatedAt = r.updatedAt;
        if (state.current && state.current.id === live.id) state.current.meta = meta;
        if (live !== note) note.meta = meta;
        refreshViews();
        toast(tags.length ? '標籤：' + tags.map(function (t) { return '#' + t; }).join(' ') : '已清除標籤');
      }, function (e) { toast('儲存失敗：' + (e && e.message || e)); });
    });
  }
  function showNoteMenu(note, anchor) {
    const r = anchor.getBoundingClientRect();
    const actions = [];
    if (isMine(note)) actions.push({ icon: 'tag', label: '標籤…', fn: function () { editTags(note); } });
    // 小說不能分享（伺服器也擋），連結給別人也打不開
    if (note.area !== 'novel') {
      actions.push({ icon: 'link', label: '複製連結', fn: function () { copyNoteLink(note); } });
      actions.push({ icon: 'users', label: '分享…', fn: function () { showShareDialog(note); } });
    }
    actions.push({ icon: 'copy', label: '複製筆記', fn: function () { duplicateNote(note); } });
    // 首頁靠拖放把筆記搬進資料夾；區域頁沒有拖放，改由這裡搬
    if (note.area && note.area !== 'quick') {
      actions.push({ icon: 'folder-open', label: '移動到…', fn: function () { moveNoteInArea(note); } });
    }
    if (MOVABLE_AREAS.indexOf(note.area || null) >= 0) {
      actions.push({ icon: 'layout-grid', label: '換區域…', fn: function () { moveNoteToArea(note, r.right, r.bottom + 4); } });
    }
    actions.push({ icon: 'trash', label: '移至垃圾桶', fn: function () { deleteNote(note); }, danger: true });
    openMenuAt(r.right, r.bottom + 4, actions, { alignRight: true });
  }

  // 所有筆記／課程筆記／知識區 之間搬一篇筆記——novel／quick 兩邊都不給碰
  // （伺服器那邊也會擋，這裡先不讓選單長出這個選項）。開一個小選單選目標區域，
  // 選了再跳資料夾選擇（沿用既有的 showFolderPicker，已支援 o.folders 覆寫）。
  const MOVABLE_AREAS = [null, 'course', 'knowledge'];
  function areaLabel(a) { return a === 'course' ? '課程筆記' : a === 'knowledge' ? '知識區' : '所有筆記'; }
  function moveNoteToArea(note, x, y) {
    const cur = note.area || null;
    const items = [
      { key: null, label: '所有筆記', icon: 'layout-grid' },
      { key: 'course', label: '課程筆記', icon: 'award' },
      { key: 'knowledge', label: '知識區', icon: 'book-open' }
    ].map(function (o) {
      return {
        icon: o.key === cur ? 'check' : o.icon, current: o.key === cur, label: o.label,
        fn: function () { if (o.key !== cur) doMoveNoteArea(note, o.key); }
      };
    });
    openMenuAt(x, y, items);
  }
  function doMoveNoteArea(note, targetArea) {
    const folders = targetArea === null
      ? state.folders.filter(function (f) { return !f.area; })
      : areaFolders(targetArea);
    showFolderPicker('搬到「' + areaLabel(targetArea) + '」的哪個資料夾？', { folders: folders, ok: '搬移' }).then(function (r) {
      if (!r) return;
      Store.moveNoteArea(note.id, targetArea, r.folderId).then(function (n) {
        const idx = state.notes.findIndex(function (x) { return x.id === n.id; });
        if (idx >= 0) { state.notes[idx].area = n.area; state.notes[idx].folderId = n.folderId; state.notes[idx].position = n.position; }
        if (state.current && state.current.id === n.id) { state.current.area = n.area; state.current.folderId = n.folderId; }
        refreshViews();
        toast('已搬到「' + areaLabel(targetArea) + '」');
      }, function (e) { toast('搬移失敗：' + (e && e.message || e)); });
    });
  }
  // 資料夾方框右上的「⋮」
  function showFolderMenu(folder, anchor) {
    const r = anchor.getBoundingClientRect();
    const actions = [];
    // 電子書是首頁那一區的功能（folders.is_book 會把資料夾列進首頁的「電子書」），區域的資料夾不給
    if (!folder.area || folder.area === 'knowledge') actions.push({ icon: 'book-open', label: '以電子書閱讀', fn: function () { openBook(folder.id); } });
    actions.push({ icon: 'file-plus', label: '在此新增筆記', fn: function () { newNote(folder.id); } });
    actions.push({ icon: 'folder-plus', label: '在此新增子資料夾', fn: function () { newFolder(folder.id); } });
    actions.push({ icon: 'pencil', label: '重新命名', fn: function () { startFolderRename(folder); } });
    // 首頁靠拖放搬資料夾；區域頁沒有拖放，改由這裡搬
    if (folder.area) actions.push({ icon: 'folder-open', label: '移動到…', fn: function () { moveFolderInArea(folder); } });
    actions.push({ icon: 'trash', label: '刪除資料夾', fn: function () { deleteFolder(folder); }, danger: true });
    openMenuAt(r.right, r.bottom + 4, actions, { alignRight: true });
  }
  // 儀表板方框上就地改名（找不到方框就退回側邊欄的樹狀改名）
  function startFolderRename(folder) {
    if (folder.area && window.AreaBrowser && AreaBrowser.renameFolderTile && AreaBrowser.renameFolderTile(folder.id)) return;
    const tile = document.querySelector('#dashboard .dash-folder-tile[data-id="' + folder.id + '"]');
    if (tile && window.Dashboard && Dashboard.renameFolderTile) Dashboard.renameFolderTile(folder.id);
    else { setSidebarOpen(true); startRename('folder', folder.id); }
  }
  function renameFolderTo(folder, val) {
    const f = state.folders.find(function (x) { return x.id === folder.id; });
    if (!f || !val || val === f.name) return;
    f.name = val;
    Store.updateFolder(f)
      .then(function () { refreshViews(); })
      .catch(function (e) { toast('改名失敗：' + (e && e.message || e)); refreshViews(); });
  }
  // 電子書：從「新增 → 電子書」挑一個資料夾做成電子書；開過一次它就會留在
  // 首頁最上層的「電子書」區（folders.is_book），直到用方塊上的 ✕ 移出。
  function pickBookFolder() {
    if (!state.folders.length) { toast('先建立一個資料夾並放入筆記，再把它做成電子書'); return; }
    showFolderPicker('選擇要做成電子書的資料夾', { ok: '開啟', noRoot: true, folders: state.folders.filter(function (f) { return !f.area || f.area === 'knowledge'; }) }).then(function (res) {
      if (res && res.folderId) openBook(res.folderId);
    });
  }
  function unmarkBook(folderId) {
    const f = state.folders.find(function (x) { return x.id === folderId; });
    if (!f || !f.isBook) return;
    f.isBook = false;
    refreshViews();
    Store.updateFolder(f).catch(function (e) {
      f.isBook = true;
      toast('移出電子書區失敗：' + (e && e.message || e));
      refreshViews();
    });
  }
  // 網址 hash：#note/<id>、#book/<folderId>——「複製連結」貼給別人就能直接開到那一篇。
  // #folder/<id> 是首頁正在看的資料夾：點進資料夾也留一筆瀏覽紀錄，「上一頁」才會退回
  // 「所有筆記」，而不是跳到再之前開的筆記或別的網站。
  function folderIdFromHash() {
    const m = location.hash.match(/^#folder\/([^\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function noteIdFromHash() {
    const m = location.hash.match(/^#note\/([^\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  // #tag/<標籤>：首頁依標籤篩選（中鍵點 #標籤 開新分頁用的；篩選本身不會改網址）
  function tagFromHash() {
    const m = location.hash.match(/^#tag\/([^\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function bookIdFromHash() {
    const m = location.hash.match(/^#book\/([^\/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setHash(h) {
    const want = h ? '#' + h : '';
    if (location.hash === want) return;
    // pushState（不是 replaceState）：首頁／筆記／電子書要各自留一筆瀏覽紀錄，
    // 這樣瀏覽器的「上一頁」才能一路退回首頁，而不是直接跳出整個 App。
    try { history.pushState(null, '', location.pathname + location.search + want); } catch (e) { /* ignore */ }
  }

  // ---- Context menu ------------------------------------------------------
  function showCtx(e, type, item) {
    e.preventDefault();
    e.stopPropagation();
    const actions = [];
    if (type === 'folder') {
      if (!item.area || item.area === 'knowledge') actions.push({ icon: 'book-open', label: '以電子書閱讀', fn: function () { openBook(item.id); } });
      actions.push({ icon: 'file-plus', label: '在此新增筆記', fn: function () { newNote(item.id); } });
      actions.push({ icon: 'folder-plus', label: '在此新增子資料夾', fn: function () { newFolder(item.id); } });
      actions.push({ icon: 'pencil', label: '重新命名', fn: function () { renameFolder(item); } });
      actions.push({ icon: 'trash', label: '刪除資料夾', fn: function () { deleteFolder(item); }, danger: true });
    } else if (item.perm && item.perm !== 'owner') {
      // Shared with me: I can copy it into my own space, or drop it. Renaming or
      // deleting someone else's note is not mine to do.
      actions.push({ icon: 'link', label: '複製連結', fn: function () { copyNoteLink(item); } });
      actions.push({ icon: 'copy', label: '複製到我的筆記', fn: function () { duplicateNote(item); } });
      // 透過「此站台所有使用者」看到的筆記沒有分享列可移除
      if (!item.viaSite) actions.push({ icon: 'x', label: '移除這個分享', fn: function () { leaveShare(item); }, danger: true });
    } else {
      actions.push({ icon: 'link', label: '複製連結', fn: function () { copyNoteLink(item); } });
      actions.push({ icon: 'users', label: '分享…', fn: function () { showShareDialog(item); } });
      actions.push({ icon: 'pencil', label: '重新命名', fn: function () { renameNote(item); } });
      actions.push({ icon: 'tag', label: '標籤…', fn: function () { editTags(item); } });
      actions.push({ icon: 'copy', label: '複製', fn: function () { duplicateNote(item); } });
      if (MOVABLE_AREAS.indexOf(item.area || null) >= 0) {
        actions.push({ icon: 'layout-grid', label: '換區域…', fn: function () { moveNoteToArea(item, e.clientX, e.clientY); } });
      }
      actions.push({ icon: 'trash', label: '移至垃圾桶', fn: function () { deleteNote(item); }, danger: true });
    }
    openMenuAt(e.clientX, e.clientY, actions);
  }
  // 在指定座標打開一份動作選單（右鍵選單與儀表板筆記列的「⋯」共用）
  function openMenuAt(x, y, actions, o) {
    ctxMenu.innerHTML = '';
    actions.forEach(function (a) {
      const b = document.createElement('button');
      b.className = 'ctx-item' + (a.danger ? ' danger' : '') + (a.current ? ' is-current' : '');
      // icon: '' keeps the label aligned with siblings that do have an icon (a check mark)
      const lead = a.icon ? Icons.svg(a.icon) : (a.icon === '' ? '<span class="ctx-spacer"></span>' : '');
      b.innerHTML = lead + '<span>' + MD.escapeHtml(a.label) + '</span>';
      // stopPropagation: an item's fn can itself open another menu (e.g. 換區域…
      // opens a second openMenuAt) — without this the same click's bubble to
      // document's hideCtx below closes that new menu in the same tick.
      b.addEventListener('click', function (e) { e.stopPropagation(); hideCtx(); a.fn(); });
      ctxMenu.appendChild(b);
    });
    ctxMenu.hidden = false;
    let left = (o && o.alignRight) ? x - ctxMenu.offsetWidth : x;
    left = Math.max(8, Math.min(left, window.innerWidth - ctxMenu.offsetWidth - 8));
    const top = Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 10);
    ctxMenu.style.left = left + 'px';
    ctxMenu.style.top = top + 'px';
  }
  function hideCtx() { ctxMenu.hidden = true; }

  // 排序方式選單（側邊欄的排序鈕、首頁清單右上角共用）
  function showSortMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const now = Sorting.mode();
    openMenuAt(r.right, r.bottom + 4, Sorting.MODES.map(function (m) {
      return {
        icon: m.key === now ? 'check' : '', current: m.key === now, label: m.label,
        fn: function () { Sorting.set(m.key); }
      };
    }), { alignRight: true });
  }
  function updateSortBtn() {
    const b = $('#sort-btn');
    if (!b) return;
    b.classList.toggle('is-auto', Sorting.mode() !== 'manual');
    b.title = '排序方式：' + Sorting.info().label + (Sorting.mode() === 'manual' ? '（可直接拖拉調整）' : '');
  }
  document.addEventListener('click', hideCtx);
  document.addEventListener('scroll', hideCtx, true);

  // ---- Sharing -----------------------------------------------------------
  // 共用對話框（Google Drive 式）：
  //   1. 新增使用者 + 角色（檢視者／編輯者）
  //   2. 「具有存取權的使用者」：擁有者一列（固定），其他人可就地改角色或移除存取權
  //   3. 「一般存取權」：限制（預設）或網站內所有人（可再選可以檢視／可以編輯）
  //   4. 複製連結（開啟仍需登入且有權限）
  // 沒有「知道連結的任何人」——這台伺服器上放的是考試報告，不開匿名存取。
  //
  // 同一個對話框也負責「一次套用到很多篇」：showShareDialog(note) 是單篇（批次只是
  // 底下多一個勾選框，把同樣的一般存取權順便套到選取的其他幾篇），showShareDialog(null, ids)
  // 則是批次列的「共用」鈕開的純批次模式——指定使用者與複製連結對一堆筆記沒有意義，
  // 那兩塊在批次模式下不出現，其餘完全同一份程式與同一份樣式。
  let shareSeq = 0;
  // 一般存取權從一個下拉選單改成兩列明白寫著的選項：下拉只有拉開才看得到「還有另一種」，
  // 而這裡最重要的資訊是「現在到底是誰看得到」。
  function generalAccessHTML(name) {
    return '<div class="share-general">' +
      '<div class="share-opt-row">' +
        '<label class="share-opt">' +
          '<input type="radio" name="' + name + '" value="restricted">' +
          '<span class="share-opt-ic">' + Icons.svg('lock') + '</span>' +
          '<span class="share-opt-body">' +
            '<span class="share-opt-title">限制</span>' +
            '<span class="share-opt-desc">只有我和我指定的人可以開啟。</span>' +
          '</span>' +
        '</label>' +
      '</div>' +
      '<div class="share-opt-row">' +
        '<label class="share-opt">' +
          '<input type="radio" name="' + name + '" value="site">' +
          '<span class="share-opt-ic">' + Icons.svg('globe') + '</span>' +
          '<span class="share-opt-body">' +
            '<span class="share-opt-title">網站內所有人</span>' +
            '<span class="share-opt-desc share-site-desc">這個網站上任何登入的人都能開啟。</span>' +
          '</span>' +
        '</label>' +
        '<select class="share-access-perm" title="網站內所有人的權限">' +
          '<option value="read">可以檢視</option><option value="edit">可以編輯</option>' +
        '</select>' +
      '</div>' +
      '</div>';
  }
  // 選取中、我自己的、還能改存取權的筆記（小說怎麼樣都不開放，伺服器也會擋）
  function shareableSelection(exceptId) {
    return Array.from(selected)
      .map(function (id) { return state.notes.find(function (x) { return x.id === id; }); })
      .filter(function (n) { return n && n.id !== exceptId && isMine(n) && n.area !== 'novel'; });
  }
  function showShareDialog(note, batchNotes) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal share-modal';
    const me = (Auth.user && Auth.user()) ? Auth.user().username : '';
    const single = !!note;
    // 單篇：其他也被勾選的筆記是「順便一起套用」的對象；批次：那份清單就是全部對象。
    const extras = single ? shareableSelection(note.id) : (batchNotes || []);
    const radioName = 'share-access-' + (++shareSeq);
    modal.innerHTML =
      '<div class="modal-title">' + Icons.svg('users') + ' ' +
        (single ? '共用「' + MD.escapeHtml(note.title || '未命名筆記') + '」' : '共用 ' + extras.length + ' 篇筆記') +
      '</div>' +
      (single ?
        '<div class="share-add">' +
        '<input class="share-user" type="text" placeholder="新增使用者（輸入帳號）" autocomplete="off" spellcheck="false">' +
        '<select class="share-perm" title="角色">' +
        '<option value="read">檢視者</option><option value="edit">編輯者</option>' +
        '</select>' +
        '<button class="btn btn-primary share-add-btn" type="button">' + Icons.svg('user-plus') + '<span>新增</span></button>' +
        '</div>' : '') +
      '<div class="share-error" hidden></div>' +
      (single ?
        '<div class="share-section-title">具有存取權的使用者</div>' +
        '<div class="share-people"></div>' : '') +
      '<div class="share-section-title">一般存取權</div>' +
      generalAccessHTML(radioName) +
      '<div class="share-mixed" hidden></div>' +
      // 沒有帳號的人：公開連結（小說區的筆記沒有這一段——它連站內都不能分享）
      (single && isMine(note) && note.area !== 'novel' ?
        '<div class="share-section-title">公開連結（沒有帳號也能看）</div>' +
        '<div class="share-public">' +
        '<div class="share-public-text"><span class="share-public-ic">' + Icons.svg('link') + '</span><span class="share-public-msg">讀取中…</span></div>' +
        '<button class="btn share-public-btn" type="button">' + Icons.svg('external-link') + '<span>管理公開連結…</span></button>' +
        '</div>' : '') +
      (single && extras.length ?
        '<label class="share-batch">' +
        '<input type="checkbox" class="share-batch-cb">' +
        '<span>同時套用到選取的其他 ' + extras.length + ' 篇筆記</span>' +
        '</label>' : '') +
      (!single ? '<div class="share-batch-list"></div>' : '') +
      '<div class="share-footer">' +
        (single ? '<button class="btn share-link-btn" type="button">' + Icons.svg('link') + '<span>複製連結</span></button>' : '<span></span>') +
        '<button class="btn btn-primary modal-cancel" type="button">完成</button>' +
      '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const peopleEl = modal.querySelector('.share-people');
    const errEl = modal.querySelector('.share-error');
    const userEl = modal.querySelector('.share-user');
    const permEl = modal.querySelector('.share-perm');
    const accessPermEl = modal.querySelector('.share-access-perm');
    const generalEl = modal.querySelector('.share-general');
    const siteDescEl = modal.querySelector('.share-site-desc');
    const mixedEl = modal.querySelector('.share-mixed');
    const batchCb = modal.querySelector('.share-batch-cb');
    const radios = Array.prototype.slice.call(modal.querySelectorAll('input[name="' + radioName + '"]'));

    if (!single) {
      const listEl = modal.querySelector('.share-batch-list');
      extras.slice(0, 8).forEach(function (n) {
        const row = document.createElement('div');
        row.className = 'share-batch-item';
        row.textContent = n.title || '未命名筆記';
        listEl.appendChild(row);
      });
      if (extras.length > 8) {
        const more = document.createElement('div');
        more.className = 'share-batch-item is-more';
        more.textContent = '…還有 ' + (extras.length - 8) + ' 篇';
        listEl.appendChild(more);
      }
    }

    function err(msg) { errEl.textContent = msg || ''; errEl.hidden = !msg; }
    function avatar(name) {
      const s = document.createElement('span');
      s.className = 'share-avatar';
      s.textContent = String(name || '?').charAt(0).toUpperCase();
      let h = 0;
      for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) % 360;
      s.style.background = 'hsl(' + h + ', 55%, 45%)';
      return s;
    }
    function personRow(name, right, sub) {
      const row = document.createElement('div');
      row.className = 'share-person';
      row.appendChild(avatar(name));
      const label = document.createElement('span');
      label.className = 'share-person-name';
      label.textContent = name;
      if (sub) { const sm = document.createElement('small'); sm.textContent = sub; label.appendChild(sm); }
      row.appendChild(label);
      row.appendChild(right);
      return row;
    }

    // 目前的一般存取權。批次時全部一致才顯示成某一個選項，不一致就兩個都不勾（並說明
    // 「目前設定不一致」）——硬選一個顯示等於騙人，使用者會以為按了「完成」就沒事了。
    function targets() {
      if (!single) return extras;
      return batchCb && batchCb.checked ? [note].concat(extras) : [note];
    }
    function currentAccess() {
      const list = single ? [note] : extras;
      if (!list.length) return { mode: '', perm: 'edit' };
      const modes = {}, perms = {};
      list.forEach(function (n) {
        modes[(n.access || 'restricted') === 'site' ? 'site' : 'restricted'] = 1;
        perms[n.accessPerm === 'edit' ? 'edit' : 'read'] = 1;
      });
      const mk = Object.keys(modes), pk = Object.keys(perms);
      return { mode: mk.length === 1 ? mk[0] : '', perm: pk.length === 1 ? pk[0] : 'edit' };
    }
    function paintGeneral() {
      const cur = currentAccess();
      const site = cur.mode === 'site';
      radios.forEach(function (r) { r.checked = r.value === cur.mode; });
      accessPermEl.value = cur.perm === 'edit' ? 'edit' : 'read';
      accessPermEl.disabled = !site;
      generalEl.classList.toggle('site', site);
      const what = single ? '這篇筆記' : '這些筆記';
      siteDescEl.textContent = site
        ? '這個網站上任何登入的人都能' + (cur.perm === 'edit' ? '編輯' : '檢視') + what + '。'
        : '這個網站上任何登入的人都能開啟' + what + '。';
      mixedEl.hidden = !!cur.mode;
      mixedEl.textContent = cur.mode ? '' : '選取的筆記目前設定不一致，選一個就會全部套用。';
    }
    // 一篇一篇送：伺服器每次都是一個交易，而且失敗的只算數量、不中斷後面——一篇沒成功
    // 不該讓另外九篇停在半路，哪幾篇沒成功後面會說。
    function applyAccess(list, mode, perm) {
      let failed = 0;
      return list.reduce(function (p, n) {
        return p.then(function () {
          return Store.setAccess(n.id, mode, perm).then(function (r) {
            n.access = r.access; n.accessPerm = r.accessPerm;
            const s = state.notes.find(function (x) { return x.id === n.id; });
            if (s && s !== n) { s.access = r.access; s.accessPerm = r.accessPerm; }
          }).catch(function () { failed++; });
        });
      }, Promise.resolve()).then(function () { return failed; });
    }
    let saving = false;
    function setBusy(v) {
      saving = v;
      radios.forEach(function (r) { r.disabled = v; });
      accessPermEl.disabled = v || currentAccess().mode !== 'site';
      if (batchCb) batchCb.disabled = v;
    }
    function saveAccess(mode, perm) {
      if (saving) return;
      err('');
      const list = targets();
      if (!list.length) return;
      setBusy(true);
      applyAccess(list, mode, perm).then(function (failed) {
        setBusy(false);
        paintGeneral();
        if (failed) err(failed + ' 篇沒有套用成功（可能不是你的筆記，或是小說區的筆記）。');
        else if (list.length > 1) toast('已套用到 ' + list.length + ' 篇筆記');
        refreshViews();
      });
    }
    radios.forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        // 從「限制」切到「網站內所有人」預設給「可以編輯」：共用出去就是要一起弄，
        // 想改成唯讀旁邊那個下拉隨時可以換。已經是 site 的則沿用它原本的權限。
        if (r.value === 'site' && currentAccess().mode !== 'site') accessPermEl.value = 'edit';
        saveAccess(r.value, accessPermEl.value);
      });
    });
    accessPermEl.addEventListener('change', function () { saveAccess('site', accessPermEl.value); });
    if (batchCb) {
      // 勾起來就馬上把現在這篇的設定套過去（不是等按「完成」——這個對話框沒有「儲存」，
      // 每一個動作都是立即生效，勾選框自己也該照這個規則）。
      batchCb.addEventListener('change', function () {
        if (!batchCb.checked) return;
        const cur = currentAccess();
        if (!cur.mode) return;
        saveAccess(cur.mode, accessPermEl.value);
      });
    }

    function refresh() {
      if (!single) return;     // 批次模式沒有「指定使用者」那一段
      Store.getShares(note.id).then(function (shares) {
        peopleEl.innerHTML = '';
        const ownerTag = document.createElement('span');
        ownerTag.className = 'share-role';
        ownerTag.textContent = '擁有者';
        peopleEl.appendChild(personRow(me, ownerTag, '（你）'));
        shares.forEach(function (s) {
          // 角色下拉：檢視者／編輯者／移除存取權，變更即時套用
          const sel = document.createElement('select');
          sel.className = 'share-role-select';
          sel.innerHTML = '<option value="read">檢視者</option><option value="edit">編輯者</option>' +
            '<option disabled>──────</option><option value="remove">移除存取權</option>';
          sel.value = s.perm === 'edit' ? 'edit' : 'read';
          sel.addEventListener('change', function () {
            err('');
            sel.disabled = true;
            const p = sel.value === 'remove'
              ? Store.removeShare(note.id, s.username)
              : Store.addShare(note.id, s.username, sel.value);
            p.then(refresh).catch(function (e) { err(e.message); refresh(); });
          });
          peopleEl.appendChild(personRow(s.username, sel));
        });
      }).catch(function (e) { err(e.message); });
    }

    function add() {
      const u = userEl.value.trim();
      if (!u) return;
      err('');
      Store.addShare(note.id, u, permEl.value).then(function () {
        userEl.value = '';
        refresh();
      }).catch(function (e) { err(e.message); });
    }
    if (single) {
      modal.querySelector('.share-add-btn').addEventListener('click', add);
      userEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); add(); }
        e.stopPropagation();
      });
      modal.querySelector('.share-link-btn').addEventListener('click', function () { copyNoteLink(note); });
    }
    // ---- 公開連結 ----
    const pubMsg = modal.querySelector('.share-public-msg');
    const pubBtn = modal.querySelector('.share-public-btn');
    function paintPublic() {
      if (!pubMsg) return;
      Store.getNoteLinks(note.id).then(function (links) {
        const alive = links.filter(function (l) { return !l.expired; });
        markPublic(note.id, alive.length > 0);
        if (!alive.length) { pubMsg.textContent = '目前沒有公開連結。建立一個之後，任何拿到網址的人不用帳號就能讀這篇筆記（唯讀）。'; return; }
        // 不自動更新的連結停在舊內容是本人要的，不算「落後」；會自動更新的落後了才要提醒
        const manual = alive.filter(function (l) { return l.autoUpdate === false; }).length;
        const stale = alive.some(function (l) { return l.stale && l.autoUpdate !== false; });
        pubMsg.textContent = '有 ' + alive.length + ' 個公開連結，任何拿到網址的人都看得到這篇筆記。' +
          (manual ? (manual === alive.length ? '都不自動更新（停在你最後一次更新的內容）。' : '其中 ' + manual + ' 個不自動更新。') : '') +
          (stale ? '筆記在那之後改過，連結上還是舊的內容。' : '');
        modal.querySelector('.share-public').classList.toggle('is-stale', stale);
      }).catch(function (e) { pubMsg.textContent = '公開連結讀取失敗：' + (e && e.message || e); });
    }
    if (pubBtn) pubBtn.addEventListener('click', function () {
      if (!window.Versions || !Versions.openNoteLinks) return;
      Versions.openNoteLinks(note, {
        // 打包用手上最新的那一份：編輯器裡剛打的字先存下去
        note: function () {
          if (state.current && state.current.id === note.id) saveNow();
          return liveNote(note.id) || note;
        },
        onChange: paintPublic
      });
    });
    paintPublic();

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    modal.querySelector('.modal-cancel').addEventListener('click', close);
    setTimeout(function () { if (userEl) userEl.focus(); }, 30);
    paintGeneral();
    refresh();
  }
  // 批次列的「共用」：一次把一般存取權套到所有勾起來的筆記
  function batchShare() {
    const notes = shareableSelection(null);
    if (!notes.length) { toast('選取的項目裡沒有可以共用的筆記'); return; }
    showShareDialog(null, notes);
  }

  // Removing myself from a share is done by the owner's endpoint — I can only ask
  // the server to drop my own row, which it allows because it is my share.
  function leaveShare(note) {
    showConfirm({
      title: '移除分享',
      message: '把「' + (note.title || '未命名筆記') + '」從你的清單移除？\n這不會刪除原始筆記，擁有者仍保有它。',
      ok: '移除', danger: true
    }).then(function (ok) {
      if (!ok) return;
      Store.removeShare(note.id, Auth.user().username).then(function () {
        state.notes = state.notes.filter(function (n) { return n.id !== note.id; });
        if (state.currentId === note.id) showEmpty();
        refreshViews();
      }).catch(function (e) { alert('移除失敗：' + e.message); });
    });
  }

  // ---- CRUD actions ------------------------------------------------------
  // 「目前打開的資料夾」：儀表板正瀏覽到的資料夾，或閱讀器裡那本書的資料夾。
  // 新增 → 筆記／證照範本／資安院報告／成效報告 都預設放進這裡，而不是丟到最上層；
  // 電子書不在此列（它本來就自己挑資料夾）。沒有打開資料夾時回 null = 最上層。
  function currentFolderId() {
    if (treeArea && treeArea !== 'quick' && AREA_INFO[treeArea] && AREA_INFO[treeArea].wrap && !AREA_INFO[treeArea].wrap.hidden &&
        window.AreaBrowser && AreaBrowser.currentFolder) {
      return AreaBrowser.currentFolder() || null;
    }
    if (emptyEl && !emptyEl.hidden && window.Dashboard && Dashboard.currentFolder) {
      return Dashboard.currentFolder() || null;
    }
    if (bookWrapEl && !bookWrapEl.hidden && window.Book && Book.current) {
      const b = Book.current();
      return (b && b.folder && b.folder.id) || null;
    }
    return null;
  }
  // 建立類的請求還在路上時不再送第二個。從外網經 Cloudflare Tunnel 連線時回應偶爾要等上
  // 好幾秒甚至半分鐘；畫面沒反應就會一直按，回應一到就一次冒出一堆資料夾／筆記。
  const creating = {};
  function createOnce(kind, make) {
    if (creating[kind]) { toast('已經送出了，還在等伺服器回應…'); return; }
    creating[kind] = true;
    const slow = setTimeout(function () { toast('伺服器回應比較慢，已經送出了，請稍候…'); }, 1500);
    make().catch(function (e) {
      toast('建立失敗：' + (e && e.message || e));
    }).then(function () {
      clearTimeout(slow);
      creating[kind] = false;
    });
  }
  function importTarget() {
    if (quickWrapEl && !quickWrapEl.hidden) return { folderId: null, area: 'quick', label: '隨筆' };
    const folderId = currentFolderId();
    const area = areaForNew(folderId);
    const where = area && AREA_INFO[area] ? AREA_INFO[area].title : '所有筆記';
    return { folderId: folderId, area: area, label: where + (folderId ? '／' + folderFullName(folderId) : '') };
  }
  function readText(file) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(fr.error || new Error('讀不到檔案')); };
      fr.readAsText(file);
    });
  }
  const MD_FILE = /\.(md|markdown)$/i;
  // 一個檔：照舊直接打開（從區域頁開的，「上一頁」會回到那個資料夾）；好幾個或整個資料夾：留在
  // 原本的頁面，列表當場長出來，最後一句話說匯了多少、到哪裡。
  // 匯入整個資料夾（<input webkitdirectory>）時每個檔帶著 webkitRelativePath「根/子/檔.md」：
  // 資料夾照原本的層次在目標底下重建（只建真的有 .md 的那幾層）。
  // 隨筆沒有資料夾，匯進隨筆就全部攤平。一個一個依路徑順序建，某個失敗不影響其他的；
  // 資料夾建失敗的話，它底下的筆記改放到上一層，不會不見。
  //
  // 圖片（js/mdimport.js，跟命令列的 server/tools/import-md.js 同一份）：選到的非 .md 檔案就是
  // 這批 Markdown 的素材庫——被 ![](相對路徑) 引用到的先上傳，再把連結改寫成站上的 img:／pdf:／
  // file:（一張圖被好幾篇引用只上傳一次），內嵌的 data: base64 圖片一樣解出來上傳。外部網址的
  // 圖片這裡抓不到（站台的 CSP 只允許同源連線），連結原樣保留，最後那句話會說可以用命令列工具。
  // 沒被引用到的檔案只有在課程筆記才會一起匯入（那裡才有「檔案」的概念），其他區域略過。
  function importMarkdownFiles(files) {
    const t = importTarget();
    const flat = t.area === 'quick';
    const list = files.map(function (f) {
      const rel = String(f.webkitRelativePath || f.name).split('/').filter(Boolean);
      return { file: f, srcDirs: rel.slice(0, -1), dirs: flat ? [] : rel.slice(0, -1), path: rel.join('/') };
    });
    const mdOnes = list.filter(function (x) { return MD_FILE.test(x.file.name); })
      .sort(function (a, b) { return a.path.localeCompare(b.path, 'zh-Hant', { numeric: true }); });
    const assets = list.filter(function (x) { return !MD_FILE.test(x.file.name); });
    const byPath = {}, byName = {};
    assets.forEach(function (a) {
      byPath[a.path] = a;
      const base = a.file.name;
      if (byName[base] === undefined) byName[base] = a;
    });
    // 一個引用 → 素材庫裡的哪個檔案（找不到就 null，連結原樣保留）
    function assetFor(dirs, target) {
      const p = MdImport.resolvePath(dirs, target);
      return byPath[p] || byName[p.split('/').pop()] || null;
    }
    const made = [], foldersMade = [], docs = [];
    const uploaded = {};    // 素材的 path → { id, scheme, name }
    const usedAssets = [];  // 真的被引用到的素材（照第一次出現的順序）
    let failed = 0, missing = 0, remoteLeft = 0, mediaMade = 0, fileNotes = 0;
    const dirIds = {};   // '根/子' -> 資料夾 id
    function ensureDir(dirs) {
      if (!dirs.length) return Promise.resolve(t.folderId);
      const key = dirs.join('/');
      if (dirIds[key] !== undefined) return Promise.resolve(dirIds[key]);
      return ensureDir(dirs.slice(0, -1)).then(function (parentId) {
        return Store.createFolder(dirs[dirs.length - 1], parentId, t.area || undefined).then(function (f) {
          state.folders.push(f);
          foldersMade.push(f);
          dirIds[key] = f.id;
          return f.id;
        }, function () { dirIds[key] = parentId; return parentId; });
      });
    }
    function upload(file, name) {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(name || '');
      const mime = isPdf ? 'application/pdf' : (file.type || MdImport.mimeOf(name));
      return Store.uploadFile(file, null, mime).then(function (id) {
        return { id: id, scheme: MdImport.schemeFor(mime, name), name: name, mime: mime, size: file.size };
      });
    }
    // 一篇：內嵌圖片上傳 → 改寫連結 → 建資料夾 → 建筆記
    function makeNote(doc) {
      let inner = Promise.resolve({});
      doc.data.forEach(function (uri, i) {
        inner = inner.then(function (map) {
          const dec = MdImport.decodeDataUri(uri, i);
          if (!dec) return map;
          const f = new File([dec.bytes], dec.name, { type: dec.mime });
          return upload(f, dec.name).then(function (res) {
            map[uri] = res; mediaMade++; return map;
          }, function () { return map; });
        });
      });
      return inner.then(function (dataMap) {
        const content = MdImport.rewrite(doc.body, function (ref) {
          if (ref.kind === 'local') {
            const a = assetFor(doc.x.srcDirs, ref.target);
            return (a && uploaded[a.path]) || null;
          }
          if (ref.kind === 'data') return dataMap[ref.target] || null;
          return null;      // 外部網址在瀏覽器裡抓不到，留著原本的連結
        });
        return ensureDir(doc.x.dirs).then(function (parentId) {
          const opts = { content: content };
          if (t.area) opts.area = t.area;
          return Store.createNote(doc.title, parentId, opts);
        });
      }).then(function (n) { state.notes.push(n); made.push(n); }, function () { failed++; });
    }
    // 沒被引用到的檔案：課程筆記才有「檔案」可以放（areaOpts 的 onUploadFile 同一套）
    function makeFileNote(a) {
      return upload(a.file, a.file.name).then(function (res) {
        const ref = MdImport.siteRef({ alt: res.name, embed: true }, res);
        return ensureDir(a.dirs).then(function (parentId) {
          return Store.createNote(res.name, parentId, {
            area: 'course', content: ref + '\n',
            meta: { file: { id: res.id, name: res.name, mime: res.mime, size: res.size } }
          });
        });
      }).then(function (n) { state.notes.push(n); fileNotes++; }, function () { failed++; });
    }
    // 1) 先把每一篇讀進來、掃出引用到什麼，才知道哪些素材真的要上傳（掃完才排得出後面那串工作，
    //    usedAssets／docs 都是在這裡面才填好的）
    const chain = Promise.all(mdOnes.map(function (x) {
      return readText(x.file).then(function (text) {
        const fm = MdImport.frontMatter(text);
        const doc = { x: x, title: fm.title || x.file.name.replace(MD_FILE, '') || '匯入的筆記', body: fm.body, data: [] };
        MdImport.scan(fm.body).forEach(function (ref) {
          if (ref.kind === 'local') {
            const a = assetFor(x.srcDirs, ref.target);
            if (!a) { missing++; return; }
            if (uploaded[a.path] === undefined) { uploaded[a.path] = null; usedAssets.push(a); }
          } else if (ref.kind === 'remote') {
            if (ref.embed) remoteLeft++;
          } else if (ref.kind === 'data' && doc.data.indexOf(ref.target) < 0) doc.data.push(ref.target);
        });
        docs.push(doc);
      }, function () { failed++; });
    })).then(function () {
      docs.sort(function (a, b) { return a.x.path.localeCompare(b.x.path, 'zh-Hant', { numeric: true }); });
      const extras = t.area === 'course' ? assets.filter(function (a) { return uploaded[a.path] === undefined; }) : [];
      const jobs = usedAssets.length + extras.length;
      if (jobs) toast('匯入中…上傳 ' + jobs + ' 個圖片／檔案');
      // 2) 被引用到的素材先上傳（同一張圖只上傳一次），3) 再一篇一篇建，4) 最後才是沒用到的檔案
      let c = Promise.resolve();
      usedAssets.forEach(function (a) {
        c = c.then(function () {
          return upload(a.file, a.file.name).then(function (res) {
            uploaded[a.path] = res; mediaMade++;
          }, function () { /* 上傳失敗：連結原樣保留 */ });
        });
      });
      docs.forEach(function (doc) { c = c.then(function () { return makeNote(doc); }); });
      extras.forEach(function (a) { c = c.then(function () { return makeFileNote(a); }); });
      return c;
    });
    return chain.then(function () {
      if (made.length === 1 && !foldersMade.length && !fileNotes && !failed && t.area !== 'quick') {
        renderTree(); openNote(made[0].id); return;
      }
      foldersMade.forEach(function (f) { state.expanded[f.id] = true; });
      if (t.folderId) state.expanded[t.folderId] = true;
      LS.set('expanded', JSON.stringify(state.expanded));
      refreshViews();
      let msg = made.length
        ? '已匯入 ' + made.length + ' 篇' + (foldersMade.length ? '、' + foldersMade.length + ' 個資料夾' : '') +
          (mediaMade ? '、' + mediaMade + ' 個圖片／檔案' : '') + (fileNotes ? '、' + fileNotes + ' 個檔案' : '') +
          '到「' + t.label + '」'
        : '沒有匯入任何筆記';
      if (missing) msg += '（' + missing + ' 個圖片找不到檔案）';
      if (remoteLeft) msg += '，' + remoteLeft + ' 個外部網址的圖片沒有下載（命令列的 import-md 可以）';
      if (failed) msg += '，' + failed + ' 個檔案失敗';
      toast(msg);
    });
  }
  function newNote(folderId) {
    createOnce('note', function () {
      return Store.createNote('未命名筆記', folderId || null, withArea(folderId)).then(function (n) {
        state.notes.push(n);
        if (folderId) state.expanded[folderId] = true;
        renderTree();
        openNote(n.id);
        setTimeout(function () { titleEl.select(); }, 50);
      });
    });
  }
  // 資安院報告：先跳 modal 收集 單位 / Domain / IP / 弱點類型，確認後才建立筆記。
  // 帶 meta.secReport，開啟時走行內步驟編輯器。
  function createSecReport() {
    SecEditor.showNewDialog(function (info) {
      const blank = SecEditor.blankReport();
      blank.unit = info.unit; blank.domain = info.domain;
      blank.ip = info.ip; blank.vulnType = info.vulnType; blank.impact = info.impact;
      blank.title = SecEditor.titleFrom(info);
      Store.createNote(blank.title, currentFolderId(), withArea(currentFolderId())).then(function (n) {
        n.meta = Object.assign({}, n.meta, { secReport: blank });
        n.content = (window.SecReport && SecReport.generate)
          ? SecReport.generate(blank, blank.steps).content : '';
        Store.updateNote(n).then(function () {
          state.notes.push(n);
          renderTree();
          openNote(n.id);
        });
      });
    });
  }

  // 成效報告：先跳 modal 收集 單位 / 期間 / 範圍，確認後建立帶 meta.perfReport 的筆記。
  function createPerfReport() {
    PerfReport.showNewDialog(function (info) {
      const blank = PerfReport.blankReport();
      blank.unit = info.unit; blank.scope = info.scope;
      blank.periodStart = info.periodStart; blank.periodEnd = info.periodEnd;
      blank.title = PerfReport.titleFrom(info);
      Store.createNote(blank.title, currentFolderId(), withArea(currentFolderId())).then(function (n) {
        n.meta = Object.assign({}, n.meta, { perfReport: blank });
        n.content = PerfReport.generate(blank).content;
        Store.updateNote(n).then(function () {
          state.notes.push(n);
          renderTree();
          openNote(n.id);
        });
      });
    });
  }

  function newFolder(parentId) {
    createOnce('folder', function () {
      return Store.createFolder('新資料夾', parentId || null, areaForNew(parentId) || undefined).then(function (f) {
        state.folders.push(f);
        if (parentId) state.expanded[parentId] = true;
        state.expanded[f.id] = true;
        refreshViews();   // 儀表板立刻長出新資料夾，不用重新整理
        startRename('folder', f.id);
      });
    });
  }
  function renameNote(note) { startRename('note', note.id); }
  function renameFolder(folder) { startRename('folder', folder.id); }

  // Inline rename directly in the tree (no blocking prompt() dialogs).
  function startRename(type, id) {
    const sel = type === 'folder' ? '.folder-row' : '.note-row';
    const row = treeEl.querySelector(sel + '[data-id="' + id + '"]');
    if (!row) return;
    const label = row.querySelector('.label');
    if (!label) return;
    const input = document.createElement('input');
    input.className = 'tree-edit';
    input.value = label.textContent;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    function commit(save) {
      if (done) return;
      done = true;
      const val = input.value.trim();
      if (save && val) {
        if (type === 'folder') {
          const f = state.folders.find(function (x) { return x.id === id; });
          if (f) { f.name = val; Store.updateFolder(f).then(refreshViews); return; }
        } else {
          const n = state.notes.find(function (x) { return x.id === id; });
          if (n) {
            applyNoteTitle(id, val).then(function () { refreshViews(); renderPreview(); });
            return;
          }
        }
      }
      renderTree(); // revert / no-op
    }
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('blur', function () { commit(true); });
  }
  // 改標題的共用路徑：樹狀清單的就地改名與儀表板的「修改標題」都走這裡。
  function applyNoteTitle(id, val) {
    const n = state.notes.find(function (x) { return x.id === id; });
    if (!n || !val || val === n.title) return Promise.resolve();
    const oldTitle = n.title;
    n.title = val;
    return Store.updateNote(n).then(function () {
      if (state.currentId === id || (toolBar && toolBar.id === id)) { titleEl.value = val; fitNoteTitle(); }
      if (state.current && state.current.id === id) state.current.title = val;
      return retargetLinks(oldTitle, val);
    });
  }
  function renameNoteTo(note, val) {
    applyNoteTitle(note.id, val)
      .then(function () { refreshViews(); renderPreview(); })
      .catch(function (e) { toast('改名失敗：' + (e && e.message || e)); refreshViews(); });
  }
  // Renaming a note would orphan every [[old title]] pointing at it, so rewrite
  // those links across all notes to follow the new title.
  function retargetLinks(oldTitle, newTitle) {
    if (normTitle(oldTitle) === normTitle(newTitle)) return Promise.resolve();
    const re = /\[\[([^\[\]|\n]+)(\|[^\[\]\n]+)?\]\]/g;
    const jobs = [];
    state.notes.forEach(function (n) {
      const next = String(n.content || '').replace(re, function (raw, target, alias) {
        return normTitle(target) === normTitle(oldTitle) ? '[[' + newTitle + (alias || '') + ']]' : raw;
      });
      if (next === n.content) return;
      n.content = next;
      if (n.id === state.currentId) {
        editorEl.value = next;
        if (state.current) state.current.content = next;
        if (editorEl._hlRefresh) editorEl._hlRefresh();
      }
      jobs.push(Store.updateNote(n));
    });
    return Promise.all(jobs);
  }

  function duplicateNote(note) {
    Store.getNote(note.id).then(function (full) {
      // A copy of someone else's note lands at my root — its folderId belongs to
      // their tree and would leave the copy invisible in mine.
      const folder = full.perm === 'owner' ? full.folderId : null;
      const dupOpts = full.perm === 'owner' && full.area ? { area: full.area } : undefined;   // 複本留在原本的區域
      Store.createNote((full.title || '未命名筆記') + ' (複本)', folder, dupOpts).then(function (n) {
        n.content = full.content;
        Store.updateNote(n).then(function () {
          state.notes.push(n);
          refreshViews();
        });
      });
    });
  }
  // "Delete" is a move to the trash (server keeps the row with deleted_at set);
  // the trash page (#trash, js/trash.js) is where it is restored or really deleted.
  function deleteNote(note) {
    showConfirm({
      title: '移至垃圾桶',
      message: '把筆記「' + (note.title || '未命名筆記') + '」移到垃圾桶？\n保留期內可以從側邊欄的「垃圾桶」復原。',
      ok: '移至垃圾桶'
    }).then(function (ok) {
      if (!ok) return;
      Store.deleteNote(note.id).then(function () {
        state.notes = state.notes.filter(function (n) { return n.id !== note.id; });
        if (state.currentId === note.id) showEmpty();
        refreshViews();
        toast('已移至垃圾桶');
      }).catch(function (e) { toast('刪除失敗：' + (e && e.message || e)); });
    });
  }
  function deleteFolder(folder) {
    const folderIds = descendantFolderIds(folder.id);
    const notesInside = state.notes.filter(function (n) { return folderIds.indexOf(n.folderId) >= 0; });
    const subFolders = folderIds.length - 1;
    let detail = '含 ' + notesInside.length + ' 篇筆記';
    if (subFolders > 0) detail += '、' + subFolders + ' 個子資料夾';
    showConfirm({
      title: '刪除資料夾',
      message: '確定刪除資料夾「' + folder.name + '」？（' + detail + '）\n資料夾本身會直接刪除；裡面的筆記會移到垃圾桶，保留期內可以復原（復原後放在最上層）。',
      ok: '刪除', danger: true
    }).then(function (ok) {
      if (!ok) return;
      const noteIds = notesInside.map(function (n) { return n.id; });
      removeNotesAndFolders(noteIds, folderIds).then(function (r) {
        if (r.failed) toast('刪除資料夾時有 ' + r.failed + ' 項沒有刪成功' + (r.folders ? '' : '，資料夾都保留'));
      });
    });
  }
  function descendantFolderIds(rootId) {
    const ids = [rootId];
    let changed = true;
    while (changed) {
      changed = false;
      state.folders.forEach(function (f) {
        if (ids.indexOf(f.parentId) >= 0 && ids.indexOf(f.id) < 0) { ids.push(f.id); changed = true; }
      });
    }
    return ids;
  }

  // ---- Export ------------------------------------------------------------
  function exportPDF() {
    if (!state.current && toolBar) { toolBar.pdf(); return; }   // 開著的是圖表
    if (!state.current) return;
    // Make sure preview reflects latest text before export.
    previewEl.innerHTML = MD.render(editorEl.value);
    MD.resolveImages(previewEl);
    // Table column widths live in meta; carry them into the print clone.
    if (state.current.meta) MD.applyColWidths(previewEl, state.current.meta.tableWidths);
    statusSave.textContent = '準備列印預覽…';
    // small delay so images resolve
    setTimeout(function () {
      PDF.showPreview(state.current, previewEl, {
        meta: state.current.meta,
        // Cover fields live on the note. Save through here rather than from pdf.js
        // so the note's title/content stay in step with the editor.
        onMeta: function (meta) {
          if (!state.current) return;
          state.current.meta = meta;
          saveNow();
        }
      }).then(function () {
        statusSave.textContent = '';
      }).catch(function (err) {
        alert('產生列印預覽失敗：' + (err && err.message || err));
        statusSave.textContent = '';
      });
    }, 250);
  }

  // ---- Search ------------------------------------------------------------
  const search = { query: '', results: [], index: -1 };

  function renderMarkedText(parts, into) {
    parts.forEach(function (p) {
      const node = p.hit ? document.createElement('mark') : document.createTextNode(p.text);
      if (p.hit) { node.className = 'search-hit'; node.textContent = p.text; }
      into.appendChild(node);
    });
  }

  function runSearch(q) {
    const sameQuery = q === search.query;
    // Keep the caret on the note the user had highlighted when this is a
    // refresh of the same query (e.g. after opening a result), not a new one.
    const keepId = sameQuery && search.results[search.index]
      ? search.results[search.index].note.id : null;
    search.query = q;
    const active = !!q.trim();
    searchClearEl.hidden = !active;
    treeEl.hidden = active;
    searchResultsEl.hidden = !active;
    if (!active) { search.results = []; search.index = -1; searchResultsEl.innerHTML = ''; return; }
    // The open note's edits live in the textarea until the debounced save runs.
    // state.current is a separate object loaded from IndexedDB, not the array
    // element, so swap in a live copy rather than mutating state.notes here.
    let corpus = state.notes;
    if (state.current) {
      const live = Object.assign({}, state.current, {
        title: titleEl.value || '未命名筆記',
        content: editorEl.value
      });
      corpus = state.notes.map(function (n) { return n.id === live.id ? live : n; });
    }
    search.results = Search.search(q, corpus);
    let idx = -1;
    if (keepId) {
      idx = search.results.findIndex(function (r) { return r.note.id === keepId; });
    }
    search.index = idx >= 0 ? idx : (search.results.length ? 0 : -1);
    renderSearchResults();
  }

  function renderSearchResults() {
    searchResultsEl.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'search-count';
    head.textContent = search.results.length ? search.results.length + ' 個結果' : '找不到符合的筆記';
    searchResultsEl.appendChild(head);

    search.results.forEach(function (r, i) {
      const row = document.createElement('div');
      row.className = 'search-row' + (i === search.index ? ' active' : '') +
        (r.note.id === state.currentId ? ' current' : '');
      row.dataset.id = r.note.id;   // 中鍵開新分頁要用
      const title = document.createElement('div');
      title.className = 'search-row-title';
      const ic = document.createElement('span');
      ic.className = 'ic';
      ic.innerHTML = Icons.svg(noteIcon(r.note));
      title.appendChild(ic);
      const label = document.createElement('span');
      label.className = 'label';
      renderMarkedText(r.titleParts, label);
      title.appendChild(label);
      row.appendChild(title);

      r.snippets.forEach(function (s) {
        const snip = document.createElement('div');
        snip.className = 'search-snippet';
        if (s.lead) snip.appendChild(document.createTextNode('…'));
        renderMarkedText(s.parts, snip);
        if (s.trail) snip.appendChild(document.createTextNode('…'));
        row.appendChild(snip);
      });

      row.addEventListener('click', function () { openSearchResult(i); });
      row.addEventListener('mousemove', function () {
        if (search.index === i) return;
        search.index = i;
        highlightSearchRow();
      });
      searchResultsEl.appendChild(row);
    });
  }

  function highlightSearchRow() {
    const rows = searchResultsEl.querySelectorAll('.search-row');
    Array.prototype.forEach.call(rows, function (r, i) {
      r.classList.toggle('active', i === search.index);
    });
    const active = rows[search.index];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function moveSearchSelection(dir) {
    if (!search.results.length) return;
    search.index = (search.index + dir + search.results.length) % search.results.length;
    highlightSearchRow();
  }

  function openSearchResult(i) {
    const r = search.results[i == null ? search.index : i];
    if (!r) return;
    saveNow();
    openNote(r.note.id);
  }

  function clearSearch(focusEditor) {
    searchInput.value = '';
    runSearch('');
    if (focusEditor && state.current) editorEl.focus();
  }

  // ---- Image annotation --------------------------------------------------
  function openAnnotator(id) {
    if (!id || !window.Annotate) return;
    Annotate.open(id, {
      onSaved: function () {
        statusSave.textContent = '標註已儲存 ✓';
        renderPreviewNow(); // re-read the blob through the invalidated URL cache
      }
    });
  }

  // ---- Theme -------------------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    LS.set('theme', theme);
    // swap hljs theme
    const link = $('#hljs-theme-light');
    if (link) link.href = theme === 'dark' ? 'vendor/hljs-github-dark.min.css' : 'vendor/hljs-github.min.css';
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
    renderPreview();
  }

  // ---- Sidebar drawer ------------------------------------------------------
  // 側邊欄是浮動抽屜：預設收起，筆記區永遠吃滿整個寬度。打開只認明確動作——
  // 點左緣把手、頂列的 ☰、或 Ctrl+\——不再用滑過左緣自動彈出；收回則靠點主區／
  // 頂列、Esc 或開啟筆記。
  function isSidebarOpen() {
    const app = $('#app');
    return !!(app && app.classList.contains('sidebar-open'));
  }
  // 首頁／垃圾桶／四個區域頁預設把抽屜打開——但只在桌面：窄螢幕的抽屜是整片蓋在
  // 內容上的，一進頁面就開等於什麼都看不到，要靠 ☰ 自己拉。
  function autoOpenSidebar() { setSidebarOpen(window.innerWidth > 900); }
  function setSidebarOpen(v) {
    const app = $('#app');
    if (!app) return;
    app.classList.toggle('sidebar-open', !!v);
  }
  function toggleSidebar() { setSidebarOpen(!isSidebarOpen()); }
  function initSidebarDrawer() {
    const sidebar = $('#sidebar');
    const handle = $('#sidebar-reopen');
    const toggleBtn = $('#sidebar-collapse');
    if (!sidebar) return;
    // 點左緣把手（中間那條帶箭頭的把手）才拉出抽屜——刻意不再用滑過去自動彈出，
    // 免得開著筆記時游標一碰到左邊就跳出來擋住內容。
    if (handle) handle.addEventListener('click', function () { setSidebarOpen(true); });
    // 點到主區或頂列（抽屜鈕除外）→ 收回；右鍵選單、對話框等都在這兩區之外，不受影響
    document.addEventListener('mousedown', function (e) {
      if (!isSidebarOpen()) return;
      if (toggleBtn && toggleBtn.contains(e.target)) return;
      // 窄螢幕：抽屜蓋在內容上，點到內容就收，不分哪一頁
      if (window.innerWidth <= 900) {
        const m0 = $('#main'), t0 = $('#topbar');
        if ((m0 && m0.contains(e.target)) || (t0 && t0.contains(e.target))) setSidebarOpen(false);
        return;
      }
      // 首頁、垃圾桶頁跟四個獨立區域頁面預設開著抽屜：點頁面內容不收回，
      // 只有 ☰、Esc 或開啟筆記才會收
      if (!emptyEl.hidden || (trashWrapEl && !trashWrapEl.hidden) || (filesWrapEl && !filesWrapEl.hidden) ||
        (courseWrapEl && !courseWrapEl.hidden) || (knowledgeWrapEl && !knowledgeWrapEl.hidden) ||
        (quickWrapEl && !quickWrapEl.hidden) || (novelWrapEl && !novelWrapEl.hidden) ||
        (boardsWrapEl && !boardsWrapEl.hidden) || (startWrapEl && !startWrapEl.hidden) || (xmindWrapEl && !xmindWrapEl.hidden)) return;
      const main = $('#main'), top = $('#topbar');
      if ((main && main.contains(e.target)) || (top && top.contains(e.target))) setSidebarOpen(false);
    });
    // Esc：其他對話框／搜尋框已經吃掉的 Esc 不會走到這裡
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !e.defaultPrevented && isSidebarOpen()) setSidebarOpen(false);
    });
  }

  // ---- Divider resize ----------------------------------------------------
  function initDivider() {
    const divider = $('#divider');
    let dragging = false;
    const saved = LS.get('splitRatio', null);
    if (saved) panesEl.style.setProperty('--edit-basis', saved);
    divider.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); document.body.style.cursor = 'col-resize'; });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      const rect = panesEl.getBoundingClientRect();
      let ratio = (e.clientX - rect.left) / rect.width;
      ratio = Math.max(0.2, Math.min(0.8, ratio));
      const pct = (ratio * 100).toFixed(1) + '%';
      panesEl.style.setProperty('--edit-basis', pct);
      LS.set('splitRatio', pct);
    });
    window.addEventListener('mouseup', function () { dragging = false; document.body.style.cursor = ''; });
  }

  // ---- Events ------------------------------------------------------------
  function bindEvents() {
    // 點頂列 logo 回到首頁儀表板
    const logo = document.querySelector('#topbar .logo');
    if (logo) {
      logo.style.cursor = 'pointer';
      logo.title = '回到首頁';
      logo.addEventListener('click', goHome);
    }

    // 視窗變寬變窄、側邊欄拉開收起、瀏覽器縮放都可能改變頂列還剩多少空間
    window.addEventListener('resize', fitTopbar);
    if (window.ResizeObserver) {
      const topbarEl = $('#topbar');
      if (topbarEl) new ResizeObserver(fitTopbar).observe(topbarEl);
    }

    $('#new-note').addEventListener('click', function () { newNote(currentFolderId()); });
    // 預覽裡 PDF 的「檔案｜預覽」、獨佔一行的網址的「連結｜預覽卡片」（js/embedswitch.js）。
    // 改寫範圍是 LineSync 標在預覽元素上的原始碼行號。
    if (window.EmbedSwitch) EmbedSwitch.attach(previewEl, {
      rangeOf: function (el) {
        const hit = el.closest('[data-line0]');
        if (!hit || !previewEl.contains(hit)) return null;
        const start = parseInt(hit.getAttribute('data-line0'), 10);
        return { start: start, end: parseInt(hit.getAttribute('data-line1'), 10) || start };
      },
      getText: function () { return editorEl.value; },
      setText: applyEditorText,
      canEdit: function () { return !!state.current && state.current.perm !== 'read'; },
      onPdfPref: function (v) { LS.set('pdfDisplay', v); }
    });
    // /file、/upload：打開檔案挑選器
    if (window.Editor && Editor.setActionSnippets) Editor.setActionSnippets([
      { cmd: 'file', hint: '上傳檔案（圖片、PDF、任何附件）', action: pickFiles },
      { cmd: 'upload', hint: '上傳檔案（圖片、PDF、任何附件）', action: pickFiles },
      { cmd: 'relmap', hint: '嵌入一張你畫過的關聯分析（可拖曳縮放）', action: pickRelMapEmbed },
      { cmd: 'drawio', hint: '嵌入一張你畫過的 drawio 圖表', action: pickDrawioEmbed }
    ]);
    // 排序方式：側邊欄搜尋框旁的鈕；換了就重畫側邊欄與首頁
    const sortBtn = $('#sort-btn');
    if (sortBtn) sortBtn.addEventListener('click', function (e) {
      e.stopPropagation();   // 不然這次點擊冒泡到 document 的 hideCtx，選單開了馬上又關掉
      showSortMenu(sortBtn);
    });
    Sorting.onChange(function () { updateSortBtn(); refreshViews(); });
    updateSortBtn();
    $('#new-folder').addEventListener('click', function () { newFolder(null); });
    // 「新增」選單：筆記／證照範本／資安院報告／成效報告合併成一顆鈕，點開再選。
    // 選項按鈕保留原本的 id，各自的 click 處理（下面）完全不用改；選項自己的
    // handler 先跑（target 階段），事件冒泡到選單這層時再把它收起來。
    const newBtn = $('#new-btn');
    const newMenu = $('#new-dropdown');
    function closeNewMenu() {
      if (newMenu) newMenu.hidden = true;
      if (newBtn) newBtn.setAttribute('aria-expanded', 'false');
    }
    if (newBtn && newMenu) {
      newBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const open = newMenu.hidden;
        newMenu.hidden = !open;
        newBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      newMenu.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.target.closest('button')) closeNewMenu();
      });
      document.addEventListener('click', closeNewMenu);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNewMenu(); });
    }
    $('#export-pdf').addEventListener('click', exportPDF);
    $('#toggle-theme').addEventListener('click', toggleTheme);
    if (shareBtn) shareBtn.addEventListener('click', function () {
      const n = state.current || (toolBar && toolBar.note());
      if (n && isMine(n)) showShareDialog(n);
    });
    if (historyBtn) historyBtn.addEventListener('click', openHistory);
    // 視窗窄到連圖示版的版本／分享／PDF 都放不下（fitTopbar 收到 lvl4）：收成一顆「更多」，
    // 開合原本那三顆鈕，點法直接借用它們自己既有的 click 處理，不重複寫一次判斷邏輯。
    const moreBtn = $('#topbar-more-btn');
    if (moreBtn) moreBtn.addEventListener('click', function (e) {
      e.stopPropagation();   // 不然這次點擊會冒泡到 document 的 hideCtx，選單開了馬上又關掉
      const r = moreBtn.getBoundingClientRect();
      openMenuAt(r.right, r.bottom + 4, [
        { icon: 'history', label: '版本', fn: function () { historyBtn.click(); } },
        { icon: 'users', label: '分享', fn: function () { shareBtn.click(); } },
        { icon: 'download', label: 'PDF', fn: function () { $('#export-pdf').click(); } }
      ], { alignRight: true });
    });

    // 批次操作列
    const bMove = $('#batch-move'); if (bMove) bMove.addEventListener('click', batchMove);
    const bShare = $('#batch-share'); if (bShare) bShare.addEventListener('click', batchShare);
    const bDel = $('#batch-delete'); if (bDel) bDel.addEventListener('click', batchDelete);
    const bClr = $('#batch-clear'); if (bClr) bClr.addEventListener('click', clearSelection);

    // 頂列的抽屜鈕：開 ↔ 關；左緣把手與自動收回的邏輯在 initSidebarDrawer
    const collapseBtn = $('#sidebar-collapse');
    if (collapseBtn) collapseBtn.addEventListener('click', toggleSidebar);
    initSidebarDrawer();

    const oscpBtn = $('#oscp-report');
    if (oscpBtn && window.OSCP) oscpBtn.addEventListener('click', function () {
      OSCP.showForm(function (title, md) {
        Store.createNote(title, currentFolderId(), withArea(currentFolderId())).then(function (n) {
          n.content = md;
          Store.updateNote(n).then(function () {
            state.notes.push(n);
            renderTree();
            openNote(n.id);
            setMode('split');
          });
        });
      });
    });

    const secBtn = $('#sec-report');
    if (secBtn && window.SecEditor) secBtn.addEventListener('click', createSecReport);

    const perfBtn = $('#perf-report');
    if (perfBtn && window.PerfReport) perfBtn.addEventListener('click', createPerfReport);

    // 關聯分析：新建立就帶一組起點範例，一開就直接進全螢幕編輯器（見 openNote 裡
    // 的 RelMap.isRelNote 分支），不用像其他範本一樣再等 openNote 跑完一般流程。
    // refreshViews() 而不是只 renderTree()：其他範本的 openNote 會離開首頁，回來時首頁
    // 本來就會重畫；關聯分析卻是「浮在首頁上面」開啟，首頁一直留在底下不會重畫，
    // 只更新側邊欄的話，新筆記在關掉編輯器後的 未歸類筆記 裡就是看不到。
    const relBtn = $('#rel-map');
    if (relBtn && window.RelMap) relBtn.addEventListener('click', function () {
      Store.createNote('未命名關聯分析', currentFolderId(), withArea(currentFolderId(), { meta: { relMap: true }, content: RelMap.generate() }))
        .then(function (n) {
          state.notes.push(n);
          refreshViews();
          openNote(n.id);
        }, function (e) { toast('新增失敗：' + (e && e.message || e)); });
    });

    const docBtn = $('#new-doc');
    if (docBtn && window.Doc) docBtn.addEventListener('click', function () {
      createOnce('doc', function () {
        return Store.createNote('未命名文件', currentFolderId(), withArea(currentFolderId(), { meta: { doc: true }, content: Doc.generate() }))
          .then(function (n) {
            state.notes.push(n);
            refreshViews();
            openNote(n.id);
          });
      });
    });
    const dioBtn = $('#new-drawio');
    if (dioBtn && window.DrawIO) dioBtn.addEventListener('click', function () {
      createOnce('drawio', function () {
        return Store.createNote('未命名圖表', currentFolderId(), withArea(currentFolderId(), { meta: { drawio: true }, content: DrawIO.generate() }))
          .then(function (n) {
            state.notes.push(n);
            refreshViews();
            openNote(n.id);
          });
      });
    });

    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.mode); });
    });

    // Search
    let searchTimer = null;
    searchInput.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { runSearch(searchInput.value); }, 120);
    });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSearchSelection(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearchSelection(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); openSearchResult(); }
      else if (e.key === 'Escape') { e.preventDefault(); clearSearch(true); }
    });
    searchClearEl.addEventListener('click', function () { clearSearch(false); searchInput.focus(); });
    // Ctrl/Cmd+K from anywhere focuses the search box.
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSidebarOpen(true);      // 搜尋框在抽屜裡，先拉出來
        searchInput.focus();
        searchInput.select();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
      }
    });

    // 複製連結：#note/<id> 或 #book/<id> 變化時跟著切換（瀏覽器上一頁／下一頁也適用）
    window.addEventListener('hashchange', function () {
      closeFileViewer();   // 上一頁／下一頁換了畫面，疊在上面的檔案檢視器不該留著
      const nid = noteIdFromHash();
      if (nid) {
        if (nid !== state.currentId && state.notes.some(function (n) { return n.id === nid; })) openNote(nid);
        return;
      }
      if (location.hash === '#trash') {
        if (trashWrapEl && trashWrapEl.hidden) openTrash();
        return;
      }
      if (location.hash === '#files') {
        if (filesWrapEl && filesWrapEl.hidden) openFiles();
        return;
      }
      // #course、#course/<資料夾>（知識區、小說同理）：只切畫面，不再 pushState
      // #videos：個人區的影片分頁（跟 #novel 同一個 wrap，所以看的是影片頁本身藏不藏）
      if (location.hash === '#videos') {
        if (!videosPageEl || videosPageEl.hidden || novelWrapEl.hidden) openVideos({ keepHash: true });
        return;
      }
      const am = location.hash.match(AREA_HASH);
      if (am) {
        const ar = areaFromHash();
        const fid = am[1] === 'novel' && !novelIsUnlocked ? (am[2] ? decodeURIComponent(am[2]) : null) : ar.folderId;
        const onVideos = am[1] === 'novel' && videosPageEl && !videosPageEl.hidden;   // 從影片分頁退回小說分頁
        if (AREA_INFO[am[1]].wrap.hidden || onVideos) openArea(am[1], { folderId: fid, keepHash: true });
        else if (window.AreaBrowser && AreaBrowser.currentFolder() !== fid) AreaBrowser.openFolder(fid);
        return;
      }
      if (location.hash === '#quick') { if (quickWrapEl && quickWrapEl.hidden) openQuick(); return; }
      if (location.hash === '#board') { if (boardsWrapEl && boardsWrapEl.hidden) openBoards(); return; }
      if (location.hash === '#start') { if (startWrapEl && startWrapEl.hidden) openStart(); return; }
      if (location.hash === '#xmind') { if (xmindWrapEl && xmindWrapEl.hidden) openXmind(); return; }
      if (location.hash === '#timetree') { if (timetreeWrapEl && timetreeWrapEl.hidden) openTimeTree(); return; }
      if (location.hash === '#progress') { if (progressWrapEl && progressWrapEl.hidden) openProgress(); return; }
      if (location.hash === '#foodmap') { if (foodmapWrapEl && foodmapWrapEl.hidden) openFoodMap(); return; }
      const bid = bookIdFromHash();
      if (bid) {
        if (state.folders.some(function (f) { return f.id === bid; })) openBook(bid);
        return;
      }
      // #tag/<name>：首頁依標籤篩選（中鍵開新分頁、從別頁改網址進來都走這裡）
      const tg = tagFromHash();
      if (tg) {
        if (emptyEl.hidden) { saveNow(); LS.set('lastNote', ''); showEmpty(true); }
        if (window.Dashboard && Dashboard.setTag) Dashboard.setTag(tg);
        return;
      }
      // #folder/<id>：上一頁／下一頁走到首頁的某個資料夾。只切畫面，不再 pushState。
      const fid = folderIdFromHash();
      if (fid) {
        if (!state.folders.some(function (f) { return f.id === fid; })) return;
        if (emptyEl.hidden) {
          saveNow();
          LS.set('lastNote', '');
          showEmpty(true);
          renderTree();
        }
        if (window.Dashboard && Dashboard.currentFolder() !== fid) Dashboard.openFolder(fid);
        return;
      }
      // hash 變回空字串：「上一頁」退回首頁那一層。從筆記／電子書／垃圾桶回來就切回儀表板；
      // 本來就在儀表板、只是停在某個資料夾裡，就回到「所有筆記」。
      const inArea = (courseWrapEl && !courseWrapEl.hidden) || (knowledgeWrapEl && !knowledgeWrapEl.hidden) ||
        (quickWrapEl && !quickWrapEl.hidden) || (novelWrapEl && !novelWrapEl.hidden);
      // 關聯分析／drawio／關聯圖是整頁的工具，開著的時候 state.currentId 是空的——少了這三個
      // 判斷，在那幾頁按瀏覽器的「上一頁」網址會變回首頁、畫面卻還卡在編輯器裡。
      const inTool = (relmapWrapEl && !relmapWrapEl.hidden) || (drawioWrapEl && !drawioWrapEl.hidden) ||
        (graphWrapEl && !graphWrapEl.hidden);
      if (state.currentId || (bookWrapEl && !bookWrapEl.hidden) || (trashWrapEl && !trashWrapEl.hidden) || inArea || inTool) goHome();
      else if (window.Dashboard && Dashboard.currentFolder()) Dashboard.openFolder(null);
    });
    // 新增 → 電子書：挑一個資料夾做成電子書；開過就會出現在首頁的「電子書」區
    const newBook = $('#new-book');
    if (newBook) newBook.addEventListener('click', pickBookFolder);
    const graphBtn = $('#graph-open-btn');
    if (graphBtn) graphBtn.addEventListener('click', openGraphPage);
    // 垃圾桶：獨立頁面（#trash），見 openTrash()
    const trashBtn = $('#trash-open-btn');
    if (trashBtn) trashBtn.addEventListener('click', function () { openTrash(); });

    // 檔案管理：上傳過的圖片／PDF／其他檔案，每個用在哪些筆記、哪些沒有筆記在用
    const imagesBtn = $('#images-open-btn');
    if (imagesBtn) imagesBtn.addEventListener('click', openFiles);

    // 四個獨立區域：課程筆記、隨筆、知識區、小說（見 openArea / openQuick）
    initAreaInfo();
    const courseBtn = $('#course-open-btn'); if (courseBtn) courseBtn.addEventListener('click', function () { openArea('course'); });
    const knowledgeBtn = $('#knowledge-open-btn'); if (knowledgeBtn) knowledgeBtn.addEventListener('click', function () { openArea('knowledge'); });
    const novelBtn = $('#novel-open-btn'); if (novelBtn) novelBtn.addEventListener('click', function () { openArea('novel'); });
    // 個人區上面的分頁：小說／影片
    if (paTabsEl) paTabsEl.addEventListener('click', function (e) {
      const b = e.target.closest('[data-pa]');
      if (!b) return;
      if (b.getAttribute('data-pa') === 'videos') openVideos(); else openArea('novel');
    });
    const quickBtn = $('#quick-open-btn'); if (quickBtn) quickBtn.addEventListener('click', openQuick);
    const boardBtn = $('#board-open-btn'); if (boardBtn) boardBtn.addEventListener('click', openBoards);
    const startBtn = $('#start-open-btn'); if (startBtn) startBtn.addEventListener('click', function () { openStart(); });
    const xmindBtn = $('#xmind-open-btn'); if (xmindBtn) xmindBtn.addEventListener('click', openXmind);
    const timetreeBtn = $('#timetree-open-btn'); if (timetreeBtn) timetreeBtn.addEventListener('click', function () { openTimeTree(); });
    const progressBtn = $('#progress-open-btn'); if (progressBtn) progressBtn.addEventListener('click', function () { openProgress(); });
    const foodmapBtn = $('#foodmap-open-btn'); if (foodmapBtn) foodmapBtn.addEventListener('click', function () { openFoodMap(); });

    editorEl.addEventListener('input', function () {
      renderPreview();
      scheduleSave();
      updateStatus();
      danceCapybara();
      scheduleSendCursor();     // my caret moved
      shiftRemoteCarets(editorEl.value);   // others' carets move with the text they sit in
      scheduleCaretRender();    // text reflowed → reposition others' carets
    });
    editorEl.addEventListener('paste', handlePaste);
    // Broadcast my caret as it moves; reposition remote carets on scroll/resize.
    editorEl.addEventListener('keyup', scheduleSendCursor);
    editorEl.addEventListener('click', scheduleSendCursor);
    editorEl.addEventListener('focus', scheduleSendCursor);
    editorEl.addEventListener('scroll', scheduleCaretRender);
    document.addEventListener('selectionchange', function () {
      if (document.activeElement === editorEl) scheduleSendCursor();
    });
    window.addEventListener('resize', scheduleCaretRender);
    editorEl.addEventListener('keydown', function (e) {
      // Ctrl/Cmd+S saves
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveNow();
      }
    });
    // Drag & drop image files into the editor
    editorEl.addEventListener('dragover', function (e) {
      if (hasFiles(e)) { e.preventDefault(); editorEl.classList.add('drag-over'); }
    });
    editorEl.addEventListener('dragleave', function (e) {
      if (e.target === editorEl) editorEl.classList.remove('drag-over');
    });
    editorEl.addEventListener('drop', handleEditorDrop);
    // Prevent the browser from navigating away if a file is dropped outside the editor
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', function (e) { if (hasFiles(e)) e.preventDefault(); });
    // Editor syntax-highlight backdrop + line numbers
    if (window.EditorHL) EditorHL.attach(editorEl, $('#editor-backdrop'));
    // Click a line in the editor or the preview, the matching line underlines
    // on the other side.
    if (window.LineSync) LineSync.init(editorEl, previewEl);
    // Markdown editing helpers + autocomplete (auto-pairs, list continuation, suggestions)
    if (window.Editor) Editor.attach(editorEl);
    // 多行編輯（Alt 拖曳直欄、Ctrl+Alt+↑↓、Ctrl+D），見 js/multicursor.js
    if (window.MultiCursor) multi = MultiCursor.attach(editorEl, {
      onChange: function (n) { if (statusCursors) statusCursors.textContent = n > 1 ? n + ' 個游標（Esc 取消）' : ''; }
    });
    // Mind maps are editable directly in the preview; every change writes the
    // outline straight back into the fenced block, so the markdown in the editor
    // updates as the map is edited.
    if (window.MindMap && MindMap.bindPreview) {
      MindMap.bindPreview(previewEl, {
        onChange: function (blockIndex, outline) { replaceMindmapBlock(blockIndex, outline); },
        isReadOnly: function () { return !!(state.current && state.current.perm === 'read'); }
      });
    }
    // Interactive table tooling (Notion-like controls + align/tidy)
    if (window.TableTool) TableTool.attach(editorEl, {
      isActive: function () { return state.mode !== 'preview' && !!state.current; }
    });

    // Formatting toolbar
    const tb = $('#edit-toolbar');
    if (tb) {
      tb.addEventListener('mousedown', function (e) {
        if (e.target.closest('button')) e.preventDefault(); // keep textarea selection/focus
      });
      tb.addEventListener('click', function (e) {
        const btn = e.target.closest('button');
        if (btn && btn.dataset.fmt) applyFormat(btn.dataset.fmt);
      });
    }
    // sync scroll between editor & preview in split mode (bidirectional, heading-anchored)
    let scrollSyncing = false;
    function linkScroll(src, dst) {
      src.addEventListener('scroll', function () {
        if (state.mode !== 'split' || !src || !dst) return;
        // 對方剛被程式捲動而觸發的 scroll 事件：吃掉一次即可，避免來回震盪
        if (scrollSyncing) { scrollSyncing = false; return; }
        const sMax = src.scrollHeight - src.clientHeight;
        const dMax = dst.scrollHeight - dst.clientHeight;
        if (sMax <= 0 || dMax <= 0) return;
        const target = Math.round(Math.max(0, Math.min(dMax, mapScrollTop(src === editorEl, src.scrollTop))));
        if (Math.abs(dst.scrollTop - target) < 1) return;   // 已對齊就別再設，免得卡住旗標
        scrollSyncing = true;
        dst.scrollTop = target;
      });
    }
    if (previewScrollEl) {
      linkScroll(editorEl, previewScrollEl);   // 左捲動 → 右跟隨
      linkScroll(previewScrollEl, editorEl);   // 右捲動 → 左跟隨
      // 兩邊任何一側高度變了（打字、圖片載入、拖分隔線、改視窗大小）錨點就重算
      const dirty = function () { scrollAnchorsDirty = true; };
      editorEl.addEventListener('input', dirty);
      window.addEventListener('resize', dirty);
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(dirty);
        ro.observe(previewEl);
        ro.observe(previewScrollEl);
        ro.observe(editorEl);
      }
    }
    // scroll-spy: highlight the current heading in the TOC
    if (previewScrollEl) previewScrollEl.addEventListener('scroll', function () { updateTocActive(tocEl, previewScrollEl); });
    // TOC show button (re-open a collapsed TOC)
    { const b = $('#toc-show'); if (b) b.addEventListener('click', function () { setTocCollapsed(false); }); }
    // Copy button on code blocks
    // 預覽裡的圖片點兩下放大（使用者：「筆記的預覽，點兩下圖片要放大」）：一個 position: fixed 的燈箱，
    // 先縮到螢幕放得下，再點一下圖切 1:1（太大就可以捲），滾輪縮放，Esc／點暗處／✕ 關掉。只是看，什麼都不寫。
    function openLightbox(img) {
      const src = img.currentSrc || img.src; if (!src) return;
      const old = document.querySelector('.lightbox'); if (old) old.remove();
      const box = document.createElement('div');
      box.className = 'lightbox';
      box.innerHTML = '<div class="lightbox-bar"><span class="lightbox-cap"></span><span class="lightbox-zoom"></span>' +
        '<button type="button" class="lightbox-btn" data-lb="out" title="縮小">' + Icons.svg('minus') + '</button>' +
        '<button type="button" class="lightbox-btn" data-lb="in" title="放大">' + Icons.svg('plus') + '</button>' +
        '<button type="button" class="lightbox-btn" data-lb="fit" title="符合螢幕／原始大小">' + Icons.svg('maximize') + '</button>' +
        '<button type="button" class="lightbox-btn" data-lb="open" title="在新分頁開啟">' + Icons.svg('external-link') + '</button>' +
        '<button type="button" class="lightbox-btn" data-lb="close" title="關閉 (Esc)">' + Icons.svg('x') + '</button></div>' +
        '<div class="lightbox-stage"><img class="lightbox-img" alt=""></div>';
      document.body.appendChild(box);
      const pic = box.querySelector('.lightbox-img'), stage = box.querySelector('.lightbox-stage'), zoomEl = box.querySelector('.lightbox-zoom');
      box.querySelector('.lightbox-cap').textContent = img.getAttribute('alt') || '';
      pic.src = src;
      let scale = 1, fit = true;   // fit：縮到放得下；否則 scale 是相對原始大小的倍率
      function apply() {
        const nw = pic.naturalWidth || 1, nh = pic.naturalHeight || 1;
        const sw = stage.clientWidth - 32, sh = stage.clientHeight - 32;
        if (fit) scale = Math.min(1, sw / nw, sh / nh);
        pic.style.width = Math.round(nw * scale) + 'px';
        pic.style.height = Math.round(nh * scale) + 'px';
        box.classList.toggle('is-fit', fit);
        zoomEl.textContent = Math.round(scale * 100) + '%';
      }
      function setScale(v) { fit = false; scale = Math.max(0.1, Math.min(8, v)); apply(); }
      function close() { box.classList.add('is-out'); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', apply); setTimeout(function () { box.remove(); }, 160); }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === '+' || e.key === '=') { e.preventDefault(); setScale(scale * 1.25); }
        else if (e.key === '-') { e.preventDefault(); setScale(scale / 1.25); }
        else if (e.key === '0') { e.preventDefault(); fit = true; apply(); }
      }
      pic.addEventListener('load', apply);
      if (pic.complete) apply();
      // 點圖：符合螢幕 ↔ 1:1（1:1 比螢幕小的圖，點了就放到 2 倍）
      pic.addEventListener('click', function (e) { e.stopPropagation(); if (fit) { const nw = pic.naturalWidth, fitted = pic.offsetWidth; setScale(nw > fitted + 2 ? 1 : 2); } else { fit = true; apply(); } });
      stage.addEventListener('click', function (e) { if (e.target === stage) close(); });
      box.addEventListener('click', function (e) {
        const b = e.target.closest('[data-lb]'); if (!b) return;
        const a = b.getAttribute('data-lb');
        if (a === 'close') close(); else if (a === 'in') setScale(scale * 1.25); else if (a === 'out') setScale(scale / 1.25);
        else if (a === 'fit') { if (fit) setScale(1); else { fit = true; apply(); } }
        else if (a === 'open') window.open(img.getAttribute('data-img-id') ? '/api/images/' + img.getAttribute('data-img-id') : src, '_blank', 'noopener');   // 預覽裡的 src 是 blob:，新分頁要用真正的網址
      });
      box.addEventListener('wheel', function (e) { e.preventDefault(); setScale(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false });
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', apply);
    }
    previewEl.addEventListener('dblclick', function (e) {
      const img = e.target.closest('img');
      if (!img || img.closest('.lightbox, .img-tools, .link-card')) return;
      e.preventDefault();
      if (window.getSelection) { const sel = window.getSelection(); if (sel && sel.removeAllRanges) sel.removeAllRanges(); }   // 雙擊順便選到的字取消
      openLightbox(img);
    });
    previewEl.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      // 待辦清單：預覽裡的勾選框直接改寫原始 markdown（Notion 式）
      const task = e.target.closest('.task-check');
      if (task) {
        if (state.current && state.current.perm === 'read') { e.preventDefault(); return; }
        toggleTask(Number(task.getAttribute('data-task')), task.checked);
        return;
      }
      const mmBtn = e.target.closest('.mm-edit-btn');
      if (mmBtn) { e.preventDefault(); openMindMapBlock(mmBtn.closest('.mindmap-block')); return; }
      const rmBtn = e.target.closest('.rm-edit-btn');
      if (rmBtn) { e.preventDefault(); openRelMapBlock(rmBtn.closest('.relmap-block')); return; }
      // 嵌入的關聯分析（![名稱](relmap:id)）：縮放鈕改 SVG 的 viewBox，全螢幕鈕直接
      // 打開被引用的那一篇（它是 meta.relMap，openNote 會送進整頁編輯器）。
      const rmZoom = e.target.closest('[data-relmap-zoom]');
      if (rmZoom) {
        e.preventDefault();
        const box = rmZoom.closest('.relmap-embed');
        const svg = box && box.querySelector('svg');
        if (svg && svg._rmZoom) svg._rmZoom(rmZoom.getAttribute('data-relmap-zoom'));
        return;
      }
      const rmOpen = e.target.closest('[data-relmap-open]');
      if (rmOpen) { e.preventDefault(); saveNow(); openNote(rmOpen.getAttribute('data-relmap-open')); return; }
      const dioOpen = e.target.closest('[data-drawio-open]');
      if (dioOpen) { e.preventDefault(); saveNow(); openNote(dioOpen.getAttribute('data-drawio-open')); return; }
      const link = e.target.closest('.note-link');
      if (link) { e.preventDefault(); handleNoteLink(link); return; }
      const tag = e.target.closest('.hashtag');
      if (tag) { e.preventDefault(); browseTag(tag.getAttribute('data-tag')); return; }
      const anno = e.target.closest('.img-annotate');
      if (anno) { e.preventDefault(); openAnnotator(anno.getAttribute('data-annotate')); return; }
      const frameBtn = e.target.closest('.img-frame-btn');
      if (frameBtn) { e.preventDefault(); toggleImageFrame(frameBtn); return; }
      // 內文 [toc] 的展開鈕：預設只列到 ##，點了才顯示底下的 ###
      const tocToggle = e.target.closest('.md-toc-toggle');
      if (tocToggle) {
        e.preventDefault();
        const key = tocToggle.getAttribute('data-toc');
        const li = tocToggle.closest('li');
        const open = li.classList.toggle('open');
        if (open) tocOpen.add(key); else tocOpen.delete(key);
        return;
      }
      // Inline [toc] entries: scroll the preview pane instead of changing the URL hash.
      const tocLink = e.target.closest('.md-toc a[href^="#"]');
      if (tocLink) {
        e.preventDefault();
        const id = decodeURIComponent(tocLink.getAttribute('href').slice(1));
        const target = id && previewEl.querySelector('[id="' + id.replace(/"/g, '\\"') + '"]');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const btn = e.target.closest('.code-copy');
      if (!btn) return;
      const block = btn.closest('.code-block');
      if (!block) return;
      // Numbered blocks hold one <code> per <li> (see markdown.js) instead of
      // a single blob, so their lines have to be rejoined for copying.
      const lines = block.querySelectorAll('.code-lines > li');
      const text = lines.length
        ? Array.prototype.map.call(lines, function (li) { return li.textContent; }).join('\n')
        : (block.querySelector('pre code') || {}).textContent;
      if (text != null) copyText(text, btn);
    });

    // ---- 中鍵（滾輪按下）開新分頁 ----
    // 清單上的筆記列、側邊欄的樹、資料夾磚、電子書磚、搜尋結果、隨筆卡片、預覽裡的 [[wiki]] 與
    // #標籤：點了會開東西的地方，中鍵就在新分頁開同一個東西（跟一般網站的連結一樣）。
    // 真正的 <a href="http…"> 瀏覽器自己會處理，這裡不碰。mousedown 也要擋：Chrome 在非連結
    // 的地方按中鍵會進入自動捲動模式。
    // 使用者（2026-10-11）：「所有連結按下滾輪都要可以開新分頁」——所以不只筆記列：側邊欄的區域列、
    // 麵包屑、標籤、trello／xmind 磚、start.me 分頁、timetree 的行事曆列、課程進度的課程與章節筆記、
    // 電子書目錄、檔案管理「使用於」的筆記、嵌入圖的「全螢幕／編輯」、標題列的資料夾前綴，都算。
    const NAV_HASH = { 'course-open-btn': '#course', 'quick-open-btn': '#quick', 'knowledge-open-btn': '#knowledge', 'board-open-btn': '#board', 'start-open-btn': '#start', 'xmind-open-btn': '#xmind', 'timetree-open-btn': '#timetree', 'progress-open-btn': '#progress', 'foodmap-open-btn': '#foodmap', 'novel-open-btn': '#novel', 'images-open-btn': '#files', 'trash-open-btn': '#trash' };
    function middleTarget(t) {
      if (!t || !t.closest) return null;
      const fh = function (f) { return f ? (f.area ? '#' + f.area + '/' + f.id : '#folder/' + f.id) : null; };
      const folderById = function (id) { return state.folders.find(function (f) { return f.id === id; }); };
      let el;
      if ((el = t.closest('.note-link[data-note-id]'))) return '#note/' + el.getAttribute('data-note-id');
      if ((el = t.closest('.hashtag[data-tag], .tag-chip[data-tag], .dash-row-tag[data-tag]'))) return '#tag/' + encodeURIComponent(el.getAttribute('data-tag'));
      if ((el = t.closest('.book-tree-link[data-note-id]'))) return '#note/' + el.getAttribute('data-note-id');
      if (t.closest('a[href]')) return null;
      if (t.closest('.trash-row')) return null;   // 垃圾桶裡的筆記開不了（#note/<id> 會 404）
      if ((el = t.closest('.dash-note-wrap[data-id], #tree .note-row[data-id], .search-row[data-id], .qn-card[data-id], .boards-tile[data-id], .xmi-tile[data-id], .vd-card[data-id], .vd-stats [data-id]'))) return '#note/' + el.dataset.id;
      if ((el = t.closest('.pa-tab[data-pa]'))) return el.getAttribute('data-pa') === 'videos' ? '#videos' : '#novel';
      if ((el = t.closest('.sp-tab[data-page]'))) return '#note/' + el.getAttribute('data-page');
      if ((el = t.closest('.tt-cal[data-cal]'))) return '#note/' + el.getAttribute('data-cal');
      if ((el = t.closest('.pg-course[data-course]'))) return '#note/' + el.getAttribute('data-course');
      if ((el = t.closest('[data-open-note], .imglib-use[data-note-id], [data-relmap-open], [data-drawio-open]'))) return '#note/' + (el.getAttribute('data-open-note') || el.getAttribute('data-note-id') || el.getAttribute('data-relmap-open') || el.getAttribute('data-drawio-open'));
      if ((el = t.closest('.pg-page [data-act="calendar"]'))) return '#timetree';
      if ((el = t.closest('.pg-page [data-act="folder"][data-folder]'))) return fh(folderById(el.getAttribute('data-folder')));
      if ((el = t.closest('.dash-book-tile[data-id]'))) return '#book/' + el.dataset.id;
      if ((el = t.closest('.dash-folder-tile[data-id], #tree .folder-row[data-id]'))) return fh(folderById(el.dataset.id));
      if ((el = t.closest('.dash-crumb[data-folder]'))) return el.dataset.folder ? fh(folderById(el.dataset.folder)) : (el.dataset.area ? '#' + el.dataset.area : '#');
      if (t.closest('#note-path')) { const n = state.current || (toolBar && toolBar.note()); return n && n.folderId ? fh(folderById(n.folderId)) : null; }
      if ((el = t.closest('.sidebar-nav-item[id]')) && NAV_HASH[el.id]) return NAV_HASH[el.id];
      if (t.closest('#topbar .logo')) return '#';   // logo = 回首頁
      return null;
    }
    document.addEventListener('mousedown', function (e) {
      if (e.button === 1 && middleTarget(e.target)) e.preventDefault();
    });
    document.addEventListener('auxclick', function (e) {
      if (e.button !== 1) return;
      const h = middleTarget(e.target);
      if (!h) return;
      e.preventDefault(); e.stopPropagation();
      window.open(location.pathname + location.search + h, '_blank', 'noopener');
    }, true);

    titleEl.addEventListener('input', scheduleSave);
    titleEl.addEventListener('input', fitNoteTitle);
    // 開著的是圖表（toolBar）：scheduleSave 不會動它（state.current 是空的），標題走它自己那條
    titleEl.addEventListener('input', function () { if (!state.current && toolBar) toolBar.titleInput(titleEl.value); });
    titleEl.addEventListener('change', function () { if (!state.current && toolBar) toolBar.commitTitle(); });
    if (notePathEl) notePathEl.addEventListener('click', function () {
      const n = state.current || (toolBar && toolBar.note());
      if (n && n.folderId) goToFolder(n.folderId);
    });

    // 匯入 .md：建到「現在所在的地方」——跟側邊欄的「新增」同一套判斷（currentFolderId /
    // areaForNew）：課程筆記／知識區／小說正在看的資料夾、首頁正在看的資料夾、電子書的資料夾，
    // 在隨筆頁就是隨筆。以前一律建在「所有筆記」最上層，在區域裡匯入的東西得自己再搬過去。
    // 兩種：挑幾個 .md 檔，或挑一整個資料夾（連子資料夾一起）。選單上直接寫出會匯到哪裡。
    $('#import-btn').addEventListener('click', function (e) {
      e.stopPropagation();   // 跟其他 openMenuAt 的觸發鈕一樣，不然同一下點擊冒泡到 document 就把選單關掉了
      const r = e.currentTarget.getBoundingClientRect();
      const t = importTarget();
      openMenuAt(r.left, r.top - 8, [
        { icon: 'file-text', label: '匯入 .md（圖片可一起選）', fn: function () { $('#import-input').click(); } },
        { icon: 'folder', label: '匯入整個資料夾', fn: function () { $('#import-dir-input').click(); } },
        { icon: '', label: '→ 匯到「' + t.label + '」', fn: function () {} }
      ]);
      // 選單從按鈕往上長（按鈕在側邊欄最底下）
      ctxMenu.style.top = Math.max(8, r.top - ctxMenu.offsetHeight - 4) + 'px';
      const hint = ctxMenu.lastElementChild;
      if (hint) { hint.disabled = true; hint.classList.add('ctx-hint'); }
    });
    ['#import-input', '#import-dir-input'].forEach(function (sel) {
      const inp = $(sel);
      if (!inp) return;
      inp.addEventListener('change', function (e) {
        const files = Array.prototype.slice.call(e.target.files || []);
        e.target.value = '';
        if (files.length) importMarkdownFiles(files);
      });
    });

    initDivider();
  }

  // Shared with other modules (admin.js reuses the confirm dialog).
  // uploadFiles：封面設計器（js/cover.js，由 pdf.js 打開）上傳 Logo／底圖用——資安院／成效報告的 PDF 也從它們自己的模組開預覽，所以放在 App 上
  window.App = { confirm: showConfirm, prompt: showPrompt, toast: toast, reload: loadData, uploadFiles: function (files) { return uploadFiles(files, {}); } };

  // Go
  init();
})();
