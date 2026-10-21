/* trash.js — 垃圾桶頁：刪除的筆記先放這裡，保留期（伺服器 TRASH_KEEP_DAYS，預設 30 天）
 * 過後才真的刪掉；期間可以復原、永久刪除或整個清空。
 *
 * 以前是對話框，現在是跟首頁同一套版面的獨立頁面（網址 #trash）：app.js 的
 * openTrash() 收起其他檢視、打開 #trash-wrap，再呼叫這裡把內容畫進 #trash-page。
 *
 *   Trash.render(container, { folders, onChanged, onHome })
 *     folders    app.js 的資料夾清單，用來顯示筆記原本在哪個資料夾
 *     onChanged  每次復原或永久刪除之後呼叫，讓 app.js 重抓筆記清單、更新側邊欄
 *     onHome     麵包屑「所有筆記」與空狀態的「回到所有筆記」
 *
 * 只透過 Store 跟伺服器講話；跟 versions.js 一樣，不管筆記怎麼載入或畫出來。
 */
(function (global) {
  'use strict';

  const SOON_DAYS = 3;   // 剩這幾天以內的另外放一區「即將永久刪除」

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name) { return global.Icons ? Icons.svg(name) : ''; }
  // 伺服器只回「哪一種」（api.js 的 kindOfMeta），圖示跟顏色照首頁清單的那一套
  const KINDS = {
    '': { icon: 'file-text', cls: '' },
    relmap: { icon: 'network', cls: 'kind-relmap' },
    drawio: { icon: 'shapes', cls: 'kind-drawio' },
    board: { icon: 'kanban', cls: 'kind-board' },
    start: { icon: 'layout-grid', cls: 'kind-start' },
    xmind: { icon: 'mind-map', cls: 'kind-xmind' },
    timetree: { icon: 'calendar', cls: 'kind-timetree' },
    progress: { icon: 'list-checks', cls: 'kind-progress' },
    foodmap: { icon: 'map-pin', cls: 'kind-foodmap' },
    doc: { icon: 'file-pen', cls: 'kind-doc' },
    video: { icon: 'film', cls: 'kind-video' },
    sec: { icon: 'shield', cls: 'kind-sec' },
    perf: { icon: 'chart', cls: 'kind-perf' },
    file: { icon: 'paperclip', cls: '' },
    sticky: { icon: 'pin', cls: '' }
  };
  function button(cls, iconName, label) {
    const b = el('button', cls);
    b.type = 'button';
    if (iconName) b.innerHTML = icon(iconName);
    b.appendChild(el('span', null, label));
    return b;
  }
  function toast(msg) { if (global.App && App.toast) App.toast(msg); }
  function confirm(opts) {
    if (global.App && App.confirm) return App.confirm(opts);
    return Promise.resolve(window.confirm(opts.message));
  }
  function errText(e) { return (e && e.message) || String(e); }

  function when(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    const p = function (x) { return x < 10 ? '0' + x : '' + x; };
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    const y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '/') +
      (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }
  function chars(n) {
    if (n == null) return '';
    return n >= 10000 ? (n / 1000).toFixed(1) + 'k 字' : n + ' 字';
  }
  // Whole days left, rounded up: a note deleted 29.5 days ago still has "1 天".
  function daysLeft(expiresAt) {
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000));
  }

  // 每次 render 都加一：慢回來的舊請求不能把新畫面蓋掉
  let generation = 0;

  function render(container, opts) {
    if (!container) return;
    const o = opts || {};
    const folders = o.folders || [];
    const gen = ++generation;
    let notes = [];
    let keepDays = 30;
    let query = '';
    let busy = false;
    const selected = new Set();

    function byId(id) { return notes.find(function (n) { return n.id === id; }); }
    function titleOf(n) { return (n && n.title) || '未命名筆記'; }
    function folderOf(id) { return folders.find(function (f) { return f.id === id; }); }
    function folderGone(n) { return !!n.folderId && !folderOf(n.folderId); }
    function fromLabel(n) {
      if (!n.folderId) return '最上層';
      if (folderGone(n)) return '原資料夾已刪除，復原後放在最上層';
      const names = [], seen = {};
      let cur = n.folderId;
      while (cur && !seen[cur]) {
        seen[cur] = true;
        const f = folderOf(cur);
        if (!f) break;
        names.unshift(f.name || '未命名資料夾');
        cur = f.parentId;
      }
      return names.join(' / ');
    }

    // ---- 頁首：麵包屑、說明、搜尋與清空 ----
    container.textContent = '';
    container.classList.remove('is-busy');

    const head = el('header', 'dash-head');
    const headMain = el('div', 'dash-head-main');
    const nav = el('nav', 'dash-crumbs');
    nav.setAttribute('aria-label', '位置');
    const home = el('button', 'dash-crumb');
    home.type = 'button';
    home.title = '回到所有筆記';
    home.innerHTML = icon('layout-grid');
    home.appendChild(el('span', null, '所有筆記'));
    home.addEventListener('click', function () { if (o.onHome) o.onHome(); });
    const sep = el('span', 'dash-crumb-sep');
    sep.innerHTML = icon('chevron-right');
    const here = el('button', 'dash-crumb is-current');
    here.type = 'button';
    here.setAttribute('aria-current', 'page');
    here.innerHTML = icon('trash');
    here.appendChild(el('span', null, '垃圾桶'));
    nav.appendChild(home);
    nav.appendChild(sep);
    nav.appendChild(here);
    const subtitle = el('p', 'dash-subtitle', '載入中…');
    headMain.appendChild(nav);
    headMain.appendChild(subtitle);

    const headRight = el('div', 'dash-head-right');
    const search = el('label', 'trash-search');
    search.innerHTML = icon('search');
    const input = el('input');
    input.type = 'search';
    input.placeholder = '搜尋垃圾桶…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', '搜尋垃圾桶');
    search.appendChild(input);
    const emptyAllBtn = button('btn trash-empty-btn', 'trash', '清空垃圾桶');
    search.hidden = true;
    emptyAllBtn.hidden = true;
    headRight.appendChild(search);
    headRight.appendChild(emptyAllBtn);
    head.appendChild(headMain);
    head.appendChild(headRight);

    // 勾選後才出現、黏在頁面頂端的批次操作列
    const batch = el('div', 'trash-batch');
    batch.hidden = true;
    const batchCount = el('span', 'trash-batch-count');
    const batchRestore = button('btn btn-primary', 'rotate-ccw', '復原');
    const batchPurge = button('btn trash-purge-btn', 'trash', '永久刪除');
    const batchClear = button('btn btn-ghost', 'x', '取消選取');
    batch.appendChild(batchCount);
    batch.appendChild(batchRestore);
    batch.appendChild(batchPurge);
    batch.appendChild(batchClear);

    const body = el('div', 'trash-body');
    container.appendChild(head);
    container.appendChild(batch);
    container.appendChild(body);

    input.addEventListener('input', function () {
      query = input.value.trim().toLowerCase();
      renderBody();
    });
    emptyAllBtn.addEventListener('click', emptyAll);
    batchRestore.addEventListener('click', function () { restoreIds(Array.from(selected)); });
    batchPurge.addEventListener('click', function () { purgeIds(Array.from(selected)); });
    batchClear.addEventListener('click', function () {
      selected.clear();
      renderBody();
    });

    // ---- 內容 ----
    function visibleNotes() {
      if (!query) return notes;
      return notes.filter(function (n) {
        return (titleOf(n) + '\n' + fromLabel(n)).toLowerCase().indexOf(query) >= 0;
      });
    }

    function renderBody() {
      body.textContent = '';
      const hasAny = notes.length > 0;
      subtitle.textContent = hasAny
        ? '共 ' + notes.length + ' 篇 · 刪除的筆記保留 ' + keepDays + ' 天，之後自動永久刪除；復原會放回原本的資料夾。'
        : '刪除的筆記會在這裡保留 ' + keepDays + ' 天，之後自動永久刪除。';
      search.hidden = !hasAny;
      emptyAllBtn.hidden = !hasAny;

      const list = visibleNotes();
      // 搜尋篩掉、看不到的就不算選取，免得批次操作動到畫面上沒有的筆記
      const visible = {};
      list.forEach(function (n) { visible[n.id] = true; });
      Array.from(selected).forEach(function (id) { if (!visible[id]) selected.delete(id); });

      if (!hasAny) {
        body.appendChild(emptyState());
      } else if (!list.length) {
        const none = el('div', 'dash-empty');
        none.innerHTML = icon('search');
        none.appendChild(el('span', null, '找不到符合「' + input.value.trim() + '」的筆記。'));
        body.appendChild(none);
      } else {
        const soon = list.filter(function (n) { return daysLeft(n.expiresAt) <= SOON_DAYS; });
        const rest = list.filter(function (n) { return daysLeft(n.expiresAt) > SOON_DAYS; });
        if (soon.length) body.appendChild(section(SOON_DAYS + ' 天內永久刪除', 'alert-triangle', soon, 'is-soon'));
        if (rest.length) body.appendChild(section('已刪除的筆記', 'trash', rest, ''));
      }
      syncBatch();
    }

    function section(label, iconName, list, cls) {
      const sec = el('section', 'dash-section trash-section' + (cls ? ' ' + cls : ''));
      const h = el('div', 'dash-section-head');
      h.innerHTML = icon(iconName);
      h.appendChild(el('span', null, label));
      h.appendChild(el('span', 'dash-section-count', String(list.length)));
      const allOn = list.every(function (n) { return selected.has(n.id); });
      const selAll = el('button', 'trash-selall', allOn ? '取消全選' : '全選');
      selAll.type = 'button';
      selAll.addEventListener('click', function () {
        list.forEach(function (n) { if (allOn) selected.delete(n.id); else selected.add(n.id); });
        renderBody();
      });
      h.appendChild(selAll);
      sec.appendChild(h);
      const rows = el('div', 'dash-list trash-list');
      list.forEach(function (n) { rows.appendChild(row(n)); });
      sec.appendChild(rows);
      return sec;
    }

    function row(n) {
      const on = selected.has(n.id);
      const wrap = el('div', 'dash-note-wrap trash-row' + (on ? ' selected' : ''));
      const cb = el('input', 'dash-note-check');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.title = '選取';
      cb.setAttribute('aria-label', '選取「' + titleOf(n) + '」');
      cb.addEventListener('change', function () {
        if (cb.checked) selected.add(n.id); else selected.delete(n.id);
        wrap.classList.toggle('selected', cb.checked);
        syncBatch();
        syncSelectAll();
      });
      wrap.appendChild(cb);

      // 垃圾桶裡的筆記打不開（伺服器對它一律 404），點整列就是勾選
      const main = el('div', 'dash-row trash-row-main');
      main.tabIndex = 0;
      main.setAttribute('role', 'button');
      main.setAttribute('aria-pressed', on ? 'true' : 'false');
      // 每一種筆記用它在清單上的那個圖示，丟進垃圾桶之後還認得出哪個是哪個
      const k = KINDS[n.kind] || KINDS[''];
      const ic = el('span', 'dash-row-ic' + (k.cls ? ' ' + k.cls : ''));
      ic.innerHTML = icon(k.icon);
      main.appendChild(ic);
      const text = el('span', 'trash-row-text');
      text.appendChild(el('span', 'dash-row-title', titleOf(n)));
      const gone = folderGone(n);
      const from = el('span', 'trash-row-from' + (gone ? ' gone' : ''));
      from.innerHTML = icon(gone ? 'alert-triangle' : (n.folderId ? 'folder' : 'layout-grid'));
      from.appendChild(document.createTextNode(fromLabel(n)));
      text.appendChild(from);
      main.appendChild(text);

      const meta = el('span', 'dash-row-meta');
      const left = daysLeft(n.expiresAt);
      const leftEl = el('span', 'trash-left' + (left <= SOON_DAYS ? ' soon' : ''), left ? left + ' 天後刪除' : '即將刪除');
      leftEl.title = '保留到 ' + when(n.expiresAt);
      meta.appendChild(leftEl);
      meta.appendChild(el('span', 'trash-row-size', chars(n.chars)));
      const time = el('span', 'dash-row-time', when(n.deletedAt));
      time.title = '刪除時間';
      meta.appendChild(time);
      main.appendChild(meta);
      function toggle() {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
        main.setAttribute('aria-pressed', cb.checked ? 'true' : 'false');
      }
      main.addEventListener('click', toggle);
      main.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      wrap.appendChild(main);

      const acts = el('div', 'trash-row-acts');
      const restore = button('trash-act restore', 'rotate-ccw', '復原');
      restore.title = '放回' + (gone || !n.folderId ? '最上層' : '「' + fromLabel(n) + '」');
      restore.addEventListener('click', function () { restoreIds([n.id]); });
      const purge = button('trash-act purge', 'trash', '永久刪除');
      purge.addEventListener('click', function () { purgeIds([n.id]); });
      acts.appendChild(restore);
      acts.appendChild(purge);
      wrap.appendChild(acts);
      return wrap;
    }

    function syncBatch() {
      batch.hidden = !selected.size;
      batchCount.textContent = '已選取 ' + selected.size + ' 篇';
    }
    function syncSelectAll() {
      body.querySelectorAll('.trash-section').forEach(function (sec) {
        const boxes = Array.from(sec.querySelectorAll('.dash-note-check'));
        const btn = sec.querySelector('.trash-selall');
        if (btn) btn.textContent = boxes.length && boxes.every(function (b) { return b.checked; }) ? '取消全選' : '全選';
      });
    }

    function emptyState() {
      const box = el('div', 'trash-emptystate');
      const ic = el('div', 'trash-emptystate-ic');
      ic.innerHTML = icon('trash');
      box.appendChild(ic);
      box.appendChild(el('div', 'trash-emptystate-title', '垃圾桶是空的'));
      box.appendChild(el('div', 'trash-emptystate-sub', '刪除的筆記會先放在這裡 ' + keepDays + ' 天，期間隨時可以復原。'));
      const back = button('btn', 'arrow-left', '回到所有筆記');
      back.addEventListener('click', function () { if (o.onHome) o.onHome(); });
      box.appendChild(back);
      return box;
    }

    // ---- 動作 ----
    // 一次一篇依序送出；全部跑完才重抓清單，中間失敗的只算數量回報
    function runEach(ids, fn, report) {
      if (busy || !ids.length) return;
      busy = true;
      container.classList.add('is-busy');
      let done = 0, failed = 0, lastErr = null;
      let chain = Promise.resolve();
      ids.forEach(function (id) {
        chain = chain.then(function () {
          return fn(id).then(function () { done++; selected.delete(id); },
            function (e) { failed++; lastErr = e; });
        });
      });
      chain.then(function () {
        busy = false;
        container.classList.remove('is-busy');
        report(done, failed, lastErr);
        if (done && o.onChanged) o.onChanged();
        load();
      });
    }

    function restoreIds(ids) {
      const one = ids.length === 1 ? byId(ids[0]) : null;
      runEach(ids, function (id) { return Store.restoreNote(id); }, function (done, failed, e) {
        if (failed) toast('復原失敗 ' + failed + ' 篇' + (done ? '，成功 ' + done + ' 篇' : '') + '：' + errText(e));
        else toast(one ? '已復原「' + titleOf(one) + '」' : '已復原 ' + done + ' 篇筆記');
      });
    }

    function purgeIds(ids) {
      if (busy || !ids.length) return;
      const one = ids.length === 1 ? byId(ids[0]) : null;
      confirm({
        title: '永久刪除',
        message: (one ? '確定永久刪除「' + titleOf(one) + '」？' : '確定永久刪除這 ' + ids.length + ' 篇筆記？') +
          '\n這次真的無法復原，版本紀錄會一起刪除。',
        ok: '永久刪除', danger: true
      }).then(function (ok) {
        if (!ok) return;
        runEach(ids, function (id) { return Store.purgeNote(id); }, function (done, failed, e) {
          if (failed) toast('刪除失敗 ' + failed + ' 篇' + (done ? '，成功 ' + done + ' 篇' : '') + '：' + errText(e));
          else toast(one ? '已永久刪除「' + titleOf(one) + '」' : '已永久刪除 ' + done + ' 篇筆記');
        });
      });
    }

    function emptyAll() {
      if (busy || !notes.length) return;
      confirm({
        title: '清空垃圾桶',
        message: '確定永久刪除垃圾桶裡的全部 ' + notes.length + ' 篇筆記？\n這次真的無法復原。',
        ok: '全部永久刪除', danger: true
      }).then(function (ok) {
        if (!ok) return;
        busy = true;
        container.classList.add('is-busy');
        Store.emptyTrash().then(function (r) {
          toast('已清空垃圾桶（' + ((r && r.purged) || 0) + ' 篇）');
          selected.clear();
          if (o.onChanged) o.onChanged();
        }).catch(function (e) {
          toast('清空失敗：' + errText(e));
        }).then(function () {
          busy = false;
          container.classList.remove('is-busy');
          load();
        });
      });
    }

    function load() {
      Store.getTrash().then(function (data) {
        if (gen !== generation) return;
        keepDays = (data && data.keepDays) || keepDays;
        notes = ((data && data.notes) || []).slice().sort(function (a, b) { return b.deletedAt - a.deletedAt; });
        renderBody();
      }).catch(function (e) {
        if (gen !== generation) return;
        subtitle.textContent = '';
        body.textContent = '';
        const err = el('div', 'dash-empty');
        err.innerHTML = icon('alert-triangle');
        err.appendChild(el('span', null, '讀取垃圾桶失敗：' + errText(e)));
        body.appendChild(err);
      });
    }

    load();
  }

  global.Trash = { render: render };
})(window);
