/* pdf.js — paginate a note with paged.js, preview it in-app, then print / save as PDF.
 *
 * The preview renders the very same document that gets printed: it is written into
 * an iframe rather than a popup, so theme and watermark changes can be re-rendered
 * in place instead of spawning a window per attempt.
 */
(function (global) {
  'use strict';

  function baseHref() {
    // Absolute base URL of the app so the print document can load local vendor assets.
    return location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function formatDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // ---------------- themes ----------------
  // Each theme only re-skins the cover and the accent colour; the content rules
  // below are shared so a note paginates identically whichever theme is picked.
  const THEMES = [
    {
      id: 'tech', name: '科技風（淺色）',
      accent: '#0068d6', rule: '#ccd6e0', wm: 'rgba(15, 27, 40, .07)',
      cover: [
        '.pdf-cover { background: #f3f6f9; color: #0f1b28;',
        '  border-left: 10mm solid #0068d6; }',
        '.pdf-cover .kicker { color: #0068d6; }',
        '.pdf-cover h1 { font-weight: 700; }',
        '.pdf-cover .rule { background: #0068d6; }',
        '.pdf-cover .meta { color: #5b6b7c; }',
        '.pdf-cover-logo { background: #fff; border: 1px solid #ccd6e0; }'
      ]
    },
    {
      id: 'blue', name: '經典藍（漸層）',
      accent: '#1f6feb', rule: '#d0d7de', wm: 'rgba(31, 35, 40, .08)',
      cover: [
        '.pdf-cover { background: linear-gradient(135deg, #1f6feb 0%, #0b3d91 100%); color: #fff; }',
        '.pdf-cover .kicker { opacity: .8; }',
        '.pdf-cover .rule { background: #fff; opacity: .8; }',
        '.pdf-cover .meta { opacity: .9; }',
        '.pdf-cover-logo { background: #fff; }'
      ]
    },
    {
      id: 'mono', name: '極簡黑白',
      accent: '#111111', rule: '#cccccc', wm: 'rgba(0, 0, 0, .07)',
      cover: [
        '.pdf-cover { background: #fff; color: #111; border-top: 3pt solid #111;',
        '  border-bottom: 3pt solid #111; }',
        '.pdf-cover .kicker { color: #666; }',
        '.pdf-cover h1 { font-weight: 700; }',
        '.pdf-cover .rule { background: #111; }',
        '.pdf-cover .meta { color: #555; }',
        '.pdf-cover-logo { background: #fff; border: 1px solid #ddd; }'
      ]
    },
    {
      id: 'dark', name: '深色封面',
      accent: '#1f6feb', rule: '#d0d7de', wm: 'rgba(15, 27, 40, .08)',
      cover: [
        '.pdf-cover { background: #0b1017; color: #e8f1fb; }',
        '.pdf-cover .kicker { color: #3d9bff; }',
        '.pdf-cover .rule { background: #3d9bff; }',
        '.pdf-cover .meta { color: #8496a8; }',
        '.pdf-cover-logo { background: #fff; }'
      ]
    },
    {
      id: 'red', name: '紅隊（暗紅）',
      accent: '#c62828', rule: '#e0cccc', wm: 'rgba(120, 20, 25, .09)',
      cover: [
        '.pdf-cover { background: linear-gradient(160deg, #1b0508 0%, #4a0d15 100%); color: #ffe9ea;',
        '  border-left: 10mm solid #c62828; }',
        '.pdf-cover .kicker { color: #ff6b6b; }',
        '.pdf-cover h1 { font-weight: 800; }',
        '.pdf-cover .rule { background: #c62828; }',
        '.pdf-cover .meta { color: #d9a3a6; }',
        '.pdf-cover-logo { background: #fff; }'
      ]
    },
    {
      id: 'corporate', name: '企業襯線（白底）',
      accent: '#1a4d8f', rule: '#d5dce5', wm: 'rgba(26, 77, 143, .08)',
      cover: [
        '.pdf-cover { background: #fff; color: #14243a; justify-content: flex-start;',
        '  padding-top: 60mm; border-bottom: 16mm solid #1a4d8f; }',
        '.pdf-cover .kicker { color: #1a4d8f; font-size: 10pt; }',
        '.pdf-cover h1 { font-size: 30pt; font-weight: 400; letter-spacing: .01em;',
        '  font-family: Georgia, "Times New Roman", "Noto Serif CJK TC", "Songti TC", "PMingLiU", serif; }',
        '.pdf-cover .rule { background: #1a4d8f; height: 2pt; width: 90pt; }',
        '.pdf-cover .meta { color: #5a6c85;',
        '  font-family: Georgia, "Times New Roman", "Noto Serif CJK TC", "Songti TC", "PMingLiU", serif; }',
        '.pdf-cover-logo { background: #fff; border: 1px solid #d5dce5; }'
      ]
    },
    {
      id: 'terminal', name: '終端機（等寬綠字）',
      accent: '#12813f', rule: '#cfd8d2', wm: 'rgba(10, 40, 20, .08)',
      cover: [
        '.pdf-cover { background: #05080a; color: #7ee787;',
        '  background-image: repeating-linear-gradient(0deg, rgba(126,231,135,.05) 0 1px, transparent 1px 4px); }',
        '.pdf-cover .kicker { color: #3fb950; letter-spacing: .18em;',
        '  font-family: "SFMono-Regular", Consolas, monospace; }',
        '.pdf-cover .kicker::before { content: "> "; }',
        '.pdf-cover h1 { font-size: 28pt; font-weight: 700;',
        '  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }',
        '.pdf-cover .rule { background: #3fb950; }',
        '.pdf-cover .meta { color: #6e9a76; font-family: "SFMono-Regular", Consolas, monospace; }',
        '.pdf-cover-logo { background: #fff; }'
      ]
    },
    {
      id: 'teal', name: '青綠漸層',
      accent: '#0a7ea4', rule: '#cfe0e6', wm: 'rgba(10, 78, 92, .08)',
      cover: [
        '.pdf-cover { background: linear-gradient(135deg, #0a7ea4 0%, #05323f 100%); color: #eafcff; }',
        '.pdf-cover .kicker { color: #7fdbe8; }',
        '.pdf-cover .rule { background: #7fdbe8; }',
        '.pdf-cover .meta { color: #a9d8e2; }',
        '.pdf-cover-logo { background: #fff; }'
      ]
    },
    {
      id: 'blueprint', name: '藍圖格線',
      accent: '#0d3b66', rule: '#ccd8e4', wm: 'rgba(13, 59, 102, .09)',
      cover: [
        '.pdf-cover { background: #0d3b66; color: #eaf3ff;',
        '  background-image: repeating-linear-gradient(0deg, rgba(255,255,255,.13) 0 1px, transparent 1px 10mm),',
        '                    repeating-linear-gradient(90deg, rgba(255,255,255,.13) 0 1px, transparent 1px 10mm); }',
        '.pdf-cover .kicker { color: #9ec5ef; font-family: "SFMono-Regular", Consolas, monospace; }',
        '.pdf-cover h1 { font-weight: 700; }',
        '.pdf-cover .rule { background: #eaf3ff; }',
        '.pdf-cover .meta { color: #b9d3ee; font-family: "SFMono-Regular", Consolas, monospace; }',
        '.pdf-cover-logo { background: #fff; }'
      ]
    },
    {
      id: 'frame', name: '框線（正式）',
      accent: '#333333', rule: '#d4d4d4', wm: 'rgba(0, 0, 0, .06)',
      cover: [
        '.pdf-cover { background: #fff; color: #1a1a1a; align-items: center; text-align: center;',
        '  outline: 1pt solid #1a1a1a; outline-offset: -14mm;',
        '  border: 4pt double #1a1a1a; }',
        '.pdf-cover .kicker { color: #777; }',
        '.pdf-cover h1 { font-size: 28pt; font-weight: 600;',
        '  font-family: Georgia, "Times New Roman", "Noto Serif CJK TC", "Songti TC", "PMingLiU", serif; }',
        '.pdf-cover .rule { background: #1a1a1a; height: 1pt; width: 120pt; }',
        '.pdf-cover .meta { color: #555; }',
        '.pdf-cover-logo { background: #fff; align-self: center; border: 1px solid #e0e0e0; }'
      ]
    },
    {
      id: 'amber', name: '琥珀（暖色）',
      accent: '#a56a09', rule: '#e8dcc4', wm: 'rgba(120, 80, 10, .08)',
      cover: [
        '.pdf-cover { background: #fdf6e7; color: #3d2c0a;',
        '  border-top: 12mm solid #a56a09; }',
        '.pdf-cover .kicker { color: #a56a09; }',
        '.pdf-cover h1 { font-weight: 700; }',
        '.pdf-cover .rule { background: #a56a09; }',
        '.pdf-cover .meta { color: #7a6435; }',
        '.pdf-cover-logo { background: #fff; border: 1px solid #e8dcc4; }'
      ]
    }
  ];
  function themeById(id) {
    return THEMES.filter(function (t) { return t.id === id; })[0] || THEMES[0];
  }

  const WATERMARK_PRESETS = ['DRAFT', 'CONFIDENTIAL', 'INTERNAL USE ONLY'];

  // FIRST's TLP 2.0 標準配色：一律黑底，文字顏色代表等級。
  // `color` is the official on-black badge colour used on the cover. `ink` is for
  // the page header, which prints straight onto white paper — a page margin box
  // fills its entire area, so giving it a black background paints a slab across
  // the top of every page. TLP:CLEAR therefore needs black ink, not white.
  const TLP = [
    { id: '', label: '無' },
    { id: 'TLP:CLEAR', label: 'TLP:CLEAR', color: '#ffffff', ink: '#111111' },
    { id: 'TLP:GREEN', label: 'TLP:GREEN', color: '#33ff00', ink: '#0f7a1e' },
    { id: 'TLP:AMBER', label: 'TLP:AMBER', color: '#ffc000', ink: '#a06b00' },
    { id: 'TLP:AMBER+STRICT', label: 'TLP:AMBER+STRICT', color: '#ffc000', ink: '#a06b00' },
    { id: 'TLP:RED', label: 'TLP:RED', color: '#ff2b2b', ink: '#d40b12' }
  ];
  function tlpById(id) { return TLP.filter(function (t) { return t.id === id; })[0] || TLP[0]; }

  const RISK_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
  /* ---- 列印色票：直接讀 app.css，不再自己抄一份 -----------------------------
     app.css 裡的 --sev-*-ink/-tint/-line、--co-*-ink/-tint 與 --k-*-ink 是「紙本」
     權威值，任何主題都不覆寫它們，所以不管使用者現在開的是淺色還是深色主題，從
     活著的文件上讀到的都是同一組顏色。
     這取代了原本寫死的那張表：它的 critical 是 #a01019、螢幕上卻是 #a5192a，兩份
     手抄的值早就對不上了。現在要改色，只有 app.css 一個地方能改。
     每個 token 都給 fallback，萬一樣式表還沒解析完也不會印出空字串。 */
  const SEV_VAR = { critical: 'crit', high: 'high', medium: 'med', low: 'low', info: 'info' };
  const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'];
  const KALI_KINDS = ['cmd', 'kw', 'str', 'var', 'num', 'com', 'meta'];
  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    const v = function (name, fb) {
      const got = String(cs.getPropertyValue(name) || '').trim();
      return got || fb;
    };
    const risk = {};
    RISK_ORDER.forEach(function (lvl) {
      const k = SEV_VAR[lvl];
      risk[lvl] = {
        fg: v('--sev-' + k + '-ink', '#5a6675'),
        bg: v('--sev-' + k + '-tint', '#f1f3f6'),
        border: v('--sev-' + k + '-line', '#d5dae2')
      };
    });
    const callout = {};
    CALLOUT_KINDS.forEach(function (n) {
      callout[n] = { fg: v('--co-' + n + '-ink', '#5a6675'), bg: v('--co-' + n + '-tint', '#f1f3f6') };
    });
    const kali = {};
    KALI_KINDS.forEach(function (n) { kali[n] = v('--k-' + n + '-ink', '#24292f'); });
    return { risk: risk, callout: callout, kali: kali };
  }

  // Findings summary: severity-ordered table whose page numbers resolve through
  // the same target-counter() mechanism the TOC uses.
  function buildFindingsSummary(clone) {
    const items = MD.extractFindings(clone);
    if (!items.length) return '';
    items.sort(function (a, b) { return a.rank - b.rank || a.no - b.no; });
    const counts = {};
    items.forEach(function (f) { counts[f.level] = (counts[f.level] || 0) + 1; });

    let html = '<section class="pdf-summary"><h1 class="summary-heading">Findings Summary</h1>';
    html += '<div class="summary-counts">';
    RISK_ORDER.forEach(function (lvl) {
      if (!counts[lvl]) return;
      html += '<span class="sc sc-' + lvl + '"><b>' + counts[lvl] + '</b> ' +
        MD.escapeHtml(MD.riskLevels[lvl].label) + '</span>';
    });
    html += '</div>';
    html += '<table class="summary-table"><thead><tr>' +
      '<th class="c-no">#</th><th class="c-sev">Severity</th>' +
      '<th class="c-title">Finding</th><th class="c-page">Page</th>' +
      '</tr></thead><tbody>';
    items.forEach(function (f) {
      html += '<tr>' +
        '<td class="c-no">F-' + (f.no < 10 ? '0' + f.no : f.no) + '</td>' +
        '<td class="c-sev"><span class="sev sev-' + f.level + '">' +
        MD.escapeHtml(f.label.toUpperCase()) + '</span></td>' +
        '<td class="c-title"><a href="#' + f.id + '">' + MD.escapeHtml(f.title) + '</a></td>' +
        '<td class="c-page"><a class="pageref" href="#' + f.id + '"></a></td>' +
        '</tr>';
    });
    html += '</tbody></table></section>';
    return html;
  }

  function buildTOC(headings) {
    // Only include h1-h3 in the TOC to keep it clean.
    const items = headings.filter(function (h) { return h.level <= 3 && h.id; });
    if (!items.length) return '';
    // Section numbers (1 / 1.1 / 1.1.1) are derived here rather than with CSS
    // counters so the same string can be reused by an index later on.
    const ctr = [0, 0, 0];
    let html = '<nav class="pdf-toc">' +
      '<div class="toc-kicker">Contents</div>' +
      '<h1 class="toc-heading">Table of Contents</h1>' +
      '<div class="toc-rule"></div>' +
      '<ol class="toc">';
    items.forEach(function (h) {
      const lv = h.level - 1;
      ctr[lv]++;
      for (let i = lv + 1; i < 3; i++) ctr[i] = 0;
      const num = ctr.slice(0, lv + 1).join('.');
      html += '<li class="toc-l' + h.level + '">' +
        '<a href="#' + h.id + '">' +
        '<span class="toc-num">' + num + '</span>' +
        '<span class="toc-text">' + MD.escapeHtml(h.text) + '</span>' +
        '<span class="toc-leader"></span>' +
        '</a></li>';
    });
    html += '</ol></nav>';
    return html;
  }

  // A CSS string literal — quotes and backslashes would otherwise break out of content:"".
  function cssString(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  // paged.js renders each sheet as a .pagedjs_page element, so the watermark is a
  // pseudo-element on those rather than an @page background (which browsers ignore).
  //
  // This CSS is injected only once paged.js has finished laying out — it rewrites
  // the stylesheets it is given, and drops the :first-of-type exclusion on the way
  // through, which stamped the watermark across the cover too.
  function watermarkCSS(text, theme) {
    if (!text) return '';
    return [
      '.pagedjs_page { position: relative; }',
      '.pagedjs_page::after {',
      '  content: ' + cssString(text) + ';',
      '  position: absolute; top: 50%; left: 50%;',
      '  transform: translate(-50%, -50%) rotate(-35deg);',
      '  font-size: 64pt; font-weight: 800; letter-spacing: .06em; white-space: nowrap;',
      '  color: ' + theme.wm + '; pointer-events: none; z-index: 400;',
      '  -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
      /* the cover has its own artwork — stamping it there just muddies the design */
      '.pagedjs_page:first-of-type::after { content: none; }'
    ].join('\n');
  }

  // Print CSS driving paged.js pagination, cover, TOC leaders, page numbers.
  function printCSS(title, theme, opts) {
    const safe = String(title).replace(/["\\]/g, '');
    const tlp = tlpById(opts.tlp);
    const pal = readPalette();
    const tlpHeader = tlp.id
      ? '  @top-left { content: "' + tlp.id.replace(/["\\]/g, '') + '"; font-size: 8pt;' +
        ' font-weight: 700; letter-spacing: .04em; color: ' + tlp.ink + '; }'
      : '';
    return [
      ':root { --pdf-accent: ' + theme.accent + '; --pdf-rule: ' + theme.rule + '; }',
      '@page {',
      '  size: A4;',
      '  margin: 22mm 20mm 20mm 20mm;',
      '  @bottom-center { content: counter(page); font-size: 9pt; color: #888; }',
      '  @top-right { content: "' + safe + '"; font-size: 8pt; color: #bbb; }',
      tlpHeader,
      '}',
      '@page cover { margin: 0; @top-right { content: none; } @bottom-center { content: none; }',
      '  @top-left { content: none; } }',
      '@page toc { @top-right { content: none; } @bottom-center { content: none; } }',
      /* optional:每個 H1 大章節從新的一頁開始（第一個除外，否則會多一張空白頁） */
      (opts.breakH1 ? '.pdf-content h1 { break-before: page; }' : ''),
      (opts.breakH1 ? '.pdf-content > h1:first-child { break-before: avoid; }' : ''),
      /* 資安院報告（opts.stepPages）：一步一頁。每個「## 步驟 N」都從新的一頁開始，
         所以每一步都是從頁首寫起——這同時也是「不要切到」的作法：一步只有在它本身
         比一整頁還高的時候才會被切開，其餘情況自然整步待在同一頁。
         刻意「不」用 break-inside: avoid 把整步框起來：paged.js 對高過一頁的
         break-inside:avoid 區塊沒有退路，它會把超出頁面的部分直接不畫出來（見下面
         程式碼區塊那段說明）。報告是評分證據，寧可讓長步驟分頁，也不能默默吞掉內容。
         圖片另外給一個高度上限：可列印高度是 A4 297mm 減去上下邊界 42mm＝255mm，
         留給標題與描述文字之後，200mm 讓一張整頁截圖仍舊完整落在同一頁裡，
         而不是跨頁被切成兩半（max-width 已經在，兩個一起用會等比例縮）。 */
      (opts.stepPages ? '.pdf-content.pdf-steps h2 { break-before: page; }' : ''),
      (opts.stepPages ? '.pdf-content.pdf-steps > h2:first-child { break-before: avoid; }' : ''),
      (opts.stepPages ? '.pdf-content.pdf-steps img { max-height: 200mm; }' : ''),
      'html, body { margin: 0; padding: 0; }',
      // Same stack as the app. The print document carries a <base href> pointing
      // at the app origin, so vendor/fonts/ resolves and the PDF matches the screen.
      'body { font-family: "Inter", "Noto Sans TC", -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif;',
      '  color: #24292f; font-size: 11pt; line-height: 1.7;',
      '  -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
      /* cover — the skin comes from the theme block appended below */
      '.pdf-cover { page: cover; break-after: page; height: 100vh; display: flex;',
      '  flex-direction: column; justify-content: center; align-items: flex-start;',
      '  padding: 40mm 24mm; box-sizing: border-box; }',
      '.pdf-cover-logo { max-height: 78pt; max-width: 60%; margin-bottom: 22pt;',
      '  padding: 8pt 12pt; border-radius: 0; align-self: flex-start; }',
      '.pdf-cover .kicker { font-size: 12pt; letter-spacing: .3em; text-transform: uppercase; }',
      '.pdf-cover h1 { font-size: 34pt; line-height: 1.2; margin: 14pt 0 0; border: 0; }',
      '.pdf-cover .meta { margin-top: 28pt; font-size: 11pt; }',
      /* fixed label column so the two dates line up despite unequal label lengths */
      '.pdf-cover .meta .k { display: inline-block; min-width: 96pt; letter-spacing: .04em;',
      '  text-transform: uppercase; font-size: 9pt; opacity: .75; }',
      '.pdf-cover .meta .v { font-variant-numeric: tabular-nums; }',
      '.pdf-cover .rule { width: 60pt; height: 4pt; margin: 18pt 0; }',
      /* toc */
      '.pdf-toc { page: toc; break-after: page; }',
      /* restart page numbering at the first content page (cover + toc are not counted) */
      '.pdf-content { counter-reset: page 1; }',
      /* TOC page: kicker + title + accent rule (echoes the cover), then a
         numbered outline. Level-1 entries are separated by hairlines, deeper
         levels indent under the number column; page numbers sit in a fixed
         right column so they line up down the page. */
      '.toc-kicker { font-size: 9pt; font-weight: 700; letter-spacing: .3em; text-transform: uppercase;',
      '  color: var(--pdf-accent); }',
      '.toc-heading { font-size: 24pt; margin: 4pt 0 0; padding: 0; border: 0; letter-spacing: -.01em; }',
      '.toc-rule { width: 60pt; height: 4pt; background: var(--pdf-accent); margin: 12pt 0 20pt; }',
      'ol.toc { list-style: none; padding: 0; margin: 0; }',
      'ol.toc li { margin: 0; break-inside: avoid; }',
      'ol.toc a { display: flex; align-items: baseline; text-decoration: none; color: #24292f;',
      '  padding: 4pt 0; font-size: 11pt; line-height: 1.4; }',
      'ol.toc .toc-num { flex: 0 0 auto; width: 34pt; font-family: "SFMono-Regular", Consolas, monospace;',
      '  font-size: 9.5pt; color: var(--pdf-accent); font-variant-numeric: tabular-nums; }',
      'ol.toc .toc-text { flex: 0 1 auto; }',
      'ol.toc .toc-leader { flex: 1 1 auto; min-width: 16pt; margin: 0 6pt; border-bottom: 1px dotted #c3c9d0;',
      '  transform: translateY(-3pt); }',
      'ol.toc a::after { content: target-counter(attr(href), page); flex: 0 0 auto; min-width: 22pt;',
      '  text-align: right; font-family: "SFMono-Regular", Consolas, monospace; font-size: 10pt;',
      '  color: #57606a; font-variant-numeric: tabular-nums; }',
      'ol.toc .toc-l1 { margin-top: 8pt; padding-top: 6pt; border-top: 1px solid var(--pdf-rule); }',
      'ol.toc .toc-l1:first-child { margin-top: 0; padding-top: 0; border-top: 0; }',
      'ol.toc .toc-l1 > a { font-weight: 700; font-size: 12pt; }',
      'ol.toc .toc-l1 > a::after { color: #24292f; font-weight: 700; }',
      'ol.toc .toc-l2 > a { padding-left: 34pt; }',
      'ol.toc .toc-l2 > a .toc-num { width: 40pt; color: #57606a; }',
      'ol.toc .toc-l3 > a { padding-left: 74pt; font-size: 10pt; color: #57606a; }',
      'ol.toc .toc-l3 > a .toc-num { width: 46pt; color: #8b949e; }',
      /* content — mirror the on-screen markdown-body but tuned for print */
      '.pdf-content h1, .pdf-content h2 { border-bottom: 1px solid var(--pdf-rule); padding-bottom: 4pt; }',
      '.pdf-content h1 { font-size: 20pt; margin: 22pt 0 10pt; }',
      '.pdf-content h2 { font-size: 16pt; margin: 20pt 0 8pt; }',
      '.pdf-content h3 { font-size: 13pt; margin: 16pt 0 6pt; }',
      '.pdf-content h1, .pdf-content h2, .pdf-content h3 { break-after: avoid; }',
      '.pdf-content a { color: var(--pdf-accent); text-decoration: none; }',
      '.pdf-content p, .pdf-content li { orphans: 2; widows: 2; }',
      '.pdf-content img { max-width: 100%; }',
      '.pdf-content .code-block { position: relative; margin: 0 0 10pt; }',
      '.pdf-content .code-block .code-tools { position: absolute; top: 0; right: 0; }',
      '.pdf-content .code-copy, .pdf-content .img-tools, .pdf-content .mm-edit-btn,' +
      ' .pdf-content .mm-hint, .pdf-content .rm-edit-btn { display: none; }',
      /* 圖片黑框（markdown 裡的 img:<id>#frame）。列印文件沒有畫面上的 CSS 變數，
         一律純黑——本來就是為了紙上的白底截圖才有這個功能。 */
      '.pdf-content img.img-framed { border: 1px solid #000; }',
      /* 心智圖：節點的底色與字色在畫面上是靠 CSS 變數決定的，列印文件裡沒有那些
         變數，不補這幾行的話 fill 會失效變成整塊黑。 */
      '.pdf-content .mindmap-block { border: 1px solid #d0d7de; padding: 8pt; margin: 0 0 12pt;',
      '  break-inside: avoid; overflow: hidden; }',
      '.pdf-content .mm-svg { display: block; max-width: 100%; height: auto; }',
      '.pdf-content .mm-rect { fill: #ffffff; }',
      '.pdf-content .mm-rect-root { fill: #1f2430; stroke: #1f2430; }',
      '.pdf-content .mm-text { fill: #1f2430; }',
      '.pdf-content .mm-text-root { fill: #ffffff; }',
      '.pdf-content .mm-badge-t { fill: #ffffff; }',
      /* 關聯分析：螢幕上是深色畫布（app.css 的 --rm-*），紙本換白底、深字，節點／連線的
         顏色 class（.rm-<色名>／.rm-auto-k／.rm-e<k>）在這裡整批重新指定一次固定值。 */
      '.pdf-content .relmap-block { border: 1px solid #d0d7de; background: #ffffff; padding: 8pt; margin: 0 0 12pt;',
      '  break-inside: avoid; overflow: hidden; }',
      '.pdf-content .relmap-svg { display: block; max-width: 100%; height: auto; }',
      /* 嵌入別篇關聯分析（![名稱](relmap:id)）：紙上是一張靜態圖，工具列拿掉，
         螢幕上那個固定高度的取景框也要放開成自動高度，不然只印得到框裡那一截。 */
      '.pdf-content .relmap-embed { border: 1px solid #d0d7de; background: #ffffff; margin: 0 0 12pt;',
      '  break-inside: avoid; overflow: hidden; }',
      '.pdf-content .relmap-embed-bar { display: none; }',
      '.pdf-content .relmap-embed-canvas { display: block; height: auto; padding: 8pt; }',
      '.pdf-content .relmap-embed-canvas .relmap-svg { width: auto; height: auto; }',
      '.pdf-content .rm-node .rm-disc { fill: #ffffff; stroke: #57606a; stroke-width: 2; }',
      '.pdf-content .rm-node .rm-mono { fill: #57606a; }',
      '.pdf-content .rm-node .rm-lbl { fill: #1f2430; stroke: #ffffff; }',
      '.pdf-content .rm-edge .rm-line { stroke: #8a5a1e; stroke-width: 1.4; stroke-dasharray: 5 3; opacity: 1; }',
      '.pdf-content .rm-edge-lbg { fill: #ffffff; stroke: #d0d7de; }',
      '.pdf-content .rm-edge-lbl { fill: #57606a; }',
      '.pdf-content .rm-arrowhead { fill: context-stroke; }',
      /* drawio 圖表：一張 SVG。高度壓在一頁以內，外框才敢用 break-inside: avoid——
         paged.js 碰到比一頁還高的 avoid 區塊不會切，是直接不印（見上面 pre 那段說明）。 */
      '.pdf-content .drawio-block, .pdf-content .drawio-embed { border: 1px solid #d0d7de; background: #ffffff;',
      '  margin: 0 0 12pt; padding: 8pt; text-align: center; break-inside: avoid; overflow: hidden; }',
      '.pdf-content .drawio-embed-bar { display: none; }',
      '.pdf-content .drawio-embed-canvas { display: block; padding: 0; }',
      '.pdf-content .dio-svg, .pdf-content .drawio-img { display: block; margin: 0 auto; max-width: 100%; max-height: 225mm; width: auto; height: auto; }',
      /* 多頁的圖：每一頁連著頁名一起不切開 */
      '.pdf-content .dio-pg { break-inside: avoid; margin: 0 0 5mm; }',
      '.pdf-content .dio-pg-t { margin: 0 0 2mm; font-size: 9pt; font-weight: 600; color: #57606a; text-align: left; }',
      '.pdf-content .dio-pg-empty { font-size: 9pt; color: #8c959f; }',
      /* 看板（```board，js/board.js 的 blockHTML）：靜態的列表與卡片；app.css 到不了列印文件，顏色在這裡重寫 */
      '.pdf-content .kbs-board { display: flex; align-items: flex-start; gap: 3mm; padding: 3mm; border-radius: 2mm; overflow: hidden; flex-wrap: wrap; }',
      '.pdf-content .kbs-list { flex: 0 0 58mm; background: #f1f2f4; border-radius: 2mm; padding: 2mm; break-inside: avoid; }',
      '.pdf-content .kbs-list-t { font-weight: 700; font-size: 9.5pt; color: #172b4d; margin: 0 0 1.5mm 1mm; }',
      '.pdf-content .kbs-n { color: #626f86; font-weight: 400; }',
      '.pdf-content .kbs-card { background: #fff; border-radius: 1.5mm; padding: 1.5mm 2mm; margin: 0 0 1.5mm; font-size: 8.5pt; box-shadow: 0 0 0 .2mm #d0d4db; }',
      '.pdf-content .kbs-labels { display: flex; flex-wrap: wrap; gap: 1mm; margin-bottom: 1mm; }',
      '.pdf-content .kbs-label { display: inline-block; min-width: 8mm; height: 3.5mm; line-height: 3.5mm; padding: 0 1.5mm; border-radius: 1mm; font-size: 7pt; font-weight: 600; }',
      '.pdf-content .kbs-title { color: #172b4d; }',
      '.pdf-content .kbs-badges { display: flex; flex-wrap: wrap; gap: 1.5mm; margin-top: 1mm; font-size: 7.5pt; color: #44546f; }',
      '.pdf-content .kbs-badge { display: inline-flex; align-items: center; gap: .7mm; }',
      '.pdf-content .kbs-badge .ic-svg { width: 3mm; height: 3mm; }',
      '.pdf-content .kbs-due.is-over { color: #ae2e24; } .pdf-content .kbs-due.is-soon { color: #7f5f01; } .pdf-content .kbs-due.is-done, .pdf-content .kbs-badge.is-done { color: #216e4e; }',
      '.pdf-content .kbs-desc { margin-top: 1mm; font-size: 7.5pt; color: #44546f; }',
      '.pdf-content .kbs-check { list-style: none; margin: 1mm 0 0; padding: 0; font-size: 7.5pt; color: #172b4d; }',
      '.pdf-content .kbs-check li { display: flex; align-items: center; gap: 1mm; } .pdf-content .kbs-check li.is-done { color: #626f86; text-decoration: line-through; }',
      '.pdf-content .kbs-check .ic-svg { width: 3mm; height: 3mm; }',
      '.pdf-content .kbs-board.is-empty { background: #f6f8fa; color: #626f86; justify-content: center; font-size: 9pt; }',
      /* 文件（js/doc.js）的分頁符號、目錄、程式碼區塊，筆記裡若貼了這些 HTML 也照樣印 */
      '.pdf-content .gd-pagebreak { break-after: page; height: 0; margin: 0; border: 0; visibility: hidden; }',
      '.pdf-content pre.gd-code { position: relative; font-family: "Courier New", Consolas, monospace; font-size: 9pt; line-height: 1.45; tab-size: 4; background: #f1f3f4; border: 1px solid #dadce0; padding: 2mm 3mm; white-space: pre-wrap; }',
      (global.Doc && Doc.codePrintCSS) ? Doc.codePrintCSS('.pdf-content') : '',   // 行號欄與上色（doc.js 的 staticCode 產生的 .gd-cl／.gd-t-*）
      /* 課程進度（```progress，js/progress.js 的 blockHTML）：進度條加章節清單 */
      '.pdf-content .pgs { border: 1px solid #d0d7de; border-radius: 2mm; margin: 0 0 5mm; break-inside: avoid; font-size: 9pt; }',
      '.pdf-content .pgs-head { display: flex; align-items: center; gap: 2mm; padding: 2mm 3mm; border-bottom: 1px solid #d0d7de; } .pdf-content .pgs-head i { width: 3mm; height: 3mm; border-radius: 50%; display: inline-block; } .pdf-content .pgs-head span { color: #57606a; font-size: 8pt; }',
      '.pdf-content .pgs-bar { height: 2.5mm; background: #eaeef2; } .pdf-content .pgs-bar i { display: block; height: 100%; }',
      '.pdf-content .pgs-list { list-style: none; margin: 0; padding: 1.5mm 3mm; } .pdf-content .pgs-list li { display: flex; align-items: center; gap: 2mm; padding: 1mm 0; border-bottom: 1px dashed #e1e4e8; } .pdf-content .pgs-list li:last-child { border-bottom: 0; }',
      '.pdf-content .pgs-chk { display: inline-flex; color: #57606a; } .pdf-content .pgs-chk .ic-svg { width: 3.5mm; height: 3.5mm; } .pdf-content .pgs-list li.is-done .pgs-chk { color: #17934f; } .pdf-content .pgs-list li.is-done .pgs-t { color: #8c959f; text-decoration: line-through; }',
      '.pdf-content .pgs-t { flex: 1 1 auto; } .pdf-content .pgs-due { font-size: 8pt; color: #57606a; } .pdf-content .pgs-list li.is-overdue .pgs-due { color: #cf222e; }',
      /* 行事曆（```timetree，js/timetree.js 的 blockHTML）：月曆格線加行程清單 */
      '.pdf-content .tts { border: 1px solid #d0d7de; border-radius: 2mm; margin: 0 0 5mm; break-inside: avoid; font-size: 8.5pt; }',
      '.pdf-content .tts-head { display: flex; align-items: center; gap: 2mm; padding: 2mm 3mm; border-bottom: 1px solid #d0d7de; } .pdf-content .tts-head i { width: 3mm; height: 3mm; border-radius: 50%; display: inline-block; } .pdf-content .tts-head span { color: #57606a; font-size: 7.5pt; }',
      '.pdf-content .tts-wd { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; font-size: 7.5pt; color: #57606a; padding: 1mm 0; border-bottom: 1px solid #d0d7de; }',
      '.pdf-content .tts-week { position: relative; display: grid; grid-template-columns: repeat(7, 1fr); min-height: 22mm; border-bottom: 1px solid #e1e4e8; }',
      '.pdf-content .tts-day { border-right: 1px solid #e1e4e8; padding: 1mm; } .pdf-content .tts-day:last-child { border-right: 0; } .pdf-content .tts-day.is-other { background: #f6f8fa; color: #8c959f; }',
      '.pdf-content .tts-num { font-weight: 600; } .pdf-content .tts-day.is-sun .tts-num { color: #e5493a; } .pdf-content .tts-day.is-sat .tts-num { color: #3b7ddd; }',
      '.pdf-content .tts-more { position: absolute; left: 1mm; bottom: 0; font-size: 7pt; color: #57606a; }',
      '.pdf-content .tts-bar { position: absolute; height: 4.6mm; line-height: 4.6mm; margin: 0 .5mm; padding: 0 1.5mm; border-radius: 1mm; font-size: 7.5pt; color: #fff; background: var(--c); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }',
      '.pdf-content .tts-bar:not(.is-allday) { background: transparent; color: #24292f; } .pdf-content .tts-bar:not(.is-allday) i { display: inline-block; width: 2mm; height: 2mm; border-radius: 50%; background: var(--c); margin-right: 1mm; } .pdf-content .tts-bar-t { color: #57606a; margin-right: 1mm; }',
      '.pdf-content .tts-agenda { padding: 2mm 3mm 3mm; } .pdf-content .tts-agenda-t { font-size: 7.5pt; font-weight: 700; color: #57606a; margin: 1mm 0; }',
      '.pdf-content .tts-agenda-day { display: flex; align-items: center; gap: 2mm; margin: 2mm 0 1mm; } .pdf-content .tts-agenda-day b { font-size: 10pt; } .pdf-content .tts-agenda-day span { font-size: 7.5pt; color: #57606a; }',
      '.pdf-content .tts-agenda-row { display: flex; align-items: center; gap: 2mm; padding: .8mm 1mm; } .pdf-content .tts-agenda-row i { width: 2.2mm; height: 2.2mm; border-radius: 50%; flex: 0 0 auto; } .pdf-content .tts-agenda-time { flex: 0 0 22mm; color: #57606a; font-size: 7.5pt; } .pdf-content .tts-agenda-loc { color: #57606a; font-size: 7.5pt; } .pdf-content .tts-agenda-loc .ic-svg { width: 2.5mm; height: 2.5mm; }',
      '.pdf-content .tts-empty { padding: 3mm; text-align: center; color: #8c959f; }',
      /* 心智圖（```xmind，js/xmind.js 的 blockHTML）：一張 SVG，太高就縮到一頁內；多張工作表各自一塊 */
      '.pdf-content .xmind-block { margin: 0 0 5mm; }',
      '.pdf-content .xmind-block svg { display: block; max-width: 100%; height: auto; max-height: 225mm; border-radius: 2mm; }',
      '.pdf-content .xm-fig { break-inside: avoid; margin: 0 0 5mm; }',
      '.pdf-content .xm-fig-t { margin: 0 0 2mm; font-size: 9pt; font-weight: 600; color: #57606a; text-align: left; }',
      /* 起始頁（```startpage，js/startpage.js 的 blockHTML）：幾欄小工具與書籤 */
      '.pdf-content .sps-page { display: grid; gap: 3mm; padding: 3mm; border-radius: 2mm; }',
      '.pdf-content .sps-page.is-dark { color: #e6e9ef; }',
      '.pdf-content .sps-widget { background: #fff; border-radius: 1.5mm; padding: 2mm; margin: 0 0 3mm; box-shadow: 0 0 0 .2mm #d0d4db; break-inside: avoid; color: #172b4d; }',
      '.pdf-content .sps-widget-t { font-weight: 700; font-size: 9.5pt; margin: 0 0 1.5mm; }',
      '.pdf-content .sps-links { list-style: none; margin: 0; padding: 0; font-size: 8.5pt; }',
      '.pdf-content .sps-links li { display: flex; align-items: center; gap: 1.5mm; padding: .7mm 0; }',
      '.pdf-content .sps-links a { color: #172b4d; text-decoration: none; }',
      '.pdf-content .sps-fav { display: inline-flex; align-items: center; justify-content: center; width: 4mm; height: 4mm; border-radius: 1mm; color: #fff; font-size: 7pt; font-weight: 700; flex: 0 0 auto; }',
      '.pdf-content .sps-note { font-size: 8.5pt; white-space: pre-wrap; }',
      '.pdf-content .sps-page.is-empty { display: flex; justify-content: center; background: #f6f8fa; color: #626f86; font-size: 9pt; }',
      /* 便條紙：紙本上還是一張紙，但用比較淡的暖黃（列印出來不會糊成一塊），
         色帶壓深一點才印得出來。 */
      '.pdf-content .rm-note .rm-note-paper { fill: #fbf3cf; stroke: #c9b678; stroke-width: 1; }',
      '.pdf-content .rm-note .rm-note-band { fill: #d8bf6a; }',
      '.pdf-content .rm-note .rm-note-txt { fill: #2b2a1f; }',
      '.pdf-content .rm-node.rm-red .rm-disc { stroke: #d6293e; } .pdf-content .rm-node.rm-red .rm-mono { fill: #d6293e; }',
      '.pdf-content .rm-node.rm-orange .rm-disc { stroke: #c9701c; } .pdf-content .rm-node.rm-orange .rm-mono { fill: #c9701c; }',
      '.pdf-content .rm-node.rm-yellow .rm-disc { stroke: #a68a00; } .pdf-content .rm-node.rm-yellow .rm-mono { fill: #a68a00; }',
      '.pdf-content .rm-node.rm-green .rm-disc { stroke: #1f8a3d; } .pdf-content .rm-node.rm-green .rm-mono { fill: #1f8a3d; }',
      '.pdf-content .rm-node.rm-teal .rm-disc { stroke: #128a80; } .pdf-content .rm-node.rm-teal .rm-mono { fill: #128a80; }',
      '.pdf-content .rm-node.rm-blue .rm-disc { stroke: #1c64d1; } .pdf-content .rm-node.rm-blue .rm-mono { fill: #1c64d1; }',
      '.pdf-content .rm-node.rm-purple .rm-disc { stroke: #7c3aed; } .pdf-content .rm-node.rm-purple .rm-mono { fill: #7c3aed; }',
      '.pdf-content .rm-node.rm-auto-0 .rm-disc { stroke: #a8862a; } .pdf-content .rm-node.rm-auto-0 .rm-mono { fill: #a8862a; }',
      '.pdf-content .rm-node.rm-auto-1 .rm-disc { stroke: #3a78c2; } .pdf-content .rm-node.rm-auto-1 .rm-mono { fill: #3a78c2; }',
      '.pdf-content .rm-node.rm-auto-2 .rm-disc { stroke: #c46f38; } .pdf-content .rm-node.rm-auto-2 .rm-mono { fill: #c46f38; }',
      '.pdf-content .rm-node.rm-auto-3 .rm-disc { stroke: #2f8a5c; } .pdf-content .rm-node.rm-auto-3 .rm-mono { fill: #2f8a5c; }',
      '.pdf-content .rm-node.rm-auto-4 .rm-disc { stroke: #b34f73; } .pdf-content .rm-node.rm-auto-4 .rm-mono { fill: #b34f73; }',
      '.pdf-content .rm-node.rm-auto-5 .rm-disc { stroke: #6f58b8; } .pdf-content .rm-node.rm-auto-5 .rm-mono { fill: #6f58b8; }',
      '.pdf-content .rm-node.rm-auto-6 .rm-disc { stroke: #2f8f8f; } .pdf-content .rm-node.rm-auto-6 .rm-mono { fill: #2f8f8f; }',
      '.pdf-content .rm-node.rm-auto-7 .rm-disc { stroke: #b34444; } .pdf-content .rm-node.rm-auto-7 .rm-mono { fill: #b34444; }',
      '.pdf-content .rm-edge.rm-e5 .rm-line { stroke: #2f6fc0; } .pdf-content .rm-edge.rm-e6 .rm-line { stroke: #b8404e; }',
      '.pdf-content .rm-edge.rm-e7 .rm-line { stroke: #6f4fbf; } .pdf-content .rm-edge.rm-e8 .rm-line { stroke: #2f8f86; }',
      /* 待辦清單：紙本上不畫項目符號，只留勾選框與文字。 */
      /* 勾選框絕對定位、文字靠 padding 內縮：折行的第二行才會對齊文字，而不是跑到勾選框底下 */
      '.pdf-content li.task-item { list-style: none; position: relative; margin-left: -1.2em; padding-left: 1.45em; }',
      '.pdf-content li.task-item .task-check { position: absolute; left: 0; top: .3em; margin: 0; }',
      /* 網址預覽卡片與附件連結：紙本上沒有滑鼠，只留內容 */
      '.pdf-content .link-card { margin: 0 0 10pt; break-inside: avoid; }',
      '.pdf-content .link-card-a { display: flex; gap: 10pt; border: 1px solid #d0d7de; padding: 8pt 10pt;',
      '  color: #24292f; text-decoration: none; }',
      '.pdf-content .link-card-body { display: flex; flex-direction: column; gap: 2pt; min-width: 0; flex: 1; }',
      '.pdf-content .link-card-title { font-weight: 700; }',
      '.pdf-content .link-card-desc { font-size: 9pt; color: #57606a; }',
      '.pdf-content .link-card-desc:empty { display: none; }',
      '.pdf-content .link-card-url { display: flex; align-items: center; gap: 4pt; font-size: 8pt; color: #6e7781; }',
      '.pdf-content .link-card-icon img { width: 10pt; height: 10pt; }',
      '.pdf-content .link-card-thumb { flex: 0 0 90pt; }',
      '.pdf-content .link-card-thumb:empty { display: none; }',
      '.pdf-content .link-card-thumb img { width: 90pt; height: 60pt; object-fit: cover; }',
      '.pdf-content .file-chip { border: 1px solid #d0d7de; padding: 1pt 5pt; color: #24292f; }',
      '.pdf-content .file-chip .ic-svg { display: none; }',
      '.pdf-content .file-chip-type { margin-left: 4pt; font-size: 7pt; color: #6e7781; }',
      '.pdf-content li.task-item.task-done { color: #6e7781; text-decoration: line-through; }',
      '.pdf-content .code-block .code-lang {',
      '  font-size: 7pt; padding: 2pt 6pt; color: #6a737d; background: #eaeef2;',
      '  border-radius: 0; text-transform: uppercase; letter-spacing: .05em; }',
      /* Output/code blocks can run well past one page (terminal dumps, long
         listings) — they must be allowed to paginate. paged.js has no
         fallback for break-inside:avoid on content taller than a page: it
         just leaves the overflow off the bottom of the page, unrendered,
         instead of flowing it onward. break-inside:avoid is kept only on the
         per-line <li> below, which is never more than a few wrapped visual
         lines tall, so it always fits and is safe to keep whole. */
      '.pdf-content pre { background: #f6f8fa; padding: 10pt; border-radius: 0; margin: 0;',
      '  font-size: 9pt; white-space: pre-wrap; word-wrap: break-word; }',
      '.pdf-content .code-lines { list-style: none; margin: 0; padding: 0; }',
      '.pdf-content .code-lines > li {',
      '  display: grid; grid-template-columns: auto 1fr; column-gap: 8pt; margin: 0;',
      '  white-space: pre-wrap; word-wrap: break-word; break-inside: avoid; }',
      '.pdf-content .code-lines > li::before {',
      '  content: attr(data-ln); text-align: right; padding-right: 8pt;',
      '  border-right: 1px solid #d0d7de; color: #9aa5b1; }',
      '.pdf-content code { font-family: "SFMono-Regular", Consolas, monospace; }',
      '.pdf-content p code, .pdf-content li code { background: rgba(175,184,193,.2);',
      '  padding: .1em .3em; border-radius: 0; font-size: 9.5pt; }',
      /* ...but not a fenced block's own <code>, which the rule above also
         matches now that line numbers put each line in an <li> — undo the
         inline-code treatment there so it stays plain block code. */
      '.pdf-content .code-lines li code { background: none; padding: 0; font-size: inherit; }',
      /* ```linux 的終端配色本來只存在於螢幕，匯出 PDF 會退回一般 GitHub 配色。 */
      '.pdf-content .code-linux .code-lang { text-transform: lowercase; }',
      '.pdf-content .code-linux .hljs-built_in, .pdf-content .code-linux .hljs-title,' +
      ' .pdf-content .code-linux .hljs-title.function_,' +
      ' .pdf-content .code-linux .hljs-section { color: ' + pal.kali.cmd + '; }',
      '.pdf-content .code-linux .hljs-keyword, .pdf-content .code-linux .hljs-literal,' +
      ' .pdf-content .code-linux .hljs-selector-tag { color: ' + pal.kali.kw + '; }',
      '.pdf-content .code-linux .hljs-string, .pdf-content .code-linux .hljs-meta .hljs-string,' +
      ' .pdf-content .code-linux .hljs-regexp,' +
      ' .pdf-content .code-linux .hljs-addition { color: ' + pal.kali.str + '; }',
      '.pdf-content .code-linux .hljs-variable, .pdf-content .code-linux .hljs-template-variable,' +
      ' .pdf-content .code-linux .hljs-attr { color: ' + pal.kali['var'] + '; }',
      '.pdf-content .code-linux .hljs-number, .pdf-content .code-linux .hljs-symbol,' +
      ' .pdf-content .code-linux .hljs-bullet { color: ' + pal.kali.num + '; }',
      '.pdf-content .code-linux .hljs-comment,' +
      ' .pdf-content .code-linux .hljs-quote { color: ' + pal.kali.com + '; font-style: italic; }',
      '.pdf-content .code-linux .hljs-meta { color: ' + pal.kali.meta + '; }',
      '.pdf-content blockquote { margin: 8pt 0; padding: 0 12pt; color: #57606a;',
      '  border-left: 3px solid #d0d7de; }',
      '.pdf-content table { border-collapse: collapse; width: 100%; font-size: 10pt; break-inside: avoid; }',
      '.pdf-content th, .pdf-content td { border: 1px solid #d0d7de; padding: 5pt 8pt; text-align: left; }',
      '.pdf-content th { background: #f6f8fa; font-weight: 700; border-bottom: 2pt solid #b6bec7; }',
      '.pdf-content tr:nth-child(2n) td { background: rgba(0,0,0,.02); }',
      /* callouts in print — kept in step with the on-screen palette in app.css:
         no border, no left bar, square corners */
      '.pdf-content .callout { border: 0; border-radius: 0;',
      '  padding: 8pt 12pt; margin: 10pt 0; break-inside: avoid; }',
      '.pdf-content .callout-title { font-weight: 700; margin-bottom: 3pt; font-size: 10.5pt; }',
      CALLOUT_KINDS.map(function (n) {
        const c = pal.callout[n];
        return '.pdf-content .callout-' + n + ' { background: ' + c.bg + '; }' +
          '\n.pdf-content .callout-' + n + ' .callout-title { color: ' + c.fg + '; }';
      }).join('\n'),
      '.pdf-content .callout-content > :first-child { margin-top: 0; }',
      '.pdf-content .callout-content > :last-child { margin-bottom: 0; }',
      /* TLP badge on the cover */
      '.pdf-cover { position: relative; }',
      '.tlp-badge { position: absolute; top: 16mm; right: 16mm; background: #000;',
      '  font-family: "SFMono-Regular", Consolas, monospace; font-weight: 700; font-size: 10pt;',
      '  letter-spacing: .06em; padding: 4pt 9pt; }',
      /* findings summary page */
      '.pdf-summary { page: toc; break-after: page; }',
      '.summary-heading { font-size: 20pt; border-bottom: 2px solid var(--pdf-accent); padding-bottom: 6pt; }',
      '.summary-counts { display: flex; gap: 8pt; flex-wrap: wrap; margin: 14pt 0 12pt; }',
      '.summary-counts .sc { font-size: 9pt; padding: 3pt 8pt; border: 1px solid; }',
      '.summary-counts .sc b { font-size: 11pt; }',
      '.summary-table { border-collapse: collapse; width: 100%; font-size: 10pt; }',
      '.summary-table th, .summary-table td { border: 1px solid #d0d7de; padding: 5pt 8pt; text-align: left; }',
      '.summary-table th { background: #f6f8fa; font-size: 8pt; text-transform: uppercase; letter-spacing: .06em; }',
      '.summary-table .c-no { width: 44pt; font-family: "SFMono-Regular", Consolas, monospace; }',
      '.summary-table .c-sev { width: 74pt; }',
      '.summary-table .c-page { width: 40pt; text-align: right; font-variant-numeric: tabular-nums; }',
      '.summary-table a { color: #24292f; text-decoration: none; }',
      '.summary-table a.pageref::after { content: target-counter(attr(href), page); }',
      '.summary-table .sev { font-size: 8pt; font-weight: 800; letter-spacing: .06em; color: #fff;',
      '  padding: 2pt 6pt; font-family: "SFMono-Regular", Consolas, monospace; }',
      /* findings in the body */
      '.pdf-content .finding { border: 1px solid; border-left-width: 3pt; margin: 0 0 12pt;',
      '  break-inside: avoid; }',
      '.pdf-content .finding-head { display: flex; align-items: center; gap: 8pt;',
      '  padding: 6pt 10pt; border-bottom: 1px solid; }',
      '.pdf-content .risk-badge { color: #fff; font-size: 7.5pt; font-weight: 800; letter-spacing: .08em;',
      '  padding: 2pt 6pt; font-family: "SFMono-Regular", Consolas, monospace; }',
      '.pdf-content .finding-no { font-family: "SFMono-Regular", Consolas, monospace; font-size: 8.5pt;',
      '  font-weight: 700; }',
      '.pdf-content .finding-title { font-weight: 700; font-size: 11pt; }',
      '.pdf-content .finding-content { padding: 8pt 10pt; }',
      '.pdf-content .finding-content > :first-child { margin-top: 0; }',
      '.pdf-content .finding-content > :last-child { margin-bottom: 0; }'
    ].concat(RISK_ORDER.map(function (lvl) {
      const c = pal.risk[lvl];
      return '.pdf-content .finding-' + lvl + ' { background: ' + c.bg + '; border-color: ' + c.border +
        '; border-left-color: ' + c.fg + '; }\n' +
        '.pdf-content .finding-' + lvl + ' .finding-head { border-bottom-color: ' + c.border + '; }\n' +
        '.pdf-content .finding-' + lvl + ' .risk-badge { background: ' + c.fg + '; }\n' +
        '.pdf-content .finding-' + lvl + ' .finding-no { color: ' + c.fg + '; }\n' +
        '.summary-table .sev-' + lvl + ' { background: ' + c.fg + '; }\n' +
        '.summary-counts .sc-' + lvl + ' { background: ' + c.bg + '; border-color: ' + c.border +
        '; color: ' + c.fg + '; }';
    })).concat(theme.cover).concat(global.Cover ? [Cover.css()] : []).join('\n');
  }

  // 自訂封面的欄位值：設計裡的「標題／作者／客戶／版本／日期／TLP」元素印出來的字
  function coverCtx(parts, meta, tlp) {
    return {
      title: parts.title, author: meta.author || '', client: meta.client || '', version: meta.version || '',
      generated: parts.created, updated: parts.updated, tlp: tlp.id, tlpColor: tlp.color, logoId: parts.logoId
    };
  }
  // 設計裡用到的圖（Logo、底圖）轉成 data URL——列印文件自己抓不到 /api/images；抓不到的那張略過，不擋整份 PDF
  function coverImages(design) {
    const ids = global.Cover ? Cover.imageIds(design) : [];
    const out = {};
    return Promise.all(ids.map(function (id) {
      return Store.getImageBlob(id).then(function (blob) {
        if (!blob) return;
        return new Promise(function (resolve) {
          const r = new FileReader();
          r.onload = function () { out[id] = r.result; resolve(); };
          r.onerror = function () { resolve(); };
          r.readAsDataURL(blob);
        });
      }).catch(function () { /* 略過 */ });
    })).then(function () { return out; });
  }

  // Build the printable document.
  //
  // Note there is no inline <script> here: the Content-Security-Policy forbids
  // inline scripts, and this document inherits the policy of the page that
  // creates it. boot() below installs paged.js from the outside instead.
  function buildDoc(parts, opts) {
    const theme = themeById(opts.theme);
    const base = baseHref();
    const title = parts.title;
    const meta = opts.meta || {};
    const tlp = tlpById(opts.tlp);

    // Only the fields that were actually filled in reach the cover.
    const rows = [];
    if (meta.client) rows.push(['Client', meta.client]);
    if (meta.version) rows.push(['Version', meta.version]);
    if (meta.author) rows.push(['Author', meta.author]);
    rows.push(['Generated', parts.created]);
    rows.push(['Last Updated', parts.updated]);
    const metaHTML = rows.map(function (r) {
      return '<span class="k">' + MD.escapeHtml(r[0]) + '</span>' +
        '<span class="v">' + MD.escapeHtml(r[1]) + '</span>';
    }).join('<br>');

    // 自訂封面（meta.cover，js/cover.js 的設計器）：元素絕對定位在 A4 上；沒有就是內建的樣式封面
    const coverHTML = (global.Cover && Cover.isCustom(meta))
      ? Cover.html(meta.cover, coverCtx(parts, meta, tlp), parts.coverImages || {})
      : '<section class="pdf-cover">' +
        (tlp.id ? '<div class="tlp-badge" style="color:' + tlp.color + '">' +
          MD.escapeHtml(tlp.id) + '</div>' : '') +
        (parts.logoSrc ? '<img class="pdf-cover-logo" src="' + parts.logoSrc + '">' : '') +
        '<div class="kicker">Report</div>' +
        '<h1>' + MD.escapeHtml(title) + '</h1>' +
        '<div class="rule"></div>' +
        '<div class="meta">' + metaHTML + '</div>' +
        '</section>';

    return '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">' +
      '<base href="' + base + '">' +
      '<title>' + MD.escapeHtml(title) + '</title>' +
      '<link rel="stylesheet" href="' + base + 'vendor/fonts/fonts.css">' +
      '<link rel="stylesheet" href="' + base + 'vendor/hljs-github.min.css">' +
      '<style>' + printCSS(title, theme, opts) + '</style>' +
      '</head><body>' +
      coverHTML +
      parts.toc +
      parts.summary +
      '<article class="pdf-content markdown-body' + (opts.stepPages ? ' pdf-steps' : '') + '">' +
      parts.contentHTML + '</article>' +
      '</body></html>';
  }

  // Write `html` into a same-origin document and start paged.js on it from here.
  //
  // Doing it from the outside means the print document needs no inline script (CSP
  // forbids those) and lets us hand paged.js real function references instead of
  // serialising callbacks into a string.
  function boot(doc, html, opts, onDone) {
    const theme = themeById(opts.theme);
    const wmCSS = watermarkCSS(opts.watermark, theme);
    doc.open();
    doc.write(html);
    doc.close();
    const win = doc.defaultView;
    win.PagedConfig = {
      auto: true,
      after: function () {
        // Injected only once pagination is done — paged.js rewrites the
        // stylesheets it is handed and drops the cover exclusion on the way.
        if (wmCSS) {
          const s = doc.createElement('style');
          s.textContent = wmCSS;
          doc.head.appendChild(s);
        }
        if (opts.autoPrint) setTimeout(function () { win.focus(); win.print(); }, 400);
        if (onDone) onDone(doc);
      }
    };
    // Wait for the bundled webfonts before paginating. paged.js decides page
    // breaks by measuring text; if it runs against fallback metrics and the real
    // font swaps in afterwards, every line reflows and the page numbers that the
    // TOC and the findings summary resolve through target-counter() end up
    // pointing at the wrong pages. The timeout is a backstop so a font that
    // fails to load can never leave the preview spinning forever.
    const start = function () {
      const s = doc.createElement('script');
      s.src = baseHref() + 'vendor/paged.polyfill.js';
      doc.head.appendChild(s);
    };
    if (doc.fonts && doc.fonts.ready) {
      let started = false;
      const once = function () { if (!started) { started = true; start(); } };
      doc.fonts.ready.then(once, once);
      setTimeout(once, 3000);
    } else {
      start();
    }
  }

  // Snapshot the rendered preview into everything the print document needs.
  function prepare(note, previewEl) {
    const clone = previewEl.cloneNode(true);
    // strip interactive controls from the export
    Array.prototype.forEach.call(clone.querySelectorAll('.code-copy, .img-tools, .mm-edit-btn'),
      function (b) { b.remove(); });
    // A to-do box on paper is a record, not a control — leave the tick visible
    // but make sure nobody can change it in a PDF viewer that renders form
    // fields live.
    Array.prototype.forEach.call(clone.querySelectorAll('.task-check'),
      function (b) { b.disabled = true; });
    // An inline [toc] would only duplicate the TOC page (which also has page numbers).
    Array.prototype.forEach.call(clone.querySelectorAll('.md-toc'), function (n) { n.remove(); });
    // 影片在紙上播不了：換成一行連結
    if (MD.replaceVideosForExport) MD.replaceVideosForExport(clone, 'PDF');
    // 內文的封面 Logo（證照範本放的 ![__cover_logo__](img:id)）：id 要在 inline 之前讀，inline 會把 data-img-id 拿掉；
    // 自訂封面的設計器用它當起始的 Logo 元素
    const logoEl = clone.querySelector('img.cover-logo');
    const logoId = logoEl ? logoEl.getAttribute('data-img-id') : null;
    const meta = note.meta || {};
    return Promise.all([MD.inlineImagesAsDataURL(clone), coverImages(meta.cover)]).then(function (r) {
      // pull the cover logo out of the body and onto the cover page
      let logoSrc = null;
      const logoImg = clone.querySelector('img.cover-logo');
      if (logoImg) { logoSrc = logoImg.getAttribute('src'); logoImg.remove(); }
      return {
        title: note.title || 'Untitled Note',
        logoSrc: logoSrc,
        logoId: logoId,
        coverImages: r[1],
        toc: buildTOC(MD.extractHeadings(clone)),
        summary: buildFindingsSummary(clone),
        findings: MD.extractFindings(clone).length,
        contentHTML: clone.innerHTML,
        created: formatDate(Date.now()),
        updated: formatDate(note.updatedAt || Date.now())
      };
    });
  }

  // ---------------- preview dialog ----------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const LS_THEME = 'pdfTheme', LS_WM = 'pdfWatermark', LS_H1 = 'pdfBreakH1';
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // opts: { meta, onMeta } — cover fields live on the note, so they are handed in
  // and saved back through app.js rather than written to the store from here.
  function showPreview(note, previewEl, opts) {
    return prepare(note, previewEl).then(function (parts) {
      buildPreviewUI(parts, opts || {});
    });
  }

  function buildPreviewUI(parts, o) {
    let theme = lsGet(LS_THEME, 'tech');
    let watermark = lsGet(LS_WM, '');
    let breakH1 = lsGet(LS_H1, '0') === '1';
    const meta = Object.assign({ client: '', version: '', author: '', tlp: '' }, o.meta || {});

    const overlay = el('div', 'modal-overlay pv-overlay');
    const modal = el('div', 'modal pv-modal');

    const head = el('div', 'pv-head');
    head.appendChild(el('div', 'modal-title', '列印預覽'));
    const pages = el('div', 'pv-pages', '排版中…');
    head.appendChild(pages);
    modal.appendChild(head);

    // ---- controls ----
    const bar = el('div', 'pv-bar');

    const themeWrap = el('label', 'pv-ctl');
    themeWrap.appendChild(el('span', null, '樣式'));
    const themeSel = document.createElement('select');
    THEMES.forEach(function (t) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.name;
      themeSel.appendChild(o);
    });
    themeSel.value = theme;
    themeWrap.appendChild(themeSel);
    bar.appendChild(themeWrap);

    const wmWrap = el('label', 'pv-ctl');
    wmWrap.appendChild(el('span', null, '浮水印'));
    const wmSel = document.createElement('select');
    [['', '無']].concat(WATERMARK_PRESETS.map(function (w) { return [w, w]; }))
      .concat([['__custom', '自訂…']])
      .forEach(function (p) {
        const o = document.createElement('option');
        o.value = p[0]; o.textContent = p[1];
        wmSel.appendChild(o);
      });
    const isPreset = !watermark || WATERMARK_PRESETS.indexOf(watermark) >= 0;
    wmSel.value = isPreset ? watermark : '__custom';
    wmWrap.appendChild(wmSel);
    bar.appendChild(wmWrap);

    const wmText = el('input', 'pv-wm-text');
    wmText.type = 'text';
    wmText.placeholder = '浮水印文字';
    wmText.value = isPreset ? '' : watermark;
    wmText.hidden = isPreset;
    bar.appendChild(wmText);

    const tlpWrap = el('label', 'pv-ctl');
    tlpWrap.appendChild(el('span', null, 'TLP'));
    const tlpSel = document.createElement('select');
    TLP.forEach(function (t) {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.label;
      tlpSel.appendChild(opt);
    });
    tlpSel.value = meta.tlp || '';
    tlpWrap.appendChild(tlpSel);
    bar.appendChild(tlpWrap);

    const h1Wrap = el('label', 'pv-check');
    const h1Box = document.createElement('input');
    h1Box.type = 'checkbox';
    h1Box.checked = breakH1;
    h1Wrap.appendChild(h1Box);
    h1Wrap.appendChild(document.createTextNode(' H1 章節從新頁開始'));
    bar.appendChild(h1Wrap);
    modal.appendChild(bar);

    // ---- cover fields ----
    const cover = el('div', 'pv-bar pv-cover-bar');
    cover.appendChild(el('span', 'pv-bar-label', '封面欄位'));
    const fields = {};
    [['client', '客戶名稱'], ['version', '版本（如 v1.0）'], ['author', '作者']].forEach(function (f) {
      const i = el('input', 'pv-meta-input');
      i.type = 'text';
      i.placeholder = f[1];
      i.value = meta[f[0]] || '';
      fields[f[0]] = i;
      cover.appendChild(i);
    });
    // 封面設計器（js/cover.js）：自己排標題／作者的位置、上傳 Logo；設計存在 meta.cover
    const designBtn = el('button', 'btn pv-design', '設計封面…');
    designBtn.type = 'button';
    const customTag = el('span', 'pv-custom-tag', '自訂封面');
    if (global.Cover) { cover.appendChild(designBtn); cover.appendChild(customTag); }
    function syncCustomTag() { customTag.hidden = !(global.Cover && Cover.isCustom(meta)); }
    syncCustomTag();
    modal.appendChild(cover);

    // ---- preview surface ----
    const stage = el('div', 'pv-stage');
    const frame = document.createElement('iframe');
    frame.className = 'pv-frame';
    frame.setAttribute('title', '列印預覽');
    stage.appendChild(frame);
    modal.appendChild(stage);

    const actions = el('div', 'modal-actions');
    const hint = el('span', 'pv-hint', '在列印視窗選擇「另存為 PDF」');
    actions.appendChild(hint);
    const cancel = el('button', 'btn modal-cancel', '關閉');
    const print = el('button', 'btn btn-primary', '⭳ 列印 / 另存 PDF');
    [cancel, print].forEach(function (b) { b.type = 'button'; actions.appendChild(b); });
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // ---- render ----
    let renderToken = 0;
    function render() {
      const mine = ++renderToken;
      pages.textContent = '排版中…';
      print.disabled = true;
      const opts = {
        theme: theme, watermark: watermark, autoPrint: false,
        tlp: meta.tlp, breakH1: breakH1, meta: meta,
        // 資安院報告是步驟式的，一步一頁（見 printCSS 的 stepPages）
        stepPages: !!meta.secReport
      };
      // 自訂封面的圖可能剛在設計器裡換過：每次排版前重抓（Store 有快取，沒換的不會再打一次）
      coverImages(meta.cover).then(function (imgs) {
        if (mine !== renderToken) return;
        parts.coverImages = imgs;
        // document.write (rather than srcdoc) keeps the frame same-origin, so the
        // vendor script loads under the app's own policy.
        boot(frame.contentDocument, buildDoc(parts, opts), opts, function (doc) {
          if (mine !== renderToken) return;   // a newer render superseded this one
          const n = doc.querySelectorAll('.pagedjs_page').length;
          pages.textContent = (n ? '共 ' + n + ' 頁' : '') +
            (parts.findings ? ' · ' + parts.findings + ' 個弱點' : '');
          print.disabled = false;
        });
      });
    }
    designBtn.addEventListener('click', function () {
      if (!global.Cover) return;
      const tlp = tlpById(meta.tlp);
      const ctx = Object.assign(coverCtx(parts, meta, tlp), { themeId: theme, themes: THEMES.map(function (t) { return { id: t.id, name: t.name }; }) });
      Cover.open(Cover.isCustom(meta) ? meta.cover : null, ctx, {
        onUpload: o.onUpload || (global.App && App.uploadFiles) || null,
        onSave: function (design) { meta.cover = design; saveMeta(); syncCustomTag(); render(); },
        onReset: Cover.isCustom(meta) ? function () { delete meta.cover; saveMeta(); syncCustomTag(); render(); } : null
      });
    });

    themeSel.addEventListener('change', function () {
      theme = themeSel.value;
      lsSet(LS_THEME, theme);
      render();
    });
    function applyWatermark() {
      watermark = (wmSel.value === '__custom') ? wmText.value.trim() : wmSel.value;
      lsSet(LS_WM, watermark);
      render();
    }
    wmSel.addEventListener('change', function () {
      wmText.hidden = wmSel.value !== '__custom';
      if (wmSel.value === '__custom') { wmText.focus(); if (!wmText.value.trim()) return; }
      applyWatermark();
    });
    let wmTimer = null;
    wmText.addEventListener('input', function () {
      if (wmTimer) clearTimeout(wmTimer);
      wmTimer = setTimeout(applyWatermark, 400);
    });

    h1Box.addEventListener('change', function () {
      breakH1 = h1Box.checked;
      lsSet(LS_H1, breakH1 ? '1' : '0');
      render();
    });

    // Cover fields and TLP belong to the note, so they persist through app.js.
    function saveMeta() {
      if (o.onMeta) o.onMeta(Object.assign({}, meta));
    }
    tlpSel.addEventListener('change', function () {
      meta.tlp = tlpSel.value;
      saveMeta();
      render();
    });
    let metaTimer = null;
    Object.keys(fields).forEach(function (k) {
      fields[k].addEventListener('input', function () {
        meta[k] = fields[k].value.trim();
        if (metaTimer) clearTimeout(metaTimer);
        metaTimer = setTimeout(function () { saveMeta(); render(); }, 400);
      });
    });

    print.addEventListener('click', function () {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    });

    function close() {
      renderToken++;              // ignore any in-flight paged.js callback
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (e.target && e.target.tagName === 'INPUT') return; // let text fields handle keys
      if (document.querySelector('.cv-overlay')) return;    // 設計封面開著：Esc 是它的
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    cancel.addEventListener('click', close);

    render();
  }

  // 泛用版的列印預覽：拿到的 html 就是完整的文件（<!DOCTYPE html>…），不加封面、目錄、樣式或浮水印——
  // 文件（js/doc.js）自己排好 @page 與頁首頁尾，這裡只負責用 paged.js 分頁、數頁、列印。
  function showHTML(html, o) {
    o = o || {};
    const overlay = el('div', 'modal-overlay pv-overlay');
    const modal = el('div', 'modal pv-modal');
    const head = el('div', 'pv-head');
    head.appendChild(el('div', 'modal-title', o.title ? '列印預覽 — ' + o.title : '列印預覽'));
    const pages = el('div', 'pv-pages', '排版中…');
    head.appendChild(pages);
    modal.appendChild(head);
    const stage = el('div', 'pv-stage');
    const frame = document.createElement('iframe');
    frame.className = 'pv-frame';
    frame.setAttribute('title', '列印預覽');
    stage.appendChild(frame);
    modal.appendChild(stage);
    const actions = el('div', 'modal-actions');
    actions.appendChild(el('span', 'pv-hint', '在列印視窗選擇「另存為 PDF」'));
    const cancel = el('button', 'btn modal-cancel', '關閉');
    const print = el('button', 'btn btn-primary', '⭳ 列印 / 另存 PDF');
    [cancel, print].forEach(function (b) { b.type = 'button'; actions.appendChild(b); });
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    let token = 1;
    print.disabled = true;
    boot(frame.contentDocument, html, { autoPrint: false, watermark: '' }, function (doc) {
      if (!token) return;
      const n = doc.querySelectorAll('.pagedjs_page').length;
      pages.textContent = n ? '共 ' + n + ' 頁' : '';
      print.disabled = false;
      if (o.onReady) o.onReady(doc, n);
    });
    print.addEventListener('click', function () { frame.contentWindow.focus(); frame.contentWindow.print(); });
    function close() { token = 0; overlay.remove(); document.removeEventListener('keydown', onKey, true); if (o.onClose) o.onClose(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    cancel.addEventListener('click', close);
    return Promise.resolve({ close: close, frame: frame });
  }

  // Legacy direct path: paginate in a popup and print immediately, no preview.
  function exportNote(note, previewEl) {
    return prepare(note, previewEl).then(function (parts) {
      const meta = note.meta || {};
      const opts = {
        theme: lsGet(LS_THEME, 'tech'), watermark: lsGet(LS_WM, ''), autoPrint: true,
        tlp: meta.tlp, breakH1: lsGet(LS_H1, '0') === '1', meta: meta,
        stepPages: !!meta.secReport
      };
      const w = global.open('', '_blank');
      if (!w) throw new Error('無法開啟新視窗，請允許彈出視窗後再試。');
      boot(w.document, buildDoc(parts, opts), opts, null);
    });
  }

  global.PDF = {
    showPreview: showPreview,
    showHTML: showHTML,
    exportNote: exportNote,
    themes: THEMES,
    watermarks: WATERMARK_PRESETS
  };
})(window);
