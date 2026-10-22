/* timetree.js — 行事曆：照 TimeTree 的個人功能做的（使用者的話：「新增一個 timetree 的頁面，裡面的功能做到 100% 跟
 * timetree 一樣（先以個人功能為主）」）。
 *
 * 一本行事曆是一篇 area:'timetree'、meta.timetree 的筆記，內容是 ```timetree 圍欄裡的 JSON（跟看板／起始頁／xmind
 * 一樣「文字就是真相」）：
 *   { color, labels: [{id, name, color}×10], events: [event] }
 *   event = { id, title, allDay, start, end, label, location, url, notes, images, repeat: null|{freq, interval, until, count, byDay},
 *             exdates: ['YYYY-MM-DD'], reminders: [分鐘前…], keep }
 * 日期一律本地時間字串：全天是 'YYYY-MM-DD'（end 含當天），有時間是 'YYYY-MM-DDTHH:MM'。
 * 畫面（#timetree 一頁，TimeTree.render）：左欄行事曆清單（顏色點、顯示／隱藏、⋯ 選單）、Keep（還沒排日期的行程）、
 * 設定；上面是標題「2026年10月」、今天、←→、月／週／日／行程切換、搜尋、＋；中間是月曆（跨日的行程是橫條）、
 * 週曆／日曆（時間軸、全天列、拖動改時間、拉下緣改結束）、行程清單；點一天右邊列出當天行程。行程：標題、全天、
 * 起迄、標籤顏色（TimeTree 的十色，可改名）、重複（每天／每週／每月／每年＋間隔、結束日）、提醒（可多個；頁面開著
 * 時用瀏覽器通知）、地點、網址、備註、圖片；重複的行程編輯／刪除可以選「只有這一次」或「全部」。匯出／匯入 .ics。
 * blockHTML 把一本行事曆畫成靜態的這個月＋接下來兩週（預覽、PDF、電子書）。
 */
(function (global) {
  'use strict';

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }
  function uid(p) { return (p || 'e') + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } }

  // TimeTree 的十個標籤顏色（可以改名；顏色固定）
  const LABELS = [['#e5493a', '紅'], ['#f0862c', '橘'], ['#f3c13a', '黃'], ['#7cb342', '綠'], ['#26a69a', '藍綠'], ['#3b7ddd', '藍'], ['#8e5bc7', '紫'], ['#e46ba0', '粉紅'], ['#a1785b', '咖啡'], ['#8a9499', '灰']];
  const CAL_COLORS = ['#2ec4a6', '#3b7ddd', '#e5493a', '#f0862c', '#7cb342', '#8e5bc7', '#e46ba0', '#26a69a', '#f3c13a', '#8a9499'];
  const REMINDERS = [[0, '準時'], [5, '5 分鐘前'], [10, '10 分鐘前'], [30, '30 分鐘前'], [60, '1 小時前'], [120, '2 小時前'], [1440, '1 天前'], [2880, '2 天前'], [10080, '1 週前']];
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  // ---------------- 日期 ----------------
  function dkey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function tkey(d) { return dkey(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function parseLocal(s) {   // 'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:MM' → Date（本地）
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(String(s || ''));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0, 0);
  }
  function dayOf(s) { return parseLocal(String(s || '').slice(0, 10)); }
  function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes()); return x; }
  function addMonths(d, n) { const x = new Date(d.getFullYear(), d.getMonth() + n, 1); const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate(); x.setDate(Math.min(d.getDate(), last)); x.setHours(d.getHours(), d.getMinutes()); return x; }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function startOfWeek(d, ws) { const x = startOfDay(d); const diff = (x.getDay() - ws + 7) % 7; return addDays(x, -diff); }
  function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / 86400000); }
  function fmtTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function fmtDate(d, withYear) { return (withYear ? d.getFullYear() + '年' : '') + (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WEEKDAYS[d.getDay()] + '）'; }
  function isToday(d) { return dkey(d) === dkey(new Date()); }
  function rangeText(inst) {
    const s = inst.start, e = inst.end;
    if (inst.allDay) { const days = daysBetween(s, e); return days <= 0 ? fmtDate(s, true) + '　全天' : fmtDate(s, true) + ' – ' + fmtDate(e, s.getFullYear() !== e.getFullYear()); }
    if (dkey(s) === dkey(e)) return fmtDate(s, true) + '　' + fmtTime(s) + ' – ' + fmtTime(e);
    return fmtDate(s, true) + ' ' + fmtTime(s) + ' – ' + fmtDate(e, s.getFullYear() !== e.getFullYear()) + ' ' + fmtTime(e);
  }

  // ---------------- 模型 ----------------
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 2000) : ''; }
  function hexOk(c) { return /^#[0-9a-f]{6}$/i.test(c || ''); }
  function defaultLabels() { return LABELS.map(function (l, i) { return { id: 'l' + (i + 1), name: l[1], color: l[0] }; }); }
  function newCalendar(color) { return { color: hexOk(color) ? color : CAL_COLORS[0], labels: defaultLabels(), events: [] }; }
  function cleanRepeat(r) {
    if (!r || typeof r !== 'object') return null;
    const freq = ['daily', 'weekly', 'monthly', 'yearly'].indexOf(r.freq) >= 0 ? r.freq : null;
    if (!freq) return null;
    const o = { freq: freq, interval: Math.max(1, Math.min(99, parseInt(r.interval, 10) || 1)) };
    if (r.until && parseLocal(String(r.until).slice(0, 10))) o.until = String(r.until).slice(0, 10);
    if (r.count && parseInt(r.count, 10) > 0) o.count = Math.min(999, parseInt(r.count, 10));
    if (freq === 'weekly' && Array.isArray(r.byDay)) { const bd = r.byDay.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x >= 0 && x <= 6; }); if (bd.length) o.byDay = bd.filter(function (x, i, a) { return a.indexOf(x) === i; }).sort(); }
    return o;
  }
  function cleanEvent(e, seen) {
    if (!e || typeof e !== 'object') return null;
    let id = typeof e.id === 'string' ? e.id.slice(0, 40) : uid('e');
    if (seen[id]) id = uid('e');
    seen[id] = 1;
    const o = { id: id, title: str(e.title, 300), allDay: e.allDay !== false, start: '', end: '', label: typeof e.label === 'string' ? e.label.slice(0, 20) : null, location: str(e.location, 300), url: str(e.url, 1000), notes: str(e.notes, 5000), images: [], repeat: cleanRepeat(e.repeat), exdates: [], reminders: [], keep: !!e.keep };
    if (!/^(https?:\/\/|mailto:)/i.test(o.url)) o.url = o.url ? 'https://' + o.url.replace(/^\/+/, '') : '';
    (Array.isArray(e.images) ? e.images : []).forEach(function (x) { if (typeof x === 'string' && /^[A-Za-z0-9_][\w.-]{0,63}$/.test(x)) o.images.push(x); });
    (Array.isArray(e.exdates) ? e.exdates : []).forEach(function (x) { if (typeof x === 'string' && parseLocal(x.slice(0, 10))) o.exdates.push(x.slice(0, 10)); });
    (Array.isArray(e.reminders) ? e.reminders : []).forEach(function (x) { const n = parseInt(x, 10); if (n >= 0 && n <= 40320 && o.reminders.indexOf(n) < 0) o.reminders.push(n); });
    o.reminders.sort(function (a, b) { return a - b; });
    if (o.keep) { o.start = ''; o.end = ''; return o; }
    const s = parseLocal(e.start), en = parseLocal(e.end);
    if (!s) return null;
    if (o.allDay) { o.start = dkey(s); o.end = en && en >= s ? dkey(en) : o.start; }
    else { o.start = tkey(s); o.end = en && en > s ? tkey(en) : tkey(new Date(s.getTime() + 3600000)); }
    return o;
  }
  function cleanCalendar(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const cal = newCalendar(raw.color);
    if (Array.isArray(raw.labels) && raw.labels.length) {
      cal.labels = cal.labels.map(function (def, i) { const r = raw.labels.find(function (x) { return x && x.id === def.id; }) || raw.labels[i]; return { id: def.id, name: r && typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 30) : def.name, color: def.color }; });
    }
    const seen = {};
    (Array.isArray(raw.events) ? raw.events : []).forEach(function (e) { const c = cleanEvent(e, seen); if (c) { if (c.label && !cal.labels.some(function (l) { return l.id === c.label; })) c.label = null; cal.events.push(c); } });
    return cal;
  }
  function parse(text) { let raw = null; try { raw = JSON.parse(String(text || '')); } catch (e) { raw = null; } return cleanCalendar(raw); }
  function serialize(cal) { return JSON.stringify(cal, null, 1); }
  function payloadOf(content) { const m = /^```timetree[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/m.exec(String(content || '')); return m ? m[1] : null; }
  function wrap(json) { return '```timetree\n' + json + '\n```\n'; }
  function generate(color) { return wrap(serialize(newCalendar(color))); }
  function isNote(note) { return !!(note && note.meta && note.meta.timetree); }
  function labelOf(cal, ev) { return cal.labels.find(function (l) { return l.id === ev.label; }) || null; }
  function colorOf(cal, ev) { const l = labelOf(cal, ev); return l ? l.color : cal.color; }

  // ---------------- 重複：把 [from, to] 這段期間裡的每一次都展開 ----------------
  // 回傳 instances：{ ev, cal, calId, start: Date, end: Date, allDay, key: 'YYYY-MM-DD'（這一次的起始日）, days }
  function instanceAt(ev, cal, calId, dayStart) {
    const s0 = parseLocal(ev.start), e0 = parseLocal(ev.end);
    const shift = daysBetween(s0, dayStart);
    const s = addDays(s0, shift), e = addDays(e0, shift);
    return { ev: ev, cal: cal, calId: calId, start: s, end: e, allDay: ev.allDay, key: dkey(s), days: daysBetween(s, e) + (ev.allDay ? 1 : (fmtTime(e) === '00:00' && daysBetween(s, e) > 0 ? 0 : 1)) };
  }
  function expand(cal, calId, from, to) {
    const out = [];
    const toEnd = addDays(startOfDay(to), 1);
    cal.events.forEach(function (ev) {
      if (ev.keep || !ev.start) return;
      const s0 = parseLocal(ev.start), e0 = parseLocal(ev.end);
      if (!s0 || !e0) return;
      const span = Math.max(0, daysBetween(s0, e0));
      const push = function (day) { if (ev.exdates.indexOf(dkey(day)) >= 0) return; const inst = instanceAt(ev, cal, calId, day); if (inst.start < toEnd && (ev.allDay ? addDays(startOfDay(inst.end), 1) : inst.end) > startOfDay(from)) out.push(inst); };
      if (!ev.repeat) { push(startOfDay(s0)); return; }
      const r = ev.repeat, until = r.until ? parseLocal(r.until) : null;
      let count = 0;
      const limit = until ? new Date(Math.min(until.getTime() + 86400000, toEnd.getTime())) : toEnd;
      if (r.freq === 'weekly' && r.byDay && r.byDay.length) {
        // 每週幾天：從開始那一週起，每隔 interval 週，各天都算一次
        let week = startOfWeek(s0, 0), guard = 0;
        while (week < limit && guard++ < 6000) {
          for (let i = 0; i < r.byDay.length; i++) {
            const day = addDays(week, r.byDay[i]);
            if (day < startOfDay(s0)) continue;
            if (day >= limit) break;
            count++; if (r.count && count > r.count) return;
            if (addDays(day, span) >= startOfDay(from)) push(day);
          }
          week = addDays(week, 7 * r.interval);
        }
        return;
      }
      let day = startOfDay(s0), n = 0, guard = 0;
      while (day < limit && guard++ < 6000) {
        count++; if (r.count && count > r.count) break;
        if (addDays(day, span) >= startOfDay(from)) push(day);
        n++;
        if (r.freq === 'daily') day = addDays(startOfDay(s0), n * r.interval);
        else if (r.freq === 'weekly') day = addDays(startOfDay(s0), 7 * n * r.interval);
        else if (r.freq === 'monthly') day = addMonths(startOfDay(s0), n * r.interval);
        else day = new Date(s0.getFullYear() + n * r.interval, s0.getMonth(), s0.getDate());
      }
    });
    return out;
  }
  function repeatText(r) {
    if (!r) return '不重複';
    const base = { daily: '天', weekly: '週', monthly: '月', yearly: '年' }[r.freq];
    let s = r.interval > 1 ? '每 ' + r.interval + ' ' + base : '每' + base;
    if (r.freq === 'weekly' && r.byDay && r.byDay.length) s += '（' + r.byDay.map(function (d) { return '週' + WEEKDAYS[d]; }).join('、') + '）';
    if (r.until) s += '，到 ' + r.until;
    if (r.count) s += '，共 ' + r.count + ' 次';
    return s;
  }
  function reminderText(m) { const hit = REMINDERS.find(function (x) { return x[0] === m; }); if (hit) return hit[1]; if (m % 1440 === 0) return (m / 1440) + ' 天前'; if (m % 60 === 0) return (m / 60) + ' 小時前'; return m + ' 分鐘前'; }

  // ---------------- iCalendar 匯出／匯入 ----------------
  function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function icsDate(s) { return s.replace(/-/g, ''); }
  function icsDT(s) { return s.replace(/-/g, '').replace(':', '') + '00'; }
  function fold(line) { const out = []; let i = 0; while (i < line.length) { out.push((i ? ' ' : '') + line.slice(i, i + 72)); i += 72; } return out.join('\r\n'); }
  function toICS(cal, name) {
    const BY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//capynote//timetree//ZH', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:' + icsEsc(name || '行事曆')];
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    cal.events.forEach(function (ev) {
      if (ev.keep || !ev.start) return;
      lines.push('BEGIN:VEVENT', 'UID:' + ev.id + '@capynote', 'DTSTAMP:' + stamp, 'SUMMARY:' + icsEsc(ev.title));
      if (ev.allDay) { lines.push('DTSTART;VALUE=DATE:' + icsDate(ev.start), 'DTEND;VALUE=DATE:' + icsDate(dkey(addDays(parseLocal(ev.end), 1)))); }
      else lines.push('DTSTART:' + icsDT(ev.start), 'DTEND:' + icsDT(ev.end));
      if (ev.repeat) { let r = 'RRULE:FREQ=' + ev.repeat.freq.toUpperCase(); if (ev.repeat.interval > 1) r += ';INTERVAL=' + ev.repeat.interval; if (ev.repeat.until) r += ';UNTIL=' + icsDate(ev.repeat.until) + (ev.allDay ? '' : 'T235959'); if (ev.repeat.count) r += ';COUNT=' + ev.repeat.count; if (ev.repeat.byDay) r += ';BYDAY=' + ev.repeat.byDay.map(function (d) { return BY[d]; }).join(','); lines.push(r); }
      ev.exdates.forEach(function (x) { lines.push(ev.allDay ? 'EXDATE;VALUE=DATE:' + icsDate(x) : 'EXDATE:' + icsDT(x + 'T' + ev.start.slice(11))); });
      if (ev.location) lines.push('LOCATION:' + icsEsc(ev.location));
      if (ev.url) lines.push('URL:' + ev.url);
      if (ev.notes) lines.push('DESCRIPTION:' + icsEsc(ev.notes));
      const lb = labelOf(cal, ev); if (lb) lines.push('CATEGORIES:' + icsEsc(lb.name));
      ev.reminders.forEach(function (m) { lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(ev.title), 'TRIGGER:-PT' + m + 'M', 'END:VALARM'); });
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }
  function fromICS(text) {
    const raw = String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
    const events = []; let cur = null;
    const unesc = function (s) { return s.replace(/\\n/gi, '\n').replace(/\\([;,\\])/g, '$1'); };
    const BY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const parseDT = function (v, params) {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim());
      if (!m) return null;
      if (!m[4]) return { allDay: true, d: new Date(+m[1], +m[2] - 1, +m[3]) };
      let d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      if (m[7]) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
      return { allDay: /VALUE=DATE(?!-TIME)/.test(params || ''), d: d };
    };
    raw.forEach(function (line) {
      if (line === 'BEGIN:VEVENT') { cur = { reminders: [], exdates: [] }; return; }
      if (line === 'END:VEVENT') { if (cur && cur.start) { const ev = { id: uid('e'), title: cur.title || '（無標題）', allDay: cur.start.allDay, start: cur.start.allDay ? dkey(cur.start.d) : tkey(cur.start.d), label: null, location: cur.location || '', url: cur.url || '', notes: cur.notes || '', reminders: cur.reminders, exdates: cur.exdates, repeat: cur.repeat || null };
          if (cur.start.allDay) ev.end = cur.end ? dkey(addDays(cur.end.d, -1)) : ev.start; else ev.end = cur.end ? tkey(cur.end.d) : tkey(new Date(cur.start.d.getTime() + 3600000));
          if (ev.allDay && parseLocal(ev.end) < parseLocal(ev.start)) ev.end = ev.start;
          events.push(ev); } cur = null; return; }
      if (!cur) return;
      const i = line.indexOf(':'); if (i < 0) return;
      const head = line.slice(0, i), val = line.slice(i + 1), name = head.split(';')[0].toUpperCase(), params = head.slice(name.length);
      if (name === 'SUMMARY') cur.title = unesc(val);
      else if (name === 'DESCRIPTION') cur.notes = unesc(val);
      else if (name === 'LOCATION') cur.location = unesc(val);
      else if (name === 'URL') cur.url = val.trim();
      else if (name === 'DTSTART') cur.start = parseDT(val, params);
      else if (name === 'DTEND') cur.end = parseDT(val, params);
      else if (name === 'EXDATE') val.split(',').forEach(function (x) { const p = parseDT(x, params); if (p) cur.exdates.push(dkey(p.d)); });
      else if (name === 'TRIGGER') { const m = /^-P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(val.trim()); if (m) cur.reminders.push((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0)); else if (/^-P(\d+)D$/.test(val.trim())) cur.reminders.push(parseInt(RegExp.$1, 10) * 1440); }
      else if (name === 'RRULE') {
        const r = {}; val.split(';').forEach(function (kv) { const p = kv.split('='); r[p[0].toUpperCase()] = p[1]; });
        const rep = { freq: (r.FREQ || '').toLowerCase(), interval: parseInt(r.INTERVAL, 10) || 1 };
        if (r.UNTIL) { const u = parseDT(r.UNTIL); if (u) rep.until = dkey(u.d); }
        if (r.COUNT) rep.count = parseInt(r.COUNT, 10);
        if (r.BYDAY && rep.freq === 'weekly') rep.byDay = r.BYDAY.split(',').map(function (x) { return BY[x.replace(/^[-+]?\d+/, '')]; }).filter(function (x) { return x != null; });
        cur.repeat = cleanRepeat(rep);
      }
    });
    return events;
  }

  // ---------------- 靜態（預覽／PDF／電子書）：這個月的月曆＋接下來兩週 ----------------
  function monthGridHTML(cals, cursor, ws, cls) {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const gridStart = startOfWeek(first, ws);
    const rows = [];
    const insts = [];
    cals.forEach(function (c) { expand(c.cal, c.id, gridStart, addDays(gridStart, 42)).forEach(function (i) { insts.push(i); }); });
    let h = '<div class="' + cls + '-month"><div class="' + cls + '-wd">' + [0, 1, 2, 3, 4, 5, 6].map(function (i) { const d = (ws + i) % 7; return '<span class="' + (d === 0 ? 'is-sun' : d === 6 ? 'is-sat' : '') + '">' + WEEKDAYS[d] + '</span>'; }).join('') + '</div>';
    for (let w = 0; w < 6; w++) {
      const wStart = addDays(gridStart, w * 7), wEnd = addDays(wStart, 6);
      if (w === 5 && wStart.getMonth() !== cursor.getMonth()) break;
      const bars = layoutWeek(insts, wStart, wEnd, 4);
      h += '<div class="' + cls + '-week">';
      for (let d = 0; d < 7; d++) {
        const day = addDays(wStart, d);
        const other = day.getMonth() !== cursor.getMonth();
        h += '<div class="' + cls + '-day' + (other ? ' is-other' : '') + (isToday(day) ? ' is-today' : '') + (day.getDay() === 0 ? ' is-sun' : day.getDay() === 6 ? ' is-sat' : '') + '" data-key="' + dkey(day) + '"><span class="' + cls + '-num">' + day.getDate() + '</span>' + (bars.more[d] ? '<span class="' + cls + '-more" data-key="' + dkey(day) + '">+' + bars.more[d] + '</span>' : '') + '</div>';
      }
      bars.placed.forEach(function (b) {
        const inst = b.inst;
        h += '<div class="' + cls + '-bar' + (inst.allDay || b.span > 1 ? ' is-allday' : '') + (b.cutL ? ' is-cutl' : '') + (b.cutR ? ' is-cutr' : '') + '" data-id="' + esc(inst.ev.id) + '" data-cal="' + esc(inst.calId) + '" data-key="' + inst.key + '" style="left:' + (b.col / 7 * 100) + '%;width:' + (b.span / 7 * 100) + '%;top:' + (26 + b.slot * 22) + 'px;--c:' + colorOf(inst.cal, inst.ev) + '">' + (inst.allDay || b.span > 1 ? '' : '<i></i><span class="' + cls + '-bar-t">' + fmtTime(inst.start) + '</span>') + esc(inst.ev.title || '（無標題）') + '</div>';
      });
      h += '</div>';
    }
    return h + '</div>';
  }
  // 一週的橫條怎麼疊：先長的、先開始的、全天的；每一條找第一個放得下的槽，放不下就算進那幾天的 +N
  function layoutWeek(insts, wStart, wEnd, max) {
    const wEndX = addDays(wEnd, 1);
    const list = insts.filter(function (i) { const e = i.allDay ? addDays(startOfDay(i.end), 1) : i.end; return i.start < wEndX && e > wStart; });
    list.sort(function (a, b) { const da = daysBetween(wStart, a.start < wStart ? wStart : a.start), db = daysBetween(wStart, b.start < wStart ? wStart : b.start); if (da !== db) return da - db; if (a.days !== b.days) return b.days - a.days; if (a.allDay !== b.allDay) return a.allDay ? -1 : 1; return a.start - b.start; });
    const slots = [], placed = [], more = [0, 0, 0, 0, 0, 0, 0];
    list.forEach(function (inst) {
      const sD = inst.start < wStart ? wStart : startOfDay(inst.start);
      let eD = inst.allDay ? startOfDay(inst.end) : startOfDay(new Date(inst.end.getTime() - 1));
      if (eD < sD) eD = sD;
      if (eD >= wEndX) eD = wEnd;
      const col = daysBetween(wStart, sD), span = daysBetween(sD, eD) + 1;
      let slot = 0;
      while (slot < max) { let free = true; for (let c = col; c < col + span; c++) if (slots[slot] && slots[slot][c]) { free = false; break; } if (free) break; slot++; }
      if (slot >= max) { for (let c = col; c < col + span; c++) more[c]++; return; }
      slots[slot] = slots[slot] || [];
      for (let c = col; c < col + span; c++) slots[slot][c] = true;
      placed.push({ inst: inst, col: col, span: span, slot: slot, cutL: inst.start < wStart, cutR: (inst.allDay ? startOfDay(inst.end) : startOfDay(new Date(inst.end.getTime() - 1))) > wEnd });
    });
    return { placed: placed, more: more, rows: slots.length };
  }
  function agendaHTML(cals, from, days, cls, query) {
    const to = addDays(from, days - 1);
    let insts = [];
    cals.forEach(function (c) { insts = insts.concat(expand(c.cal, c.id, from, to)); });
    if (query) { const q = query.toLowerCase(); insts = insts.filter(function (i) { return (i.ev.title + ' ' + i.ev.location + ' ' + i.ev.notes).toLowerCase().indexOf(q) >= 0; }); }
    insts.sort(function (a, b) { return a.start - b.start || (a.allDay ? -1 : 1); });
    if (!insts.length) return '<div class="' + cls + '-empty">這段時間沒有行程</div>';
    let h = '', lastKey = '';
    insts.forEach(function (i) {
      const k = dkey(i.start < from ? from : i.start);
      if (k !== lastKey) { lastKey = k; const d = parseLocal(k); h += '<div class="' + cls + '-agenda-day' + (isToday(d) ? ' is-today' : '') + '"><b>' + d.getDate() + '</b><span>' + (d.getMonth() + 1) + '月・週' + WEEKDAYS[d.getDay()] + '</span></div>'; }
      h += '<div class="' + cls + '-agenda-row" data-id="' + esc(i.ev.id) + '" data-cal="' + esc(i.calId) + '" data-key="' + i.key + '"><i style="background:' + colorOf(i.cal, i.ev) + '"></i><span class="' + cls + '-agenda-time">' + (i.allDay ? '全天' : fmtTime(i.start) + '–' + fmtTime(i.end)) + '</span><span class="' + cls + '-agenda-title">' + esc(i.ev.title || '（無標題）') + '</span>' + (i.ev.location ? '<span class="' + cls + '-agenda-loc">' + ic('map-pin') + esc(i.ev.location) + '</span>' : '') + '</div>';
    });
    return h;
  }
  function blockHTML(payload, name) {
    const cal = parse(payload);
    const cals = [{ id: 'static', cal: cal, name: name || '行事曆' }];
    const now = new Date();
    return '<div class="tts"><div class="tts-head"><i style="background:' + cal.color + '"></i><b>' + esc(name || '行事曆') + '</b><span>' + now.getFullYear() + '年' + (now.getMonth() + 1) + '月・' + cal.events.length + ' 個行程</span></div>' + monthGridHTML(cals, now, 0, 'tts') + '<div class="tts-agenda"><div class="tts-agenda-t">接下來兩週</div>' + agendaHTML(cals, startOfDay(now), 14, 'tts') + '</div></div>';
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
    menuEl = el('div', 'tt-menu');
    menuEl.innerHTML = items.map(function (it) { return it ? '<button class="tt-menu-item' + (it[3] ? ' is-danger' : '') + (it[4] ? ' on' : '') + '" type="button" data-a="' + it[0] + '"' + (it[2] ? ' disabled' : '') + '>' + esc(it[1]) + '</button>' : '<div class="tt-menu-sep"></div>'; }).join('');
    placeFixed(menuEl, x, y);
    menuEl.addEventListener('click', function (e) { const b = e.target.closest('[data-a]'); if (!b || b.disabled) return; const a = b.getAttribute('data-a'); closePop(); onPick(a); });
  }
  document.addEventListener('mousedown', function (e) { if ((popEl && !popEl.contains(e.target)) || (menuEl && !menuEl.contains(e.target))) { if (!e.target.closest('.tt-pop, .tt-menu')) closePop(); } }, true);

  const S = { view: lsGet('ttView', 'month'), cursor: new Date(), selected: null, search: '', hidden: {}, timers: [], dragging: null };
  try { S.hidden = JSON.parse(lsGet('ttHidden', '{}')) || {}; } catch (e) { S.hidden = {}; }
  const cache = new Map();   // noteId → { content, cal }
  let host = null, O = null;

  function calsOf() {
    return (O.calendars || []).map(function (n) {
      let c = cache.get(n.id);
      if (!c || c.content !== n.content) { c = { content: n.content, cal: parse(payloadOf(n.content) || '') }; cache.set(n.id, c); }
      return { id: n.id, note: n, cal: c.cal, name: n.title || '行事曆', ro: !!(O.readOnly && O.readOnly(n)) };
    });
  }
  function visibleCals() { return calsOf().filter(function (c) { return !S.hidden[c.id]; }); }
  function calById(id) { return calsOf().find(function (c) { return c.id === id; }) || null; }
  function weekStart() { return lsGet('ttWeekStart', '0') === '1' ? 1 : 0; }
  function save(c) {
    const json = serialize(c.cal), content = wrap(json);
    cache.set(c.id, { content: content, cal: c.cal });
    c.note.content = content;
    if (O.onChange) O.onChange(c.note, content);
  }
  function findEvent(calId, id) { const c = calById(calId); if (!c) return null; const ev = c.cal.events.find(function (e) { return e.id === id; }); return ev ? { c: c, ev: ev } : null; }

  function render(container, opts) {
    host = container; O = opts || {};
    closePop();
    const cals = calsOf();
    host.className = 'tt-page' + (S.sideOpen ? ' is-side-open' : '');   // 手機版：左欄是抽屜，開著就留著（render 會整個重畫）
    const title = S.view === 'month' ? S.cursor.getFullYear() + '年' + (S.cursor.getMonth() + 1) + '月'
      : S.view === 'week' ? (function () { const a = startOfWeek(S.cursor, weekStart()), b = addDays(a, 6); return a.getFullYear() + '年' + (a.getMonth() + 1) + '月' + a.getDate() + '日 – ' + (b.getMonth() !== a.getMonth() ? (b.getMonth() + 1) + '月' : '') + b.getDate() + '日'; })()
      : S.view === 'day' ? fmtDate(S.cursor, true) : '行程';
    host.innerHTML =
      '<aside class="tt-side">' +
        '<div class="tt-side-head"><b>行事曆</b><button class="tt-tb" type="button" data-act="sideclose" title="關閉">' + ic('x') + '</button></div>' +
        '<div class="tt-side-t">行事曆</div><div class="tt-cals">' + (cals.length ? cals.map(function (c) { return '<div class="tt-cal' + (S.hidden[c.id] ? ' is-hidden' : '') + '" data-cal="' + esc(c.id) + '"><label class="tt-cal-chk"><input type="checkbox"' + (S.hidden[c.id] ? '' : ' checked') + ' data-vis="' + esc(c.id) + '"><i style="background:' + c.cal.color + '"></i></label><span class="tt-cal-name">' + esc(c.name) + '</span>' + (c.ro ? '<span class="tt-cal-ro" title="唯讀">' + ic('lock') + '</span>' : '') + '<button class="tt-cal-more" type="button" data-calmenu="' + esc(c.id) + '" title="更多">' + ic('more-horizontal') + '</button></div>'; }).join('') : '<div class="tt-side-empty">還沒有行事曆</div>') + '</div>' +
        '<button class="tt-side-add" type="button" data-act="newcal">' + ic('plus') + '<span>建立行事曆</span></button>' +
        '<div class="tt-side-t">Keep <small>還沒排日期</small></div><div class="tt-keeps">' + keepsHTML(cals) + '</div>' +
        '<button class="tt-side-add" type="button" data-act="newkeep"' + (cals.length ? '' : ' disabled') + '>' + ic('plus') + '<span>新增 Keep</span></button>' +
        '<div class="tt-side-foot"><button class="tt-tb" type="button" data-act="settings" title="設定">' + ic('settings') + '<span>設定</span></button></div>' +
      '</aside>' +
      '<div class="tt-side-bg" data-act="sideclose"></div>' +
      '<div class="tt-main">' +
        '<div class="tt-head">' +
          '<button class="tt-tb tt-side-btn" type="button" data-act="side" title="行事曆與 Keep">' + ic('calendar') + '</button>' +
          '<button class="tt-tb tt-today" type="button" data-act="today">今天</button>' +
          '<button class="tt-tb tt-nav" type="button" data-act="prev" title="上一個">' + ic('chevron-left') + '</button><button class="tt-tb tt-nav" type="button" data-act="next" title="下一個">' + ic('chevron-right') + '</button>' +
          '<button class="tt-title" type="button" data-act="jump" title="跳到…">' + esc(title) + '</button>' +
          '<span class="tt-sp"></span>' +
          '<div class="tt-views">' + [['month', '月'], ['week', '週'], ['day', '日'], ['list', '行程']].map(function (v) { return '<button class="tt-view' + (S.view === v[0] ? ' on' : '') + '" type="button" data-view="' + v[0] + '">' + v[1] + '</button>'; }).join('') + '</div>' +
          '<label class="tt-search">' + ic('search') + '<input type="search" placeholder="搜尋行程" value="' + esc(S.search) + '" aria-label="搜尋行程"></label>' +
          '<button class="tt-tb tt-add" type="button" data-act="new"' + (cals.length ? '' : ' disabled') + '>' + ic('plus') + '<span>新增</span></button>' +
        '</div>' +
        '<div class="tt-body"><div class="tt-view-wrap"></div><aside class="tt-daypanel" hidden></aside></div>' +
      '</div>';
    renderView();
    renderDayPanel();
    if (!host.__ttBound) { host.__ttBound = true; bind(); }   // host 不換，監聽綁一次就好（innerHTML 換掉的是裡面）
    scheduleReminders();
  }
  function keepsHTML(cals) {
    const items = [];
    cals.forEach(function (c) { if (S.hidden[c.id]) return; c.cal.events.forEach(function (ev) { if (ev.keep) items.push({ c: c, ev: ev }); }); });
    if (!items.length) return '<div class="tt-side-empty">把還沒決定日期的行程先放這裡，之後拖到月曆上</div>';
    return items.map(function (x) { return '<div class="tt-keep" draggable="true" data-id="' + esc(x.ev.id) + '" data-cal="' + esc(x.c.id) + '"><i style="background:' + colorOf(x.c.cal, x.ev) + '"></i><span>' + esc(x.ev.title || '（無標題）') + '</span></div>'; }).join('');
  }
  function renderView() {
    const wrapEl = host.querySelector('.tt-view-wrap');
    const cals = visibleCals();
    if (S.search.trim()) { wrapEl.className = 'tt-view-wrap is-list'; wrapEl.innerHTML = '<div class="tt-list"><div class="tt-list-t">搜尋「' + esc(S.search.trim()) + '」</div>' + agendaHTML(cals, addDays(startOfDay(new Date()), -365), 730, 'tt', S.search.trim()) + '</div>'; return; }
    if (S.view === 'month') { wrapEl.className = 'tt-view-wrap is-month'; wrapEl.innerHTML = monthGridHTML(cals, S.cursor, weekStart(), 'tt'); return; }
    if (S.view === 'list') { wrapEl.className = 'tt-view-wrap is-list'; wrapEl.innerHTML = '<div class="tt-list"><div class="tt-list-t">接下來 60 天</div>' + agendaHTML(cals, startOfDay(S.cursor), 60, 'tt') + '</div>'; return; }
    wrapEl.className = 'tt-view-wrap is-time';
    wrapEl.innerHTML = timeGridHTML(cals, S.view === 'day' ? startOfDay(S.cursor) : startOfWeek(S.cursor, weekStart()), S.view === 'day' ? 1 : 7);
    // 捲到早上 8 點
    const sc = wrapEl.querySelector('.tt-time-scroll'); if (sc) sc.scrollTop = 8 * HOUR_H - 10;
  }
  const HOUR_H = 48;
  function timeGridHTML(cals, from, nDays) {
    const to = addDays(from, nDays - 1);
    let insts = [];
    cals.forEach(function (c) { insts = insts.concat(expand(c.cal, c.id, from, to)); });
    const allday = insts.filter(function (i) { return i.allDay || i.days > 1; });
    const timed = insts.filter(function (i) { return !i.allDay && i.days <= 1; });
    const bars = layoutWeek(allday, from, to, 6);
    let h = '<div class="tt-time-head"><div class="tt-time-gutter"></div>';
    for (let d = 0; d < nDays; d++) { const day = addDays(from, d); h += '<div class="tt-time-day' + (isToday(day) ? ' is-today' : '') + (day.getDay() === 0 ? ' is-sun' : day.getDay() === 6 ? ' is-sat' : '') + '" data-key="' + dkey(day) + '"><span class="tt-time-wd">週' + WEEKDAYS[day.getDay()] + '</span><span class="tt-time-num">' + day.getDate() + '</span></div>'; }
    h += '</div><div class="tt-allday" style="--n:' + nDays + ';height:' + Math.max(28, 6 + bars.rows * 22) + 'px"><div class="tt-time-gutter">全天</div><div class="tt-allday-cells">';
    for (let d = 0; d < nDays; d++) h += '<div class="tt-allday-cell" data-key="' + dkey(addDays(from, d)) + '"></div>';
    bars.placed.forEach(function (b) { h += '<div class="tt-bar is-allday' + (b.cutL ? ' is-cutl' : '') + (b.cutR ? ' is-cutr' : '') + '" data-id="' + esc(b.inst.ev.id) + '" data-cal="' + esc(b.inst.calId) + '" data-key="' + b.inst.key + '" style="left:' + (b.col / nDays * 100) + '%;width:' + (b.span / nDays * 100) + '%;top:' + (3 + b.slot * 22) + 'px;--c:' + colorOf(b.inst.cal, b.inst.ev) + '">' + esc(b.inst.ev.title || '（無標題）') + '</div>'; });
    h += '</div></div><div class="tt-time-scroll"><div class="tt-time-grid" style="--n:' + nDays + '"><div class="tt-time-gutter">';
    for (let hr = 0; hr < 24; hr++) h += '<div class="tt-hour" style="top:' + (hr * HOUR_H) + 'px">' + (hr ? pad2(hr) + ':00' : '') + '</div>';
    h += '</div>';
    for (let d = 0; d < nDays; d++) {
      const day = addDays(from, d), dayEnd = addDays(day, 1);
      h += '<div class="tt-time-col' + (isToday(day) ? ' is-today' : '') + '" data-key="' + dkey(day) + '">';
      for (let hr = 0; hr < 24; hr++) h += '<div class="tt-hline" style="top:' + (hr * HOUR_H) + 'px"></div>';
      // 當天有時間的行程：重疊的分欄
      const list = timed.filter(function (i) { return i.start < dayEnd && i.end > day; }).sort(function (a, b) { return a.start - b.start || b.end - a.end; });
      const cols = [];   // 每欄的最後結束時間
      const laid = [];
      let groupEnd = null, group = [];
      const flush = function () { const n = cols.length; group.forEach(function (x) { x.n = n; }); cols.length = 0; group = []; };
      list.forEach(function (i) {
        if (groupEnd && i.start >= groupEnd) flush();
        let k = 0; while (k < cols.length && cols[k] > i.start) k++;
        cols[k] = i.end; const it = { inst: i, col: k, n: 1 }; group.push(it); laid.push(it);
        groupEnd = !groupEnd || i.end > groupEnd ? i.end : groupEnd;
      });
      flush();
      laid.forEach(function (x) {
        const s = x.inst.start < day ? day : x.inst.start, e = x.inst.end > dayEnd ? dayEnd : x.inst.end;
        const top = (s.getHours() * 60 + s.getMinutes()) / 60 * HOUR_H, hgt = Math.max(18, (e - s) / 3600000 * HOUR_H - 2);
        h += '<div class="tt-wev' + (hgt < 36 ? ' is-short' : '') + '" data-id="' + esc(x.inst.ev.id) + '" data-cal="' + esc(x.inst.calId) + '" data-key="' + x.inst.key + '" style="top:' + top + 'px;height:' + hgt + 'px;left:calc(' + (x.col / x.n * 100) + '% + 1px);width:calc(' + (100 / x.n) + '% - 3px);--c:' + colorOf(x.inst.cal, x.inst.ev) + '"><span class="tt-wev-title">' + esc(x.inst.ev.title || '（無標題）') + '</span><span class="tt-wev-t">' + fmtTime(x.inst.start) + ' – ' + fmtTime(x.inst.end) + '</span><span class="tt-wev-rs"></span></div>';
      });
      if (isToday(day)) { const now = new Date(); h += '<div class="tt-now" style="top:' + ((now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_H) + 'px"></div>'; }
      h += '</div>';
    }
    return h + '</div></div>';
  }
  function renderDayPanel() {
    const panel = host.querySelector('.tt-daypanel');
    if (!panel) return;
    if (!S.selected || S.view === 'list') { panel.hidden = true; return; }
    const day = parseLocal(S.selected);
    panel.hidden = false;
    const cals = visibleCals();
    panel.innerHTML = '<div class="tt-dp-head"><div class="tt-dp-date' + (isToday(day) ? ' is-today' : '') + '"><b>' + day.getDate() + '</b><span>' + (day.getMonth() + 1) + '月・週' + WEEKDAYS[day.getDay()] + '</span></div><button class="tt-tb" type="button" data-act="dp-add" title="在這一天新增">' + ic('plus') + '</button><button class="tt-tb" type="button" data-act="dp-close" title="關閉">' + ic('x') + '</button></div><div class="tt-dp-list">' + agendaHTML(cals, day, 1, 'tt').replace(/<div class="tt-agenda-day[^"]*">.*?<\/div>/, '') + '</div>';
  }

  // ---- 事件綁定 ----
  function bind() {
    host.addEventListener('click', onClick);
    host.addEventListener('contextmenu', function (e) { const bar = e.target.closest('[data-id][data-cal]'); if (bar) { e.preventDefault(); eventMenu(bar, e.clientX, e.clientY); } });
    let st = null;
    host.addEventListener('input', function (e) { const search = e.target.closest('.tt-search input'); if (!search) return; clearTimeout(st); st = setTimeout(function () { S.search = search.value; renderView(); renderDayPanel(); }, 200); });
    host.addEventListener('keydown', function (e) { const search = e.target.closest('.tt-search input'); if (!search) return; e.stopPropagation(); if (e.key === 'Escape') { search.value = ''; S.search = ''; renderView(); } });
    host.addEventListener('change', function (e) { const v = e.target.closest('[data-vis]'); if (v) { const id = v.getAttribute('data-vis'); if (v.checked) delete S.hidden[id]; else S.hidden[id] = 1; lsSet('ttHidden', JSON.stringify(S.hidden)); render(host, O); } });
    host.addEventListener('mousedown', onDown);
    host.addEventListener('dblclick', function (e) {
      const cell = e.target.closest('.tt-day, .tt-time-col, .tt-allday-cell');
      if (!cell || e.target.closest('[data-id]')) return;
      const key = cell.getAttribute('data-key');
      const col = e.target.closest('.tt-time-col');
      if (col) { const r = col.getBoundingClientRect(); const mins = Math.round(((e.clientY - r.top) / HOUR_H * 60) / 30) * 30; openEditor(null, null, { date: key, time: pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60) }); }
      else openEditor(null, null, { date: key });
    });
    // Keep 拖到日子上
    host.addEventListener('dragstart', function (e) { const k = e.target.closest('.tt-keep'); if (!k) return; e.dataTransfer.setData('text/plain', k.getAttribute('data-cal') + '|' + k.getAttribute('data-id')); e.dataTransfer.effectAllowed = 'move'; });
    host.addEventListener('dragover', function (e) { const cell = e.target.closest('.tt-day, .tt-allday-cell, .tt-time-col'); if (cell) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; host.querySelectorAll('.is-dropover').forEach(function (x) { x.classList.remove('is-dropover'); }); cell.classList.add('is-dropover'); } });
    host.addEventListener('dragleave', function (e) { const cell = e.target.closest('.tt-day, .tt-allday-cell, .tt-time-col'); if (cell) cell.classList.remove('is-dropover'); });
    host.addEventListener('drop', function (e) {
      const cell = e.target.closest('.tt-day, .tt-allday-cell, .tt-time-col'); if (!cell) return;
      e.preventDefault();
      const raw = e.dataTransfer.getData('text/plain') || ''; const p = raw.split('|');
      const hit = findEvent(p[0], p[1]); if (!hit || !hit.ev.keep || hit.c.ro) return;
      hit.ev.keep = false; hit.ev.allDay = true; hit.ev.start = cell.getAttribute('data-key'); hit.ev.end = hit.ev.start;
      save(hit.c); render(host, O);
    });
    document.addEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (!host || !host.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (host.closest('[hidden]')) return;   // 行事曆的頁面沒開著（在別的畫面）就不要接快速鍵
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable)) return;
    if (document.querySelector('.modal-overlay')) return;
    if (e.key === 'Escape') { if (popEl || menuEl) { closePop(); } else if (S.sideOpen) { act('sideclose'); } else if (S.selected) { S.selected = null; renderDayPanel(); } return; }
    if (e.key === 't' || e.key === 'T') { act('today'); }
    else if (e.key === 'ArrowLeft') act('prev'); else if (e.key === 'ArrowRight') act('next');
    else if (e.key === 'm' || e.key === 'M') setView('month'); else if (e.key === 'w' || e.key === 'W') setView('week'); else if (e.key === 'd' || e.key === 'D') setView('day'); else if (e.key === 'l' || e.key === 'L') setView('list');
    else if (e.key === 'n' || e.key === 'N') act('new');
  }
  function setView(v) { S.view = v; lsSet('ttView', v); render(host, O); }
  function act(a) {
    if (a === 'today') { S.cursor = new Date(); render(host, O); }
    else if (a === 'prev' || a === 'next') { const n = a === 'prev' ? -1 : 1; S.cursor = S.view === 'month' ? addMonths(S.cursor, n) : S.view === 'week' ? addDays(S.cursor, 7 * n) : S.view === 'day' ? addDays(S.cursor, n) : addDays(S.cursor, 60 * n); render(host, O); }
    else if (a === 'new') openEditor(null, null, { date: S.selected || dkey(S.cursor) });
    else if (a === 'newkeep') openEditor(null, null, { keep: true });
    else if (a === 'newcal') newCalendarDialog();
    else if (a === 'settings') settingsPop(host.querySelector('[data-act="settings"]'));
    else if (a === 'side') { S.sideOpen = !S.sideOpen; host.classList.toggle('is-side-open', S.sideOpen); }
    else if (a === 'sideclose') { S.sideOpen = false; host.classList.remove('is-side-open'); }
    else if (a === 'jump') jumpPop(host.querySelector('.tt-title'));
    else if (a === 'dp-add') openEditor(null, null, { date: S.selected });
    else if (a === 'dp-close') { S.selected = null; renderDayPanel(); }
  }
  function onClick(e) {
    const vb = e.target.closest('[data-view]'); if (vb) { setView(vb.getAttribute('data-view')); return; }
    const ab = e.target.closest('[data-act]'); if (ab && host.contains(ab)) { act(ab.getAttribute('data-act')); return; }
    const cm = e.target.closest('[data-calmenu]'); if (cm) { calMenu(cm.getAttribute('data-calmenu'), cm); return; }
    if (S.dragging && S.dragging.moved) return;
    const bar = e.target.closest('[data-id][data-cal]');
    if (bar && !bar.classList.contains('tt-keep')) { showDetail(bar); return; }
    const keep = e.target.closest('.tt-keep'); if (keep) { const hit = findEvent(keep.getAttribute('data-cal'), keep.getAttribute('data-id')); if (hit) openEditor(hit.ev, hit.c, {}); return; }
    const more = e.target.closest('.tt-more'); if (more) { S.selected = more.getAttribute('data-key'); renderDayPanel(); return; }
    const day = e.target.closest('.tt-day, .tt-time-day'); if (day) { const key = day.getAttribute('data-key'); if (S.view === 'month') { S.selected = S.selected === key ? null : key; renderDayPanel(); } else { S.cursor = parseLocal(key); setView('day'); } return; }
  }
  function calMenu(calId, anchor) {
    const c = calById(calId); if (!c) return;
    const r = anchor.getBoundingClientRect();
    menuAt(r.left, r.bottom + 4, [['only', '只顯示這本'], ['all', '顯示全部'], null, ['rename', '重新命名', c.ro], ['color', '變更顏色', c.ro], ['labels', '標籤名稱…', c.ro], ['tags', '標籤…'], null, ['export', '匯出 .ics'], ['import', '匯入 .ics…', c.ro], null, ['del', '移到垃圾桶', c.ro, true]], function (a) {
      if (a === 'only') { S.hidden = {}; calsOf().forEach(function (x) { if (x.id !== calId) S.hidden[x.id] = 1; }); lsSet('ttHidden', JSON.stringify(S.hidden)); render(host, O); }
      else if (a === 'all') { S.hidden = {}; lsSet('ttHidden', '{}'); render(host, O); }
      else if (a === 'rename') { if (O.onRename) O.onRename(c.note); }
      else if (a === 'color') colorPop(anchor, c);
      else if (a === 'labels') labelsDialog(c);
      else if (a === 'tags') { if (O.onTags) O.onTags(c.note); }
      else if (a === 'export') downloadText(safeName(c.name) + '.ics', toICS(c.cal, c.name), 'text/calendar');
      else if (a === 'import') importICS(c);
      else if (a === 'del') { if (O.onDelete) O.onDelete(c.note); }
    });
  }
  function safeName(t) { return (String(t || '').trim() || '行事曆').replace(/[\\/:*?"<>|]+/g, '_'); }
  function downloadText(name, text, type) { const a = document.createElement('a'); const url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })); a.href = url; a.download = name; a.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000); }
  function importICS(c) {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.ics,text/calendar';
    inp.addEventListener('change', function () {
      const f = inp.files && inp.files[0]; if (!f) return;
      f.text().then(function (txt) {
        const evs = fromICS(txt); if (!evs.length) { toast('這個檔案裡沒有行程'); return; }
        const seen = {}; c.cal.events.forEach(function (e) { seen[e.id] = 1; });
        let n = 0; evs.forEach(function (e) { const ce = cleanEvent(e, seen); if (ce) { c.cal.events.push(ce); n++; } });
        save(c); render(host, O); toast('匯入了 ' + n + ' 個行程');
      });
    });
    inp.click();
  }
  function toast(t) { if (global.App && App.toast) App.toast(t); }
  function colorPop(anchor, c) {
    closePop();
    popEl = el('div', 'tt-pop tt-pop-colors');
    popEl.innerHTML = CAL_COLORS.map(function (col) { return '<button type="button" class="tt-swatch' + (col === c.cal.color ? ' on' : '') + '" data-color="' + col + '" style="background:' + col + '"></button>'; }).join('');
    const r = anchor.getBoundingClientRect(); placeFixed(popEl, r.left, r.bottom + 4);
    popEl.addEventListener('click', function (e) { const b = e.target.closest('[data-color]'); if (!b) return; c.cal.color = b.getAttribute('data-color'); closePop(); save(c); render(host, O); });
  }
  function jumpPop(anchor) {
    closePop();
    popEl = el('div', 'tt-pop tt-pop-jump');
    popEl.innerHTML = '<div class="tt-pop-label">跳到</div><input class="tt-input" type="date" value="' + dkey(S.cursor) + '"><div class="tt-pop-row"><button type="button" class="tt-btn tt-btn-primary" data-j="go">前往</button><button type="button" class="tt-btn" data-j="today">今天</button></div>';
    const r = anchor.getBoundingClientRect(); placeFixed(popEl, r.left, r.bottom + 4);
    const inp = popEl.querySelector('input');
    const go = function () { const d = parseLocal(inp.value); if (d) { S.cursor = d; if (S.view === 'month') S.selected = inp.value; closePop(); render(host, O); } };
    popEl.addEventListener('click', function (e) { const b = e.target.closest('[data-j]'); if (!b) return; if (b.getAttribute('data-j') === 'today') { closePop(); act('today'); } else go(); });
    inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') go(); if (e.key === 'Escape') closePop(); });
    setTimeout(function () { inp.focus(); }, 0);
  }
  function settingsPop(anchor) {
    closePop();
    popEl = el('div', 'tt-pop tt-pop-settings');
    const notify = lsGet('ttNotify', '0') === '1';
    popEl.innerHTML = '<div class="tt-pop-label">設定</div>' +
      '<label class="tt-set-row"><span>一週的第一天</span><select class="tt-input" data-s="ws"><option value="0"' + (weekStart() === 0 ? ' selected' : '') + '>星期日</option><option value="1"' + (weekStart() === 1 ? ' selected' : '') + '>星期一</option></select></label>' +
      '<label class="tt-set-row"><span>提醒通知（頁面開著時）</span><input type="checkbox" data-s="notify"' + (notify ? ' checked' : '') + '></label>' +
      '<div class="tt-set-hint">快速鍵：T 今天、← → 前後、M／W／D／L 切換檢視、N 新增、雙擊日子新增。</div>';
    const r = anchor.getBoundingClientRect(); placeFixed(popEl, r.left, r.top - popEl.offsetHeight - 4);
    popEl.querySelector('[data-s="ws"]').addEventListener('change', function (e) { lsSet('ttWeekStart', e.target.value); render(host, O); });
    popEl.querySelector('[data-s="notify"]').addEventListener('change', function (e) {
      if (e.target.checked) { if (global.Notification && Notification.permission !== 'granted') Notification.requestPermission().then(function (p) { if (p !== 'granted') { e.target.checked = false; lsSet('ttNotify', '0'); toast('瀏覽器沒有允許通知'); } else { lsSet('ttNotify', '1'); scheduleReminders(); } }); else { lsSet('ttNotify', '1'); scheduleReminders(); } }
      else { lsSet('ttNotify', '0'); scheduleReminders(); }
    });
  }
  function newCalendarDialog() {
    const ask = global.App && App.prompt ? App.prompt({ title: '建立行事曆', placeholder: '名稱，例如：工作、家人、考試', ok: '建立' }) : Promise.resolve(window.prompt('名稱'));
    ask.then(function (name) { name = String(name || '').trim(); if (!name || !O.onCreate) return; O.onCreate({ title: name, color: CAL_COLORS[calsOf().length % CAL_COLORS.length] }); });
  }
  function labelsDialog(c) {
    const ov = el('div', 'modal-overlay tt-dialog-overlay');
    ov.innerHTML = '<div class="modal tt-dialog" role="dialog" aria-modal="true"><div class="modal-title">標籤名稱</div><div class="tt-dialog-body">' + c.cal.labels.map(function (l) { return '<label class="tt-label-row"><i style="background:' + l.color + '"></i><input class="tt-input" type="text" maxlength="30" data-label="' + l.id + '" value="' + esc(l.name) + '"></label>'; }).join('') + '</div><div class="modal-actions"><button class="btn tt-dcancel" type="button">取消</button><button class="btn btn-primary tt-dok" type="button">儲存</button></div></div>';
    document.body.appendChild(ov);
    const close = function () { ov.remove(); };
    ov.querySelector('.tt-dcancel').addEventListener('click', close);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    ov.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape') close(); });
    ov.querySelector('.tt-dok').addEventListener('click', function () { ov.querySelectorAll('[data-label]').forEach(function (i) { const l = c.cal.labels.find(function (x) { return x.id === i.getAttribute('data-label'); }); if (l && i.value.trim()) l.name = i.value.trim().slice(0, 30); }); close(); save(c); render(host, O); });
  }

  // ---- 行程詳細 ----
  function instFromEl(bar) { const hit = findEvent(bar.getAttribute('data-cal'), bar.getAttribute('data-id')); if (!hit) return null; const key = bar.getAttribute('data-key'); return { hit: hit, inst: instanceAt(hit.ev, hit.c.cal, hit.c.id, parseLocal(key || hit.ev.start.slice(0, 10))), key: key }; }
  function showDetail(bar) {
    const x = instFromEl(bar); if (!x) return;
    closePop();
    const ev = x.hit.ev, c = x.hit.c, lb = labelOf(c.cal, ev);
    popEl = el('div', 'tt-pop tt-detail');
    popEl.innerHTML = '<div class="tt-detail-bar" style="background:' + colorOf(c.cal, ev) + '"></div>' +
      '<div class="tt-detail-head"><div class="tt-detail-title">' + esc(ev.title || '（無標題）') + '</div><div class="tt-detail-tools">' + (c.ro ? '' : '<button type="button" class="tt-tb" data-d="edit" title="編輯">' + ic('pen-line') + '</button><button type="button" class="tt-tb" data-d="copy" title="複製">' + ic('copy') + '</button><button type="button" class="tt-tb" data-d="del" title="刪除">' + ic('trash') + '</button>') + '<button type="button" class="tt-tb" data-d="close" title="關閉">' + ic('x') + '</button></div></div>' +
      '<div class="tt-detail-row">' + ic('clock') + '<span>' + esc(rangeText(x.inst)) + (ev.repeat ? '<br><small>' + esc(repeatText(ev.repeat)) + '</small>' : '') + '</span></div>' +
      '<div class="tt-detail-row"><i class="tt-dot" style="background:' + c.cal.color + '"></i><span>' + esc(c.name) + (lb ? '　<span class="tt-chip" style="background:' + lb.color + '">' + esc(lb.name) + '</span>' : '') + '</span></div>' +
      (ev.location ? '<div class="tt-detail-row">' + ic('map-pin') + '<a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ev.location) + '" target="_blank" rel="noopener noreferrer">' + esc(ev.location) + '</a></div>' : '') +
      (ev.url ? '<div class="tt-detail-row">' + ic('link') + '<a href="' + esc(ev.url) + '" target="_blank" rel="noopener noreferrer">' + esc(ev.url.replace(/^https?:\/\//, '').slice(0, 60)) + '</a></div>' : '') +
      (ev.reminders.length ? '<div class="tt-detail-row">' + ic('bell') + '<span>' + ev.reminders.map(reminderText).map(esc).join('、') + '</span></div>' : '') +
      (ev.notes ? '<div class="tt-detail-notes">' + esc(ev.notes) + '</div>' : '') +
      (ev.images.length ? '<div class="tt-detail-imgs">' + ev.images.map(function (id) { return '<img src="/api/images/' + esc(id) + '" alt="" loading="lazy">'; }).join('') + '</div>' : '');
    const r = bar.getBoundingClientRect();
    placeFixed(popEl, r.left, r.bottom + 6);
    if (r.bottom + popEl.offsetHeight + 6 > window.innerHeight) popEl.style.top = Math.max(8, r.top - popEl.offsetHeight - 6) + 'px';
    popEl.addEventListener('click', function (e) {
      const b = e.target.closest('[data-d]'); if (!b) return;
      const d = b.getAttribute('data-d');
      if (d === 'close') closePop();
      else if (d === 'edit') { closePop(); openEditor(ev, c, { instKey: x.key }); }
      else if (d === 'copy') { closePop(); const copy = JSON.parse(JSON.stringify(ev)); copy.id = uid('e'); copy.title = ev.title + '（複本）'; c.cal.events.push(copy); save(c); render(host, O); }
      else if (d === 'del') { closePop(); deleteEvent(ev, c, x.key); }
    });
  }
  function eventMenu(bar, x, y) {
    const inst = instFromEl(bar); if (!inst) return;
    const c = inst.hit.c, ev = inst.hit.ev;
    menuAt(x, y, [['open', '查看'], ['edit', '編輯', c.ro], ['copy', '複製', c.ro], ['keep', '放回 Keep（取消日期）', c.ro || !!ev.repeat], null, ['del', '刪除', c.ro, true]], function (a) {
      if (a === 'open') showDetail(bar);
      else if (a === 'edit') openEditor(ev, c, { instKey: inst.key });
      else if (a === 'copy') { const copy = JSON.parse(JSON.stringify(ev)); copy.id = uid('e'); copy.title = ev.title + '（複本）'; c.cal.events.push(copy); save(c); render(host, O); }
      else if (a === 'keep') { ev.keep = true; ev.start = ''; ev.end = ''; save(c); render(host, O); }
      else if (a === 'del') deleteEvent(ev, c, inst.key);
    });
  }
  function deleteEvent(ev, c, instKey) {
    const confirmBox = function (o) { return global.App && App.confirm ? App.confirm(o) : Promise.resolve(window.confirm(o.message)); };
    if (ev.repeat && instKey) {
      menuAt(window.innerWidth / 2 - 100, window.innerHeight / 2 - 40, [['one', '只刪除這一次'], ['all', '刪除所有重複的行程', false, true], null, ['cancel', '取消']], function (a) {
        if (a === 'one') { ev.exdates.push(instKey); save(c); render(host, O); }
        else if (a === 'all') { c.cal.events = c.cal.events.filter(function (e) { return e !== ev; }); save(c); render(host, O); }
      });
      return;
    }
    confirmBox({ title: '刪除行程', message: '刪除「' + (ev.title || '（無標題）') + '」？', ok: '刪除', danger: true }).then(function (yes) { if (!yes) return; c.cal.events = c.cal.events.filter(function (e) { return e !== ev; }); save(c); render(host, O); });
  }

  // ---- 編輯行程（照 TimeTree 的欄位）----
  // ev 為 null 是新增；o.date／o.time 是預設日期時間；o.keep 是 Keep；o.instKey 是重複行程的哪一次
  function openEditor(ev, c, o) {
    o = o || {};
    closePop();
    const cals = calsOf().filter(function (x) { return !x.ro; });
    if (!cals.length) { toast('先建立一本行事曆'); return; }
    c = c || calById(S.lastCal) || cals[0];
    const isNew = !ev;
    const base = ev ? JSON.parse(JSON.stringify(ev)) : { id: uid('e'), title: '', allDay: !o.time, start: '', end: '', label: null, location: '', url: '', notes: '', images: [], repeat: null, exdates: [], reminders: [], keep: !!o.keep };
    if (isNew && !o.keep) { const d = o.date || dkey(new Date()); if (o.time) { base.start = d + 'T' + o.time; const s = parseLocal(base.start); base.end = tkey(new Date(s.getTime() + 3600000)); } else { base.start = d; base.end = d; } }
    // 重複行程的某一次：先把這一次的日期算出來放進欄位
    let instStart = null;
    if (ev && ev.repeat && o.instKey && !ev.keep) { const inst = instanceAt(ev, c.cal, c.id, parseLocal(o.instKey)); instStart = inst; base.start = ev.allDay ? dkey(inst.start) : tkey(inst.start); base.end = ev.allDay ? dkey(inst.end) : tkey(inst.end); }
    const ov = el('div', 'modal-overlay tt-dialog-overlay');
    const sd = base.start ? base.start.slice(0, 10) : dkey(new Date()), ed = base.end ? base.end.slice(0, 10) : sd;
    const stm = base.start && base.start.length > 10 ? base.start.slice(11) : '09:00', etm = base.end && base.end.length > 10 ? base.end.slice(11) : '10:00';
    const rep = base.repeat || { freq: '', interval: 1 };
    ov.innerHTML = '<div class="modal tt-dialog tt-editor" role="dialog" aria-modal="true">' +
      '<div class="tt-ed-head"><input class="tt-ed-title" type="text" maxlength="300" placeholder="標題" value="' + esc(base.title) + '" data-f="title"><button class="tt-tb" type="button" data-e="close" title="關閉">' + ic('x') + '</button></div>' +
      '<div class="tt-dialog-body">' +
      (ev && ev.repeat && o.instKey ? '<div class="tt-ed-row tt-ed-scope"><span>套用到</span><label><input type="radio" name="tt-scope" value="one" checked> 只有這一次</label><label><input type="radio" name="tt-scope" value="all"> 所有重複的行程</label></div>' : '') +
      '<div class="tt-ed-row"><label class="tt-ed-check"><input type="checkbox" data-f="keep"' + (base.keep ? ' checked' : '') + '> 先放 Keep（還沒決定日期）</label><label class="tt-ed-check tt-ed-allday"><input type="checkbox" data-f="allDay"' + (base.allDay ? ' checked' : '') + '> 全天</label></div>' +
      '<div class="tt-ed-dates"><div class="tt-ed-row"><span class="tt-ed-l">開始</span><input class="tt-input" type="date" data-f="sd" value="' + sd + '"><input class="tt-input tt-ed-time" type="time" data-f="st" value="' + stm + '"></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">結束</span><input class="tt-input" type="date" data-f="ed" value="' + ed + '"><input class="tt-input tt-ed-time" type="time" data-f="et" value="' + etm + '"></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">重複</span><select class="tt-input" data-f="freq"><option value="">不重複</option><option value="daily"' + (rep.freq === 'daily' ? ' selected' : '') + '>每天</option><option value="weekly"' + (rep.freq === 'weekly' ? ' selected' : '') + '>每週</option><option value="monthly"' + (rep.freq === 'monthly' ? ' selected' : '') + '>每月</option><option value="yearly"' + (rep.freq === 'yearly' ? ' selected' : '') + '>每年</option></select>' +
      '<span class="tt-ed-rep"><span>每</span><input class="tt-input tt-ed-num" type="number" min="1" max="99" data-f="interval" value="' + (rep.interval || 1) + '"><span class="tt-ed-unit"></span><span>　到</span><input class="tt-input" type="date" data-f="until" value="' + (rep.until || '') + '"></span></div>' +
      '<div class="tt-ed-row tt-ed-bydays"><span class="tt-ed-l"></span>' + [0, 1, 2, 3, 4, 5, 6].map(function (d) { return '<label class="tt-ed-day"><input type="checkbox" data-day="' + d + '"' + (rep.byDay && rep.byDay.indexOf(d) >= 0 ? ' checked' : '') + '><span>' + WEEKDAYS[d] + '</span></label>'; }).join('') + '</div></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">行事曆</span><select class="tt-input" data-f="cal">' + cals.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === c.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">標籤</span><div class="tt-ed-labels"><button type="button" class="tt-lbl' + (!base.label ? ' on' : '') + '" data-label="" title="不用標籤（用行事曆顏色）" style="--c:' + c.cal.color + '"></button>' + c.cal.labels.map(function (l) { return '<button type="button" class="tt-lbl' + (base.label === l.id ? ' on' : '') + '" data-label="' + l.id + '" title="' + esc(l.name) + '" style="--c:' + l.color + '"></button>'; }).join('') + '<span class="tt-lbl-name">' + esc((labelOf(c.cal, base) || {}).name || '') + '</span></div></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">提醒</span><div class="tt-ed-rem">' + REMINDERS.map(function (r) { return '<button type="button" class="tt-rem' + (base.reminders.indexOf(r[0]) >= 0 ? ' on' : '') + '" data-rem="' + r[0] + '">' + r[1] + '</button>'; }).join('') + '</div></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">' + ic('map-pin') + '</span><input class="tt-input" type="text" maxlength="300" placeholder="地點" data-f="location" value="' + esc(base.location) + '"></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">' + ic('link') + '</span><input class="tt-input" type="url" maxlength="1000" placeholder="網址" data-f="url" value="' + esc(base.url) + '"></div>' +
      '<div class="tt-ed-row tt-ed-notes"><span class="tt-ed-l">' + ic('file-text') + '</span><textarea class="tt-input" rows="3" maxlength="5000" placeholder="備註" data-f="notes">' + esc(base.notes) + '</textarea></div>' +
      '<div class="tt-ed-row"><span class="tt-ed-l">' + ic('image') + '</span><div class="tt-ed-imgs">' + base.images.map(function (id) { return '<span class="tt-ed-img" data-img="' + esc(id) + '"><img src="/api/images/' + esc(id) + '" alt=""><button type="button" data-rmimg="' + esc(id) + '" title="移除">' + ic('x') + '</button></span>'; }).join('') + (O.onUpload ? '<button type="button" class="tt-ed-addimg" data-e="img">' + ic('plus') + ' 圖片</button>' : '') + '</div></div>' +
      '</div><div class="modal-actions">' + (isNew ? '' : '<button class="btn tt-ed-del" type="button" data-e="del">刪除</button>') + '<span class="tt-sp"></span><button class="btn" type="button" data-e="close">取消</button><button class="btn btn-primary" type="button" data-e="save">儲存</button></div></div>';
    document.body.appendChild(ov);
    const q = function (sel) { return ov.querySelector(sel); };
    const f = function (name) { return q('[data-f="' + name + '"]'); };
    let label = base.label, reminders = base.reminders.slice(), images = base.images.slice();
    let curCal = c;
    const refreshUI = function () {
      const keep = f('keep').checked, allDay = f('allDay').checked, freq = f('freq').value;
      q('.tt-ed-dates').style.display = keep ? 'none' : '';
      q('.tt-ed-allday').style.visibility = keep ? 'hidden' : '';
      ov.querySelectorAll('.tt-ed-time').forEach(function (x) { x.style.display = allDay ? 'none' : ''; });
      q('.tt-ed-rep').style.display = freq ? '' : 'none';
      q('.tt-ed-bydays').style.display = freq === 'weekly' ? '' : 'none';
      q('.tt-ed-unit').textContent = { daily: '天', weekly: '週', monthly: '月', yearly: '年' }[freq] || '';
    };
    refreshUI();
    ov.addEventListener('change', function (e) {
      const t = e.target;
      if (t.getAttribute('data-f') === 'sd') { const s = parseLocal(f('sd').value), en = parseLocal(f('ed').value); if (s && (!en || en < s)) f('ed').value = f('sd').value; }
      if (t.getAttribute('data-f') === 'st' && f('sd').value === f('ed').value && f('et').value <= f('st').value) { const s = parseLocal(f('sd').value + 'T' + f('st').value); if (s) f('et').value = fmtTime(new Date(s.getTime() + 3600000)); }
      if (t.getAttribute('data-f') === 'cal') { curCal = calById(t.value) || curCal; label = null; ov.querySelectorAll('.tt-lbl').forEach(function (b, i) { const l = curCal.cal.labels[i - 1]; if (i === 0) { b.style.setProperty('--c', curCal.cal.color); b.classList.add('on'); } else { b.style.setProperty('--c', l.color); b.title = l.name; b.classList.remove('on'); } }); q('.tt-lbl-name').textContent = ''; }
      refreshUI();
    });
    ov.addEventListener('click', function (e) {
      const lb = e.target.closest('[data-label]'); if (lb) { label = lb.getAttribute('data-label') || null; ov.querySelectorAll('.tt-lbl').forEach(function (b) { b.classList.toggle('on', b === lb); }); q('.tt-lbl-name').textContent = (labelOf(curCal.cal, { label: label }) || {}).name || ''; return; }
      const rm = e.target.closest('[data-rem]'); if (rm) { const m = +rm.getAttribute('data-rem'); const i = reminders.indexOf(m); if (i >= 0) reminders.splice(i, 1); else reminders.push(m); rm.classList.toggle('on'); return; }
      const ri = e.target.closest('[data-rmimg]'); if (ri) { const id = ri.getAttribute('data-rmimg'); images = images.filter(function (x) { return x !== id; }); ri.closest('.tt-ed-img').remove(); return; }
      const b = e.target.closest('[data-e]'); if (!b) return;
      const a = b.getAttribute('data-e');
      if (a === 'close') close();
      else if (a === 'img') pickImages();
      else if (a === 'del') { close(); deleteEvent(ev, c, o.instKey); }
      else if (a === 'save') doSave();
    });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    ov.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (e.target.tagName === 'INPUT' && e.target.type === 'text' && e.target.getAttribute('data-f') === 'title'))) { e.preventDefault(); doSave(); }
    });
    function pickImages() {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.addEventListener('change', function () {
        const files = Array.prototype.slice.call(inp.files || []); if (!files.length) return;
        Promise.resolve(O.onUpload(files)).then(function (mds) {
          (mds || []).forEach(function (md) { const m = /\(img:([^)#]+)\)/.exec(md || ''); if (m) { images.push(m[1]); q('.tt-ed-imgs').insertAdjacentHTML('afterbegin', '<span class="tt-ed-img" data-img="' + esc(m[1]) + '"><img src="/api/images/' + esc(m[1]) + '" alt=""><button type="button" data-rmimg="' + esc(m[1]) + '" title="移除">' + ic('x') + '</button></span>'); } });
        });
      });
      inp.click();
    }
    function close() { ov.remove(); }
    function doSave() {
      const out = { id: base.id, title: f('title').value.trim(), allDay: f('allDay').checked, label: label, location: f('location').value.trim(), url: f('url').value.trim(), notes: f('notes').value, images: images, reminders: reminders, exdates: base.exdates || [], keep: f('keep').checked, repeat: null };
      if (!out.keep) {
        const sd0 = f('sd').value, ed0 = f('ed').value || sd0;
        if (!parseLocal(sd0)) { f('sd').focus(); return; }
        if (out.allDay) { out.start = sd0; out.end = parseLocal(ed0) >= parseLocal(sd0) ? ed0 : sd0; }
        else { out.start = sd0 + 'T' + (f('st').value || '09:00'); out.end = ed0 + 'T' + (f('et').value || '10:00'); if (!(parseLocal(out.end) > parseLocal(out.start))) out.end = tkey(new Date(parseLocal(out.start).getTime() + 3600000)); }
        const freq = f('freq').value;
        if (freq) { out.repeat = { freq: freq, interval: parseInt(f('interval').value, 10) || 1 }; if (f('until').value) out.repeat.until = f('until').value; if (freq === 'weekly') { const bd = Array.prototype.filter.call(ov.querySelectorAll('[data-day]'), function (x) { return x.checked; }).map(function (x) { return +x.getAttribute('data-day'); }); if (bd.length) out.repeat.byDay = bd; } }
      }
      const target = calById(f('cal').value) || c;
      const scopeEl = q('input[name="tt-scope"]:checked');
      const scope = scopeEl ? scopeEl.value : 'all';
      if (!isNew && ev.repeat && o.instKey && scope === 'one') {
        // 只改這一次：原本的那一次排除，另外存一個不重複的
        ev.exdates.push(o.instKey);
        const one = cleanEvent(Object.assign({}, out, { id: uid('e'), repeat: null, exdates: [] }), {});
        if (one) target.cal.events.push(one);
        save(c); if (target !== c) save(target);
      } else if (!isNew && ev.repeat && o.instKey && scope === 'all' && instStart) {
        // 改全部：日期以原本的第一次為準，只有時間與長度跟著改
        const s0 = parseLocal(ev.start), newS = parseLocal(out.start), newE = parseLocal(out.end);
        const dayShift = daysBetween(instStart.start, newS);
        const ns = addDays(s0, dayShift); if (!out.allDay) ns.setHours(newS.getHours(), newS.getMinutes());
        const dur = newE - newS;
        out.start = out.allDay ? dkey(ns) : tkey(ns);
        out.end = out.allDay ? dkey(addDays(ns, daysBetween(newS, newE))) : tkey(new Date(ns.getTime() + dur));
        applyUpdate(out, target);
      } else applyUpdate(out, target);
      S.lastCal = target.id;
      close(); render(host, O);
    }
    function applyUpdate(out, target) {
      const clean = cleanEvent(out, {}); if (!clean) return;
      if (!isNew) c.cal.events = c.cal.events.filter(function (e) { return e.id !== ev.id; });
      clean.id = base.id;
      if (clean.label && !target.cal.labels.some(function (l) { return l.id === clean.label; })) clean.label = null;
      target.cal.events.push(clean);
      if (!isNew && target !== c) save(c);
      save(target);
    }
    setTimeout(function () { f('title').focus(); }, 0);
  }

  // ---- 拖動：月曆的橫條換天、週／日曆的行程換時間、拉下緣改結束 ----
  function onDown(e) {
    if (e.button !== 0) return;
    const bar = e.target.closest('.tt-bar, .tt-wev');
    if (!bar || !host.contains(bar)) return;
    const x = instFromEl(bar); if (!x || x.hit.c.ro) return;
    const resize = !!e.target.closest('.tt-wev-rs');
    S.dragging = { bar: bar, x: x, sx: e.clientX, sy: e.clientY, moved: false, resize: resize, ghost: null, grabY: e.clientY - bar.getBoundingClientRect().top };
    const move = function (ev2) {
      const d = S.dragging; if (!d) return;
      if (!d.moved && Math.abs(ev2.clientX - d.sx) + Math.abs(ev2.clientY - d.sy) < 5) return;
      d.moved = true; bar.classList.add('is-dragging');
      host.querySelectorAll('.is-dropover').forEach(function (n) { n.classList.remove('is-dropover'); });
      const under = document.elementFromPoint(ev2.clientX, ev2.clientY);
      const cell = under && under.closest ? under.closest('.tt-day, .tt-time-col, .tt-allday-cell') : null;
      if (cell) cell.classList.add('is-dropover');
      d.last = ev2; d.cell = cell;
    };
    const up = function (ev2) {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      const d = S.dragging; if (!d) return;
      bar.classList.remove('is-dragging');
      host.querySelectorAll('.is-dropover').forEach(function (n) { n.classList.remove('is-dropover'); });
      if (!d.moved) { S.dragging = null; return; }
      setTimeout(function () { S.dragging = null; }, 0);
      const cell = d.cell; if (!cell) return;
      const ev = d.x.hit.ev, c = d.x.hit.c, inst = d.x.inst;
      const key = cell.getAttribute('data-key');
      let newStart, newEnd;
      if (cell.classList.contains('tt-time-col')) {
        const r = cell.getBoundingClientRect();
        const yy = d.resize ? ev2.clientY : ev2.clientY - (bar.classList.contains('tt-wev') ? d.grabY : 0);
        const mins = Math.max(0, Math.min(24 * 60 - 15, Math.round(((yy - r.top) / HOUR_H * 60) / 15) * 15));
        const t = parseLocal(key); t.setHours(Math.floor(mins / 60), mins % 60);
        if (d.resize) { if (inst.allDay) return; newStart = inst.start; newEnd = t > newStart ? t : new Date(newStart.getTime() + 15 * 60000); }
        else if (inst.allDay) { newStart = t; newEnd = new Date(t.getTime() + 3600000); }
        else { const dur = inst.end - inst.start; newStart = t; newEnd = new Date(t.getTime() + dur); }
        applyMove(ev, c, d.x.key, newStart, newEnd, false);
      } else {
        // 月曆或全天列：換天（時間照舊）
        const day = parseLocal(key);
        const shift = daysBetween(inst.start, day);
        if (!shift && !cell.classList.contains('tt-allday-cell')) return;
        newStart = addDays(inst.start, shift); newEnd = addDays(inst.end, shift);
        const toAllDay = cell.classList.contains('tt-allday-cell') && !inst.allDay;
        if (toAllDay) { newStart = startOfDay(newStart); newEnd = startOfDay(newEnd); }
        applyMove(ev, c, d.x.key, newStart, newEnd, toAllDay ? true : inst.allDay);
      }
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }
  function applyMove(ev, c, instKey, newStart, newEnd, allDay) {
    const fmt = function (d) { return allDay ? dkey(d) : tkey(d); };
    if (ev.repeat && instKey) {
      // 拖某一次：那一次排除、另存一個不重複的
      ev.exdates.push(instKey);
      const one = cleanEvent(Object.assign(JSON.parse(JSON.stringify(ev)), { id: uid('e'), repeat: null, exdates: [], allDay: allDay, start: fmt(newStart), end: fmt(allDay && daysBetween(newStart, newEnd) < 0 ? newStart : newEnd) }), {});
      if (one) c.cal.events.push(one);
    } else { ev.allDay = allDay; ev.start = fmt(newStart); ev.end = fmt(newEnd); if (allDay && parseLocal(ev.end) < parseLocal(ev.start)) ev.end = ev.start; }
    save(c); render(host, O);
  }

  // ---- 提醒：頁面開著時，接下來 24 小時內的提醒用瀏覽器通知 ----
  function scheduleReminders() {
    S.timers.forEach(clearTimeout); S.timers = [];
    if (lsGet('ttNotify', '0') !== '1') return;
    const now = new Date(), to = new Date(now.getTime() + 86400000);
    calsOf().forEach(function (c) {
      expand(c.cal, c.id, now, to).forEach(function (inst) {
        inst.ev.reminders.forEach(function (m) {
          const at = inst.start.getTime() - m * 60000;
          if (at < now.getTime() || at > to.getTime()) return;
          S.timers.push(setTimeout(function () {
            const body = rangeText(inst) + (inst.ev.location ? '\n' + inst.ev.location : '');
            if (global.Notification && Notification.permission === 'granted') { try { new Notification(inst.ev.title || '（無標題）', { body: body }); } catch (e) { toast('提醒：' + inst.ev.title); } }
            else toast('提醒：' + inst.ev.title + '　' + body);
          }, at - now.getTime()));
        });
      });
    });
  }
  function teardown() { S.timers.forEach(clearTimeout); S.timers = []; S.sideOpen = false; closePop(); document.removeEventListener('keydown', onKey); }

  global.TimeTree = { isNote: isNote, generate: generate, parse: parse, serialize: serialize, payloadOf: payloadOf, wrap: wrap, blockHTML: blockHTML, render: render, closePop: closePop, teardown: teardown, expand: expand, toICS: toICS, fromICS: fromICS, cleanEvent: cleanEvent, LABELS: LABELS, CAL_COLORS: CAL_COLORS, state: S };
})(window);
