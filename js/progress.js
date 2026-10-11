/* progress.js — 課程進度管理（使用者的話：「我可以輸入課程名稱、課程章節；完成一個章節就直接點完成，系統上就會顯示完成度；
 * 課程管理要綁定課程筆記以及 timetree；timetree 預設一個日曆叫做課程管理；可以新增提醒功能，並當逾期可以提示我重新規劃」）。
 *
 * 一門課程是一篇 area:'progress'、meta.progress 的筆記，標題就是課程名稱，內容是 ```progress 圍欄裡的 JSON（跟行事曆／看板一樣
 * 「文字就是真相」，版本、備份、搜尋、垃圾桶都不用新東西）：
 *   { color, folderId, reminders: [分鐘前…], chapters: [{ id, title, done, doneAt, due: 'YYYY-MM-DD'|'', noteId, eventId, reminders }] }
 *   - folderId：綁定的「課程筆記」資料夾（area 'course'）；章節的 noteId 是那個資料夾裡的一篇筆記（可以從章節直接建立）。
 *   - 跟 timetree 的綁定：有預計完成日的章節會在「課程管理」那本行事曆（meta.courseCal，第一次開這一頁時自動建立）放一個
 *     全天行程，eventId 記住它；改日期、改名、完成（標題加 ✓）、刪章節都同步過去，提醒就是那個行程的 reminders
 *     （timetree 頁面開著時會跳瀏覽器通知）。
 *   - 逾期：還沒完成而且預計完成日已經過了 → 頁面上方提示「重新規劃」：整批往後延 N 天、或重新平均分配到某一天。
 * 畫面（#progress 一頁，Progress.render）：左欄課程清單（圓環＋名稱＋幾章），右邊是選到的課程：總覽卡（大圓環、幾章完成、
 * 一格一章的進度條）、逾期提示、章節清單（圓圈裡是編號、勾了變打勾；點標題改名；右邊只放設定了的筆記／日期／提醒 chip，
 * 沒設定的滑過那列才淡淡出現；日期 chip 點開小選單 duePop，真正的 <input type=date data-due> 藏在列裡給 showPicker 用）、
 * 底下一列新增。blockHTML 把一門課程畫成靜態的進度卡（預覽、PDF、電子書）。
 */
(function (global) {
  'use strict';

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }
  function uid(p) { return (p || 'c') + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } }
  function toast(t) { if (global.App && App.toast) App.toast(t); }

  const COLORS = ['#d9962a', '#3b7ddd', '#7cb342', '#e5493a', '#8e5bc7', '#26a69a', '#e46ba0', '#f0862c', '#8a9499', '#2ec4a6'];
  // 章節是全天的，提醒只有「幾天前」才有意義
  const REMINDERS = [[0, '當天'], [1440, '1 天前'], [2880, '2 天前'], [4320, '3 天前'], [10080, '1 週前']];
  const REM_TEXT = {}; REMINDERS.forEach(function (r) { REM_TEXT[r[0]] = r[1]; });
  const ID_RE = /^[A-Za-z0-9_][\w.-]{0,63}$/;

  // ---------------- 日期（本地、字串） ----------------
  function dkey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseDay(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
  function fmtDay(s) { const d = parseDay(s); return d ? (d.getFullYear() !== today().getFullYear() ? d.getFullYear() + '/' : '') + (d.getMonth() + 1) + '/' + d.getDate() : ''; }
  function dueState(ch) {
    if (ch.done || !ch.due) return '';
    const n = daysBetween(today(), parseDay(ch.due));
    return n < 0 ? 'overdue' : n === 0 ? 'today' : n <= 3 ? 'soon' : '';
  }

  // ---------------- 模型 ----------------
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 500) : ''; }
  function cleanReminders(a) {
    const out = [];
    (Array.isArray(a) ? a : []).forEach(function (x) { const n = parseInt(x, 10); if (n >= 0 && n <= 40320 && out.indexOf(n) < 0) out.push(n); });
    return out.sort(function (p, q) { return p - q; });
  }
  function cleanChapter(c, seen) {
    if (!c || typeof c !== 'object') return null;
    let id = typeof c.id === 'string' && c.id ? c.id.slice(0, 40) : uid('c');
    if (seen[id]) id = uid('c');
    seen[id] = 1;
    const o = { id: id, title: str(c.title, 300).trim(), done: !!c.done, doneAt: c.done && c.doneAt > 0 ? Math.floor(c.doneAt) : 0, due: parseDay(c.due) ? c.due : '', noteId: ID_RE.test(c.noteId || '') ? c.noteId : '', eventId: typeof c.eventId === 'string' ? c.eventId.slice(0, 40) : '', reminders: cleanReminders(c.reminders) };
    if (!o.title) o.title = '（未命名章節）';
    return o;
  }
  function cleanCourse(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const o = { color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : COLORS[0], folderId: ID_RE.test(raw.folderId || '') ? raw.folderId : '', reminders: cleanReminders(raw.reminders), chapters: [] };
    const seen = {};
    (Array.isArray(raw.chapters) ? raw.chapters : []).forEach(function (c) { const x = cleanChapter(c, seen); if (x) o.chapters.push(x); });
    return o;
  }
  function parse(text) { let raw = null; try { raw = JSON.parse(String(text || '')); } catch (e) { raw = null; } return cleanCourse(raw); }
  function serialize(c) { return JSON.stringify(c, null, 1); }
  function payloadOf(content) { const m = /^```progress[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/m.exec(String(content || '')); return m ? m[1] : null; }
  function wrap(json) { return '```progress\n' + json + '\n```\n'; }
  function isNote(note) { return !!(note && note.meta && note.meta.progress); }
  // 新課程：章節標題一行一個；給了起訖日就把預計完成日平均分配
  function newCourse(d) {
    d = d || {};
    const c = cleanCourse({ color: d.color, folderId: d.folderId, reminders: d.reminders || [1440] });
    const titles = (d.chapters || []).map(function (t) { return String(t || '').trim(); }).filter(Boolean);
    const seen = {};
    titles.forEach(function (t) { c.chapters.push(cleanChapter({ title: t, reminders: c.reminders }, seen)); });
    if (d.start && d.end) distribute(c.chapters, d.start, d.end);
    return c;
  }
  function generate(d) { return wrap(serialize(newCourse(d))); }
  // 把章節的預計完成日平均分到 [start, end]（最後一章落在 end）
  function distribute(chs, start, end) {
    const s = parseDay(start), e = parseDay(end);
    if (!s || !e || !chs.length) return;
    const span = Math.max(0, daysBetween(s, e)), n = chs.length;
    chs.forEach(function (ch, i) { ch.due = dkey(addDays(s, n === 1 ? span : Math.round(span * (i + 1) / n))); });
  }
  function stats(c) {
    const total = c.chapters.length, done = c.chapters.filter(function (x) { return x.done; }).length;
    const overdue = c.chapters.filter(function (x) { return dueState(x) === 'overdue'; });
    const todayL = c.chapters.filter(function (x) { return dueState(x) === 'today'; });
    const dues = c.chapters.filter(function (x) { return x.due; }).map(function (x) { return x.due; }).sort();
    return { total: total, done: done, pct: total ? Math.round(done / total * 100) : 0, overdue: overdue, today: todayL, end: dues.length ? dues[dues.length - 1] : '' };
  }

  // ---------------- 靜態（```progress 圍欄：預覽、PDF、電子書） ----------------
  function blockHTML(payload, name) {
    const c = parse(payload), st = stats(c);
    return '<div class="pgs"><div class="pgs-head"><i style="background:' + c.color + '"></i><b>' + esc(name || '課程進度') + '</b><span>' + st.done + ' / ' + st.total + ' 章節・' + st.pct + '%' + (st.end ? '・預計 ' + esc(fmtDay(st.end)) + ' 完成' : '') + '</span></div>' +
      '<div class="pgs-bar"><i style="width:' + st.pct + '%;background:' + c.color + '"></i></div>' +
      '<ol class="pgs-list">' + c.chapters.map(function (ch) { const ds = dueState(ch); return '<li class="' + (ch.done ? 'is-done' : ds ? 'is-' + ds : '') + '"><span class="pgs-chk">' + ic(ch.done ? 'check-square' : 'square-empty') + '</span><span class="pgs-t">' + esc(ch.title) + '</span>' + (ch.due ? '<span class="pgs-due">' + esc(fmtDay(ch.due)) + (ds === 'overdue' ? '（逾期）' : '') + '</span>' : '') + '</li>'; }).join('') + (c.chapters.length ? '' : '<li class="is-empty">還沒有章節</li>') + '</ol></div>';
  }

  // ---------------- 頁面 ----------------
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function placeFixed(node, x, y) {
    document.body.appendChild(node);
    const w = node.offsetWidth, h = node.offsetHeight;
    node.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    node.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  }
  function menuAt(x, y, items, onPick) {
    closePop();
    popEl = el('div', 'tt-menu pg-menu');
    popEl.innerHTML = items.map(function (it) { return it ? '<button class="tt-menu-item' + (it[3] ? ' is-danger' : '') + '" type="button" data-a="' + it[0] + '"' + (it[2] ? ' disabled' : '') + '>' + esc(it[1]) + '</button>' : '<div class="tt-menu-sep"></div>'; }).join('');
    placeFixed(popEl, x, y);
    popEl.addEventListener('click', function (e) { const b = e.target.closest('[data-a]'); if (!b || b.disabled) return; const a = b.getAttribute('data-a'); closePop(); onPick(a); });
  }
  document.addEventListener('mousedown', function (e) { if (popEl && !popEl.contains(e.target) && !e.target.closest('.pg-pop, .pg-menu')) closePop(); }, true);

  const S = { selected: lsGet('pgCourse', '') || null, editing: null };
  const cache = new Map();   // noteId → { content, course }
  let host = null, O = null;

  function coursesOf() {
    return (O.courses || []).map(function (n) {
      let c = cache.get(n.id);
      if (!c || c.content !== n.content) { c = { content: n.content, course: parse(payloadOf(n.content) || '') }; cache.set(n.id, c); }
      return { id: n.id, note: n, course: c.course, name: n.title || '課程', ro: !!(O.readOnly && O.readOnly(n)) };
    });
  }
  function byId(id) { return coursesOf().find(function (c) { return c.id === id; }) || null; }
  function save(c) {
    const content = wrap(serialize(c.course));
    cache.set(c.id, { content: content, course: c.course });
    c.note.content = content;
    if (O.onChange) O.onChange(c.note, content);
  }
  function noteTitle(id) { const n = (O.allNotes || O.courseNotes || []).find(function (x) { return x.id === id; }); return n ? (n.title || '未命名筆記') : null; }
  function folderName(id) { const f = (O.courseFolders || []).find(function (x) { return x.id === id; }); return f ? f.name : null; }

  // ---- 跟 timetree 同步：有預計完成日的章節 = 「課程管理」行事曆裡的一個全天行程 ----
  function calData() {
    const n = O.calendar;
    if (!n || !global.TimeTree) return null;
    return { note: n, cal: TimeTree.parse(TimeTree.payloadOf(n.content) || '') };
  }
  function eventFor(c, ch) {
    return { id: ch.eventId || uid('e'), title: (ch.done ? '✓ ' : '') + c.name + '：' + ch.title, allDay: true, start: ch.due, end: ch.due, label: null, location: '', url: '', notes: '課程進度「' + c.name + '」的章節', images: [], repeat: null, exdates: [], reminders: ch.reminders.slice(), keep: false };
  }
  // chs 省略 = 整門課。回傳有沒有真的改到行事曆
  function syncEvents(c, chs) {
    const cd = calData();
    if (!cd) return false;
    let changed = false;
    const seen = {}; cd.cal.events.forEach(function (e) { seen[e.id] = 1; });
    (chs || c.course.chapters).forEach(function (ch) {
      const i = ch.eventId ? cd.cal.events.findIndex(function (e) { return e.id === ch.eventId; }) : -1;
      if (!ch.due) { if (i >= 0) { cd.cal.events.splice(i, 1); changed = true; } if (ch.eventId) { ch.eventId = ''; } return; }
      if (i < 0) delete seen[ch.eventId];
      const ev = TimeTree.cleanEvent(eventFor(c, ch), i >= 0 ? {} : seen);
      if (!ev) return;
      if (i >= 0) { if (JSON.stringify(cd.cal.events[i]) !== JSON.stringify(ev)) { cd.cal.events[i] = ev; changed = true; } }
      else { cd.cal.events.push(ev); changed = true; }
      if (ch.eventId !== ev.id) ch.eventId = ev.id;
    });
    if (changed) saveCal(cd);
    return changed;
  }
  function removeEvents(c, chs) {
    const cd = calData();
    if (!cd) return;
    const ids = {}; (chs || c.course.chapters).forEach(function (ch) { if (ch.eventId) ids[ch.eventId] = 1; });
    const before = cd.cal.events.length;
    cd.cal.events = cd.cal.events.filter(function (e) { return !ids[e.id]; });
    if (cd.cal.events.length !== before) saveCal(cd);
  }
  function saveCal(cd) {
    const content = TimeTree.wrap(TimeTree.serialize(cd.cal));
    cd.note.content = content;
    if (O.onChange) O.onChange(cd.note, content);
  }
  // 章節改了：先存課程，再同步行事曆（同步可能又改到 eventId，所以存兩次也沒關係——第二次才帶 eventId）
  function commit(c, chs) {
    const touched = syncEvents(c, chs);
    save(c);
    render(host, O);
    return touched;
  }

  // 圓環：r=17 → 周長 106.8
  function ring(pct, color) {
    // 0% 時不畫前景：round 的線端在長度 0 也會留一個點
    return '<svg class="pg-ring" viewBox="0 0 40 40" aria-hidden="true"><circle class="pg-ring-bg" cx="20" cy="20" r="17"></circle>' + (pct > 0 ? '<circle class="pg-ring-fg" cx="20" cy="20" r="17" style="stroke:' + color + ';stroke-dasharray:' + (pct * 1.068).toFixed(2) + ' 106.8" transform="rotate(-90 20 20)"></circle>' : '') + '</svg>';
  }
  function remText(list) { return list.map(function (m) { return REM_TEXT[m] || (m + ' 分鐘前'); }).join('、'); }
  // 預計完成日的文字＋狀態標籤（列上的日期 chip 和 popover 共用）
  function dueLabel(ch) {
    const ds = dueState(ch);
    if (!ch.due) return '';
    const n = daysBetween(today(), parseDay(ch.due));
    return esc(fmtDay(ch.due)) + (ds === 'overdue' ? '<span class="pg-tag is-overdue">逾期 ' + (-n) + ' 天</span>' : ds === 'today' ? '<span class="pg-tag is-today">今天</span>' : ds === 'soon' ? '<span class="pg-tag is-soon">' + n + ' 天後</span>' : '');
  }
  function render(container, opts) {
    host = container; O = opts || {};
    closePop();
    const cs = coursesOf();
    if (S.selected && !cs.some(function (c) { return c.id === S.selected; })) S.selected = null;
    if (!S.selected && cs.length) S.selected = cs[0].id;
    host.className = 'pg-page';
    host.innerHTML =
      '<aside class="pg-side">' +
        '<div class="pg-side-t"><span>課程</span><small>' + cs.length + '</small></div><div class="pg-courses">' +
        (cs.length ? cs.map(function (c) {
          const st = stats(c.course);
          return '<button type="button" class="pg-course' + (c.id === S.selected ? ' on' : '') + '" data-course="' + esc(c.id) + '" style="--c:' + c.course.color + '">' +
            '<span class="pg-course-ring">' + ring(st.pct, c.course.color) + '</span>' +
            '<span class="pg-course-body"><span class="pg-course-top"><span class="pg-course-name">' + esc(c.name) + '</span><span class="pg-course-pct">' + st.pct + '%</span></span>' +
            '<span class="pg-course-sub">' + (st.total ? st.done + ' / ' + st.total + ' 章' : '還沒有章節') + (st.overdue.length ? '<span class="pg-course-warn">' + ic('alert-triangle') + '逾期 ' + st.overdue.length + ' 章</span>' : st.today.length ? '<span class="pg-course-today">今天 ' + st.today.length + ' 章</span>' : '') + '</span></span>' +
          '</button>';
        }).join('') : '<div class="pg-side-empty">還沒有課程</div>') +
        '</div><button class="pg-side-add" type="button" data-act="new">' + ic('plus') + '<span>建立課程</span></button>' +
        '<div class="pg-side-foot"><button class="pg-side-link" type="button" data-act="calendar"' + (O.calendar ? '' : ' disabled') + '>' + ic('calendar') + '<span>在 timetree 看「課程管理」</span></button></div>' +
      '</aside>' +
      '<div class="pg-main">' + (S.selected ? '' : '<div class="pg-empty">' + ic('list-checks') + '<p>' + (cs.length ? '選一門課程' : '還沒有課程') + '</p>' + (cs.length ? '' : '<p class="pg-empty-sub">輸入課程名稱跟章節，完成一章就勾一章，進度跟 timetree 都會跟著動。</p><button class="tt-btn tt-btn-primary" type="button" data-act="new">' + ic('plus') + '建立課程</button>') + '</div>') + '</div>';
    if (S.selected) renderCourse();
    if (!host.__pgBound) { host.__pgBound = true; bind(); }
  }
  function renderCourse() {
    const c = byId(S.selected); if (!c) return;
    const st = stats(c.course), main = host.querySelector('.pg-main');
    const folder = c.course.folderId ? folderName(c.course.folderId) : null;
    const left = st.total - st.done;
    const meta = [];
    if (st.total && !left) meta.push('<b class="is-ok">全部完成 🎉</b>');
    else if (st.total) meta.push('剩 ' + left + ' 章');
    if (st.overdue.length) meta.push('<b class="is-bad">逾期 ' + st.overdue.length + ' 章</b>');
    if (st.today.length) meta.push('<b class="is-warn">今天 ' + st.today.length + ' 章</b>');
    if (st.end && left) meta.push('預計 ' + esc(fmtDay(st.end)) + ' 完成');
    main.innerHTML =
      '<div class="pg-course-page" style="--c:' + c.course.color + '">' +
      '<header class="pg-head">' +
        '<div class="pg-head-main"><h2 class="pg-name" data-act="rename" title="點一下改名">' + esc(c.name) + '</h2>' +
          '<div class="pg-sub">' +
            (c.course.folderId ? (folder ? '<button type="button" class="pg-link" data-act="folder" title="打開課程筆記資料夾">' + ic('folder') + esc(folder) + '</button>' : '<span class="pg-sub-x">' + ic('folder') + '綁定的資料夾已不存在</span>') : (c.ro ? '' : '<button type="button" class="pg-link is-dim" data-act="bind">' + ic('folder-plus') + '綁定課程筆記資料夾</button>')) +
            (c.course.reminders.length ? '<span>' + ic('bell') + esc(remText(c.course.reminders)) + '</span>' : '') +
          '</div></div>' +
        '<div class="pg-head-right">' + (c.ro ? '' : '<button class="tt-btn" type="button" data-act="replan">' + ic('repeat') + '重新規劃</button><button class="tt-btn pg-more" type="button" data-act="menu" title="更多">' + ic('more-horizontal') + '</button>') + '</div>' +
      '</header>' +
      '<section class="pg-overview">' +
        '<div class="pg-ring-wrap">' + ring(st.pct, c.course.color) + '<div class="pg-pct">' + st.pct + '%</div></div>' +
        '<div class="pg-ov-body">' +
          '<div class="pg-count">' + (st.total ? st.done + ' / ' + st.total + ' 章節完成' : '還沒有章節') + '</div>' +
          (meta.length ? '<div class="pg-ov-meta">' + meta.join('<i class="pg-dot"></i>') + '</div>' : '') +
          (st.total ? '<div class="pg-segs" title="每一格是一章">' + c.course.chapters.map(function (ch, i) { const ds = dueState(ch); return '<i class="' + (ch.done ? 'is-done' : ds === 'overdue' ? 'is-overdue' : ds === 'today' ? 'is-today' : '') + '" title="' + (i + 1) + '. ' + esc(ch.title) + (ch.done ? '（完成）' : ds === 'overdue' ? '（逾期）' : ds === 'today' ? '（今天）' : '') + '"></i>'; }).join('') + '</div>' : '') +
        '</div>' +
      '</section>' +
      (st.overdue.length ? '<div class="pg-alert">' + ic('alert-triangle') + '<span>有 ' + st.overdue.length + ' 個章節已經過了預計完成日：' + esc(st.overdue.map(function (x) { return x.title; }).slice(0, 3).join('、')) + (st.overdue.length > 3 ? '…' : '') + '。要不要重新規劃？</span>' + (c.ro ? '' : '<button class="tt-btn pg-alert-btn" type="button" data-act="replan">重新規劃</button>') + '</div>' : '') +
      (st.today.length && !st.overdue.length ? '<div class="pg-alert is-info">' + ic('bell') + '<span>今天要完成：' + esc(st.today.map(function (x) { return x.title; }).join('、')) + '</span></div>' : '') +
      '<section class="pg-chapters">' +
        c.course.chapters.map(function (ch, i) {
          const ds = dueState(ch), nt = ch.noteId ? noteTitle(ch.noteId) : null;
          return '<div class="pg-ch' + (ch.done ? ' is-done' : '') + (ds ? ' is-' + ds : '') + (S.editing === ch.id ? ' is-editing' : '') + '" data-ch="' + esc(ch.id) + '">' +
            '<label class="pg-ch-chk" title="' + (ch.done ? '取消完成' : '完成') + '"><input type="checkbox" data-done="' + esc(ch.id) + '"' + (ch.done ? ' checked' : '') + (c.ro ? ' disabled' : '') + '><i><span class="pg-ch-n">' + (i + 1) + '</span></i></label>' +
            '<div class="pg-ch-main">' + (S.editing === ch.id ? '<input class="tt-input pg-ch-edit" type="text" value="' + esc(ch.title) + '" data-edit="' + esc(ch.id) + '" maxlength="300">' : '<span class="pg-ch-t" data-edit-title="' + esc(ch.id) + '" title="點一下改名">' + esc(ch.title) + '</span>') + (ch.done && ch.doneAt ? '<span class="pg-ch-doneat">' + ic('check') + esc(fmtDay(dkey(new Date(ch.doneAt)))) + ' 完成</span>' : '') + '</div>' +
            '<div class="pg-ch-meta">' +
              (ch.noteId ? (nt !== null ? '<button type="button" class="pg-chip pg-chip-note" data-open-note="' + esc(ch.noteId) + '" title="打開筆記">' + ic('file-text') + '<span>' + esc(nt) + '</span></button>' : '<button type="button" class="pg-chip is-ghost is-bad" data-pick-note="' + esc(ch.id) + '" title="筆記已不存在，重新選">' + ic('file-text') + '<span>找不到筆記</span></button>') : (c.ro ? '' : '<button type="button" class="pg-chip is-ghost" data-pick-note="' + esc(ch.id) + '" title="綁一篇課程筆記">' + ic('file-plus') + '<span>筆記</span></button>')) +
              (ch.due ? '<button type="button" class="pg-chip pg-chip-due' + (ds ? ' is-' + ds : '') + '" data-due-pick="' + esc(ch.id) + '"' + (c.ro ? ' disabled' : '') + ' title="預計完成日">' + ic('calendar') + '<span>' + dueLabel(ch) + '</span></button>' : (c.ro ? '' : '<button type="button" class="pg-chip is-ghost" data-due-pick="' + esc(ch.id) + '" title="設定預計完成日">' + ic('calendar') + '<span>日期</span></button>')) +
              '<input class="pg-date-hidden" type="date" data-due="' + esc(ch.id) + '" value="' + esc(ch.due) + '" tabindex="-1"' + (c.ro ? ' disabled' : '') + '>' +
              (ch.due ? '<button type="button" class="pg-chip pg-chip-rem' + (ch.reminders.length ? ' on' : ' is-ghost') + '" data-rem="' + esc(ch.id) + '"' + (c.ro ? ' disabled' : '') + ' title="' + (ch.reminders.length ? '提醒：' + esc(remText(ch.reminders)) : '設定提醒') + '">' + ic('bell') + '<span>' + (ch.reminders.length ? esc(remText(ch.reminders)) : '提醒') + '</span></button>' : '') +
              (c.ro ? '' : '<button type="button" class="pg-icbtn" data-chmenu="' + esc(ch.id) + '" title="更多">' + ic('more-horizontal') + '</button>') +
            '</div>' +
          '</div>';
        }).join('') +
        (c.course.chapters.length || c.ro ? '' : '<div class="pg-ch-none">還沒有章節，在下面輸入第一章。</div>') +
        (c.ro ? '' : '<form class="pg-add"><span class="pg-add-ic">' + ic('plus') + '</span><input class="pg-add-input" type="text" placeholder="新增章節，按 Enter 加入（一次貼好幾行也可以）" maxlength="300"><button type="button" class="pg-chip is-ghost pg-add-date" data-add-date title="預計完成日（可不填）">' + ic('calendar') + '<span>日期</span></button><input class="pg-date pg-date-hidden" type="date" tabindex="-1"></form>') +
      '</section></div>';
    if (S.editing) { const inp = main.querySelector('[data-edit]'); if (inp) { inp.focus(); inp.select(); } }
  }
  // 原生日期選擇器：藏起來的 <input type=date> 用 showPicker 打開（要在使用者的點擊裡呼叫）
  function openPicker(inp) {
    if (!inp) return;
    try { if (inp.showPicker) { inp.showPicker(); return; } } catch (e) { /* 沒有使用者手勢等 → 退回 focus */ }
    inp.focus(); try { inp.click(); } catch (e) { /* */ }
  }
  // 日期 chip 的小選單：今天／明天／三天後／下週／自己選／清掉
  function duePop(chId, anchor) {
    const c = byId(S.selected); if (!c || c.ro) return;
    const ch = c.course.chapters.find(function (x) { return x.id === chId; }); if (!ch) return;
    closePop();
    const t = today();
    const quick = [['今天', dkey(t)], ['明天', dkey(addDays(t, 1))], ['3 天後', dkey(addDays(t, 3))], ['下週', dkey(addDays(t, 7))]];
    popEl = el('div', 'tt-pop pg-pop pg-duepop');
    popEl.innerHTML = '<div class="tt-pop-label">預計完成日' + (ch.due ? '：' + esc(fmtDay(ch.due)) : '') + '</div>' +
      '<div class="pg-quick">' + quick.map(function (q) { return '<button type="button" class="tt-rem' + (ch.due === q[1] ? ' on' : '') + '" data-d="' + q[1] + '">' + q[0] + '</button>'; }).join('') + '</div>' +
      '<div class="pg-duepop-row"><button type="button" class="tt-btn" data-pick="1">' + ic('calendar') + '選日期…</button>' + (ch.due ? '<button type="button" class="tt-btn" data-clear="1">清掉日期</button>' : '') + '</div>';
    const r = anchor.getBoundingClientRect(); placeFixed(popEl, r.left, r.bottom + 4);
    popEl.addEventListener('click', function (e) {
      const inp = host.querySelector('[data-due="' + ch.id + '"]');
      const q = e.target.closest('[data-d]');
      if (q) { closePop(); ch.due = q.getAttribute('data-d'); commit(c, [ch]); return; }
      if (e.target.closest('[data-clear]')) { closePop(); ch.due = ''; commit(c, [ch]); return; }
      if (e.target.closest('[data-pick]')) { closePop(); openPicker(inp); }
    });
  }

  // ---- 事件 ----
  function bind() {
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('submit', function (e) { const f = e.target.closest('.pg-add'); if (!f) return; e.preventDefault(); addFromForm(f); });
    host.addEventListener('paste', function (e) {
      const inp = e.target.closest('.pg-add-input'); if (!inp) return;
      const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (text.indexOf('\n') < 0) return;
      e.preventDefault();
      const c = byId(S.selected); if (!c || c.ro) return;
      addChapters(c, (inp.value + text).split(/\r?\n/));
    });
    host.addEventListener('keydown', function (e) {
      const ed = e.target.closest('[data-edit]');
      if (ed) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commitEdit(ed); } else if (e.key === 'Escape') { S.editing = null; render(host, O); } return; }
      if (e.target.closest('.pg-add')) e.stopPropagation();
    });
    host.addEventListener('focusout', function (e) { const ed = e.target.closest ? e.target.closest('[data-edit]') : null; if (ed && S.editing) commitEdit(ed); });
  }
  function addFromForm(f) {
    const c = byId(S.selected); if (!c || c.ro) return;
    const inp = f.querySelector('.pg-add-input'), due = f.querySelector('.pg-date').value;
    const t = inp.value.trim(); if (!t) return;
    addChapters(c, [t], due);
  }
  function addChapters(c, titles, due) {
    const seen = {}; c.course.chapters.forEach(function (x) { seen[x.id] = 1; });
    const added = [];
    titles.forEach(function (t) { t = String(t || '').trim(); if (!t) return; const ch = cleanChapter({ title: t, due: due || '', reminders: c.course.reminders }, seen); c.course.chapters.push(ch); added.push(ch); });
    if (!added.length) return;
    commit(c, added);
    const inp = host.querySelector('.pg-add-input'); if (inp) inp.focus();
  }
  function commitEdit(inp) {
    const c = byId(S.selected), id = inp.getAttribute('data-edit');
    S.editing = null;
    if (!c) { render(host, O); return; }
    const ch = c.course.chapters.find(function (x) { return x.id === id; });
    const t = inp.value.trim();
    if (!ch || !t || t === ch.title) { render(host, O); return; }
    ch.title = t;
    commit(c, [ch]);
  }
  function onChange(e) {
    const c = byId(S.selected); if (!c || c.ro) return;
    const done = e.target.closest('[data-done]');
    if (done) {
      const ch = c.course.chapters.find(function (x) { return x.id === done.getAttribute('data-done'); }); if (!ch) return;
      ch.done = done.checked; ch.doneAt = ch.done ? Date.now() : 0;
      commit(c, [ch]);
      if (ch.done && stats(c.course).done === stats(c.course).total) toast('「' + c.name + '」全部完成了 🎉');
      return;
    }
    const due = e.target.closest('[data-due]');
    if (due) {
      const ch = c.course.chapters.find(function (x) { return x.id === due.getAttribute('data-due'); }); if (!ch) return;
      ch.due = parseDay(due.value) ? due.value : '';
      commit(c, [ch]);
      return;
    }
    // 新增列的日期：chip 顯示選到的日期
    const addDate = e.target.closest('.pg-add .pg-date');
    if (addDate) {
      const chip = host.querySelector('.pg-add-date'); if (!chip) return;
      const v = parseDay(addDate.value) ? addDate.value : '';
      chip.classList.toggle('is-ghost', !v); chip.classList.toggle('on', !!v);
      chip.querySelector('span').textContent = v ? fmtDay(v) : '日期';
      const inp = host.querySelector('.pg-add-input'); if (inp) inp.focus();
    }
  }
  function onClick(e) {
    const cb = e.target.closest('[data-course]'); if (cb) { S.selected = cb.getAttribute('data-course'); lsSet('pgCourse', S.selected); S.editing = null; render(host, O); if (O.onSelect) O.onSelect(S.selected); return; }
    const on = e.target.closest('[data-open-note]'); if (on) { if (O.onOpenNote) O.onOpenNote(on.getAttribute('data-open-note')); return; }
    const pn = e.target.closest('[data-pick-note]'); if (pn) { pickNote(pn.getAttribute('data-pick-note'), pn); return; }
    const rm = e.target.closest('[data-rem]'); if (rm) { reminderPop(rm.getAttribute('data-rem'), rm); return; }
    const dp = e.target.closest('[data-due-pick]'); if (dp) { duePop(dp.getAttribute('data-due-pick'), dp); return; }
    const ad = e.target.closest('[data-add-date]'); if (ad) { openPicker(host.querySelector('.pg-add .pg-date')); return; }
    const cm = e.target.closest('[data-chmenu]'); if (cm) { chapterMenu(cm.getAttribute('data-chmenu'), cm); return; }
    const et = e.target.closest('[data-edit-title]'); if (et) { const c = byId(S.selected); if (c && !c.ro) { S.editing = et.getAttribute('data-edit-title'); render(host, O); } return; }
    const ab = e.target.closest('[data-act]'); if (ab && host.contains(ab)) { act(ab.getAttribute('data-act'), ab); }
  }
  function act(a, anchor) {
    const c = byId(S.selected);
    if (a === 'new') { newCourseDialog(); return; }
    if (a === 'calendar') { if (O.onOpenCalendar) O.onOpenCalendar(); return; }
    if (!c) return;
    if (a === 'rename') { if (!c.ro && O.onRename) O.onRename(c.note); }
    else if (a === 'folder') { if (O.onOpenFolder) O.onOpenFolder(c.course.folderId); }
    else if (a === 'bind') { if (!c.ro) bindFolderDialog(c); }
    else if (a === 'replan') { if (!c.ro) replanDialog(c); }
    else if (a === 'menu') courseMenu(c, anchor);
  }
  function courseMenu(c, anchor) {
    const r = anchor.getBoundingClientRect();
    menuAt(r.right - 180, r.bottom + 4, [['rename', '重新命名'], ['bind', c.course.folderId ? '更換綁定的資料夾…' : '綁定課程筆記資料夾…'], ['import', '把資料夾裡的筆記加成章節', !c.course.folderId], ['color', '變更顏色'], ['reminders', '預設提醒…'], ['tags', '標籤…'], null, ['resetdone', '全部標成未完成'], null, ['del', '移到垃圾桶', false, true]], function (a) {
      if (a === 'rename') { if (O.onRename) O.onRename(c.note); }
      else if (a === 'bind') bindFolderDialog(c);
      else if (a === 'import') importFolderNotes(c);
      else if (a === 'color') colorPop(anchor, c);
      else if (a === 'reminders') remindersDialog(c);
      else if (a === 'tags') { if (O.onTags) O.onTags(c.note); }
      else if (a === 'resetdone') { c.course.chapters.forEach(function (x) { x.done = false; x.doneAt = 0; }); commit(c); }
      else if (a === 'del') { if (O.onDelete) O.onDelete(c.note, function () { removeEvents(c); }); }
    });
  }
  function chapterMenu(id, anchor) {
    const c = byId(S.selected); if (!c) return;
    const i = c.course.chapters.findIndex(function (x) { return x.id === id; }); if (i < 0) return;
    const ch = c.course.chapters[i];
    const r = anchor.getBoundingClientRect();
    menuAt(r.right - 180, r.bottom + 4, [['edit', '改名'], ['newnote', ch.noteId ? '建立另一篇筆記' : '在課程筆記裡建立這一章的筆記'], ['picknote', '選擇已有的筆記'], ['unlink', '取消連結筆記', !ch.noteId], null, ['up', '上移', i === 0], ['down', '下移', i === c.course.chapters.length - 1], ['insert', '在上面插入章節'], null, ['del', '刪除章節', false, true]], function (a) {
      if (a === 'edit') { S.editing = id; render(host, O); }
      else if (a === 'newnote') newNoteFor(c, ch);
      else if (a === 'picknote') pickNote(id, anchor);
      else if (a === 'unlink') { ch.noteId = ''; commit(c, [ch]); }
      else if (a === 'up' || a === 'down') { const j = a === 'up' ? i - 1 : i + 1; c.course.chapters.splice(i, 1); c.course.chapters.splice(j, 0, ch); save(c); render(host, O); }
      else if (a === 'insert') { const ask = global.App && App.prompt ? App.prompt({ title: '插入章節', placeholder: '章節名稱', ok: '插入' }) : Promise.resolve(window.prompt('章節名稱')); ask.then(function (t) { t = String(t || '').trim(); if (!t) return; const seen = {}; c.course.chapters.forEach(function (x) { seen[x.id] = 1; }); const nc = cleanChapter({ title: t, reminders: c.course.reminders }, seen); c.course.chapters.splice(i, 0, nc); commit(c, [nc]); }); }
      else if (a === 'del') { const ask = global.App && App.confirm ? App.confirm({ title: '刪除章節', message: '刪除「' + ch.title + '」？行事曆上對應的行程也會一起拿掉。', ok: '刪除', danger: true }) : Promise.resolve(window.confirm('刪除？')); ask.then(function (yes) { if (!yes) return; removeEvents(c, [ch]); c.course.chapters.splice(i, 1); save(c); render(host, O); }); }
    });
  }
  function newNoteFor(c, ch) {
    if (!O.onNewNote) return;
    const go = function (folderId) {
      Promise.resolve(O.onNewNote(folderId, ch.title)).then(function (n) { if (!n) return; ch.noteId = n.id; commit(c, [ch]); toast('已在課程筆記建立「' + ch.title + '」'); }, function (e) { toast('建立失敗：' + (e && e.message || e)); });
    };
    if (c.course.folderId && folderName(c.course.folderId)) { go(c.course.folderId); return; }
    // 還沒綁資料夾：先建一個同名資料夾綁起來，再把筆記放進去
    if (!O.onCreateFolder) { go(null); return; }
    Promise.resolve(O.onCreateFolder(c.name)).then(function (f) { if (f) { c.course.folderId = f.id; save(c); } go(f ? f.id : null); }, function (e) { toast('建立資料夾失敗：' + (e && e.message || e)); });
  }
  function notesInFolder(folderId) {
    return (O.courseNotes || []).filter(function (n) { return !folderId || n.folderId === folderId; }).slice().sort(function (a, b) { return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hant', { numeric: true }); });
  }
  function pickNote(chId, anchor) {
    const c = byId(S.selected); if (!c || c.ro) return;
    const ch = c.course.chapters.find(function (x) { return x.id === chId; }); if (!ch) return;
    closePop();
    const inFolder = c.course.folderId ? notesInFolder(c.course.folderId) : [];
    const all = notesInFolder(null);
    popEl = el('div', 'tt-pop pg-pop pg-pick');
    const row = function (n) { return '<button type="button" class="pg-pick-row' + (n.id === ch.noteId ? ' on' : '') + '" data-n="' + esc(n.id) + '">' + ic('file-text') + '<span>' + esc(n.title || '未命名筆記') + '</span></button>'; };
    popEl.innerHTML = '<div class="tt-pop-label">「' + esc(ch.title) + '」的筆記</div>' +
      '<button type="button" class="pg-pick-row is-new" data-new="1">' + ic('file-plus') + '<span>建立新筆記「' + esc(ch.title) + '」</span></button>' +
      '<input class="tt-input pg-pick-q" type="search" placeholder="搜尋課程筆記">' +
      '<div class="pg-pick-list">' + (inFolder.length ? '<div class="pg-pick-t">' + esc(folderName(c.course.folderId)) + '</div>' + inFolder.map(row).join('') : '') + (all.length ? '<div class="pg-pick-t">所有課程筆記</div>' + all.map(row).join('') : '<div class="tt-side-empty">還沒有課程筆記</div>') + '</div>';
    const r = anchor.getBoundingClientRect(); placeFixed(popEl, r.left, r.bottom + 4);
    popEl.addEventListener('click', function (e) {
      if (e.target.closest('[data-new]')) { closePop(); newNoteFor(c, ch); return; }
      const b = e.target.closest('[data-n]'); if (!b) return;
      ch.noteId = b.getAttribute('data-n'); closePop(); commit(c, [ch]);
    });
    const q = popEl.querySelector('.pg-pick-q');
    q.addEventListener('input', function () { const v = q.value.trim().toLowerCase(); popEl.querySelectorAll('.pg-pick-row[data-n]').forEach(function (b) { b.hidden = !!v && b.textContent.toLowerCase().indexOf(v) < 0; }); });
    q.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape') closePop(); });
    setTimeout(function () { q.focus(); }, 0);
  }
  function reminderPop(chId, anchor) {
    const c = byId(S.selected); if (!c || c.ro) return;
    const ch = c.course.chapters.find(function (x) { return x.id === chId; }); if (!ch) return;
    closePop();
    popEl = el('div', 'tt-pop pg-pop');
    popEl.innerHTML = '<div class="tt-pop-label">提醒' + (ch.due ? '（預計 ' + esc(fmtDay(ch.due)) + '）' : '') + '</div>' + (ch.due ? '' : '<div class="tt-side-empty">先填預計完成日，提醒才會放到行事曆。</div>') +
      '<div class="tt-ed-rem">' + REMINDERS.map(function (r) { return '<button type="button" class="tt-rem' + (ch.reminders.indexOf(r[0]) >= 0 ? ' on' : '') + '" data-m="' + r[0] + '">' + r[1] + '</button>'; }).join('') + '</div>' +
      '<div class="tt-set-hint">提醒是「課程管理」行事曆上那個行程的提醒：timetree 頁面開著時會跳通知。</div>';
    const r = anchor.getBoundingClientRect(); placeFixed(popEl, r.left, r.bottom + 4);
    popEl.addEventListener('click', function (e) {
      const b = e.target.closest('[data-m]'); if (!b) return;
      const m = +b.getAttribute('data-m'), i = ch.reminders.indexOf(m);
      if (i >= 0) ch.reminders.splice(i, 1); else ch.reminders.push(m);
      ch.reminders.sort(function (p, q) { return p - q; });
      b.classList.toggle('on');
      syncEvents(c, [ch]); save(c);
      const chip = host.querySelector('[data-rem="' + ch.id + '"]');
      if (chip) { chip.classList.toggle('on', !!ch.reminders.length); chip.classList.toggle('is-ghost', !ch.reminders.length); chip.querySelector('span').textContent = ch.reminders.length ? remText(ch.reminders) : '提醒'; chip.title = ch.reminders.length ? '提醒：' + remText(ch.reminders) : '設定提醒'; }
    });
  }
  function colorPop(anchor, c) {
    closePop();
    popEl = el('div', 'tt-pop tt-pop-colors pg-pop');
    popEl.innerHTML = COLORS.map(function (col) { return '<button type="button" class="tt-swatch' + (col === c.course.color ? ' on' : '') + '" data-color="' + col + '" style="background:' + col + '"></button>'; }).join('');
    const r = anchor.getBoundingClientRect(); placeFixed(popEl, r.left, r.bottom + 4);
    popEl.addEventListener('click', function (e) { const b = e.target.closest('[data-color]'); if (!b) return; c.course.color = b.getAttribute('data-color'); closePop(); save(c); render(host, O); });
  }
  // 把綁定資料夾裡還沒變成章節的筆記加進來（標題自然排序）
  function importFolderNotes(c) {
    if (!c.course.folderId) return;
    const have = {}; c.course.chapters.forEach(function (x) { if (x.noteId) have[x.noteId] = 1; });
    const seen = {}; c.course.chapters.forEach(function (x) { seen[x.id] = 1; });
    const added = [];
    notesInFolder(c.course.folderId).forEach(function (n) { if (have[n.id]) return; const ch = cleanChapter({ title: n.title || '未命名筆記', noteId: n.id, reminders: c.course.reminders }, seen); c.course.chapters.push(ch); added.push(ch); });
    if (!added.length) { toast('資料夾裡的筆記都已經是章節了'); return; }
    commit(c, added); toast('加入了 ' + added.length + ' 個章節');
  }

  // ---- 對話框 ----
  function dialog(cls, html) {
    const ov = el('div', 'modal-overlay tt-dialog-overlay');
    ov.innerHTML = '<div class="modal tt-dialog pg-dialog ' + (cls || '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(ov);
    const close = function () { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    ov.addEventListener('keydown', function (e) { e.stopPropagation(); });
    const cancel = ov.querySelector('.pg-dcancel'); if (cancel) cancel.addEventListener('click', close);
    return { ov: ov, close: close, f: function (name) { return ov.querySelector('[data-f="' + name + '"]'); } };
  }
  function folderOptions(sel) {
    return '<option value="">（不綁定）</option><option value="__new__">建立同名的新資料夾</option>' + (O.courseFolders || []).slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh-Hant'); }).map(function (f) { return '<option value="' + esc(f.id) + '"' + (f.id === sel ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('');
  }
  function remChips(selected) { return '<div class="tt-ed-rem">' + REMINDERS.map(function (r) { return '<button type="button" class="tt-rem' + (selected.indexOf(r[0]) >= 0 ? ' on' : '') + '" data-m="' + r[0] + '">' + r[1] + '</button>'; }).join('') + '</div>'; }
  function chipsValue(root) { return Array.prototype.map.call(root.querySelectorAll('.tt-rem.on'), function (b) { return +b.getAttribute('data-m'); }); }
  function bindChips(root) { root.addEventListener('click', function (e) { const b = e.target.closest('.tt-rem'); if (b) b.classList.toggle('on'); }); }
  function newCourseDialog() {
    const d = dialog('pg-new',
      '<div class="modal-title">' + ic('list-checks') + '建立課程</div>' +
      '<div class="tt-dialog-body">' +
        '<label class="pg-f"><span>課程名稱</span><input class="tt-input" type="text" data-f="title" placeholder="例如：OSCP 課程、Python 入門" maxlength="200"></label>' +
        '<label class="pg-f"><span>章節（一行一章）</span><textarea class="tt-input pg-ta" data-f="chapters" rows="6" placeholder="第 1 章 環境建置&#10;第 2 章 資訊收集&#10;第 3 章 …"></textarea></label>' +
        '<label class="pg-f"><span>綁定課程筆記資料夾</span><select class="tt-input" data-f="folder">' + folderOptions('') + '</select><small class="pg-f-hint">綁了之後，每一章可以直接在那個資料夾建立筆記；也可以把資料夾裡已有的筆記當章節。</small></label>' +
        '<label class="pg-f pg-f-chk"><input type="checkbox" data-f="fromFolder"><span>用資料夾裡的筆記當章節（跟上面的章節合併）</span></label>' +
        '<div class="pg-f-row"><label class="pg-f"><span>開始日</span><input class="tt-input" type="date" data-f="start" value="' + dkey(today()) + '"></label><label class="pg-f"><span>預計完成日</span><input class="tt-input" type="date" data-f="end"></label></div>' +
        '<div class="pg-f-hint">兩個日期都填，章節的預計完成日會平均分配，並放到 timetree 的「課程管理」行事曆。</div>' +
        '<div class="pg-f"><span>預設提醒（每一章的預計完成日前）</span>' + remChips([1440]) + '</div>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn pg-dcancel" type="button">取消</button><button class="btn btn-primary pg-dok" type="button">建立</button></div>');
    bindChips(d.ov);
    const go = function () {
      const title = d.f('title').value.trim();
      if (!title) { d.f('title').focus(); d.f('title').classList.add('is-err'); return; }
      const folderSel = d.f('folder').value, start = d.f('start').value, end = d.f('end').value;
      const chapters = d.f('chapters').value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      const reminders = chipsValue(d.ov), fromFolder = d.f('fromFolder').checked;
      d.close();
      const make = function (folderId) {
        const course = newCourse({ chapters: chapters, folderId: folderId || '', reminders: reminders, color: COLORS[coursesOf().length % COLORS.length] });
        if (fromFolder && folderId) {
          const have = {}; course.chapters.forEach(function (x) { have[x.title] = x; });
          const seen = {}; course.chapters.forEach(function (x) { seen[x.id] = 1; });
          notesInFolder(folderId).forEach(function (n) { const t = n.title || '未命名筆記'; if (have[t]) { have[t].noteId = n.id; return; } course.chapters.push(cleanChapter({ title: t, noteId: n.id, reminders: reminders }, seen)); });
        }
        if (start && end) distribute(course.chapters, start, end);
        if (O.onCreate) O.onCreate({ title: title, course: course });
      };
      if (folderSel === '__new__' && O.onCreateFolder) Promise.resolve(O.onCreateFolder(title)).then(function (f) { make(f ? f.id : ''); }, function (e) { toast('建立資料夾失敗：' + (e && e.message || e)); make(''); });
      else make(folderSel);
    };
    d.ov.querySelector('.pg-dok').addEventListener('click', go);
    d.f('title').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    setTimeout(function () { d.f('title').focus(); }, 0);
  }
  // 建立完成後（app.js 建好筆記再呼叫，帶新的 opts——舊的 O.courses 裡還沒有這門課）：選到它、章節的行程寫進行事曆
  function afterCreate(noteId, opts) {
    if (opts) O = opts;
    S.selected = noteId; lsSet('pgCourse', noteId);
    const c = byId(noteId);
    if (c) { if (syncEvents(c)) save(c); }
    render(host, O);
  }
  function bindFolderDialog(c) {
    const d = dialog('',
      '<div class="modal-title">' + ic('folder') + '綁定課程筆記資料夾</div>' +
      '<div class="tt-dialog-body"><label class="pg-f"><span>資料夾（課程筆記）</span><select class="tt-input" data-f="folder">' + folderOptions(c.course.folderId) + '</select></label><div class="pg-f-hint">章節的「筆記」會從這個資料夾裡選或建立。</div></div>' +
      '<div class="modal-actions"><button class="btn pg-dcancel" type="button">取消</button><button class="btn btn-primary pg-dok" type="button">確定</button></div>');
    d.ov.querySelector('.pg-dok').addEventListener('click', function () {
      const v = d.f('folder').value; d.close();
      const set = function (id) { c.course.folderId = id || ''; save(c); render(host, O); };
      if (v === '__new__' && O.onCreateFolder) Promise.resolve(O.onCreateFolder(c.name)).then(function (f) { set(f ? f.id : ''); }, function (e) { toast('建立資料夾失敗：' + (e && e.message || e)); });
      else set(v);
    });
  }
  function remindersDialog(c) {
    const d = dialog('',
      '<div class="modal-title">' + ic('bell') + '預設提醒</div>' +
      '<div class="tt-dialog-body"><div class="pg-f"><span>之後新增的章節預設提醒</span>' + remChips(c.course.reminders) + '</div><label class="pg-f pg-f-chk"><input type="checkbox" data-f="apply"><span>也套用到現有的章節</span></label></div>' +
      '<div class="modal-actions"><button class="btn pg-dcancel" type="button">取消</button><button class="btn btn-primary pg-dok" type="button">儲存</button></div>');
    bindChips(d.ov);
    d.ov.querySelector('.pg-dok').addEventListener('click', function () {
      c.course.reminders = chipsValue(d.ov);
      const apply = d.f('apply').checked; d.close();
      if (apply) { c.course.chapters.forEach(function (x) { x.reminders = c.course.reminders.slice(); }); commit(c); }
      else { save(c); render(host, O); }
    });
  }
  // 重新規劃：逾期（或全部未完成）的章節整批往後延，或重新平均分配到新的完成日
  function replanDialog(c) {
    const st = stats(c.course);
    const undone = c.course.chapters.filter(function (x) { return !x.done; });
    if (!undone.length) { toast('所有章節都完成了，沒有需要規劃的'); return; }
    const defEnd = st.end && parseDay(st.end) > today() ? st.end : dkey(addDays(today(), Math.max(7, undone.length * 3)));
    const d = dialog('pg-replan',
      '<div class="modal-title">' + ic('repeat') + '重新規劃「' + esc(c.name) + '」</div>' +
      '<div class="tt-dialog-body">' +
        (st.overdue.length ? '<div class="pg-alert">' + ic('alert-triangle') + '<span>逾期 ' + st.overdue.length + ' 章：' + esc(st.overdue.map(function (x) { return x.title + '（' + fmtDay(x.due) + '）'; }).join('、')) + '</span></div>' : '') +
        '<label class="pg-opt"><input type="radio" name="pg-how" value="shift" checked><span>把還沒完成的章節整批往後延 <input class="tt-input pg-days" type="number" min="1" max="365" value="7" data-f="days"> 天</span></label>' +
        '<label class="pg-opt"><input type="radio" name="pg-how" value="spread"><span>重新平均分配：從今天到 <input class="tt-input pg-datein" type="date" data-f="end" value="' + esc(defEnd) + '"> 完成剩下的 ' + undone.length + ' 章</span></label>' +
        '<label class="pg-opt"><input type="radio" name="pg-how" value="overdue"><span>只把逾期的章節改到今天起接著排（每天一章）</span></label>' +
        '<label class="pg-opt"><input type="radio" name="pg-how" value="clear"><span>清掉逾期章節的日期（之後再排）</span></label>' +
        '<div class="pg-f-hint">timetree「課程管理」行事曆上的行程會一起改。</div>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn pg-dcancel" type="button">取消</button><button class="btn btn-primary pg-dok" type="button">套用</button></div>');
    d.ov.querySelector('.pg-dok').addEventListener('click', function () {
      const how = d.ov.querySelector('input[name="pg-how"]:checked').value;
      const days = Math.max(1, Math.min(365, parseInt(d.f('days').value, 10) || 7)), end = d.f('end').value;
      d.close();
      if (how === 'shift') undone.forEach(function (x) { if (x.due) x.due = dkey(addDays(parseDay(x.due), days)); });
      else if (how === 'spread') { if (!parseDay(end) || parseDay(end) < today()) { toast('完成日要在今天之後'); return; } distribute(undone, dkey(today()), end); }
      else if (how === 'overdue') { st.overdue.forEach(function (x, i) { x.due = dkey(addDays(today(), i)); }); }
      else if (how === 'clear') st.overdue.forEach(function (x) { x.due = ''; });
      commit(c, undone);
      toast('已重新規劃');
    });
  }

  function teardown() { closePop(); }

  global.Progress = { isNote: isNote, generate: generate, parse: parse, serialize: serialize, payloadOf: payloadOf, wrap: wrap, newCourse: newCourse, stats: stats, blockHTML: blockHTML, render: render, afterCreate: afterCreate, closePop: closePop, teardown: teardown, state: S, REMINDERS: REMINDERS, COLORS: COLORS };
})(window);
