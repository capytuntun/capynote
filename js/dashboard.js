/* dashboard.js — 首頁儀表板（沒有開啟筆記時顯示於右側）
 *
 * 版面：頁面標題（含可點的麵包屑）→ #標籤 → 資料夾方框 → 筆記條列。
 * 沒有外框，直接鋪在整個頁面上；資料夾是方框（右上角有「⋮」選單），筆記是
 * 條列，滑過去才出現勾選框與「釘選／改標題／⋯」。標籤篩選時平列所有帶該標籤
 * 的筆記。全部由目前載入的 state（notes / folders）即時計算，不需額外 API。
 *
 * 用法：Dashboard.render(opts) / Dashboard.refresh(opts)
 *   notes, folders            目前資料
 *   onOpen(noteId)            開啟筆記
 *   onBook(folderId)          以電子書模式閱讀整個資料夾（book.js）
 *   onBookRemove(folderId)    電子書方塊的 ✕：把資料夾移出電子書區（清 is_book）
 *   onBookUpdate(folderId)    資料夾頁的「更新到電子書」（只有 is_book 的資料夾才有）
 *   onPin(note, on)           釘選／取消釘選（存在 note.meta.pinned）
 *   onRename(note, title)     改筆記標題
 *   onMenu(note, el)          筆記的「⋯」選單
 *   onFolderMenu(folder, el)  資料夾的「⋮」選單
 *   onFolderRename(folder, n) 改資料夾名稱
 *   selection                 { has(id), toggle(id, on) }，與側邊欄共用批次選取
 * render() 會清掉標籤篩選（回首頁 = 顯示全部）；refresh() 保留目前的資料夾與篩選。
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
  function ic(name, cls) { return (global.Icons && Icons.svg) ? Icons.svg(name, cls) : ''; }

  const isMine = function (n) { return !n.perm || n.perm === 'owner'; };
  const isPinned = function (n) { return !!(n.meta && n.meta.pinned); };
  function noteKind(n) {
    if (n.meta && n.meta.perfReport) return { icon: 'chart', label: '成效報告', cls: 'kind-perf' };
    if (n.meta && n.meta.secReport) return { icon: 'shield', label: '資安院報告', cls: 'kind-sec' };
    // 關聯分析：這裡原本漏了，落到最後一行，在首頁看起來跟一般筆記一模一樣（側邊欄的樹
    // 跟區域頁倒是有分）。圖示跟「新增 → 關聯分析」、側邊欄用的是同一個。
    if (n.meta && n.meta.relMap) return { icon: 'network', label: '關聯分析', cls: 'kind-relmap' };
    if (n.meta && n.meta.drawio) return { icon: 'shapes', label: 'drawio', cls: 'kind-drawio' };
    if (n.meta && n.meta.board) return { icon: 'kanban', label: 'trello', cls: 'kind-board' };
    if (n.meta && n.meta.startpage) return { icon: 'layout-grid', label: 'start.me', cls: 'kind-start' };
    if (n.meta && n.meta.xmind) return { icon: 'mind-map', label: 'xmind', cls: 'kind-xmind' };
    if (n.meta && n.meta.timetree) return { icon: 'calendar', label: 'timetree', cls: 'kind-timetree' };
    if (n.meta && n.meta.progress) return { icon: 'list-checks', label: '課程進度', cls: 'kind-progress' };
    if (n.meta && n.meta.foodmap) return { icon: 'map-pin', label: '圖資中心', cls: 'kind-foodmap' };
    if (n.meta && n.meta.doc) return { icon: 'file-pen', label: '文件', cls: 'kind-doc' };
    if (n.meta && n.meta.video) return { icon: 'film', label: '影片', cls: 'kind-video' };
    return { icon: 'file-text', label: '', cls: '' };
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

  // ---- 狀態 ----------------------------------------------------------------
  let curFolderId = null;          // 目前瀏覽到哪個資料夾（null = 最上層）
  let lastOpts = null;             // 記住最近一次 render 的資料，供導覽時重繪
  let tagFilter = null;            // 目前的 #標籤 篩選（null = 不篩選）

  // 排序跟側邊欄共用一套（js/sorting.js）：釘選的永遠在最前面，其餘看目前的排序方式
  function foldersIn(folders, parentId) {
    return folders
      .filter(function (f) { return (f.parentId || null) === parentId; })
      .sort(function (a, b) { return Sorting.compareFolders(a, b); });
  }
  function sortNotes(list) {
    return list.sort(function (a, b) { return Sorting.compareNotes(a, b); });
  }
  function notesIn(notes, folderId) {
    return sortNotes(notes.filter(function (n) { return isMine(n) && (n.folderId || null) === folderId; }));
  }
  function folderById(folders, id) {
    for (let i = 0; i < folders.length; i++) if (folders[i].id === id) return folders[i];
    return null;
  }
  function countNotesDeep(notes, folders, folderId) {
    let c = notesIn(notes, folderId).length;
    foldersIn(folders, folderId).forEach(function (f) { c += countNotesDeep(notes, folders, f.id); });
    return c;
  }
  function crumbPath(folders, id) {
    const path = [];
    let cur = id;
    const guard = {};
    while (cur && !guard[cur]) {
      guard[cur] = true;
      const f = folderById(folders, cur);
      if (!f) break;
      path.unshift(f);
      cur = f.parentId || null;
    }
    return path;
  }

  function navigate(folderId) {
    curFolderId = folderId || null;
    paint();
  }
  // 使用者自己點進／點出資料夾（方框、麵包屑）：切換畫面之外，也讓 app.js 在網址留一筆
  // #folder/<id> 的瀏覽紀錄，瀏覽器的「上一頁」才會一層層退回「所有筆記」。app.js 自己
  // 呼叫的 openFolder（例如跟著上一頁切換）直接走 navigate，不再多留紀錄。
  function go(folderId) {
    navigate(folderId);
    if (lastOpts && lastOpts.onNavigate) lastOpts.onNavigate(curFolderId);
  }
  function setTag(tag) {
    tagFilter = tag || null;
    paint();
  }

  function collectTags(notes) {
    const map = {};
    notes.filter(isMine).forEach(function (n) {
      const tags = (global.MD && MD.noteTags) ? MD.noteTags(n) : [];
      tags.forEach(function (t) {
        const k = t.toLowerCase();
        if (!map[k]) map[k] = { tag: t, count: 0 };
        map[k].count++;
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hant'); });
  }

  // ---- 就地改名（資料夾方框與筆記列共用同一套行為）---------------------------
  function inlineRename(host, current, cls, onDone) {
    if (host.parentNode.querySelector('.' + cls)) return;
    const input = el('input', cls);
    input.type = 'text';
    input.value = current || '';
    // 方框和筆記列都可以拖拉；改名時暫停，不然在框裡拖選文字會變成把整塊拖走
    const dragHost = host.closest('[draggable="true"]');
    if (dragHost) dragHost.draggable = false;
    host.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    function finish(save) {
      if (done) return;
      done = true;
      if (dragHost) dragHost.draggable = true;
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

  // ---- 頁面標題 + 麵包屑 -----------------------------------------------------
  // 最上層時標題就是「所有筆記」；進到資料夾後，上方多一行可點的路徑，
  // 標題換成目前的資料夾名稱，點路徑上的任何一段都能跳回去。
  function renderHead(o) {
    const head = el('header', 'dash-head');
    const main = el('div', 'dash-head-main');
    const path = crumbPath(o.folders, curFolderId);

    // The breadcrumb is always present, including at the top level where it is a
    // single 所有筆記 crumb. A path that appears only once you are inside a folder
    // reads as an error message rather than as navigation, and there is nowhere
    // to drop a note you want to move back out to the top.
    const nav = el('nav', 'dash-crumbs');
    nav.setAttribute('aria-label', '資料夾路徑');

    function crumb(label, iconName, folderId, isCurrent) {
      const c = el('button', 'dash-crumb' + (isCurrent ? ' is-current' : ''),
        (iconName ? ic(iconName) : '') + '<span>' + esc(label) + '</span>');
      c.type = 'button';
      c.dataset.folder = folderId || '';   // 中鍵開新分頁用（app.js middleTarget）
      if (isCurrent) {
        c.setAttribute('aria-current', 'page');
      } else {
        c.title = '回到「' + (label) + '」';
        c.addEventListener('click', function () { tagFilter = null; go(folderId); });
      }
      // Every crumb accepts a drop, so dragging onto an ancestor moves a note (or a
      // folder tile) up the tree — the reverse of dropping it onto a folder tile.
      makeDropTarget(c, folderId, o, true);
      return c;
    }

    const atRoot = !curFolderId && !tagFilter;
    nav.appendChild(crumb('所有筆記', 'layout-grid', null, atRoot));
    path.forEach(function (f, i) {
      nav.appendChild(el('span', 'dash-crumb-sep', ic('chevron-right')));
      nav.appendChild(crumb(f.name || '未命名資料夾', null, f.id,
        !tagFilter && i === path.length - 1));
    });
    if (tagFilter) {
      nav.appendChild(el('span', 'dash-crumb-sep', ic('chevron-right')));
      const t = el('button', 'dash-crumb is-current', ic('tag') + '<span>' + esc(tagFilter) + '</span>');
      t.type = 'button';
      t.setAttribute('aria-current', 'page');
      nav.appendChild(t);
    }
    main.appendChild(nav);

    // 目前層的內容量，當麵包屑的副標——不再另外疊一個「所有筆記」大標題，
    // 麵包屑本身（含目前這一段的醒目樣式）就是頁面標題。
    if (!tagFilter) {
      const subs = foldersIn(o.folders, curFolderId).length;
      const ns = notesIn(o.notes, curFolderId).length;
      const bits = [];
      if (subs) bits.push(subs + ' 個資料夾');
      bits.push(ns + ' 篇筆記');
      main.appendChild(el('div', 'dash-subtitle', esc(bits.join('・'))));
    }
    head.appendChild(main);

    const right = el('div', 'dash-head-right');
    right.appendChild(viewToggle(function () { paint(); }, viewKey('home', curFolderId)));
    if (o.onSortMenu) {
      const s = el('button', 'btn dash-sort-btn', ic('arrow-up-down') + '<span>排序：</span>' +
        '<span class="dash-sort-mode">' + esc(Sorting.info().short) + '</span>');
      s.type = 'button';
      s.title = '排序方式（側邊欄也用同一套）；手動排序時可以直接拖拉筆記和資料夾';
      s.setAttribute('aria-haspopup', 'true');
      s.addEventListener('click', function (e) { e.stopPropagation(); o.onSortMenu(s); });
      right.appendChild(s);
    }
    if (tagFilter) {
      const clear = el('button', 'btn', ic('x') + '<span>清除篩選</span>');
      clear.type = 'button';
      clear.addEventListener('click', function () { setTag(null); });
      right.appendChild(clear);
    } else if (curFolderId && o.onBookUpdate && (folderById(o.folders, curFolderId) || {}).isBook) {
      // 只有做成電子書的資料夾才有這顆鈕：把公開分享連結用目前內容重新打包，
      // 再打開閱讀器。沒做成電子書的資料夾什麼都不顯示（要做就走 新增 → 電子書）。
      const b = el('button', 'btn btn-primary dash-book-btn', ic('book-open') + '<span>更新到電子書</span>');
      b.type = 'button';
      b.title = '用這個資料夾目前的內容重新打包公開分享連結，然後打開電子書';
      b.addEventListener('click', function () { o.onBookUpdate(curFolderId); });
      right.appendChild(b);
    }
    head.appendChild(right);
    return head;
  }

  // ---- #標籤 ---------------------------------------------------------------
  // 列上的小籤片：筆記選單「標籤…」加的 meta.tags（內文裡的 #標籤本來就在內文裡看得到）。點一下就篩選。
  function rowTags(note, onPick) {
    const box = el('span', 'dash-row-tags');
    const tags = (note.meta && Array.isArray(note.meta.tags)) ? note.meta.tags.slice(0, 4) : [];
    tags.forEach(function (t) {
      const b = el('button', 'dash-row-tag', '#' + esc(t));
      b.type = 'button'; b.title = '篩選「#' + t + '」'; b.dataset.tag = t;
      b.addEventListener('click', function (e) { e.stopPropagation(); if (onPick) onPick(t); });
      box.appendChild(b);
    });
    if (note.meta && Array.isArray(note.meta.tags) && note.meta.tags.length > 4) box.appendChild(el('span', 'dash-row-tag is-more', '+' + (note.meta.tags.length - 4)));
    return box;
  }
  function renderTagCloud(notes) {
    const tags = collectTags(notes);
    if (!tags.length) return null;
    const sec = el('section', 'dash-section dash-tags');
    sec.appendChild(sectionHead('tag', '標籤', tags.length));
    const cloud = el('div', 'dash-tag-cloud');
    tags.forEach(function (t) {
      const active = tagFilter && tagFilter.toLowerCase() === t.tag.toLowerCase();
      const chip = el('button', 'tag-chip' + (active ? ' active' : ''));
      chip.type = 'button'; chip.dataset.tag = t.tag;
      chip.innerHTML = '<span class="tag-hash">#</span>' + esc(t.tag) + '<span class="tag-count">' + t.count + '</span>';
      chip.addEventListener('click', function () { setTag(active ? null : t.tag); });
      cloud.appendChild(chip);
    });
    sec.appendChild(cloud);
    return sec;
  }

  // ---- 資料夾方框 -------------------------------------------------------------
  // ---- Drag notes into folders --------------------------------------------
  //
  // The payload rides on a private MIME type rather than a module variable, so a
  // drag that starts here is inert everywhere else on the page (and a drag that
  // starts elsewhere — a file, a link — never looks like a note move).
  const DND = 'application/x-strikenote-notes';
  let dragging = null;   // ids being dragged, for the dragover check

  function beginNoteDrag(e, note, o) {
    // Dragging one of several selected notes moves the whole selection, which is
    // what the checkboxes are for; dragging an unselected note moves just it.
    let ids = [note.id];
    if (o.selection && o.selection.has(note.id) && o.selection.ids) {
      const all = o.selection.ids();
      if (all.length > 1) ids = all;
    }
    dragging = ids;
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData(DND, JSON.stringify(ids));
      // A plain-text fallback keeps the cursor from showing "no drop" in browsers
      // that ignore unknown MIME types during dragover.
      e.dataTransfer.setData('text/plain', note.title || '');
    } catch (err) { /* older browsers restrict setData; the module var still works */ }
    e.stopPropagation();
  }

  function isNoteDrag(e) {
    if (dragging) return true;
    const t = e.dataTransfer && e.dataTransfer.types;
    return !!(t && Array.prototype.indexOf.call(t, DND) >= 0);
  }

  // ---- 拖拉排序（js/sorting.js）--------------------------------------------
  // 筆記列拖到另一列的上半／下半 = 插在它前面／後面；資料夾方框拖到另一個方框的左右兩側
  // = 插在前後，拖到正中間 = 放進那個資料夾。順序由 app.js 存（onReorderNotes /
  // onPlaceFolders），不是手動排序時會自動切成手動。
  const DND_FOLDER = 'application/x-strikenote-folder';
  let draggingFolder = null;
  function isFolderDrag(e) {
    if (draggingFolder) return true;
    const t = e.dataTransfer && e.dataTransfer.types;
    return !!(t && Array.prototype.indexOf.call(t, DND_FOLDER) >= 0);
  }
  function clearDropHints() {
    document.querySelectorAll('#dashboard .drop-target, #dashboard .drop-before, #dashboard .drop-after')
      .forEach(function (n) { n.classList.remove('drop-target', 'drop-before', 'drop-after'); });
  }
  function draggedNoteIds(e) {
    let ids = dragging;
    try {
      const raw = e.dataTransfer.getData(DND);
      if (raw) ids = JSON.parse(raw);
    } catch (err) { /* fall back to the ids captured on dragstart */ }
    return ids || [];
  }

  // 一列筆記當排序落點：只在「目前這一層」（不是標籤篩選）才有意義
  function makeNoteRowDrop(wrap, note, o) {
    if (!o.onReorderNotes) return;
    wrap.addEventListener('dragover', function (e) {
      if (!isNoteDrag(e) || tagFilter) return;
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
      if (!isNoteDrag(e) || tagFilter) return;
      e.preventDefault();
      e.stopPropagation();
      const after = wrap.classList.contains('drop-after');
      clearDropHints();
      const ids = draggedNoteIds(e);
      dragging = null;
      if (ids.length && !(ids.length === 1 && ids[0] === note.id)) {
        o.onReorderNotes(ids, curFolderId, note.id, after);
      }
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
      } catch (err) { /* the module var still works */ }
      e.stopPropagation();
    });
    tile.addEventListener('dragend', function () { draggingFolder = null; clearDropHints(); });
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
      let id = draggingFolder;
      try { id = e.dataTransfer.getData(DND_FOLDER) || id; } catch (err) { /* keep the module var */ }
      draggingFolder = null;
      if (!id || id === folder.id) return;
      if (before || after) o.onPlaceFolders([id], folder.parentId || null, folder.id, after);
      else o.onPlaceFolders([id], folder.id, null, true);
    });
  }

  // `folderId` may be null, which means "the top level" — that is how a note gets
  // dragged back out of a folder onto the 所有筆記 crumb. With `acceptFolders`
  // (the crumbs) a dragged folder tile can be dropped there too.
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
        let id = draggingFolder;
        try { id = e.dataTransfer.getData(DND_FOLDER) || id; } catch (err) { /* keep the module var */ }
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

  // 電子書方塊：點了用閱讀器打開；右上角的 ✕ 只是移出電子書區（清掉 is_book），
  // 資料夾與筆記都還在。版型借用資料夾方塊的 head / meta / acts。
  function makeBookTile(folder, o) {
    const chapters = countNotesDeep(o.notes, o.folders, folder.id);
    const tile = el('div', 'dash-book-tile');
    tile.dataset.id = folder.id;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.title = '以電子書閱讀';
    const head = el('div', 'dash-folder-head');
    head.appendChild(el('span', 'dash-folder-ic dash-book-ic', ic('book-open')));
    head.appendChild(el('span', 'dash-folder-name', esc(folder.name || '未命名資料夾')));
    tile.appendChild(head);
    tile.appendChild(el('div', 'dash-folder-meta', esc(chapters + ' 章')));
    function open() { if (o.onBook) o.onBook(folder.id); }
    tile.addEventListener('click', open);
    tile.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    if (o.onBookRemove) {
      const acts = el('div', 'dash-folder-acts');
      const x = el('button', 'dash-folder-menu dash-book-remove', ic('x'));
      x.type = 'button';
      x.title = '移出電子書區（資料夾與筆記都不會被刪除）';
      x.addEventListener('click', function (e) { e.stopPropagation(); o.onBookRemove(folder.id); });
      acts.appendChild(x);
      tile.appendChild(acts);
    }
    return tile;
  }

  function makeFolderTile(folder, o) {
    const notes = o.notes, folders = o.folders;
    const subs = foldersIn(folders, folder.id);
    const deep = countNotesDeep(notes, folders, folder.id);
    const metaBits = [deep + ' 筆記'];
    if (subs.length) metaBits.push(subs.length + ' 子資料夾');

    const tile = el('div', 'dash-folder-tile');
    tile.dataset.id = folder.id;
    tile.style.setProperty('--fc', folderColor(folder.id));   // 每個資料夾自己的顏色（圖示、色條、光暈）
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.title = '打開資料夾';
    makeDropTarget(tile, folder.id, o);
    makeFolderTileDnD(tile, folder, o);

    const head = el('div', 'dash-folder-head');
    head.appendChild(el('span', 'dash-folder-ic', ic('folder')));
    const nameEl = el('span', 'dash-folder-name', esc(folder.name || '未命名資料夾'));
    head.appendChild(nameEl);
    tile.appendChild(head);
    tile.appendChild(el('div', 'dash-folder-meta', esc(metaBits.join('・'))));

    // 右上角：電子書 + 直式「⋮」選單
    const acts = el('div', 'dash-folder-acts');
    if (o.onBook && deep > 0) {
      const b = el('button', 'dash-folder-book', ic('book-open') + '<span>電子書</span>');
      b.type = 'button';
      b.title = '以電子書模式閱讀這個資料夾';
      b.addEventListener('click', function (e) { e.stopPropagation(); o.onBook(folder.id); });
      acts.appendChild(b);
    }
    if (o.onFolderMenu) {
      const m = el('button', 'dash-folder-menu', ic('more-vertical'));
      m.type = 'button';
      m.title = '更多';
      m.addEventListener('click', function (e) { e.stopPropagation(); o.onFolderMenu(folder, m); });
      acts.appendChild(m);
    }
    tile.appendChild(acts);

    tile.addEventListener('dblclick', function (e) {
      if (!o.onFolderRename) return;
      e.preventDefault(); e.stopPropagation();
      renameTile(folder, nameEl, o);
    });
    tile.addEventListener('click', function () { go(folder.id); });
    tile.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(folder.id); }
      else if (e.key === 'F2') { e.preventDefault(); renameTile(folder, nameEl, o); }
    });
    return tile;
  }
  function renameTile(folder, nameEl, o) {
    inlineRename(nameEl, folder.name || '', 'dash-folder-edit', function (val) {
      if (o.onFolderRename) o.onFolderRename(folder, val);
    });
  }

  // ---- 筆記條列 ---------------------------------------------------------------
  function actBtn(icon, title, cls, fn) {
    const b = el('button', 'dash-row-act' + (cls ? ' ' + cls : ''), ic(icon));
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(e, b); });
    return b;
  }

  function makeNoteRow(note, o) {
    const k = noteKind(note);
    const mine = isMine(note);
    const pinned = isPinned(note);
    const wrap = el('div', 'dash-note-wrap' + (pinned ? ' pinned' : ''));
    wrap.dataset.id = note.id;

    // Only my own notes can be filed. A note shared with me lives in the owner's
    // tree, so dragging it into one of my folders would do nothing.
    if (mine && o.onMoveNotes) {
      wrap.draggable = true;
      wrap.addEventListener('dragstart', function (e) { beginNoteDrag(e, note, o); });
      wrap.addEventListener('dragend', function () {
        dragging = null;
        clearDropHints();
      });
      makeNoteRowDrop(wrap, note, o);
    }

    if (o.selection && mine) {
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
    row.appendChild(rowTags(note, function (t) { setTag(t); }));
    // 開放給網站內所有人的筆記要看得出來：設定完就把對話框關掉了，清單上沒有任何標記
    // 的話，等於沒辦法知道自己到底開放了哪幾篇（不小心開的那幾篇尤其重要）。
    if ((note.access || 'restricted') === 'site') {
      const g = el('span', 'dash-row-shared', ic('globe'));
      g.title = '網站內所有人可以' + (note.accessPerm === 'edit' ? '編輯' : '檢視');
      row.appendChild(g);
    }
    // 有公開連結（沒有帳號的人也看得到）的筆記同理要標出來
    if (note.publicLink) {
      const g = el('span', 'dash-row-shared dash-row-public', ic('link'));
      g.title = '有公開連結：拿到網址的人不用帳號就看得到';
      row.appendChild(g);
    }
    const meta = el('span', 'dash-row-meta');
    if (k.label) meta.appendChild(el('span', 'dash-row-kind ' + k.cls, k.label));
    meta.appendChild(el('span', 'dash-row-time', esc(relTime(note.updatedAt))));
    row.appendChild(meta);
    row.addEventListener('click', function () { o.onOpen(note.id); });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); o.onOpen(note.id); }
      else if (e.key === 'F2' && mine) { e.preventDefault(); startNoteRename(); }
    });
    wrap.appendChild(row);

    function startNoteRename() {
      inlineRename(titleEl, note.title || '', 'dash-row-edit', function (val) {
        if (o.onRename) o.onRename(note, val);
      });
    }

    if (mine) {
      const acts = el('div', 'dash-row-actions');
      acts.appendChild(actBtn('pin', pinned ? '取消釘選' : '釘選到最上面', pinned ? 'on' : '', function () {
        if (o.onPin) o.onPin(note, !pinned);
      }));
      acts.appendChild(actBtn('pencil', '修改標題', '', startNoteRename));
      acts.appendChild(actBtn('more-horizontal', '更多', '', function (e, b) {
        if (o.onMenu) o.onMenu(note, b);
      }));
      wrap.appendChild(acts);
    }
    return wrap;
  }

  function sectionHead(icon, label, count) {
    return el('div', 'dash-section-head',
      ic(icon) + '<span>' + esc(label) + '</span>' +
      (count != null ? '<span class="dash-section-count">' + count + '</span>' : ''));
  }

  // ---- 內容區 ---------------------------------------------------------------
  function renderBody(o) {
    const frag = document.createDocumentFragment();
    if (tagFilter) {
      const key = tagFilter.toLowerCase();
      const matches = sortNotes((o.allNotes || o.notes).filter(function (n) {
        if (!isMine(n)) return false;
        const tags = (global.MD && MD.noteTags) ? MD.noteTags(n) : [];
        return tags.some(function (t) { return t.toLowerCase() === key; });
      }));
      const sec = el('section', 'dash-section');
      const mh = sectionHead('file-text', '筆記', matches.length);
      const msa = selAllButton(matches, o);
      if (msa) mh.appendChild(msa);
      const msd = selDelButton(matches, o, '篇');
      if (msd) mh.appendChild(msd);
      sec.appendChild(mh);
      const body = el('div', 'dash-list');
      if (!matches.length) body.appendChild(emptyState('tag', '沒有帶有 #' + tagFilter + ' 的筆記。'));
      matches.forEach(function (n) { body.appendChild(makeNoteRow(n, o)); });
      sec.appendChild(body);
      frag.appendChild(sec);
      return frag;
    }

    if (curFolderId && !folderById(o.folders, curFolderId)) curFolderId = null;
    const subs = foldersIn(o.folders, curFolderId);
    const ns = notesIn(o.notes, curFolderId);

    // 電子書區搬到知識區了（使用者要的：「首頁的電子書拿掉，放到知識區」）；這段留著給 o.showBooks，
    // 首頁的 dashOpts 沒有開它。知識區那邊是 areabrowser.js 用 Dashboard.makeBookTile 畫同一種磚。
    if (!curFolderId && o.showBooks) {
      const books = o.folders.filter(function (f) { return f.isBook; }).sort(function (a, b) {
        return (a.name || '').localeCompare(b.name || '', 'zh-Hant');
      });
      const sec = el('section', 'dash-section');
      sec.appendChild(sectionHead('book-open', '電子書', books.length));
      if (books.length) {
        const grid = folderGrid(viewKey('home', curFolderId));
        books.forEach(function (f) { grid.appendChild(makeBookTile(f, o)); });
        sec.appendChild(grid);
      } else {
        sec.appendChild(emptyState('book-open', '還沒有電子書。從左側「新增 → 電子書」把一個資料夾做成電子書，它就會放在這裡。'));
      }
      frag.appendChild(sec);
    }

    if (subs.length) {
      const sec = el('section', 'dash-section');
      sec.appendChild(sectionHead('folder', '資料夾', subs.length));
      const grid = folderGrid(viewKey('home', curFolderId));
      subs.forEach(function (f) { grid.appendChild(makeFolderTile(f, o)); });
      sec.appendChild(grid);
      frag.appendChild(sec);
    }

    const sec2 = el('section', 'dash-section');
    const h2 = sectionHead('file-text', curFolderId ? '筆記' : '未歸類筆記', ns.length);
    const sa = selAllButton(ns, o);
    if (sa) h2.appendChild(sa);
    const sd = selDelButton(ns, o, '篇');
    if (sd) h2.appendChild(sd);
    sec2.appendChild(h2);
    const body = el('div', 'dash-list');
    if (!ns.length) {
      body.appendChild(emptyState('file-text',
        !subs.length && !curFolderId ? '還沒有筆記。從左側的「筆記」或上方的報告模式開始吧。' :
        curFolderId ? '這個資料夾裡還沒有筆記。' : '所有筆記都已歸入資料夾。'));
    }
    ns.forEach(function (n) { body.appendChild(makeNoteRow(n, o)); });
    sec2.appendChild(body);
    frag.appendChild(sec2);
    return frag;
  }

  function emptyState(icon, text) {
    return el('div', 'dash-empty', ic(icon) + '<span>' + esc(text) + '</span>');
  }
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


  // ---- 資料夾的顯示方式：方格（預設）或清單（像筆記一樣一列一列、由上到下）。首頁與區域頁共用同一顆按鈕，
  // 但「哪些地方用清單、哪些用方格」是每個位置各自記住的（使用者要的）：位置 = 頁面 + 瀏覽到的資料夾
  // （首頁最上層 'home'、首頁某資料夾 'home/<id>'、課程筆記 'course'、其某資料夾 'course/<id>'……），存在
  // localStorage folderViews 的一張表裡；沒設定過的位置沿用舊的全站鍵 folderView 當預設，所以改版前只選過
  // 一次的人看到的跟以前一樣。切換只是把 .is-list 放到 .dash-folder-grid 上，方框的 DOM 不變，CSS 排成列。----
  function viewKey(page, folderId) { return (page || 'home') + (folderId ? '/' + folderId : ''); }
  function viewMap() { try { const m = JSON.parse(localStorage.getItem('folderViews') || '{}'); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; } }
  function folderView(key) {
    const m = viewMap();
    if (key && (m[key] === 'list' || m[key] === 'grid')) return m[key];
    try { return localStorage.getItem('folderView') === 'list' ? 'list' : 'grid'; } catch (e) { return 'grid'; }
  }
  function setFolderView(key, v) {
    v = v === 'list' ? 'list' : 'grid';
    try {
      if (key) { const m = viewMap(); m[key] = v; localStorage.setItem('folderViews', JSON.stringify(m)); }
      else localStorage.setItem('folderView', v);
    } catch (e) { /* */ }
  }
  function folderGrid(key) { return el('div', 'dash-folder-grid' + (folderView(key) === 'list' ? ' is-list' : '')); }
  function viewToggle(onChange, key) {
    const box = el('div', 'dash-viewtoggle');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', '資料夾顯示方式（這個位置）');
    if (key) box.setAttribute('data-view-key', key);
    [['grid', 'layout-grid', '方格'], ['list', 'list', '清單（由上到下）']].forEach(function (v) {
      const b = el('button', 'dash-view-btn' + (folderView(key) === v[0] ? ' on' : ''), ic(v[1]));
      b.type = 'button'; b.title = '這個位置的資料夾顯示成' + v[2]; b.setAttribute('data-view', v[0]); b.setAttribute('aria-pressed', folderView(key) === v[0] ? 'true' : 'false');
      b.addEventListener('click', function (e) { e.stopPropagation(); if (folderView(key) === v[0]) return; setFolderView(key, v[0]); if (onChange) onChange(v[0]); });
      box.appendChild(b);
    });
    return box;
  }

  // ---- 資料夾顏色：每個資料夾一個（用 id 雜湊），首頁與區域頁的方框都用 ----
  const FOLDER_COLORS = ['#d9962a', '#2f6bf0', '#17934f', '#8e44ad', '#e0564b', '#128a80', '#c9701c', '#5b7fa6'];
  function folderColor(id) { let h = 0; const s = String(id || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return FOLDER_COLORS[h % FOLDER_COLORS.length]; }
  // 進場：一列一列浮起。只在真正「進到這頁」時做（render），refresh 時不要重播——每個方框／列用 --i 錯開。
  function freshen(root) {
    if (!root) return;
    const items = root.querySelectorAll('.dash-folder-tile, .dash-book-tile, .dash-note-wrap, .trash-row, .ab-file-row, .ab-sticky');
    Array.prototype.forEach.call(items, function (x, i) { x.style.setProperty('--i', Math.min(i, 14)); });
    root.classList.add('is-fresh');
    clearTimeout(root._freshTimer);
    root._freshTimer = setTimeout(function () { root.classList.remove('is-fresh'); }, 1100);
  }

  // ---- 進入點 ------------------------------------------------------------
  function paint(fresh) {
    const root = document.getElementById('dashboard');
    if (!root || !lastOpts) return;
    root.innerHTML = '';
    root.appendChild(renderHead(lastOpts));
    if (!tagFilter) {
      const cloud = renderTagCloud(lastOpts.allNotes || lastOpts.notes);
      if (cloud) root.appendChild(cloud);
    }
    root.appendChild(renderBody(lastOpts));
    if (fresh) freshen(root);
  }
  function normalize(opts) {
    const o = opts || {};
    return {
      notes: o.notes || [], folders: o.folders || [], allNotes: o.allNotes || null,
      onOpen: o.onOpen || function () {},
      onBook: o.onBook, onBookRemove: o.onBookRemove, onBookUpdate: o.onBookUpdate,
      onPin: o.onPin, onRename: o.onRename, onMenu: o.onMenu,
      onFolderMenu: o.onFolderMenu, onFolderRename: o.onFolderRename,
      onMoveNotes: o.onMoveNotes,
      onReorderNotes: o.onReorderNotes, onPlaceFolders: o.onPlaceFolders, onSortMenu: o.onSortMenu,
      onNavigate: o.onNavigate,
      selection: o.selection
    };
  }
  // render() = 回首頁：清掉標籤篩選、也回到最上層。之前只清篩選不清資料夾，
  // 所以在資料夾裡點左上角的 capynote 會原地不動。
  function render(opts) {
    lastOpts = normalize(opts);
    tagFilter = null;
    curFolderId = null;
    paint(true);
  }
  function refresh(opts) {
    lastOpts = normalize(Object.assign({}, lastOpts || {}, opts || {}));
    paint();
  }
  // 讓 app.js 的資料夾選單也能觸發方框上的就地改名
  function renameFolderTile(id) {
    const tile = document.querySelector('#dashboard .dash-folder-tile[data-id="' + id + '"]');
    if (!tile || !lastOpts) return;
    const folder = folderById(lastOpts.folders, id);
    const nameEl = tile.querySelector('.dash-folder-name');
    if (folder && nameEl) renameTile(folder, nameEl, lastOpts);
  }

  // currentFolder：app.js 用它決定「新增」要把東西放進哪個資料夾
  function currentFolder() { return curFolderId; }
  global.Dashboard = {
    makeBookTile: makeBookTile,
    rowTags: rowTags, freshen: freshen, folderColor: folderColor, folderGrid: folderGrid, viewToggle: viewToggle, folderView: folderView, viewKey: viewKey,
    render: render, refresh: refresh, setTag: setTag, openFolder: navigate,
    currentFolder: currentFolder, renameFolderTile: renameFolderTile
  };
})(window);
