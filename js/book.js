/* book.js — 電子書模式（GitBook 式閱讀介面）與「出版」成單檔 HTML。
 *
 * 一個資料夾就是一本書：
 *   - 資料夾裡的筆記依標題自然排序（「1. 前言」「2. 環境」… 會照數字排）成為章節
 *   - 子資料夾成為「分部」（Part），其中的筆記是該分部的章節；再往下也一樣遞迴
 *
 * 介面是熟悉的三欄：左邊章節目錄、中間內文、右邊「本頁」大綱（h2/h3，會跟著捲動
 * 反白），底部有上一章／下一章。內文用 MD.render 渲染，跟預覽區一模一樣。
 *
 * 「出版」會把整本書（所有章節、圖片以 data URL 內嵌、app.css 與程式碼配色）
 * 打包成一個獨立的 .html 檔，用瀏覽器直接開就能閱讀，不需要伺服器；章節切換靠
 * 網址 hash（#ch-3），所以也能直接連到某一章。
 *
 *   Book.open({ container, folderId, notes, folders, onOpenNote, onClose })
 *   Book.close()
 */
(function (global) {
  'use strict';

  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  function ic(name, cls) { return (global.Icons && Icons.svg) ? Icons.svg(name, cls) : ''; }
  function esc(s) { return MD.escapeHtml(String(s == null ? '' : s)); }
  const isMine = function (n) { return !n.perm || n.perm === 'owner'; };
  function natural(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'zh-Hant', { numeric: true, sensitivity: 'base' });
  }

  // ---- 章節結構 --------------------------------------------------------------
  // 回傳 { title, chapters: [{ idx, note, title, num, depth, part }], parts: tree }
  // chapters 是閱讀順序的扁平清單（供上一章／下一章）；tree 供左側目錄巢狀呈現。
  function buildBook(folderId, notes, folders) {
    const byParent = {};
    folders.forEach(function (f) {
      const p = f.parentId || null;
      (byParent[p] = byParent[p] || []).push(f);
    });
    Object.keys(byParent).forEach(function (k) {
      byParent[k].sort(function (a, b) { return natural(a.name, b.name); });
    });
    const root = folders.filter(function (f) { return f.id === folderId; })[0] || null;
    const chapters = [];

    function walk(fid, depth, prefix) {
      const own = notes
        .filter(function (n) { return isMine(n) && (n.folderId || null) === fid; })
        .sort(function (a, b) { return natural(a.title, b.title); });
      const node = { folder: null, items: [] };
      let i = 0;
      own.forEach(function (n) {
        i++;
        const num = prefix ? prefix + '.' + i : String(i);
        const ch = { idx: chapters.length, note: n, title: n.title || '未命名筆記', num: num, depth: depth };
        chapters.push(ch);
        node.items.push({ type: 'chapter', ch: ch });
      });
      (byParent[fid] || []).forEach(function (sub) {
        i++;
        const num = prefix ? prefix + '.' + i : String(i);
        const child = walk(sub.id, depth + 1, num);
        child.folder = sub;
        child.num = num;
        // 分部標題也算一個可點的節點：點它跳到分部裡第一章
        node.items.push({ type: 'part', folder: sub, num: num, tree: child });
      });
      return node;
    }
    const tree = walk(folderId, 0, '');
    return { title: root ? (root.name || '未命名資料夾') : '電子書', folder: root, chapters: chapters, tree: tree };
  }

  function firstChapterIn(tree) {
    for (let i = 0; i < tree.items.length; i++) {
      const it = tree.items[i];
      if (it.type === 'chapter') return it.ch;
      const c = firstChapterIn(it.tree);
      if (c) return c;
    }
    return null;
  }

  // 左側目錄的 HTML（in-app 與出版共用；出版版本用 href="#ch-n"，app 內用 data-idx）
  function navHTML(tree, current, exportMode) {
    let out = '<ul class="book-tree">';
    tree.items.forEach(function (it) {
      if (it.type === 'chapter') {
        const ch = it.ch;
        out += '<li class="book-tree-item' + (current && ch.idx === current.idx ? ' active' : '') + '">' +
          '<a class="book-tree-link" data-idx="' + ch.idx + '"' + (exportMode ? '' : ' data-note-id="' + esc(ch.note.id) + '"') + ' href="' + (exportMode ? '#ch-' + ch.idx : '#') + '">' +
          '<span class="book-tree-num">' + esc(ch.num) + '</span>' +
          '<span class="book-tree-title">' + esc(ch.title) + '</span></a></li>';
      } else {
        const first = firstChapterIn(it.tree);
        out += '<li class="book-tree-part">' +
          '<div class="book-tree-part-title"' + (first ? ' data-idx="' + first.idx + '"' : '') + '>' +
          '<span class="book-tree-num">' + esc(it.num) + '</span>' +
          ic('folder') + '<span>' + esc(it.folder.name || '未命名資料夾') + '</span></div>' +
          navHTML(it.tree, current, exportMode) + '</li>';
      }
    });
    return out + '</ul>';
  }

  // 章節路徑（分部 › 分部）供內文上方的麵包屑
  function chapterPath(ch, folders, rootId) {
    const parts = [];
    let cur = ch.note.folderId || null, guard = 0;
    while (cur && cur !== rootId && guard++ < 50) {
      const f = folders.filter(function (x) { return x.id === cur; })[0];
      if (!f) break;
      parts.unshift(f.name || '');
      cur = f.parentId || null;
    }
    return parts;
  }

  // 「本頁」大綱（h2/h3；沒有 h2 時退而列 h1）
  function outlineHTML(article) {
    let heads = article.querySelectorAll('h2, h3');
    if (!heads.length) heads = article.querySelectorAll('h1');
    if (!heads.length) return '';
    let out = '';
    heads.forEach(function (h) {
      out += '<a class="book-outline-link lv-' + h.tagName.toLowerCase() + '" href="#' + esc(h.id) + '" data-target="' + esc(h.id) + '">' +
        esc(h.textContent) + '</a>';
    });
    return out;
  }

  function pagerHTML(book, ch, exportMode) {
    const prev = ch.idx > 0 ? book.chapters[ch.idx - 1] : null;
    const next = ch.idx < book.chapters.length - 1 ? book.chapters[ch.idx + 1] : null;
    function link(c, dir) {
      if (!c) return '<span class="book-pager-slot"></span>';
      return '<a class="book-pager-link ' + dir + '" data-idx="' + c.idx + '" href="' + (exportMode ? '#ch-' + c.idx : '#') + '">' +
        '<span class="book-pager-label">' + (dir === 'prev' ? ic('arrow-left') + '<span>上一章</span>' : '<span>下一章</span>' + ic('arrow-right')) + '</span>' +
        '<span class="book-pager-title">' + esc(c.num) + '  ' + esc(c.title) + '</span></a>';
    }
    return '<nav class="book-pager">' + link(prev, 'prev') + link(next, 'next') + '</nav>';
  }

  // ---- in-app 閱讀器 ---------------------------------------------------------
  let cur = null;   // { container, book, opts, current, els }

  function open(opts) {
    close();
    const container = opts.container;
    const book = buildBook(opts.folderId, opts.notes || [], opts.folders || []);
    cur = { container: container, book: book, opts: opts, current: null, els: {} };

    container.innerHTML =
      '<header class="book-top">' +
        '<button class="book-back" type="button" title="回到首頁">' + ic('arrow-left') + '<span>返回</span></button>' +
        '<div class="book-brand">' + ic('book-open') + '<b class="book-brand-title">' + esc(book.title) + '</b>' +
          '<span class="book-brand-count">' + book.chapters.length + ' 章</span></div>' +
        '<div class="book-top-right">' +
          '<button class="btn book-edit-btn" type="button" title="用編輯器開啟這一章">' + ic('pen-line') + '<span>編輯本章</span></button>' +
          '<button class="btn book-ver-btn" type="button" title="這本書的版本紀錄">' + ic('history') + '<span>版本</span></button>' +
          '<button class="btn book-share-btn" type="button" title="產生公開連結，沒有帳號的人也能閱讀">' + ic('link') + '<span>分享連結</span></button>' +
          '<button class="btn btn-primary book-publish-btn" type="button" title="把整本書打包成一個 HTML 檔">' + ic('download') + '<span>出版 HTML</span></button>' +
        '</div>' +
      '</header>' +
      '<div class="book-body">' +
        '<nav class="book-nav"><div class="book-nav-title">' + ic('list') + '<span>目錄</span></div><div class="book-nav-scroll"></div></nav>' +
        '<main class="book-main"><div class="book-page">' +
          '<div class="book-crumbs"></div>' +
          '<article class="markdown-body book-article"></article>' +
          '<div class="book-pager-slot-wrap"></div>' +
        '</div></main>' +
        '<aside class="book-outline"><div class="book-outline-title">本頁</div><div class="book-outline-links"></div></aside>' +
      '</div>';

    const els = cur.els;
    els.nav = $('.book-nav-scroll', container);
    els.main = $('.book-main', container);
    els.crumbs = $('.book-crumbs', container);
    els.article = $('.book-article', container);
    els.pager = $('.book-pager-slot-wrap', container);
    els.outline = $('.book-outline-links', container);
    els.outlineBox = $('.book-outline', container);

    $('.book-back', container).addEventListener('click', function () { if (opts.onClose) opts.onClose(); });
    $('.book-edit-btn', container).addEventListener('click', function () {
      if (cur && cur.current && opts.onOpenNote) opts.onOpenNote(cur.current.note.id);
    });
    $('.book-publish-btn', container).addEventListener('click', function () { publish(); });
    $('.book-share-btn', container).addEventListener('click', function () {
      if (!global.Versions || !Versions.openBookLinks) return;
      if (!cur.book.folder) { if (global.App) App.toast('只有資料夾才能分享成電子書'); return; }
      Versions.openBookLinks(cur.book, {});
    });
    $('.book-ver-btn', container).addEventListener('click', function () {
      if (!global.Versions) return;
      // Chapter order is decided here, by title, so the snapshot has to be told
      // it rather than have the server guess at a second ordering rule.
      Versions.openBook(cur.book, {
        notes: opts.notes || [],
        onRestored: function () { if (opts.onRestored) opts.onRestored(); }
      });
    });

    // 目錄／上一章下一章：事件委派，一律用 data-idx 切章
    container.addEventListener('click', onClick);
    els.main.addEventListener('scroll', onScroll);

    if (!book.chapters.length) {
      els.nav.innerHTML = '<div class="book-empty">這個資料夾裡還沒有筆記。</div>';
      els.article.innerHTML = '<p class="book-empty">加幾篇筆記到「' + esc(book.title) + '」，它們就會變成這本書的章節。</p>';
      return;
    }
    showChapter(0);
  }

  function onClick(e) {
    const a = e.target.closest('[data-idx]');
    if (a) {
      e.preventDefault();
      showChapter(parseInt(a.getAttribute('data-idx'), 10));
      return;
    }
    const ol = e.target.closest('.book-outline-link');
    if (ol) {
      e.preventDefault();
      scrollToId(ol.getAttribute('data-target'));
      return;
    }
    const nl = e.target.closest('.note-link');
    if (nl) {
      // [[連結]] 若指向書中章節就在書裡翻頁，否則交給編輯器開啟
      e.preventDefault();
      const id = nl.getAttribute('data-note-id');
      if (!id) return;
      const ch = cur.book.chapters.filter(function (c) { return c.note.id === id; })[0];
      if (ch) showChapter(ch.idx);
      else if (cur.opts.onOpenNote) cur.opts.onOpenNote(id);
      return;
    }
    const anchor = e.target.closest('.book-article a[href^="#"]');
    if (anchor) {
      e.preventDefault();
      scrollToId(decodeURIComponent(anchor.getAttribute('href').slice(1)));
    }
  }

  function scrollToId(id) {
    if (!cur || !id) return;
    const target = cur.els.article.querySelector('[id="' + id.replace(/"/g, '\\"') + '"]');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showChapter(idx) {
    if (!cur) return;
    const book = cur.book;
    const ch = book.chapters[Math.max(0, Math.min(idx, book.chapters.length - 1))];
    if (!ch) return;
    cur.current = ch;
    const els = cur.els;

    els.nav.innerHTML = navHTML(book.tree, ch, false);
    const active = els.nav.querySelector('.book-tree-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });

    const path = chapterPath(ch, cur.opts.folders || [], cur.opts.folderId);
    els.crumbs.innerHTML =
      '<span class="book-crumb">' + esc(book.title) + '</span>' +
      path.map(function (p) { return ic('chevron-right') + '<span class="book-crumb">' + esc(p) + '</span>'; }).join('') +
      '<span class="book-crumb-num">' + esc(ch.num) + '</span>';

    els.article.innerHTML = MD.render(ch.note.content || '');
    MD.resolveImages(els.article);
    if (ch.note.meta) MD.applyColWidths(els.article, ch.note.meta.tableWidths);
    els.pager.innerHTML = pagerHTML(book, ch, false);

    const ol = outlineHTML(els.article);
    els.outline.innerHTML = ol;
    els.outlineBox.classList.toggle('empty', !ol);

    els.main.scrollTop = 0;
    updateOutlineActive();
  }

  // 捲動時反白「本頁」大綱裡目前所在的段落
  let scrollTimer = null;
  function onScroll() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () { scrollTimer = null; updateOutlineActive(); }, 60);
  }
  function updateOutlineActive() {
    if (!cur) return;
    const links = cur.els.outline.querySelectorAll('.book-outline-link');
    if (!links.length) return;
    const top = cur.els.main.getBoundingClientRect().top + 80;
    let activeId = null;
    links.forEach(function (l) {
      const id = l.getAttribute('data-target');
      const h = cur.els.article.querySelector('[id="' + id.replace(/"/g, '\\"') + '"]');
      if (h && h.getBoundingClientRect().top <= top) activeId = id;
    });
    if (!activeId) activeId = links[0].getAttribute('data-target');
    links.forEach(function (l) { l.classList.toggle('active', l.getAttribute('data-target') === activeId); });
  }

  function close() {
    if (!cur) return;
    try {
      cur.container.removeEventListener('click', onClick);
      if (cur.els.main) cur.els.main.removeEventListener('scroll', onScroll);
      cur.container.innerHTML = '';
    } catch (e) { /* ignore */ }
    cur = null;
  }

  // ---- 出版：單檔 HTML -----------------------------------------------------
  // 出版檔重用 app.css（內文樣式、電子書排版）與程式碼配色，再附上一小段腳本
  // 做章節切換與大綱反白；圖片內嵌成 data URL；PDF 附件無法內嵌，改成提示文字。
  function fetchText(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; });
  }

  // Pack the whole book into one self-contained HTML string. Split out of
  // publish() because the share-link feature needs exactly the same artefact —
  // the file the reader downloads and the file served at a share URL must be the
  // same thing, or the two would drift apart the first time either was touched.
  function renderStandalone() {
    if (!cur || !cur.book.chapters.length) return Promise.reject(new Error('這本書還沒有任何章節'));
    const book = cur.book;
    const folders = cur.opts.folders || [];

    const work = document.createElement('div');
    const chaptersHTML = [];
    const outlines = [];

    // 逐章渲染 + 內嵌圖片（序列進行，避免同時打太多圖片請求）
    let p = Promise.resolve();
    book.chapters.forEach(function (ch) {
      p = p.then(function () {
        return renderForExport(work, ch.note, '出版檔').then(function () {
          const path = chapterPath(ch, folders, cur.opts.folderId);
          outlines.push(outlineHTML(work));
          chaptersHTML.push(
            '<section class="book-chapter" id="ch-' + ch.idx + '" hidden>' +
              '<div class="book-crumbs"><span class="book-crumb">' + esc(book.title) + '</span>' +
              path.map(function (x) { return ic('chevron-right') + '<span class="book-crumb">' + esc(x) + '</span>'; }).join('') +
              '<span class="book-crumb-num">' + esc(ch.num) + '</span></div>' +
              '<article class="markdown-body book-article">' + work.innerHTML + '</article>' +
              pagerHTML(book, ch, true) +
            '</section>');
        });
      });
    });

    return Promise.all([p, fetchText('app.css'), fetchText('vendor/hljs-github.min.css'),
      fetchText('vendor/hljs-github-dark.min.css')])
      .then(function (r) {
        return buildStandalone(book, chaptersHTML, outlines, r[1], r[2], r[3]);
      });
  }

  // 把一篇筆記渲染到 work 裡，收拾成「離開這個網站也能看」的樣子：附件換成一行說明、
  // 編輯器的按鈕拿掉、圖片內嵌成 data URL。電子書的每一章跟單篇筆記的公開頁都走這裡。
  // where：說明文字裡的「出版檔」／「分享頁」。
  function renderForExport(work, note, where) {
    work.innerHTML = MD.render(note.content || '');
    if (note.meta) MD.applyColWidths(work, note.meta.tableWidths);
    // 影片播放器也打包不進去：換成一行連結
    if (MD.replaceVideosForExport) MD.replaceVideosForExport(work, where);
    // 附件 PDF 無法打包進單檔：換成一行說明
    work.querySelectorAll('.pdf-embed').forEach(function (n) {
      const name = (n.querySelector('.pdf-embed-name') || {}).textContent || 'PDF';
      const p = document.createElement('p');
      p.className = 'book-attachment-note';
      p.textContent = '（附件「' + name + '」未包含在' + where + '中）';
      n.replaceWith(p);
    });
    // 附件連結（[名稱](file:…)、[名稱](pdf:…)）在出版檔裡也點不開：只留名稱
    work.querySelectorAll('.file-chip').forEach(function (n) {
      const name = (n.querySelector('.file-chip-name') || {}).textContent || '附件';
      const span = document.createElement('span');
      span.className = 'book-attachment-inline';
      span.textContent = '（附件「' + name + '」未包含在' + where + '中）';
      n.replaceWith(span);
    });
    work.querySelectorAll('.img-tools, .code-copy, .mm-edit-btn, .mm-hint').forEach(function (n) { n.remove(); });
    // 嵌入的關聯分析：出版檔沒有 relmap.js，拖曳縮放不會動，所以拿掉工具列並標成
    // is-static（把螢幕上那個固定高度的取景框放開，整張圖直接攤平顯示）。
    work.querySelectorAll('.relmap-embed').forEach(function (n) {
      n.classList.add('is-static');
      const bar = n.querySelector('.relmap-embed-bar');
      if (bar) bar.remove();
    });
    // 嵌入的 drawio 圖表：出版檔裡沒有編輯器，「編輯」那一列拿掉，只留圖
    work.querySelectorAll('.drawio-embed-bar').forEach(function (n) { n.remove(); });
    // 出版檔沒有編輯器可以回寫，勾選框只是一份紀錄——留著勾選狀態，但不讓讀者
    // 以為自己改得動它。
    work.querySelectorAll('.task-check').forEach(function (n) { n.disabled = true; });
    return MD.inlineImagesAsDataURL(work);
  }

  // 單篇筆記打包成一頁（公開連結 /s/<token> 存的就是這個）。不像電子書有目錄與章節切換：
  // 就是一篇文章——標題、內文、最下面一行說明。整頁用文件本身捲動（不像 app 只捲內層），
  // 拿到連結的人才能直接用瀏覽器列印或存成 PDF。
  function renderNoteStandalone(note) {
    const work = document.createElement('div');
    return Promise.all([renderForExport(work, note, '分享頁'), fetchText('app.css'),
      fetchText('vendor/hljs-github.min.css'), fetchText('vendor/hljs-github-dark.min.css')])
      .then(function (r) {
        // 筆記之間的連結（[[wiki]]、子頁面卡片、#標籤）在外面沒有地方可去：留字，拿掉連結
        // （不留原本的 class：.note-link.missing 會用 ::after 補一個「點擊建立」，在這裡沒有東西可以建立）
        work.querySelectorAll('a.note-link, a.hashtag').forEach(function (a) {
          const span = document.createElement('span');
          span.className = 'is-static';
          const t = a.querySelector('.page-card-t');    // 子頁面卡片：只留標題，不留「子頁面／點擊建立」
          span.textContent = (t || a).textContent;
          a.replaceWith(span);
        });
        // [toc] 的子標題全部展開：沒有腳本去開合它
        work.querySelectorAll('.md-toc li').forEach(function (li) { if (li.querySelector('.md-toc-kids')) li.classList.add('open'); });
        work.querySelectorAll('.md-toc-toggle').forEach(function (b) { b.remove(); });
        return buildNoteStandalone(note, work.innerHTML, r[1], r[2], r[3]);
      });
  }
  function buildNoteStandalone(note, articleHTML, appCSS, hlLight, hlDark) {
    const title = note.title || '未命名筆記';
    const when = new Date().toLocaleString('zh-TW', { hour12: false });
    const extraCSS = [
      // app 的殼不捲動、只捲內層；這一頁反過來：整份文件捲，列印才會是整篇
      'html, body { height: auto !important; overflow: auto !important; }',
      'body { position: static !important; background: var(--bg); }',
      '#hl-dark { display: none; }',
      '.pub-top { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 10px 20px;',
      '  background: var(--bg-2); border-bottom: 1px solid var(--border); }',
      '.pub-top-title { flex: 1 1 auto; min-width: 0; font-weight: 700; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.pub-top-when { flex: 0 0 auto; font-size: 12px; color: var(--text-faint); }',
      '.pub-main { max-width: 880px; margin: 0 auto; padding: 32px 24px 64px; }',
      '.pub-article > h1:first-child { margin-top: 0; }',
      '.pub-foot { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-faint); line-height: 1.7; }',
      '.is-static { color: inherit; text-decoration: none; cursor: default; }',
      '@media print { .pub-top { display: none; } .pub-main { padding: 0; max-width: none; } .pub-foot { display: none; } }'
    ].join('\n');
    const script = [
      '(function () {',
      '  var tb = document.querySelector(".pub-theme");',
      '  function applyTheme(t) {',
      '    document.documentElement.setAttribute("data-theme", t);',
      '    document.getElementById("hl-light").disabled = t === "dark";',
      '    document.getElementById("hl-dark").disabled = t !== "dark";',
      '    try { localStorage.setItem("book-theme", t); } catch (e) {}',
      '  }',
      '  if (tb) tb.addEventListener("click", function () { applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"); });',
      '  var saved = null; try { saved = localStorage.getItem("book-theme"); } catch (e) {}',
      '  applyTheme(saved || "light");',
      '})();'
    ].join('\n');
    return '<!DOCTYPE html><html lang="zh-Hant" data-theme="light"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="robots" content="noindex, nofollow">' +
      '<title>' + esc(title) + '</title>' +
      '<style id="hl-light">' + hlLight + '</style>' +
      '<style id="hl-dark">' + hlDark + '</style>' +
      '<style>' + appCSS + '</style>' +
      '<style>' + extraCSS + '</style>' +
      '</head><body>' +
      '<header class="pub-top">' + ic('file-text') + '<span class="pub-top-title">' + esc(title) + '</span>' +
        '<span class="pub-top-when">' + esc(when) + ' 的版本</span>' +
        '<button class="icon-btn pub-theme" type="button" title="切換深色/淺色">' +
          '<span class="theme-ic theme-ic-light">' + ic('moon') + '</span><span class="theme-ic theme-ic-dark">' + ic('sun') + '</span></button>' +
      '</header>' +
      '<main class="pub-main"><article class="markdown-body pub-article">' + articleHTML + '</article>' +
      '<footer class="pub-foot">這是一份唯讀的分享頁，內容是 ' + esc(when) + ' 當時的版本。</footer></main>' +
      '<script>' + script + '</script>' +
      '</body></html>';
  }

  function publish() {
    if (!cur || !cur.book.chapters.length) return;
    const btn = $('.book-publish-btn', cur.container);
    const book = cur.book;
    if (btn) { btn.disabled = true; btn.innerHTML = ic('clock') + '<span>打包中…</span>'; }

    renderStandalone()
      .then(function (html) {
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (book.title || 'book').replace(/[\\/:*?"<>|]+/g, '_') + '.html';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      })
      .catch(function (e) {
        // App.confirm takes an options object; passing two strings threw the
        // reason away and popped an empty dialog.
        if (global.App && App.confirm) {
          App.confirm({ title: '出版失敗', message: String(e && e.message || e), ok: '知道了' });
        }
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.innerHTML = ic('download') + '<span>出版 HTML</span>'; }
      });
  }

  function buildStandalone(book, chaptersHTML, outlines, appCSS, hlLight, hlDark) {
    const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    // 出版檔只需要 app.css 裡的內文與電子書樣式；body 的 overflow:hidden 由下方覆寫
    const extraCSS = [
      'html, body { height: 100%; }',
      'body { overflow: hidden; }',
      '.book-wrap { position: fixed; inset: 0; }',
      '.book-chapter[hidden] { display: none; }',
      '#hl-dark { display: none; }'
    ].join('\n');
    const script = [
      '(function () {',
      '  var chapters = document.querySelectorAll(".book-chapter");',
      '  var outlines = ' + JSON.stringify(outlines) + ';',
      '  var nav = document.querySelector(".book-nav-scroll");',
      '  var main = document.querySelector(".book-main");',
      '  var ob = document.querySelector(".book-outline");',
      '  var ol = document.querySelector(".book-outline-links");',
      '  function esc(s) { return String(s).replace(/"/g, "\\\\\\""); }',
      '  function show(i, keepScroll) {',
      '    i = Math.max(0, Math.min(i, chapters.length - 1));',
      '    for (var k = 0; k < chapters.length; k++) chapters[k].hidden = k !== i;',
      '    var links = nav.querySelectorAll("[data-idx]");',
      '    for (var j = 0; j < links.length; j++) {',
      '      var li = links[j].parentNode;',
      '      if (li.classList.contains("book-tree-item")) li.classList.toggle("active", parseInt(links[j].getAttribute("data-idx"), 10) === i);',
      '    }',
      '    ol.innerHTML = outlines[i] || ""; ob.classList.toggle("empty", !outlines[i]);',
      '    if (!keepScroll) main.scrollTop = 0;',
      '    spy();',
      '  }',
      '  function fromHash() { var m = location.hash.match(/^#ch-(\\d+)/); return m ? parseInt(m[1], 10) : 0; }',
      '  function spy() {',
      '    var links = ol.querySelectorAll(".book-outline-link"); if (!links.length) return;',
      '    var top = main.getBoundingClientRect().top + 80, active = null;',
      '    var art = chapters[fromHash()];',
      '    for (var j = 0; j < links.length; j++) {',
      '      var id = links[j].getAttribute("data-target");',
      '      var h = art && art.querySelector("[id=\\"" + esc(id) + "\\"]");',
      '      if (h && h.getBoundingClientRect().top <= top) active = id;',
      '    }',
      '    if (!active) active = links[0].getAttribute("data-target");',
      '    for (var q = 0; q < links.length; q++) links[q].classList.toggle("active", links[q].getAttribute("data-target") === active);',
      '  }',
      '  window.addEventListener("hashchange", function () { show(fromHash()); });',
      '  document.addEventListener("click", function (e) {',
      '    var t = e.target.closest ? e.target.closest("a") : null; if (!t) return;',
      '    var href = t.getAttribute("href") || "";',
      '    if (t.classList.contains("book-outline-link") || (t.closest(".book-article") && href.charAt(0) === "#" && !/^#ch-/.test(href))) {',
      '      e.preventDefault();',
      '      var id = decodeURIComponent(href.slice(1));',
      '      var art = chapters[fromHash()];',
      '      var el = art && art.querySelector("[id=\\"" + esc(id) + "\\"]");',
      '      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });',
      '    }',
      '    if (t.classList.contains("note-link")) { e.preventDefault(); var nid = t.getAttribute("data-note-id"); if (nid && window.BOOK_NOTE_INDEX && window.BOOK_NOTE_INDEX[nid] != null) location.hash = "#ch-" + window.BOOK_NOTE_INDEX[nid]; }',
      '  });',
      '  var tb = document.querySelector(".book-theme");',
      '  function applyTheme(t) {',
      '    document.documentElement.setAttribute("data-theme", t);',
      '    document.getElementById("hl-light").disabled = t === "dark";',
      '    document.getElementById("hl-dark").disabled = t !== "dark";',
      '    try { localStorage.setItem("book-theme", t); } catch (e) {}',
      '  }',
      '  if (tb) tb.addEventListener("click", function () { applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"); });',
      '  var saved = null; try { saved = localStorage.getItem("book-theme"); } catch (e) {}',
      '  applyTheme(saved || document.documentElement.getAttribute("data-theme") || "light");',
      '  main.addEventListener("scroll", function () { spy(); });',
      '  show(fromHash(), false);',
      '})();'
    ].join('\n');

    const noteIndex = {};
    book.chapters.forEach(function (c) { noteIndex[c.note.id] = c.idx; });

    return '<!DOCTYPE html><html lang="zh-Hant" data-theme="' + theme + '"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + esc(book.title) + '</title>' +
      '<style id="hl-light">' + hlLight + '</style>' +
      '<style id="hl-dark">' + hlDark + '</style>' +
      '<style>' + appCSS + '</style>' +
      '<style>' + extraCSS + '</style>' +
      '</head><body>' +
      '<script>window.BOOK_NOTE_INDEX = ' + JSON.stringify(noteIndex) + ';</script>' +
      '<div class="book-wrap book-standalone">' +
        '<header class="book-top">' +
          '<div class="book-brand">' + ic('book-open') + '<b class="book-brand-title">' + esc(book.title) + '</b>' +
            '<span class="book-brand-count">' + book.chapters.length + ' 章</span></div>' +
          '<div class="book-top-right"><button class="icon-btn book-theme" type="button" title="切換深色/淺色">' +
            '<span class="theme-ic theme-ic-light">' + ic('moon') + '</span><span class="theme-ic theme-ic-dark">' + ic('sun') + '</span></button></div>' +
        '</header>' +
        '<div class="book-body">' +
          '<nav class="book-nav"><div class="book-nav-title">' + ic('list') + '<span>目錄</span></div>' +
            '<div class="book-nav-scroll">' + navHTML(book.tree, null, true) + '</div></nav>' +
          '<main class="book-main"><div class="book-page">' + chaptersHTML.join('') + '</div></main>' +
          '<aside class="book-outline"><div class="book-outline-title">本頁</div><div class="book-outline-links"></div></aside>' +
        '</div>' +
      '</div>' +
      '<script>' + script + '</script>' +
      '</body></html>';
  }

  global.Book = {
    open: open, close: close, buildBook: buildBook,
    // The share dialog packs the open book itself, so it needs the packer and
    // the book that is currently on screen.
    renderStandalone: renderStandalone,
    renderNoteStandalone: renderNoteStandalone,   // 單篇筆記的公開連結（app.js 的 showShareDialog）
    current: function () { return cur ? cur.book : null; }
  };
})(window);
