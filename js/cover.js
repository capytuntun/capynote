/* cover.js — PDF 封面設計器（使用者：「我想要我的封面可以自己設計，並且讓我可以指定上面標題、作者的一些位置，
 * 甚至可以自己上傳 logo」）。
 *
 * 設計存在筆記的 meta.cover（走列印預覽原本的 onMeta 存檔路徑）：
 *   { v: 1, bg: '#rrggbb', bgImg: '<imgId>'|'', els: [{ id, type, field, text, label, imgId, x, y, w, h, fs, color,
 *     bold, italic, align, font, opacity }] }
 *   - 座標與大小都是 mm（A4 210×297），字級是 pt；type 是 field（值從筆記／封面欄位來：標題、作者、客戶、版本、
 *     產生日期、更新日期）、text（自訂文字，kicker「Report」就是一個）、image（上傳過的圖片 id，Logo）、rule（色塊／橫線）、
 *     tlp（TLP 角標，顏色照 pdf.js 的 TLP 表）。
 *   - clean() 把每個欄位夾在範圍內（數字 clamp、顏色只收 hex、imgId 走 ID_RE、文字切長、最多 40 個元素）：
 *     這段 JSON 會原樣寫進列印的 HTML，而且備份還原可以塞任何東西進 meta。
 * 三個出口：
 *   - defaultDesign(themeId, ctx)：從某個內建樣式推一份長得差不多的起始設計（第一次打開不是空白頁）。
 *   - html(design, ctx, images)／css()：列印用的封面（pdf.js 的 buildDoc 有 meta.cover 就用這個，沒有就照舊）。
 *   - open(design, ctx, { onUpload, onSave, onReset })：設計器對話框——A4 畫布拖放、八個把手縮放、方向鍵微調、
 *     對齊輔助線、Ctrl+Z／Y、左邊「加入」、右邊屬性、範本（localStorage，跟 templates.js 同一種做法）。
 */
(function (global) {
  'use strict';

  const PAGE = { w: 210, h: 297 };
  const MARGIN = 24;
  const ID_RE = /^[A-Za-z0-9_][\w.-]{0,63}$/;
  const MAX_ELS = 40;
  const LS_TPL = 'strikenote.coverTemplates';
  const FIELDS = [['title', '標題'], ['author', '作者'], ['client', '客戶'], ['version', '版本'], ['generated', '產生日期'], ['updated', '更新日期']];
  const FIELD_NAME = {}; FIELDS.forEach(function (f) { FIELD_NAME[f[0]] = f[1]; });
  const FONTS = {
    sans: '"Inter", "Noto Sans TC", -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif',
    serif: 'Georgia, "Times New Roman", "Noto Serif CJK TC", "Songti TC", "PMingLiU", serif',
    mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
  };
  const FONT_NAME = { sans: '無襯線', serif: '襯線', mono: '等寬' };
  const TYPES = ['field', 'text', 'image', 'rule', 'tlp'];
  // 內建樣式的顏色（pdf.js 的 THEMES 只有 CSS 字串，這裡抄顏色出來給起始設計用；漸層取深的那端當底色）
  const THEME_INK = {
    tech: { bg: '#f3f6f9', ink: '#0f1b28', accent: '#0068d6', meta: '#5b6b7c', bars: [[0, 0, 10, 297]] },
    blue: { bg: '#174fb8', ink: '#ffffff', accent: '#ffffff', meta: '#e6edfb' },
    mono: { bg: '#ffffff', ink: '#111111', accent: '#111111', meta: '#555555', bars: [[0, 0, 210, 1], [0, 296, 210, 1]] },
    dark: { bg: '#0b1017', ink: '#e8f1fb', accent: '#3d9bff', meta: '#8496a8' },
    red: { bg: '#33090f', ink: '#ffe9ea', accent: '#c62828', meta: '#d9a3a6', bars: [[0, 0, 10, 297]] },
    corporate: { bg: '#ffffff', ink: '#14243a', accent: '#1a4d8f', meta: '#5a6c85', font: 'serif', top: 60, bars: [[0, 281, 210, 16]] },
    terminal: { bg: '#05080a', ink: '#7ee787', accent: '#3fb950', meta: '#6e9a76', font: 'mono', kicker: '> REPORT' },
    teal: { bg: '#0a6a8a', ink: '#eafcff', accent: '#7fdbe8', meta: '#a9d8e2' },
    blueprint: { bg: '#0d3b66', ink: '#eaf3ff', accent: '#9ec5ef', meta: '#b9d3ee' },
    frame: { bg: '#ffffff', ink: '#1a1a1a', accent: '#777777', meta: '#555555', font: 'serif', center: true, bars: [[10, 10, 190, 1], [10, 286, 190, 1], [10, 10, 1, 277], [199, 10, 1, 277]] },
    amber: { bg: '#fdf6e7', ink: '#3d2c0a', accent: '#a56a09', meta: '#7a6435', bars: [[0, 0, 210, 12]] }
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function uid() { return 'e' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function num(v, d, lo, hi) { const n = parseFloat(v); return isFinite(n) ? Math.round(clamp(n, lo, hi) * 100) / 100 : d; }
  function color(v, d) {
    const s = String(v || '').toLowerCase().trim();
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return d;
  }
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  // ---------------- 模型 ----------------
  function cleanEl(raw, seen) {
    if (!raw || typeof raw !== 'object' || TYPES.indexOf(raw.type) < 0) return null;
    let id = typeof raw.id === 'string' && /^[\w-]{1,24}$/.test(raw.id) ? raw.id : uid();
    if (seen[id]) id = uid();
    seen[id] = 1;
    const o = { id: id, type: raw.type, x: num(raw.x, 24, -PAGE.w, PAGE.w), y: num(raw.y, 24, -PAGE.h, PAGE.h), w: num(raw.w, 100, 1, PAGE.w * 2), h: num(raw.h, 10, 0.2, PAGE.h * 2), opacity: num(raw.opacity, 1, 0.05, 1) };
    if (o.type === 'field') { o.field = FIELD_NAME[raw.field] ? raw.field : 'title'; o.label = str(raw.label, 40); }
    if (o.type === 'text') o.text = str(raw.text, 500);
    if (o.type === 'image') { if (!ID_RE.test(raw.imgId || '')) return null; o.imgId = raw.imgId; }
    if (o.type === 'field' || o.type === 'text' || o.type === 'tlp') {
      o.fs = num(raw.fs, 12, 5, 120); o.color = color(raw.color, '#111111'); o.bold = !!raw.bold; o.italic = !!raw.italic;
      o.align = ['left', 'center', 'right'].indexOf(raw.align) >= 0 ? raw.align : 'left';
      o.font = FONTS[raw.font] ? raw.font : 'sans';
    }
    if (o.type === 'rule') o.color = color(raw.color, '#111111');
    return o;
  }
  function clean(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const o = { v: 1, bg: color(raw.bg, '#ffffff'), bgImg: ID_RE.test(raw.bgImg || '') ? raw.bgImg : '', els: [] };
    const seen = {};
    (Array.isArray(raw.els) ? raw.els : []).forEach(function (e) { if (o.els.length >= MAX_ELS) return; const x = cleanEl(e, seen); if (x) o.els.push(x); });
    return o;
  }
  function isCustom(meta) { return !!(meta && meta.cover && Array.isArray(meta.cover.els)); }
  function imageIds(design) {
    const ids = [];
    if (!design) return ids;
    if (ID_RE.test(design.bgImg || '')) ids.push(design.bgImg);
    (design.els || []).forEach(function (e) { if (e && e.type === 'image' && ID_RE.test(e.imgId || '') && ids.indexOf(e.imgId) < 0) ids.push(e.imgId); });
    return ids;
  }
  function valueOf(e, ctx) {
    if (e.type === 'text') return e.text;
    if (e.type === 'tlp') return ctx.tlp || '';
    if (e.type === 'field') return ctx[e.field] != null ? String(ctx[e.field]) : '';
    return '';
  }

  // 從內建樣式推一份起始設計：Logo、kicker、標題、橫線、幾行 meta，跟 pdf.js 的 flex 版面差不多的位置
  function defaultDesign(themeId, ctx) {
    const t = THEME_INK[themeId] || THEME_INK.tech;
    ctx = ctx || {};
    const font = t.font || 'sans', center = !!t.center;
    const x = center ? 25 : MARGIN, w = center ? 160 : 162, align = center ? 'center' : 'left';
    const els = [];
    (t.bars || []).forEach(function (b) { els.push({ type: 'rule', x: b[0], y: b[1], w: b[2], h: b[3], color: t.accent }); });
    let y = t.top ? t.top : 78;
    if (ctx.logoId) { els.push({ type: 'image', imgId: ctx.logoId, x: center ? 80 : x, y: y, w: 50, h: 22 }); y += 30; }
    els.push({ type: 'text', text: t.kicker || 'REPORT', x: x, y: y, w: w, h: 8, fs: 12, color: t.accent, bold: false, align: align, font: font }); y += 10;
    els.push({ type: 'field', field: 'title', x: x, y: y, w: w, h: 36, fs: 32, color: t.ink, bold: true, align: align, font: font }); y += 40;
    els.push({ type: 'rule', x: center ? 95 : x, y: y, w: center ? 20 : 21, h: 1.4, color: t.accent }); y += 10;
    [['client', 'Client'], ['version', 'Version'], ['author', 'Author'], ['generated', 'Generated'], ['updated', 'Last Updated']].forEach(function (f) {
      els.push({ type: 'field', field: f[0], label: f[1], x: x, y: y, w: w, h: 7, fs: 11, color: t.meta, align: align, font: font }); y += 7.5;
    });
    els.push({ type: 'tlp', x: PAGE.w - 16 - 36, y: 16, w: 36, h: 7, fs: 10, color: '#ffffff', bold: true, align: 'center', font: 'mono' });
    return clean({ bg: t.bg, bgImg: '', els: els });
  }

  // ---------------- 列印：HTML + CSS ----------------
  function textStyle(e) {
    return 'font-size:' + e.fs + 'pt;color:' + e.color + ';font-weight:' + (e.bold ? '700' : '400') + ';font-style:' + (e.italic ? 'italic' : 'normal') + ';text-align:' + e.align + ';font-family:' + FONTS[e.font] + ';';
  }
  function boxStyle(e) { return 'left:' + e.x + 'mm;top:' + e.y + 'mm;width:' + e.w + 'mm;height:' + e.h + 'mm;opacity:' + e.opacity + ';'; }
  function elHTML(e, ctx, images, forEditor) {
    const v = valueOf(e, ctx);
    if (e.type === 'image') {
      const src = forEditor ? '/api/images/' + encodeURIComponent(e.imgId) : (images && images[e.imgId]);
      return '<div class="cvp-el cvp-img" style="' + boxStyle(e) + '">' + (src ? '<img src="' + esc(src) + '" alt="">' : '') + '</div>';
    }
    if (e.type === 'rule') return '<div class="cvp-el cvp-rule" style="' + boxStyle(e) + 'background:' + e.color + ';"></div>';
    if (e.type === 'tlp') {
      if (!v && !forEditor) return '';
      return '<div class="cvp-el cvp-tlp" style="' + boxStyle(e) + textStyle(e) + (ctx.tlpColor ? 'color:' + ctx.tlpColor + ';' : '') + '">' + esc(v || 'TLP') + '</div>';
    }
    const label = e.type === 'field' && e.label ? '<span class="cvp-label">' + esc(e.label) + '</span>' : '';
    return '<div class="cvp-el cvp-text' + (e.type === 'field' && !v ? ' is-empty' : '') + '" style="' + boxStyle(e) + textStyle(e) + '">' + label + '<span class="cvp-v">' + esc(v) + '</span></div>';
  }
  function html(design, ctx, images) {
    const d = clean(design);
    const bg = d.bgImg && images && images[d.bgImg] ? '<img class="cvp-bg" src="' + esc(images[d.bgImg]) + '" alt="">' : '';
    return '<section class="pdf-cover pdf-cover-custom" style="background:' + d.bg + ';">' + bg + d.els.map(function (e) { return elHTML(e, ctx, images, false); }).join('') + '</section>';
  }
  // 放在主題的 .pdf-cover 規則之後，把 flex 版面、padding、邊框都拿掉
  function css() {
    return [
      '.pdf-cover.pdf-cover-custom { display: block; position: relative; width: 210mm; height: 297mm; padding: 0; margin: 0;',
      '  border: 0; outline: 0; background-image: none; overflow: hidden; }',
      '.pdf-cover-custom .cvp-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }',
      '.pdf-cover-custom .cvp-el { position: absolute; box-sizing: border-box; margin: 0; overflow: hidden; }',
      '.pdf-cover-custom .cvp-text { line-height: 1.25; white-space: pre-wrap; overflow-wrap: break-word; }',
      '.pdf-cover-custom .cvp-text.is-empty { display: none; }',
      '.pdf-cover-custom .cvp-label { display: inline-block; min-width: 96pt; font-size: .8em; letter-spacing: .04em; text-transform: uppercase; opacity: .75; }',
      '.pdf-cover-custom .cvp-img img { width: 100%; height: 100%; object-fit: contain; object-position: left top; display: block; }',
      '.pdf-cover-custom .cvp-tlp { display: flex; align-items: center; justify-content: center; background: #000; letter-spacing: .06em; }'
    ].join('\n');
  }

  // ---------------- 範本（localStorage） ----------------
  function loadTemplates() { try { const a = JSON.parse(localStorage.getItem(LS_TPL) || '[]'); return Array.isArray(a) ? a.filter(function (t) { return t && typeof t.name === 'string'; }) : []; } catch (e) { return []; } }
  function saveTemplates(list) { try { localStorage.setItem(LS_TPL, JSON.stringify(list)); } catch (e) { /* 隱私模式或空間滿 */ } }

  // ---------------- 設計器 ----------------
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  document.addEventListener('mousedown', function (e) { if (popEl && !popEl.contains(e.target)) closePop(); }, true);

  function open(design, ctx, o) {
    o = o || {}; ctx = ctx || {};
    let d = clean(design && design.els ? design : defaultDesign(ctx.themeId, ctx));
    let sel = null, undo = [], redo = [], scale = 2.5, editing = null;
    const aspect = {};   // imgId → 自然長寬比（h/w）
    const themes = ctx.themes || [];

    const ov = el('div', 'modal-overlay cv-overlay');
    ov.innerHTML =
      '<div class="modal cv-modal" role="dialog" aria-modal="true">' +
        '<div class="cv-head"><div class="modal-title">' + ic('image') + '設計封面</div>' +
          '<div class="cv-tools">' +
            '<button type="button" class="tt-btn" data-a="tpl">' + ic('template') + '範本' + ic('chevron-down') + '</button>' +
            '<button type="button" class="tt-btn" data-a="undo" title="復原 (Ctrl+Z)">' + ic('undo') + '</button>' +
            '<button type="button" class="tt-btn" data-a="redo" title="重做 (Ctrl+Y)">' + ic('redo') + '</button>' +
            '<button type="button" class="tt-btn" data-a="center" title="水平置中選取的元素">' + ic('align-center') + '置中</button>' +
            '<button type="button" class="tt-btn" data-a="reset" title="回到這個樣式的起始設計">' + ic('rotate-ccw') + '重設</button>' +
          '</div>' +
          '<div class="cv-hint">拖曳移動、拉角落縮放、方向鍵微調（Shift 5mm）、雙擊文字改字、Delete 刪除</div>' +
        '</div>' +
        '<div class="cv-body">' +
          '<aside class="cv-left"><div class="cv-sec">加入</div>' +
            FIELDS.map(function (f) { return '<button type="button" class="cv-add" data-add="field" data-field="' + f[0] + '">' + ic('type') + f[1] + '</button>'; }).join('') +
            '<button type="button" class="cv-add" data-add="tlp">' + ic('shield') + 'TLP 角標</button>' +
            '<button type="button" class="cv-add" data-add="text">' + ic('pen-line') + '自訂文字</button>' +
            '<button type="button" class="cv-add" data-add="image"' + (o.onUpload ? '' : ' disabled title="這裡不能上傳"') + '>' + ic('image') + 'Logo／圖片…</button>' +
            '<button type="button" class="cv-add" data-add="rule">' + ic('minus') + '橫線／色塊</button>' +
            '<input type="file" accept="image/*" class="cv-file" hidden>' +
          '</aside>' +
          '<div class="cv-stage"><div class="cv-paper"></div></div>' +
          '<aside class="cv-right"></aside>' +
        '</div>' +
        '<div class="modal-actions"><button type="button" class="btn cv-revert" ' + (o.onReset ? '' : 'hidden') + '>改回內建封面</button><span class="cv-sp"></span><button type="button" class="btn cv-cancel">取消</button><button type="button" class="btn btn-primary cv-save">儲存</button></div>' +
      '</div>';
    document.body.appendChild(ov);
    const paper = ov.querySelector('.cv-paper'), stage = ov.querySelector('.cv-stage'), right = ov.querySelector('.cv-right'), fileInp = ov.querySelector('.cv-file');
    const q = function (s) { return ov.querySelector(s); };
    const mm2px = function (mm) { return mm * scale; };
    const px2mm = function (px) { return px / scale; };
    const pt2px = function (pt) { return pt * 25.4 / 72 * scale; };
    const byId = function (id) { return d.els.find(function (e) { return e.id === id; }) || null; };
    const selEl = function () { return sel ? byId(sel) : null; };

    // ---- 畫布 ----
    function fitScale() {
      const h = stage.clientHeight - 32, w = stage.clientWidth - 32;
      scale = clamp(Math.min(h / PAGE.h, w / PAGE.w), 1.2, 4);
    }
    let render = function () {
      paper.style.width = mm2px(PAGE.w) + 'px'; paper.style.height = mm2px(PAGE.h) + 'px'; paper.style.background = d.bg;
      let h = d.bgImg ? '<img class="cv-bg" src="/api/images/' + esc(d.bgImg) + '" alt="">' : '';
      d.els.forEach(function (e) {
        const v = valueOf(e, ctx);
        const st = 'left:' + mm2px(e.x) + 'px;top:' + mm2px(e.y) + 'px;width:' + mm2px(e.w) + 'px;height:' + mm2px(e.h) + 'px;opacity:' + e.opacity + ';';
        let inner = '';
        if (e.type === 'image') inner = '<img src="/api/images/' + esc(e.imgId) + '" alt="" draggable="false">';
        else if (e.type === 'rule') inner = '';
        else {
          const ts = 'font-size:' + pt2px(e.fs) + 'px;color:' + e.color + ';font-weight:' + (e.bold ? 700 : 400) + ';font-style:' + (e.italic ? 'italic' : 'normal') + ';text-align:' + e.align + ';font-family:' + FONTS[e.font] + ';';
          if (e.type === 'tlp') inner = '<div class="cv-tlp" style="' + ts + (ctx.tlpColor ? 'color:' + ctx.tlpColor + ';' : '') + '">' + esc(v || 'TLP') + '</div>';
          else inner = '<div class="cv-txt' + (e.type === 'field' && !v ? ' is-empty' : '') + '" style="' + ts + '">' + (e.type === 'field' && e.label ? '<span class="cv-label">' + esc(e.label) + '</span>' : '') + '<span class="cv-v">' + (v ? esc(v) : (e.type === 'field' ? '（' + FIELD_NAME[e.field] + '：空）' : '')) + '</span></div>';
        }
        h += '<div class="cv-el cv-' + e.type + (e.id === sel ? ' on' : '') + '" data-id="' + e.id + '" style="' + st + (e.type === 'rule' ? 'background:' + e.color + ';' : '') + '">' + inner +
          (e.id === sel ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(function (k) { return '<i class="cv-h cv-h-' + k + '" data-h="' + k + '"></i>'; }).join('') : '') + '</div>';
      });
      paper.innerHTML = h;
    }
    function renderPaper() { render0(); }
    const render0 = render;
    render = function () { render0(); renderProps(); q('[data-a="undo"]').disabled = !undo.length; q('[data-a="redo"]').disabled = !redo.length; };
    function snapshot() { return JSON.stringify(d); }
    function commit(before) { const now = snapshot(); if (now === before) return; undo.push(before); if (undo.length > 100) undo.shift(); redo = []; render(); }
    function select(id) { sel = id; editing = null; render(); }

    // ---- 屬性面板 ----
    function propRow(label, html) { return '<label class="cv-prop"><span>' + label + '</span>' + html + '</label>'; }
    function renderProps() {
      const e = selEl();
      if (!e) {
        right.innerHTML = '<div class="cv-sec">整頁</div>' +
          propRow('底色', '<span class="cv-color"><input type="color" data-p="bg" value="' + d.bg + '"><input class="tt-input cv-hex" type="text" data-p="bg" value="' + d.bg + '" maxlength="7"></span>') +
          '<div class="cv-prop"><span>底圖</span><span class="cv-row">' + (d.bgImg ? '<span class="cv-thumb"><img src="/api/images/' + esc(d.bgImg) + '" alt=""></span><button type="button" class="tt-btn" data-a="bgclear">清除</button>' : '<button type="button" class="tt-btn" data-a="bgpick"' + (o.onUpload ? '' : ' disabled') + '>上傳底圖…</button>') + '</span></div>' +
          '<div class="cv-help">點畫布上的元素就能改它的位置、大小與字型。</div>';
        return;
      }
      const name = e.type === 'field' ? FIELD_NAME[e.field] : e.type === 'text' ? '自訂文字' : e.type === 'image' ? '圖片' : e.type === 'rule' ? '橫線／色塊' : 'TLP 角標';
      let h = '<div class="cv-sec">' + esc(name) + '</div>' +
        '<div class="cv-grid">' + [['x', 'X'], ['y', 'Y'], ['w', '寬'], ['h', e.type === 'rule' ? '粗細' : '高']].map(function (k) { return propRow(k[1] + ' mm', '<input class="tt-input" type="number" step="0.5" data-p="' + k[0] + '" value="' + e[k[0]] + '">'); }).join('') + '</div>';
      if (e.type === 'text') h += propRow('文字', '<textarea class="tt-input cv-ta" data-p="text" rows="3">' + esc(e.text) + '</textarea>');
      if (e.type === 'field') h += propRow('前綴標籤', '<input class="tt-input" type="text" data-p="label" value="' + esc(e.label) + '" placeholder="例如 Author" maxlength="40">');
      if (e.type === 'field' || e.type === 'text' || e.type === 'tlp') {
        h += '<div class="cv-grid">' + propRow('字級 pt', '<input class="tt-input" type="number" step="1" min="5" max="120" data-p="fs" value="' + e.fs + '">') +
          propRow('字體', '<select class="tt-input" data-p="font">' + Object.keys(FONTS).map(function (k) { return '<option value="' + k + '"' + (e.font === k ? ' selected' : '') + '>' + FONT_NAME[k] + '</option>'; }).join('') + '</select>') + '</div>';
        if (e.type !== 'tlp') h += propRow('顏色', '<span class="cv-color"><input type="color" data-p="color" value="' + e.color + '"><input class="tt-input cv-hex" type="text" data-p="color" value="' + e.color + '" maxlength="7"></span>');
        h += '<div class="cv-prop"><span>樣式</span><span class="cv-seg">' +
          '<button type="button" class="cv-tg' + (e.bold ? ' on' : '') + '" data-t="bold" title="粗體">' + ic('bold') + '</button>' +
          '<button type="button" class="cv-tg' + (e.italic ? ' on' : '') + '" data-t="italic" title="斜體">' + ic('italic') + '</button>' +
          '<i></i>' +
          ['left', 'center', 'right'].map(function (a) { return '<button type="button" class="cv-tg' + (e.align === a ? ' on' : '') + '" data-align="' + a + '">' + ic('align-' + a) + '</button>'; }).join('') +
          '</span></div>';
      }
      if (e.type === 'rule') h += propRow('顏色', '<span class="cv-color"><input type="color" data-p="color" value="' + e.color + '"><input class="tt-input cv-hex" type="text" data-p="color" value="' + e.color + '" maxlength="7"></span>');
      if (e.type === 'image') h += '<div class="cv-prop"><span>圖片</span><span class="cv-row"><span class="cv-thumb"><img src="/api/images/' + esc(e.imgId) + '" alt=""></span><button type="button" class="tt-btn" data-a="swap"' + (o.onUpload ? '' : ' disabled') + '>換圖…</button></span></div>';
      h += propRow('透明度', '<input type="range" min="0.05" max="1" step="0.05" data-p="opacity" value="' + e.opacity + '">');
      h += '<div class="cv-prop"><span>順序</span><span class="cv-row"><button type="button" class="tt-btn" data-a="up">上一層</button><button type="button" class="tt-btn" data-a="down">下一層</button><button type="button" class="tt-btn" data-a="dup">複製</button></span></div>' +
        '<button type="button" class="tt-btn cv-del" data-a="del">' + ic('trash') + '刪除這個元素</button>';
      right.innerHTML = h;
    }
    right.addEventListener('input', function (ev) {
      const p = ev.target.getAttribute('data-p'); if (!p) return;
      const e = selEl();
      if (ev.target.classList.contains('cv-hex') || ev.target.type === 'color') {
        const c = color(ev.target.value, null); if (!c) return;
        if (p === 'bg') d.bg = c; else if (e) e.color = c;
        // 兩個輸入框互相同步，不整個重畫（打字中）
        right.querySelectorAll('[data-p="' + p + '"]').forEach(function (i) { if (i !== ev.target) i.value = c; });
        paintOnly();
        return;
      }
      if (!e) return;
      if (p === 'text') e.text = str(ev.target.value, 500);
      else if (p === 'label') e.label = str(ev.target.value, 40);
      else if (p === 'opacity') e.opacity = num(ev.target.value, 1, 0.05, 1);
      else if (p === 'fs') e.fs = num(ev.target.value, e.fs, 5, 120);
      else if (p === 'x' || p === 'y' || p === 'w' || p === 'h') e[p] = num(ev.target.value, e[p], p === 'w' ? 1 : p === 'h' ? 0.2 : -PAGE.w, PAGE.h * 2);
      paintOnly();
    });
    right.addEventListener('change', function (ev) {
      const p = ev.target.getAttribute('data-p');
      const e = selEl();
      if (p === 'font' && e) { e.font = FONTS[ev.target.value] ? ev.target.value : 'sans'; }
      // 任何屬性改完（change 時）記一筆復原
      const before = lastProps; lastProps = snapshot(); if (before !== lastProps) { undo.push(before); redo = []; }
      render();
    });
    let lastProps = snapshot();
    right.addEventListener('focusin', function () { lastProps = snapshot(); });
    right.addEventListener('click', function (ev) {
      const e = selEl();
      const tg = ev.target.closest('[data-t]'); if (tg && e) { const before = snapshot(); e[tg.getAttribute('data-t')] = !e[tg.getAttribute('data-t')]; commit(before); return; }
      const al = ev.target.closest('[data-align]'); if (al && e) { const before = snapshot(); e.align = al.getAttribute('data-align'); commit(before); return; }
      const a = ev.target.closest('[data-a]'); if (!a) return;
      const act = a.getAttribute('data-a'), before = snapshot();
      if (act === 'del' && e) { d.els = d.els.filter(function (x) { return x !== e; }); sel = null; commit(before); }
      else if (act === 'up' && e) { const i = d.els.indexOf(e); if (i < d.els.length - 1) { d.els.splice(i, 1); d.els.splice(i + 1, 0, e); commit(before); } }
      else if (act === 'down' && e) { const i = d.els.indexOf(e); if (i > 0) { d.els.splice(i, 1); d.els.splice(i - 1, 0, e); commit(before); } }
      else if (act === 'dup' && e) { const c = cleanEl(Object.assign({}, e, { id: '', x: e.x + 5, y: e.y + 5 }), idsSeen()); if (c) { d.els.push(c); sel = c.id; commit(before); } }
      else if (act === 'swap' && e) pickFile(function (id) { e.imgId = id; delete aspect[id]; commit(before); });
      else if (act === 'bgpick') pickFile(function (id) { d.bgImg = id; commit(before); });
      else if (act === 'bgclear') { d.bgImg = ''; commit(before); }
    });
    function idsSeen() { const s = {}; d.els.forEach(function (e) { s[e.id] = 1; }); return s; }
    // 只重畫畫布上的元素（屬性打字中），不重建面板——面板重建會把正在打字的輸入框換掉
    function paintOnly() { renderPaper(); }

    // ---- 上傳 ----
    function pickFile(then) {
      if (!o.onUpload) return;
      fileInp.value = '';
      fileInp.onchange = function () {
        const f = fileInp.files && fileInp.files[0]; if (!f) return;
        Promise.resolve(o.onUpload([f])).then(function (mds) {
          const m = /img:([\w.-]+)/.exec(String((mds && mds[0]) || ''));
          if (!m) { toast('上傳的不是圖片'); return; }
          then(m[1]);
        }, function (err) { toast('上傳失敗：' + (err && err.message || err)); });
      };
      fileInp.click();
    }
    function toast(t) { if (global.App && App.toast) App.toast(t); }

    // ---- 加入 ----
    function nextY() { let y = 30; d.els.forEach(function (e) { if (e.type !== 'rule' && e.type !== 'tlp') y = Math.max(y, e.y + e.h + 4); }); return Math.min(y, PAGE.h - 30); }
    function addEl(type, field) {
      const before = snapshot();
      if (type === 'field') { const have = d.els.find(function (e) { return e.type === 'field' && e.field === field; }); if (have) { select(have.id); return; } }
      if (type === 'tlp') { const have = d.els.find(function (e) { return e.type === 'tlp'; }); if (have) { select(have.id); return; } }
      if (d.els.length >= MAX_ELS) { toast('封面最多 ' + MAX_ELS + ' 個元素'); return; }
      const ink = d.els.find(function (e) { return e.type === 'field' && e.field === 'title'; });
      const base = { x: MARGIN, y: nextY(), w: 162, h: 10, color: ink ? ink.color : '#111111', fs: 12, font: ink ? ink.font : 'sans', align: ink ? ink.align : 'left' };
      let raw;
      if (type === 'field') raw = Object.assign(base, { type: 'field', field: field, h: field === 'title' ? 30 : 8, fs: field === 'title' ? 32 : 12, bold: field === 'title' });
      else if (type === 'text') raw = Object.assign(base, { type: 'text', text: '文字' });
      else if (type === 'rule') raw = Object.assign(base, { type: 'rule', w: 40, h: 1.4, color: ink ? ink.color : '#111111' });
      else if (type === 'tlp') raw = Object.assign(base, { type: 'tlp', x: PAGE.w - 16 - 36, y: 16, w: 36, h: 7, fs: 10, color: '#ffffff', bold: true, align: 'center', font: 'mono' });
      else if (type === 'image') { pickFile(function (id) { const b2 = snapshot(); const e = cleanEl({ type: 'image', imgId: id, x: MARGIN, y: nextY(), w: 50, h: 25 }, idsSeen()); d.els.push(e); sel = e.id; fitImage(e); commit(b2); }); return; }
      const e = cleanEl(raw, idsSeen()); if (!e) return;
      d.els.push(e); sel = e.id; commit(before);
    }
    // 圖片加進來先量自然長寬，把高度改成等比
    function fitImage(e) {
      const img = new Image();
      img.onload = function () { if (!img.naturalWidth) return; aspect[e.imgId] = img.naturalHeight / img.naturalWidth; const cur = byId(e.id); if (cur) { cur.h = Math.round(cur.w * aspect[e.imgId] * 100) / 100; render(); } };
      img.src = '/api/images/' + encodeURIComponent(e.imgId);
    }
    ov.querySelector('.cv-left').addEventListener('click', function (ev) { const b = ev.target.closest('[data-add]'); if (b && !b.disabled) addEl(b.getAttribute('data-add'), b.getAttribute('data-field')); });

    // ---- 拖曳、縮放、輔助線 ----
    let g = null;
    function guidesFor(e) {
      const xs = [0, MARGIN, PAGE.w / 2, PAGE.w - MARGIN, PAGE.w], ys = [0, MARGIN, PAGE.h / 2, PAGE.h - MARGIN, PAGE.h];
      d.els.forEach(function (x) { if (x === e) return; xs.push(x.x, x.x + x.w, x.x + x.w / 2); ys.push(x.y, x.y + x.h, x.y + x.h / 2); });
      return { xs: xs, ys: ys };
    }
    function snapMove(e, nx, ny) {
      const gd = guidesFor(e), T = 1.5, hit = { v: null, h: null };
      const cand = function (list, vals) { let best = null; vals.forEach(function (v) { list.forEach(function (gv) { const dd = Math.abs(v.at - gv); if (dd <= T && (!best || dd < best.d)) best = { d: dd, delta: gv - v.at, line: gv }; }); }); return best; };
      const bx = cand(gd.xs, [{ at: nx }, { at: nx + e.w }, { at: nx + e.w / 2 }]);
      const by = cand(gd.ys, [{ at: ny }, { at: ny + e.h }, { at: ny + e.h / 2 }]);
      if (bx) { nx += bx.delta; hit.v = bx.line; }
      if (by) { ny += by.delta; hit.h = by.line; }
      return { x: nx, y: ny, hit: hit };
    }
    function showGuides(hit) {
      paper.querySelectorAll('.cv-guide').forEach(function (x) { x.remove(); });
      if (hit && hit.v != null) { const v = el('i', 'cv-guide cv-guide-v'); v.style.left = mm2px(hit.v) + 'px'; paper.appendChild(v); }
      if (hit && hit.h != null) { const h = el('i', 'cv-guide cv-guide-h'); h.style.top = mm2px(hit.h) + 'px'; paper.appendChild(h); }
    }
    function applyBox(e) {
      const n = paper.querySelector('.cv-el[data-id="' + e.id + '"]'); if (!n) return;
      n.style.left = mm2px(e.x) + 'px'; n.style.top = mm2px(e.y) + 'px'; n.style.width = mm2px(e.w) + 'px'; n.style.height = mm2px(e.h) + 'px';
    }
    // 鍵盤要落在設計器上：mousedown 有 preventDefault（不然拖曳會選到字），瀏覽器就不會自己移焦點——
    // 列印預覽的 iframe 可能還握著焦點，方向鍵就全跑去那邊了
    stage.tabIndex = -1;
    function takeFocus() { try { stage.focus({ preventScroll: true }); } catch (x) { try { stage.focus(); } catch (y) { /* */ } } }
    paper.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      if (editing) return;
      const hd = ev.target.closest('.cv-h'), node = ev.target.closest('.cv-el');
      if (!node) { if (sel) select(null); takeFocus(); return; }
      const e = byId(node.getAttribute('data-id')); if (!e) return;
      ev.preventDefault();
      // 雙擊在第二次 mousedown 就認（detail 2）：第一次已經選到並重畫過，這時的 node 是活的；
      // 等 dblclick 事件來的時候元素可能已經被重畫換掉（drawio 那邊同一個教訓）
      if (ev.detail >= 2 && e.id === sel && !hd) { startEdit(e, node); return; }
      takeFocus();
      if (e.id !== sel) select(e.id);
      g = { kind: hd ? 'resize' : 'move', h: hd ? hd.getAttribute('data-h') : null, e: e, sx: ev.clientX, sy: ev.clientY, ox: e.x, oy: e.y, ow: e.w, oh: e.h, before: snapshot(), moved: false };
    });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    function onMove(ev) {
      if (!g) return;
      const dx = px2mm(ev.clientX - g.sx), dy = px2mm(ev.clientY - g.sy), e = g.e;
      if (Math.abs(dx) + Math.abs(dy) > 0.2) g.moved = true;
      if (g.kind === 'move') {
        let nx = g.ox + dx, ny = g.oy + dy;
        const s = ev.altKey ? { x: nx, y: ny, hit: null } : snapMove(e, nx, ny);
        e.x = Math.round(clamp(s.x, -e.w + 5, PAGE.w - 5) * 10) / 10; e.y = Math.round(clamp(s.y, -e.h + 5, PAGE.h - 5) * 10) / 10;
        showGuides(s.hit);
      } else {
        const h = g.h; let x = g.ox, y = g.oy, w = g.ow, hh = g.oh;
        if (h.indexOf('e') >= 0) w = g.ow + dx;
        if (h.indexOf('s') >= 0) hh = g.oh + dy;
        if (h.indexOf('w') >= 0) { w = g.ow - dx; x = g.ox + dx; }
        if (h.indexOf('n') >= 0) { hh = g.oh - dy; y = g.oy + dy; }
        const minH = e.type === 'rule' ? 0.2 : 2;
        if (w < 3) { if (h.indexOf('w') >= 0) x = g.ox + g.ow - 3; w = 3; }
        if (hh < minH) { if (h.indexOf('n') >= 0) y = g.oy + g.oh - minH; hh = minH; }
        // 圖片拉角落時等比（Shift 解除）
        if (e.type === 'image' && h.length === 2 && !ev.shiftKey) { const r = aspect[e.imgId] || (g.oh / g.ow); hh = w * r; if (h.indexOf('n') >= 0) y = g.oy + g.oh - hh; }
        e.x = Math.round(x * 10) / 10; e.y = Math.round(y * 10) / 10; e.w = Math.round(w * 10) / 10; e.h = Math.round(hh * 100) / 100;
      }
      applyBox(e);
    }
    function onUp() {
      if (!g) return;
      const gg = g; g = null; showGuides(null);
      if (gg.moved) commit(gg.before);   // 沒動就不重畫：元素留著，雙擊的第二下才認得它
    }
    // 雙擊文字就地改字（欄位型的雙擊 → 跳到右邊的「前綴標籤」）
    function startEdit(e, node) {
      if (e.type !== 'text') { if (e.type === 'field') { const inp = right.querySelector('[data-p="label"]'); if (inp) inp.focus(); } return; }
      const v = node.querySelector('.cv-v'); if (!v) return;
      editing = e.id;
      v.contentEditable = 'true'; v.classList.add('is-editing'); v.focus();
      try { document.execCommand('selectAll', false, null); } catch (x) { /* */ }
      const before = snapshot();
      const done = function () { if (editing !== e.id) return; editing = null; e.text = str(v.textContent, 500); commit(before); if (snapshot() === before) render(); };
      v.addEventListener('blur', done);
      v.addEventListener('keydown', function (k) { k.stopPropagation(); if (k.key === 'Escape') { editing = null; render(); } else if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); v.blur(); } });
    }
    // 每張圖先量自然長寬比（縮放等比用）；起始設計裡的 Logo 是猜的高度，量到了就改成等比
    function probeImages(fitDefault) {
      d.els.forEach(function (e) {
        if (e.type !== 'image' || aspect[e.imgId]) return;
        const img = new Image();
        img.onload = function () {
          if (!img.naturalWidth) return;
          aspect[e.imgId] = img.naturalHeight / img.naturalWidth;
          if (fitDefault) { const cur = byId(e.id); if (cur) { cur.h = Math.round(cur.w * aspect[e.imgId] * 100) / 100; render(); } }
        };
        img.src = '/api/images/' + encodeURIComponent(e.imgId);
      });
    }

    // ---- 鍵盤 ----
    function onKey(ev) {
      if (!document.body.contains(ov)) return;
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) { if (ev.key === 'Escape') { ev.stopPropagation(); t.blur(); } return; }
      ev.stopPropagation();
      const e = selEl();
      if (ev.key === 'Escape') { ev.preventDefault(); if (popEl) closePop(); else if (sel) select(null); else close(); return; }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) { ev.preventDefault(); if (ev.shiftKey) doRedo(); else doUndo(); return; }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); doRedo(); return; }
      if (!e) return;
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'd' || ev.key === 'D')) { ev.preventDefault(); const before = snapshot(); const c = cleanEl(Object.assign({}, e, { id: '', x: e.x + 5, y: e.y + 5 }), idsSeen()); if (c) { d.els.push(c); sel = c.id; commit(before); } return; }
      if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); const before = snapshot(); d.els = d.els.filter(function (x) { return x !== e; }); sel = null; commit(before); return; }
      const step = ev.shiftKey ? 5 : 1;
      const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
      if (mv) { ev.preventDefault(); const before = snapshot(); e.x = Math.round((e.x + mv[0]) * 10) / 10; e.y = Math.round((e.y + mv[1]) * 10) / 10; commit(before); }
    }
    document.addEventListener('keydown', onKey, true);
    function doUndo() { if (!undo.length) return; redo.push(snapshot()); d = clean(JSON.parse(undo.pop())); if (sel && !byId(sel)) sel = null; render(); }
    function doRedo() { if (!redo.length) return; undo.push(snapshot()); d = clean(JSON.parse(redo.pop())); if (sel && !byId(sel)) sel = null; render(); }

    // ---- 上方工具 ----
    ov.querySelector('.cv-tools').addEventListener('click', function (ev) {
      const b = ev.target.closest('[data-a]'); if (!b) return;
      const a = b.getAttribute('data-a');
      if (a === 'undo') doUndo();
      else if (a === 'redo') doRedo();
      else if (a === 'center') { const e = selEl(); if (e) { const before = snapshot(); e.x = Math.round((PAGE.w - e.w) / 2 * 10) / 10; commit(before); } }
      else if (a === 'reset') { const before = snapshot(); d = defaultDesign(ctx.themeId, ctx); sel = null; commit(before); }
      else if (a === 'tpl') templateMenu(b);
    });
    function templateMenu(anchor) {
      closePop();
      const tpls = loadTemplates();
      popEl = el('div', 'tt-menu cv-menu');
      popEl.innerHTML = '<div class="cv-menu-t">從內建樣式開始</div>' +
        themes.map(function (t) { return '<button type="button" class="tt-menu-item" data-cvtheme="' + esc(t.id) + '">' + esc(t.name) + '</button>'; }).join('') +
        '<div class="tt-menu-sep"></div><div class="cv-menu-t">我的範本</div>' +
        (tpls.length ? tpls.map(function (t, i) { return '<div class="cv-menu-row"><button type="button" class="tt-menu-item" data-tpl="' + i + '">' + esc(t.name) + '</button><button type="button" class="cv-menu-x" data-tpldel="' + i + '" title="刪除範本">' + ic('x') + '</button></div>'; }).join('') : '<div class="cv-menu-empty">還沒有範本</div>') +
        '<div class="tt-menu-sep"></div><button type="button" class="tt-menu-item" data-tplsave="1">把目前的設計存成範本…</button>';
      document.body.appendChild(popEl);
      const r = anchor.getBoundingClientRect();
      popEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - popEl.offsetWidth - 8)) + 'px';
      popEl.style.top = Math.min(r.bottom + 4, window.innerHeight - popEl.offsetHeight - 8) + 'px';
      popEl.addEventListener('click', function (ev) {
        // 不能叫 data-theme：closest 會一路走到 <html data-theme>（app.js 的主題屬性），每一下都變成選樣式
        const th = ev.target.closest('[data-cvtheme]'), tp = ev.target.closest('[data-tpl]'), del = ev.target.closest('[data-tpldel]'), sv = ev.target.closest('[data-tplsave]');
        if (th) { closePop(); const before = snapshot(); d = defaultDesign(th.getAttribute('data-cvtheme'), ctx); sel = null; commit(before); }
        else if (del) { const i = +del.getAttribute('data-tpldel'); const list = loadTemplates(); const name = list[i] && list[i].name; closePop(); confirmDlg('刪除範本「' + name + '」？').then(function (yes) { if (!yes) return; list.splice(i, 1); saveTemplates(list); toast('已刪除範本'); }); }
        else if (tp) { closePop(); const t = loadTemplates()[+tp.getAttribute('data-tpl')]; if (!t) return; const before = snapshot(); d = clean(t.design); sel = null; commit(before); }
        else if (sv) { closePop(); promptDlg('範本名稱', '例如：公司報告封面').then(function (name) { name = String(name || '').trim().slice(0, 60); if (!name) return; const list = loadTemplates().filter(function (t) { return t.name !== name; }); list.unshift({ name: name, design: clean(d) }); saveTemplates(list.slice(0, 30)); toast('已存成範本「' + name + '」'); }); }
      });
    }
    function confirmDlg(msg) { return global.App && App.confirm ? App.confirm({ title: '封面範本', message: msg, ok: '刪除', danger: true }) : Promise.resolve(window.confirm(msg)); }
    function promptDlg(title, ph) { return global.App && App.prompt ? App.prompt({ title: title, placeholder: ph, ok: '儲存' }) : Promise.resolve(window.prompt(title)); }

    // ---- 關閉／儲存 ----
    function close() {
      closePop();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (ro) ro.disconnect();
      ov.remove();
    }
    q('.cv-cancel').addEventListener('click', close);
    q('.cv-save').addEventListener('click', function () { const out = clean(d); close(); if (o.onSave) o.onSave(out); });
    q('.cv-revert').addEventListener('click', function () {
      const ask = global.App && App.confirm ? App.confirm({ title: '改回內建封面', message: '丟掉這篇的自訂封面，改回用「樣式」下拉選的內建封面？', ok: '改回內建', danger: true }) : Promise.resolve(window.confirm('改回內建封面？'));
      ask.then(function (yes) { if (!yes) return; close(); if (o.onReset) o.onReset(); });
    });
    let ro = null;
    if (global.ResizeObserver) { ro = new ResizeObserver(function () { const s0 = scale; fitScale(); if (Math.abs(s0 - scale) > 0.01) render(); }); ro.observe(stage); }
    fitScale();
    render();
    probeImages(!(design && design.els));
    try { window.focus(); } catch (x) { /* */ }
    takeFocus();
    return { close: close, get design() { return clean(d); } };
  }

  global.Cover = { clean: clean, isCustom: isCustom, imageIds: imageIds, defaultDesign: defaultDesign, html: html, css: css, open: open, templates: loadTemplates, PAGE: PAGE, FIELDS: FIELDS };
})(window);
