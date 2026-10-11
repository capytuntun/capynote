/* doc.js — 文件：所見即所得的編輯器，長得像 Google 文件。
 *
 * 一份文件是一篇 meta.doc 的筆記，內容直接存 HTML（不是 Markdown——使用者要的是「所見即所得、
 * 工具列排版、不用 Markdown」）。存進去之前先過 DOMPurify，讀回來也過一次；圖片存成
 * <img data-img-id="<id>" src="img:<id>">：src 裡那個 img:<id> 是伺服器判斷「誰看得到這張圖」的
 * 依據（跟 Markdown 筆記的 ![](img:id) 同一條規則），預覽時 DOMPurify 會把這個不合法的 src 拿掉、
 * 留下 data-img-id，markdown.js 的 resolveImages 就照常把圖補上；在編輯器裡則換成 /api/images/<id>
 * 直接顯示。預覽、PDF、電子書走 MD.render()：一整段 HTML，marked 原樣放行、DOMPurify 清過。
 *
 * 工具列照 Google 文件：復原／重做、樣式（一般文字、標題 1–4、引言）、字型、字級（− 數字 ＋）、
 * 粗體／斜體／底線／刪除線、文字顏色／螢光筆、連結、圖片、對齊（左／中／右／兩端）、項目符號／
 * 編號、縮排／減少縮排、表格、分隔線、清除格式，再加上行距、上下標、程式碼區塊、分頁符號。工具列上面是
 * Google 文件式的選單列（檔案／插入／格式／工具）：下載 PDF（paged.js 排版的列印預覽，頁首頁尾與頁碼放在
 * @page 的邊界盒）、下載 Word（純瀏覽器端寫出 .docx）、頁面設定（紙張、方向、上下邊界、頁首／頁尾、頁碼：
 * 位置、格式、可以決定起始頁碼、第一頁不顯示；存在 meta.docPage）、目錄（從標題 1～4 做出來、打字時自己更新、
 * 列印時頁碼用 target-counter 算）、字數統計、尋找與取代。頁面是一張白紙（816px、1 吋邊界）放在灰底上，
 * 紙的上下各一條頁首／頁尾（雙擊編輯）。程式碼區塊有語言（右上角的語言列選）、語法上色、行號，Tab 是四個空白、
 * 選多行時整段縮排，Enter 保留上一行的縮排。
 */
(function (global) {
  'use strict';

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }

  // 字型：v 是寫進 style 的 font-family，label 給人看。標楷體在 Windows 是 DFKai-SB，macOS 是 BiauKai，
  // 都沒有時退到 serif（至少看得出是楷體那一類）
  const FONTS = [
    { v: 'Arial', label: 'Arial' }, { v: 'Times New Roman', label: 'Times New Roman' }, { v: 'Georgia', label: 'Georgia' },
    { v: 'Verdana', label: 'Verdana' }, { v: 'Courier New', label: 'Courier New' },
    { v: 'Noto Sans TC', label: 'Noto Sans TC' }, { v: 'Microsoft JhengHei', label: '微軟正黑體' },
    { v: 'DFKai-SB, BiauKai, 標楷體, serif', label: '標楷體' }, { v: 'PMingLiU, 新細明體, serif', label: '新細明體' }
  ];
  const CM = 96 / 2.54;   // 一公分幾個像素（CSS 的 1in = 96px）
  const PAPER_W = 816, MARGIN_DEF = 96;
  const SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36];
  const STYLES = [['p', '一般文字'], ['h1', '標題 1'], ['h2', '標題 2'], ['h3', '標題 3'], ['h4', '標題 4'], ['blockquote', '引言']];
  // Google 文件調色盤的前兩排＋一排常用色
  const COLORS = ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
    '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
    '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
    '#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'];
  const HILITES = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#ff9900', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#cfe2f3', 'none'];

  const IMG_RE = /^img:([A-Za-z0-9_][\w.-]{0,63})$/;
  function sanitize(html) {
    if (!global.DOMPurify) return String(html || '');
    return DOMPurify.sanitize(String(html || ''), {
      ADD_ATTR: ['target', 'data-img-id'],
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
      ALLOW_DATA_ATTR: true
    });
  }
  function isNote(note) { return !!(note && note.meta && note.meta.doc); }
  function generate() { return ''; }
  // 存檔前：圖片的 src 換回 img:<id>（伺服器靠它判斷可見性），把編輯器自己加的東西拿掉
  function toStored(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('img').forEach(function (img) {
      let id = img.getAttribute('data-img-id');
      if (!id) { const m = /\/api\/images\/([A-Za-z0-9_][\w.-]{0,63})$/.exec(img.getAttribute('src') || ''); if (m) id = m[1]; }
      if (id) { img.setAttribute('data-img-id', id); img.setAttribute('src', 'img:' + id); }
    });
    clone.querySelectorAll('.gd-toc-tools').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('pre').forEach(function (pre) { pre.textContent = preText(pre); pre.removeAttribute('data-gd-ln'); pre.removeAttribute('data-gd-lnw'); });
    clone.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
    return clone.innerHTML;
  }
  // 讀進編輯器：清過，圖片換成看得到的網址
  function toLive(html) {
    const box = document.createElement('div');
    box.innerHTML = sanitize(html);
    box.querySelectorAll('img').forEach(function (img) {
      const id = img.getAttribute('data-img-id') || (IMG_RE.exec(img.getAttribute('src') || '') || [])[1];
      if (id) { img.setAttribute('data-img-id', id); img.setAttribute('src', '/api/images/' + id); }
    });
    box.querySelectorAll('a').forEach(function (a) { if (!/^#/.test(a.getAttribute('href') || '')) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); } });
    box.querySelectorAll('.gd-toc, .gd-pagebreak').forEach(function (n) { n.setAttribute('contenteditable', 'false'); });
    return box.innerHTML;
  }
  function textOf(html) { const d = document.createElement('div'); d.innerHTML = sanitize(html); return d.textContent || ''; }
  // 程式碼區塊的純文字：編輯時 Chrome 用 <br> 換行（insertLineBreak），存檔／匯出／轉回段落一律當成換行字元
  function preText(pre) {
    let out = '';
    const walk = function (n) { Array.prototype.forEach.call(n.childNodes, function (c) { if (c.nodeType === 3) out += c.nodeValue; else if (c.nodeName === 'BR') out += '\n'; else walk(c); }); };
    walk(pre);
    return out.replace(/\n$/, '');
  }

  // ---------------- 程式碼區塊：語言、上色、行號 ----------------
  // 語言存在 <pre class="gd-code" data-lang="python">；沒寫就跟 Markdown 筆記沒標語言的圍欄一樣用 bash 文法——它很
  // 保守，貼進來的終端輸出（nmap、whoami、雜湊）幾乎一個字都不會被上色，指令才會。data-ln="off" 是使用者把行號關了，
  // 預設有行號。上色在編輯器裡不碰 DOM：用 CSS Custom Highlight API 把 Range 加進 gd-t-* 幾個 Highlight（顏色寫在
  // app.css 的 ::highlight()），所以原生的復原／重做、游標、存進去的純文字都跟沒上色時一樣；預覽、PDF、電子書是靜態的，
  // 直接包 <span class="gd-t-*">，一行一個 .gd-cl（staticCode）。
  const CODE_LANGS = [['', 'Shell（預設）'], ['plaintext', '純文字'], ['powershell', 'PowerShell'], ['dos', 'CMD / Batch'],
    ['python', 'Python'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['json', 'JSON'], ['xml', 'HTML / XML'],
    ['css', 'CSS'], ['scss', 'SCSS'], ['sql', 'SQL'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['java', 'Java'],
    ['kotlin', 'Kotlin'], ['go', 'Go'], ['rust', 'Rust'], ['php', 'PHP'], ['ruby', 'Ruby'], ['perl', 'Perl'], ['lua', 'Lua'],
    ['swift', 'Swift'], ['objectivec', 'Objective-C'], ['vbnet', 'VB.NET'], ['r', 'R'], ['yaml', 'YAML'], ['ini', 'INI / TOML'],
    ['makefile', 'Makefile'], ['diff', 'Diff'], ['markdown', 'Markdown'], ['graphql', 'GraphQL']];
  const LANG_OK = {};
  CODE_LANGS.forEach(function (x) { LANG_OK[x[0]] = 1; });
  function codeLang(pre) { const v = String(pre.getAttribute('data-lang') || '').toLowerCase(); return LANG_OK[v] ? v : ''; }
  // hljs 的 class → 顏色群組，照 GitHub 淺色主題分（紙永遠是白的）
  const TOKEN_GROUP = { keyword: 'kw', doctag: 'kw', 'template-tag': 'kw', 'template-variable': 'kw', type: 'kw', title: 'fn',
    attr: 'con', attribute: 'con', literal: 'con', meta: 'con', number: 'con', operator: 'con', variable: 'con', section: 'con',
    'selector-attr': 'con', 'selector-class': 'con', 'selector-id': 'con', string: 'str', regexp: 'str', built_in: 'bi', symbol: 'bi',
    comment: 'com', code: 'com', formula: 'com', name: 'tag', quote: 'tag', 'selector-pseudo': 'tag', 'selector-tag': 'tag',
    bullet: 'bul', addition: 'add', deletion: 'del' };
  const TOKEN_GROUPS = ['kw', 'fn', 'con', 'str', 'bi', 'com', 'tag', 'bul', 'add', 'del'];
  const TOKEN_HEX = { kw: 'D73A49', fn: '6F42C1', con: '005CC5', str: '032F62', bi: 'E36209', com: '6A737D', tag: '22863A', bul: '735C0F', add: '22863A', del: 'B31D28' };
  function tokenGroup(cls) {
    const parts = String(cls).split(/\s+/), m = /^hljs-(.+)$/.exec(parts[0] || '');
    if (!m) return null;
    if (m[1] === 'subst') return '';   // 字串裡的 ${…}：回到一般文字的顏色
    if (m[1] === 'variable' && parts.indexOf('language_') >= 0) return 'kw';
    return TOKEN_GROUP[m[1]] || null;
  }
  function unent(s) { return s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, function (m, k) { return { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" }[k]; }); }
  // 一段程式碼 → [{ s, e, g }]（字的位置與顏色群組）：每個字只算最裡面那一層有顏色的 token
  function codeSegments(text, lang) {
    if (!text || lang === 'plaintext' || !global.hljs) return [];
    const name = lang || 'bash';
    if (!hljs.getLanguage(name)) return [];
    let html;
    try { html = hljs.highlight(text, { language: name, ignoreIllegals: true }).value; } catch (e) { return []; }
    const out = [], stack = [];
    let pos = 0, m;
    const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
    while ((m = re.exec(html))) {
      if (m[2] !== undefined) {
        const len = unent(m[2]).length;
        let g = null;
        for (let i = stack.length - 1; i >= 0; i--) { if (stack[i] === '') break; if (stack[i]) { g = stack[i]; break; } }
        if (g && len) {
          const last = out[out.length - 1];
          if (last && last.g === g && last.e === pos) last.e += len; else out.push({ s: pos, e: pos + len, g: g });
        }
        pos += len;
      } else if (m[0] === '</span>') stack.pop();
      else stack.push(tokenGroup(m[1]));
    }
    return pos === text.length ? out : [];   // 對不上就寧可不上色，也不要塗錯位置
  }
  // 程式碼切成一行一段 HTML，token 跨行的地方在行尾切開
  function codeLinesHTML(text, lang) {
    const segs = codeSegments(text, lang);
    let off = 0, k = 0;
    return text.split('\n').map(function (ln) {
      const ls = off, le = off + ln.length;
      let html = '', p = ls;
      while (k < segs.length && segs[k].e <= ls) k++;
      for (let i = k; i < segs.length && segs[i].s < le; i++) {
        const s = Math.max(segs[i].s, ls), e = Math.min(segs[i].e, le);
        if (s > p) html += esc(text.slice(p, s));
        html += '<span class="gd-t-' + segs[i].g + '">' + esc(text.slice(s, e)) + '</span>';
        p = e;
      }
      if (p < le) html += esc(text.slice(p, le));
      off = le + 1;
      return html;
    });
  }
  // 靜態的程式碼區塊（預覽、電子書、公開連結、PDF）：一行一個 .gd-cl，行號是 data-n（不用 CSS 計數器——paged.js 把
  // 區塊切到下一頁時會複製一個 <pre>，計數器會從 1 重來）
  function staticCode(root) {
    Array.prototype.forEach.call(root.querySelectorAll('pre.gd-code:not(.gd-static)'), function (pre) {
      const lines = codeLinesHTML(preText(pre), codeLang(pre));
      const ln = pre.getAttribute('data-ln') !== 'off';
      pre.classList.add('gd-static');
      pre.classList.toggle('gd-has-ln', ln);
      pre.removeAttribute('data-gd-ln');
      pre.setAttribute('data-gd-lnw', String(Math.max(2, String(lines.length).length)));
      pre.innerHTML = lines.map(function (h, i) { return '<span class="gd-cl" data-n="' + (i + 1) + '">' + h + '</span>'; }).join('');
    });
    return root;
  }
  // MD.render 用：Markdown 筆記沒有這種區塊，只有文件（HTML 內容）有
  function staticCodeHTML(html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    staticCode(t.content);
    return t.innerHTML;
  }
  // 列印用的樣式（文件自己的 PDF、pdf.js 的報告 PDF 都用這份）：app.css 進不了列印文件，行號欄與顏色在這裡重寫一次
  function codePrintCSS(scope) {
    const p = scope + ' pre.gd-code';
    const out = [
      p + ' .gd-cl { display: block; position: relative; min-height: 1.45em; }',
      p + '.gd-has-ln::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: calc(2ch + 14pt); background: #e8eaed; border-right: 1px solid #dadce0; border-radius: 3pt 0 0 3pt; }',
      p + '.gd-has-ln { padding-left: calc(2ch + 22pt); }',
      p + '.gd-has-ln .gd-cl::before { content: attr(data-n); position: absolute; top: 0; right: calc(100% + 14pt); color: #80868b; }'
    ];
    [3, 4, 5].forEach(function (d) {
      out.push(p + '.gd-has-ln[data-gd-lnw="' + d + '"] { padding-left: calc(' + d + 'ch + 22pt); } ' + p + '.gd-has-ln[data-gd-lnw="' + d + '"]::before { width: calc(' + d + 'ch + 14pt); }');
    });
    TOKEN_GROUPS.forEach(function (g) { out.push(p + ' .gd-t-' + g + ' { color: #' + TOKEN_HEX[g] + '; }'); });
    out.push(p + ' .gd-t-add { background: #f0fff4; } ' + p + ' .gd-t-del { background: #ffeef0; }');
    return out.join('\n');
  }

  // ---------------- 彈窗 ----------------
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function popupAt(anchor, cls) {
    closePop();
    const p = el('div', 'gd-pop' + (cls ? ' ' + cls : ''));
    document.body.appendChild(p);
    const r = anchor.getBoundingClientRect();
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - 300)) + 'px';
    p.style.top = (r.bottom + 4) + 'px';
    popEl = p;
    return p;
  }
  document.addEventListener('mousedown', function (e) { if (popEl && !popEl.contains(e.target)) closePop(); }, true);

  // ---------------- 頁面設定（meta.docPage）：紙張、方向、上下邊界、頁首／頁尾文字、頁碼 ----------------
  // 左右邊界是尺規拖的 meta.docMargins（px），這裡是其餘的。頁碼可以決定從第幾頁開始算（使用者要的）。
  const PAGE_SIZES = { A4: [210, 297], Letter: [215.9, 279.4], Legal: [215.9, 355.6], B5: [176, 250], A3: [297, 420] };
  const PAGE_DEF = { size: 'A4', orient: 'portrait', mt: 25.4, mb: 25.4, header: '', headerAlign: 'left', footer: '', footerAlign: 'left',
    num: false, numPos: 'footer', numAlign: 'center', numStart: 1, numFmt: 'n', skipFirst: false };
  function cleanPage(p) {
    const o = Object.assign({}, PAGE_DEF, p || {});
    if (!PAGE_SIZES[o.size]) o.size = 'A4';
    o.orient = o.orient === 'landscape' ? 'landscape' : 'portrait';
    o.mt = Math.max(5, Math.min(80, +o.mt || PAGE_DEF.mt)); o.mb = Math.max(5, Math.min(80, +o.mb || PAGE_DEF.mb));
    o.header = String(o.header || '').slice(0, 200); o.footer = String(o.footer || '').slice(0, 200);
    o.headerAlign = ['left', 'center', 'right'].indexOf(o.headerAlign) >= 0 ? o.headerAlign : 'left';
    o.footerAlign = ['left', 'center', 'right'].indexOf(o.footerAlign) >= 0 ? o.footerAlign : 'left';
    o.num = !!o.num; o.numPos = o.numPos === 'header' ? 'header' : 'footer';
    o.numAlign = ['left', 'center', 'right'].indexOf(o.numAlign) >= 0 ? o.numAlign : 'center';
    o.numStart = Math.max(0, Math.min(9999, parseInt(o.numStart, 10) || 0)); if (!o.numStart && o.numStart !== 0) o.numStart = 1;
    o.numFmt = ['n', 'page-n', 'n-of-total'].indexOf(o.numFmt) >= 0 ? o.numFmt : 'n';
    o.skipFirst = !!o.skipFirst;
    return o;
  }
  function pageMM(p) { const s = PAGE_SIZES[p.size] || PAGE_SIZES.A4; return p.orient === 'landscape' ? [s[1], s[0]] : [s[0], s[1]]; }
  function pxToMM(px) { return Math.round(px * 25.4 / 96 * 10) / 10; }
  // 頁碼在畫面與列印時長什麼樣：n → 「3」、page-n → 「第 3 頁」、n-of-total → 「3 / 12」
  function numText(p, n, total) { return p.numFmt === 'page-n' ? '第 ' + n + ' 頁' : p.numFmt === 'n-of-total' ? n + ' / ' + (total == null ? '…' : total) : String(n); }

  // ---------------- 列印用的 HTML（PDF）：一份文件就是幾張紙，沒有封面、沒有報告目錄 ----------------
  // 跟報告的 pdf.js 走同一個 paged.js 排版器（PDF.showHTML），但樣式照 Google 文件下載 PDF 的樣子：
  // 紙的字型與字級、@page 的大小／邊界、頁首頁尾文字與頁碼放在 @page 的邊界盒、分頁符號、目錄的頁碼
  // 用 target-counter 算出來。
  function cssEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' '); }
  function buildPrintHTML(paper, page, margins, title) {
    const p = cleanPage(page);
    const mm = pageMM(p);
    const clone = paper.cloneNode(true);
    clone.querySelectorAll('.gd-toc-tools, .gd-hf').forEach(function (x) { x.remove(); });
    clone.querySelectorAll('[contenteditable]').forEach(function (x) { x.removeAttribute('contenteditable'); });
    clone.querySelectorAll('img').forEach(function (img) { const id = img.getAttribute('data-img-id'); if (id) img.setAttribute('src', '/api/images/' + id); });
    staticCode(clone);
    const base = location.origin + '/';
    const numContent = p.numFmt === 'page-n' ? '"第 " counter(page) " 頁"' : p.numFmt === 'n-of-total' ? 'counter(page) " / " counter(pages)' : 'counter(page)';
    const boxes = {};
    const put = function (side, align, content) { const k = '@' + side + '-' + align; boxes[k] = (boxes[k] ? boxes[k] + ' "  " ' : '') + content; };
    if (p.header) put('top', p.headerAlign, '"' + cssEsc(p.header) + '"');
    if (p.footer) put('bottom', p.footerAlign, '"' + cssEsc(p.footer) + '"');
    if (p.num) put(p.numPos === 'header' ? 'top' : 'bottom', p.numAlign, numContent);
    const boxCSS = Object.keys(boxes).map(function (k) { return '  ' + k + ' { content: ' + boxes[k] + '; font-size: 9pt; color: #444; font-family: Arial, "Noto Sans TC", sans-serif; }'; }).join('\n');
    const firstCSS = p.skipFirst ? '@page :first {' + Object.keys(boxes).map(function (k) { return ' ' + k + ' { content: none; }'; }).join('') + ' }' : '';
    const css = [
      '@page { size: ' + mm[0] + 'mm ' + mm[1] + 'mm; margin: ' + p.mt + 'mm ' + pxToMM(margins.r) + 'mm ' + p.mb + 'mm ' + pxToMM(margins.l) + 'mm;',
      boxCSS, '}', firstCSS,
      'html, body { margin: 0; padding: 0; }',
      // paged.js 認的是「內容元素」上的 counter-reset: page N（body 會被它拆掉重排）：含那個元素的那一頁改成
      // counter-increment: none; counter-reset: page N，所以第一頁就是 N，之後每頁 +1——這就是「從第幾頁開始」。
      '.gd-print { counter-reset: page ' + p.numStart + '; }',
      '.gd-print { font-family: Arial, "Noto Sans TC", "Microsoft JhengHei", sans-serif; font-size: 11pt; line-height: 1.5; color: #000; }',
      '.gd-print h1 { font-size: 20pt; font-weight: 400; margin: 20pt 0 6pt; } .gd-print h2 { font-size: 16pt; font-weight: 400; margin: 18pt 0 6pt; }',
      '.gd-print h3 { font-size: 14pt; font-weight: 400; margin: 16pt 0 4pt; color: #434343; } .gd-print h4 { font-size: 12pt; font-weight: 400; margin: 14pt 0 4pt; color: #666; }',
      '.gd-print p { margin: 0; min-height: 1.5em; } .gd-print blockquote { margin: 6pt 0; padding-left: 12pt; border-left: 3px solid #999; color: #444; }',
      '.gd-print a { color: #1155cc; } .gd-print img { max-width: 100%; height: auto; }',
      '.gd-print table { border-collapse: collapse; width: 100%; margin: 6pt 0; table-layout: fixed; } .gd-print td, .gd-print th { border: 1px solid #000; padding: 4pt 6pt; vertical-align: top; word-wrap: break-word; }',
      '.gd-print hr { border: 0; border-top: 1px solid #000; margin: 10pt 0; } .gd-print ul, .gd-print ol { margin: 0; padding-left: 36pt; }',
      '.gd-print pre.gd-code { position: relative; font-family: "Courier New", Consolas, monospace; font-size: 10pt; line-height: 1.45; tab-size: 4; background: #f1f3f4; border: 1px solid #dadce0; border-radius: 4pt; padding: 8pt 10pt; white-space: pre-wrap; word-wrap: break-word; margin: 6pt 0; }',
      codePrintCSS('.gd-print'),
      '.gd-print .gd-pagebreak { display: block; break-after: page; page-break-after: always; height: 1px; margin: 0; border: 0; visibility: hidden; }',
      '.gd-print .gd-pagebreak + * { break-before: page; page-break-before: always; }',
      '.gd-print .gd-toc { margin: 6pt 0 12pt; } .gd-print .gd-toc-t { font-size: 14pt; margin: 0 0 6pt; } .gd-print .gd-toc ol { list-style: none; margin: 0; padding: 0; }',
      '.gd-print .gd-toc li { margin: 2pt 0; } .gd-print .gd-toc li.lv2 { padding-left: 18pt; } .gd-print .gd-toc li.lv3 { padding-left: 36pt; } .gd-print .gd-toc li.lv4 { padding-left: 54pt; }',
      '.gd-print .gd-toc a { display: flex; align-items: baseline; color: #000; text-decoration: none; } .gd-print .gd-toc a > span { flex: 0 1 auto; } .gd-print .gd-toc a::before { content: ""; flex: 1 1 auto; order: 2; border-bottom: 1px dotted #888; margin: 0 4pt; min-width: 12pt; }',
      '.gd-print .gd-toc a::after { content: target-counter(attr(href), page); order: 3; flex: 0 0 auto; font-variant-numeric: tabular-nums; }',
      '.gd-print sup { vertical-align: super; font-size: .75em; } .gd-print sub { vertical-align: sub; font-size: .75em; }'
    ].join('\n');
    return '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><base href="' + base + '"><title>' + esc(title || '文件') + '</title>' +
      '<link rel="stylesheet" href="' + base + 'vendor/fonts/fonts.css"><style>' + css + '</style></head><body><article class="gd-print">' + clone.innerHTML + '</article></body></html>';
  }

  // ---------------- DOCX：純瀏覽器端寫出 Word 檔（zip 裡幾個 OOXML） ----------------
  // 只用「儲存」不壓縮的 zip 項目（Word 接受），CRC32 自己算。段落／標題／引言／清單／表格／圖片／連結／
  // 分頁／程式碼區塊／目錄／上下標／對齊／行距／頁面大小與邊界／頁首頁尾與頁碼（PAGE／NUMPAGES 欄位、
  // pgNumType 起始頁碼）都寫得出來；Word、LibreOffice、Google 文件都開得起來。
  let CRC_T = null;
  function crc32(u8) {
    if (!CRC_T) { CRC_T = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC_T[n] = c; } }
    let c = -1;
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function zipStore(entries) {   // entries: [{ name, data: Uint8Array|string }]
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const u16 = function (n) { return [n & 255, (n >> 8) & 255]; }, u32 = function (n) { return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]; };
    const now = new Date(), dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff, dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
    entries.forEach(function (e) {
      const name = enc.encode(e.name), data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      const crc = crc32(data);
      const head = new Uint8Array([].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)));
      parts.push(head, name, data);
      central.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += head.length + name.length + data.length;
    });
    let cdSize = 0; central.forEach(function (c) { cdSize += c.length; });
    const eocd = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cdSize), u32(offset), u16(0)));
    const all = parts.concat(central, [eocd]);
    let total = 0; all.forEach(function (a) { total += a.length; });
    const out = new Uint8Array(total); let pos = 0;
    all.forEach(function (a) { out.set(a, pos); pos += a.length; });
    return out;
  }
  function xml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function hex6(c) {
    if (!c) return null;
    c = String(c).trim();
    let m = /^#([0-9a-f]{6})$/i.exec(c); if (m) return m[1].toUpperCase();
    m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c); if (m) return (m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase();
    m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); if (m) return [m[1], m[2], m[3]].map(function (x) { return ('0' + (+x).toString(16)).slice(-2); }).join('').toUpperCase();
    return null;
  }
  const JC = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', justify: 'both' };
  // 文件 → Word。回傳 Promise<Blob>。
  function docxFromPaper(paper, page, margins, title) {
    const p = cleanPage(page), mm = pageMM(p);
    const twip = function (mmv) { return Math.round(mmv / 25.4 * 1440); }, pxTw = function (px) { return Math.round(px * 15); };
    const pgW = twip(mm[0]), pgH = twip(mm[1]), mL = pxTw(margins.l), mR = pxTw(margins.r), mT = twip(p.mt), mB = twip(p.mb);
    const contentW = pgW - mL - mR;   // twips
    const rels = [], media = [], numLists = [];
    let relN = 3, picN = 0;
    const addRel = function (type, target, external) { const id = 'rId' + (++relN); rels.push('<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type + '" Target="' + xml(target) + '"' + (external ? ' TargetMode="External"' : '') + '/>'); return id; };
    const imgJobs = [];
    // ---- 字元格式 ----
    function rPr(f) {
      let s = '';
      if (f.font) s += '<w:rFonts w:ascii="' + xml(f.font) + '" w:hAnsi="' + xml(f.font) + '" w:eastAsia="' + xml(f.font) + '" w:cs="' + xml(f.font) + '"/>';
      if (f.b) s += '<w:b/><w:bCs/>'; if (f.i) s += '<w:i/><w:iCs/>'; if (f.s) s += '<w:strike/>'; if (f.u) s += '<w:u w:val="single"/>';
      if (f.color) s += '<w:color w:val="' + f.color + '"/>';
      if (f.sz) s += '<w:sz w:val="' + f.sz + '"/><w:szCs w:val="' + f.sz + '"/>';
      if (f.hl) s += '<w:shd w:val="clear" w:color="auto" w:fill="' + f.hl + '"/>';
      if (f.va) s += '<w:vertAlign w:val="' + f.va + '"/>';
      if (f.link) s = '<w:rStyle w:val="Hyperlink"/>' + s;
      return s ? '<w:rPr>' + s + '</w:rPr>' : '';
    }
    function run(text, f) {
      if (!text) return '';
      const lines = text.split('\n');
      return lines.map(function (ln, i) { return '<w:r>' + rPr(f) + (i ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + xml(ln) + '</w:t></w:r>'; }).join('');
    }
    function inlineFmt(node, f) {
      const o = Object.assign({}, f);
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (tag === 'b' || tag === 'strong') o.b = 1; if (tag === 'i' || tag === 'em') o.i = 1; if (tag === 'u') o.u = 1; if (tag === 's' || tag === 'strike' || tag === 'del') o.s = 1;
      if (tag === 'sup') o.va = 'superscript'; if (tag === 'sub') o.va = 'subscript'; if (tag === 'code') o.font = 'Courier New';
      const st = node.style;
      if (st) {
        if (st.fontWeight && (st.fontWeight === 'bold' || +st.fontWeight >= 600)) o.b = 1; if (st.fontWeight === 'normal') o.b = 0;
        if (st.fontStyle === 'italic') o.i = 1;
        if (/underline/.test(st.textDecoration || st.textDecorationLine || '')) o.u = 1; if (/line-through/.test(st.textDecoration || st.textDecorationLine || '')) o.s = 1;
        const c = hex6(st.color); if (c) o.color = c;
        const bg = hex6(st.backgroundColor); if (bg && st.backgroundColor !== 'transparent') o.hl = bg;
        if (st.fontSize) { const m = /^([\d.]+)(pt|px)$/.exec(st.fontSize); if (m) o.sz = Math.round((m[2] === 'px' ? +m[1] * 0.75 : +m[1]) * 2); }
        if (st.fontFamily) o.font = st.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
        if (st.verticalAlign === 'super') o.va = 'superscript'; if (st.verticalAlign === 'sub') o.va = 'subscript';
      }
      if (node.getAttribute && node.getAttribute('color') && hex6(node.getAttribute('color'))) o.color = hex6(node.getAttribute('color'));
      if (node.getAttribute && node.getAttribute('face')) o.font = node.getAttribute('face').split(',')[0].trim();
      return o;
    }
    function imageRun(img) {
      const id = img.getAttribute('data-img-id');
      const src = id ? '/api/images/' + id : img.getAttribute('src');
      if (!src) return '';
      const n = ++picN;
      const rid = 'rIdImg' + n;
      let wpx = img.naturalWidth || img.width || 300, hpx = img.naturalHeight || img.height || 200;
      if (img.style.width && /px$/.test(img.style.width)) { const w2 = parseFloat(img.style.width); hpx = hpx * (w2 / wpx); wpx = w2; }
      else if (img.getAttribute('width')) { const w2 = parseFloat(img.getAttribute('width')); if (w2) { hpx = hpx * (w2 / wpx); wpx = w2; } }
      const maxW = contentW / 15;   // px
      if (wpx > maxW) { hpx = hpx * (maxW / wpx); wpx = maxW; }
      const cx = Math.round(wpx * 9525), cy = Math.round(hpx * 9525);
      imgJobs.push({ rid: rid, src: src, n: n });
      return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + n + '" name="Picture ' + n + '"/>' +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:nvPicPr><pic:cNvPr id="' + n + '" name="Picture ' + n + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    }
    function inlines(node, f) {
      let s = '';
      Array.prototype.forEach.call(node.childNodes, function (c) {
        if (c.nodeType === 3) { s += run(c.nodeValue.replace(/​/g, ''), f); return; }
        if (c.nodeType !== 1) return;
        const tag = c.tagName.toLowerCase();
        if (tag === 'br') { s += '<w:r>' + rPr(f) + '<w:br/></w:r>'; return; }
        if (tag === 'img') { s += imageRun(c); return; }
        if (tag === 'a' && c.getAttribute('href') && /^(https?:|mailto:)/i.test(c.getAttribute('href'))) {
          const rid = addRel('hyperlink', c.getAttribute('href'), true);
          s += '<w:hyperlink r:id="' + rid + '">' + inlines(c, Object.assign(inlineFmt(c, f), { link: 1, color: f.color || '1155CC', u: 1 })) + '</w:hyperlink>';
          return;
        }
        s += inlines(c, inlineFmt(c, f));
      });
      return s;
    }
    function pPr(el, o) {
      o = o || {};
      let s = '';
      if (o.style) s += '<w:pStyle w:val="' + o.style + '"/>';
      if (o.numId) s += '<w:numPr><w:ilvl w:val="' + (o.ilvl || 0) + '"/><w:numId w:val="' + o.numId + '"/></w:numPr>';
      if (o.pageBreakBefore) s += '<w:pageBreakBefore/>';
      const st = el && el.style;
      let spacing = '';
      if (st) {
        if (st.lineHeight && /^[\d.]+$/.test(st.lineHeight)) spacing += ' w:line="' + Math.round(parseFloat(st.lineHeight) * 240) + '" w:lineRule="auto"';
        if (st.marginTop && /pt$/.test(st.marginTop)) spacing += ' w:before="' + Math.round(parseFloat(st.marginTop) * 20) + '"';
        if (st.marginBottom && /pt$/.test(st.marginBottom)) spacing += ' w:after="' + Math.round(parseFloat(st.marginBottom) * 20) + '"';
      }
      if (spacing) s += '<w:spacing' + spacing + '/>';
      if (st) {
        let ind = '';
        const ml = st.marginLeft && /px$/.test(st.marginLeft) ? pxTw(parseFloat(st.marginLeft)) : 0;
        const ti = st.textIndent && /px$/.test(st.textIndent) ? pxTw(parseFloat(st.textIndent)) : (st.textIndent && /pt$/.test(st.textIndent) ? Math.round(parseFloat(st.textIndent) * 20) : 0);
        if (ml) ind += ' w:left="' + ml + '"'; if (ti) ind += ' w:firstLine="' + ti + '"';
        if (ind) s += '<w:ind' + ind + '/>';
        const ta = st.textAlign;
        if (st.textAlignLast === 'justify') s += '<w:jc w:val="distribute"/>';
        else if (ta && JC[ta]) s += '<w:jc w:val="' + JC[ta] + '"/>';
        else if (el && el.getAttribute && el.getAttribute('align') && JC[el.getAttribute('align')]) s += '<w:jc w:val="' + JC[el.getAttribute('align')] + '"/>';
      }
      return s ? '<w:pPr>' + s + '</w:pPr>' : '';
    }
    function para(el, o, f) { return '<w:p>' + pPr(el, o) + inlines(el, f || {}) + '</w:p>'; }
    const BLOCK = 'p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,li,table,pre,hr,div,nav,section,article,header,footer';
    function hasBlock(el) { return !!el.querySelector(BLOCK); }
    function list(el, numId, depth) {
      let s = '';
      Array.prototype.forEach.call(el.children, function (li) {
        if (li.tagName.toLowerCase() !== 'li') { s += blocks(li, {}); return; }
        // 清單項目自己的文字（子清單另外處理）
        const own = li.cloneNode(true);
        Array.prototype.forEach.call(own.querySelectorAll('ul, ol'), function (x) { x.remove(); });
        s += '<w:p>' + pPr(li, { numId: numId, ilvl: Math.min(depth, 8) }) + inlines(own, {}) + '</w:p>';
        Array.prototype.forEach.call(li.children, function (c) { const t = c.tagName.toLowerCase(); if (t === 'ul' || t === 'ol') s += list(c, t === 'ol' ? newNum(1) : 1, depth + 1); });
      });
      return s;
    }
    function newNum(abstractId) { const id = numLists.length + 3; numLists.push({ id: id, abs: abstractId }); return id; }
    function table(tb) {
      const rows = Array.prototype.filter.call(tb.querySelectorAll('tr'), function (r) { return r.closest('table') === tb; });
      if (!rows.length) return '';
      let cols = 0; rows.forEach(function (r) { cols = Math.max(cols, r.children.length); });
      const cg = tb.querySelector('colgroup');
      let widths = [];
      if (cg && cg.children.length === cols) widths = Array.prototype.map.call(cg.children, function (c) { const w = parseFloat(c.style.width); return w ? w / 100 : 1 / cols; });
      if (widths.length !== cols) { widths = []; for (let i = 0; i < cols; i++) widths.push(1 / cols); }
      const sum = widths.reduce(function (a, b) { return a + b; }, 0); widths = widths.map(function (w) { return Math.round(contentW * w / sum); });
      const border = '<w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/>';
      let s = '<w:tbl><w:tblPr><w:tblW w:w="' + contentW + '" w:type="dxa"/><w:tblBorders>' + border + '</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>' + widths.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join('') + '</w:tblGrid>';
      rows.forEach(function (r) {
        s += '<w:tr>';
        for (let i = 0; i < cols; i++) {
          const cell = r.children[i];
          const bg = cell && hex6(cell.style.backgroundColor);
          s += '<w:tc><w:tcPr><w:tcW w:w="' + widths[i] + '" w:type="dxa"/>' + (bg ? '<w:shd w:val="clear" w:color="auto" w:fill="' + bg + '"/>' : '') + '</w:tcPr>';
          const inner = cell ? (hasBlock(cell) ? blocks(cell, {}) : para(cell, {}, cell.tagName.toLowerCase() === 'th' ? { b: 1 } : {})) : '<w:p/>';
          s += (inner || '<w:p/>') + '</w:tc>';
        }
        s += '</w:tr>';
      });
      return s + '</w:tbl><w:p/>';
    }
    function blocks(root, ctx) {
      let s = '';
      Array.prototype.forEach.call(root.childNodes, function (el) {
        if (el.nodeType === 3) { if (el.nodeValue.trim()) s += '<w:p>' + run(el.nodeValue, {}) + '</w:p>'; return; }
        if (el.nodeType !== 1) return;
        const tag = el.tagName.toLowerCase();
        if (el.classList.contains('gd-pagebreak')) { s += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'; return; }
        if (el.classList.contains('gd-toc')) {
          s += '<w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr>' + run((el.querySelector('.gd-toc-t') || {}).textContent || '目錄', {}) + '</w:p>';
          Array.prototype.forEach.call(el.querySelectorAll('li'), function (li) { const lv = /lv(\d)/.exec(li.className); s += '<w:p><w:pPr><w:pStyle w:val="TOC' + (lv ? lv[1] : 1) + '"/></w:pPr>' + run(li.textContent.trim(), {}) + '</w:p>'; });
          return;
        }
        if (el.classList.contains('gd-hf') || el.classList.contains('gd-toc-tools')) return;
        if (/^h[1-6]$/.test(tag)) { s += para(el, { style: 'Heading' + tag[1] }); return; }
        if (tag === 'blockquote') { s += hasBlock(el) ? Array.prototype.map.call(el.children, function (c) { return para(c, { style: 'Quote' }); }).join('') : para(el, { style: 'Quote' }); return; }
        if (tag === 'pre') {
          // 一行一段 Code，token 的顏色照編輯器上色的群組（Word 沒有逐段的行號，行號不帶過去）
          const text = preText(el), segs = codeSegments(text, codeLang(el));
          let off = 0, k = 0;
          text.split('\n').forEach(function (ln) {
            const ls = off, le = off + ln.length;
            let runs = '', p0 = ls;
            while (k < segs.length && segs[k].e <= ls) k++;
            for (let i = k; i < segs.length && segs[i].s < le; i++) {
              const a = Math.max(segs[i].s, ls), z = Math.min(segs[i].e, le);
              if (a > p0) runs += run(text.slice(p0, a), { font: 'Courier New', sz: 20 });
              runs += run(text.slice(a, z), { font: 'Courier New', sz: 20, color: TOKEN_HEX[segs[i].g] });
              p0 = z;
            }
            if (p0 < le) runs += run(text.slice(p0, le), { font: 'Courier New', sz: 20 });
            s += '<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>' + (runs || run(' ', { font: 'Courier New', sz: 20 })) + '</w:p>';
            off = le + 1;
          });
          return;
        }
        if (tag === 'ul') { s += list(el, 1, 0); return; }
        if (tag === 'ol') { s += list(el, newNum(1), 0); return; }
        if (tag === 'table') { s += table(el); return; }
        if (tag === 'hr') { s += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="000000"/></w:pBdr></w:pPr></w:p>'; return; }
        if (tag === 'img') { s += '<w:p>' + imageRun(el) + '</w:p>'; return; }
        if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'nav') {
          if (hasBlock(el)) { s += blocks(el, ctx); return; }
          s += para(el, {}); return;
        }
        // 其他行內元素直接在最上層：包成一段
        s += '<w:p>' + inlines(el, inlineFmt(el, {})) + '</w:p>';
      });
      return s;
    }
    const body = blocks(paper, {}) || '<w:p/>';
    // ---- 頁首／頁尾 ----
    const jc = function (a) { return '<w:jc w:val="' + (a === 'center' ? 'center' : a === 'right' ? 'right' : 'left') + '"/>'; };
    const fld = function (name) { return '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ' + name + ' </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'; };
    const numRuns = p.numFmt === 'page-n' ? run('第 ', {}) + fld('PAGE') + run(' 頁', {}) : p.numFmt === 'n-of-total' ? fld('PAGE') + run(' / ', {}) + fld('NUMPAGES') : fld('PAGE');
    function hfXML(kind) {
      const text = kind === 'header' ? p.header : p.footer, align = kind === 'header' ? p.headerAlign : p.footerAlign;
      const paras = [];
      if (p.num && p.numPos === kind && text && p.numAlign === align) paras.push('<w:p><w:pPr><w:pStyle w:val="' + (kind === 'header' ? 'Header' : 'Footer') + '"/>' + jc(align) + '</w:pPr>' + run(text + '  ', {}) + numRuns + '</w:p>');
      else {
        if (text) paras.push('<w:p><w:pPr><w:pStyle w:val="' + (kind === 'header' ? 'Header' : 'Footer') + '"/>' + jc(align) + '</w:pPr>' + run(text, {}) + '</w:p>');
        if (p.num && p.numPos === kind) paras.push('<w:p><w:pPr><w:pStyle w:val="' + (kind === 'header' ? 'Header' : 'Footer') + '"/>' + jc(p.numAlign) + '</w:pPr>' + numRuns + '</w:p>');
      }
      if (!paras.length) return null;
      const root = kind === 'header' ? 'hdr' : 'ftr';
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:' + root + ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' + paras.join('') + '</w:' + root + '>';
    }
    const headerXML = hfXML('header'), footerXML = hfXML('footer');
    let sect = '';
    if (headerXML) { const rid = addRel('header', 'header1.xml'); sect += '<w:headerReference w:type="default" r:id="' + rid + '"/>'; }
    if (footerXML) { const rid = addRel('footer', 'footer1.xml'); sect += '<w:footerReference w:type="default" r:id="' + rid + '"/>'; }
    if (p.skipFirst && (headerXML || footerXML)) {
      const empty = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:hdr>';
      if (headerXML) { const rid = addRel('header', 'header2.xml'); sect += '<w:headerReference w:type="first" r:id="' + rid + '"/>'; media.push({ name: 'word/header2.xml', data: empty }); }
      if (footerXML) { const rid = addRel('footer', 'footer2.xml'); sect += '<w:footerReference w:type="first" r:id="' + rid + '"/>'; media.push({ name: 'word/footer2.xml', data: empty.replace(/hdr/g, 'ftr') }); }
    }
    sect += '<w:pgSz w:w="' + pgW + '" w:h="' + pgH + '"' + (p.orient === 'landscape' ? ' w:orient="landscape"' : '') + '/>';
    sect += '<w:pgMar w:top="' + mT + '" w:right="' + mR + '" w:bottom="' + mB + '" w:left="' + mL + '" w:header="' + Math.round(mT / 2) + '" w:footer="' + Math.round(mB / 2) + '" w:gutter="0"/>';
    if (p.num) sect += '<w:pgNumType w:start="' + p.numStart + '"/>';
    if (p.skipFirst) sect += '<w:titlePg/>';
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
    const documentXML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + NS + '><w:body>' + body + '<w:sectPr>' + sect + '</w:sectPr></w:body></w:document>';
    const h = function (id, name, sz, color, before) { return '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="' + before + '" w:after="120"/><w:outlineLvl w:val="' + (parseInt(id.slice(-1), 10) - 1) + '"/></w:pPr><w:rPr><w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/>' + (color ? '<w:color w:val="' + color + '"/>' : '') + '</w:rPr></w:style>'; };
    const stylesXML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft JhengHei" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      h('Heading1', 'heading 1', 40, null, 400) + h('Heading2', 'heading 2', 32, null, 360) + h('Heading3', 'heading 3', 28, '434343', 320) + h('Heading4', 'heading 4', 24, '666666', 280) +
      '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="999999"/></w:pBdr><w:ind w:left="240"/><w:spacing w:before="120" w:after="120"/></w:pPr><w:rPr><w:color w:val="444444"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F1F3F4"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:sz w:val="28"/></w:rPr></w:style>' +
      [1, 2, 3, 4].map(function (i) { return '<w:style w:type="paragraph" w:styleId="TOC' + i + '"><w:name w:val="toc ' + i + '"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="' + ((i - 1) * 360) + '"/><w:spacing w:after="60"/></w:pPr></w:style>'; }).join('') +
      '<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/><w:color w:val="444444"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/><w:color w:val="444444"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1155CC"/><w:u w:val="single"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style></w:styles>';
    const lvl = function (i, bullet) { return '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="' + (bullet ? 'bullet' : (i % 3 === 0 ? 'decimal' : i % 3 === 1 ? 'lowerLetter' : 'lowerRoman')) + '"/><w:lvlText w:val="' + (bullet ? ['•', 'o', '▪'][i % 3] : '%' + (i + 1) + '.') + '"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' + (720 + i * 360) + '" w:hanging="360"/></w:pPr>' + (bullet ? '<w:rPr><w:rFonts w:ascii="' + (i % 3 === 1 ? 'Courier New' : 'Arial') + '" w:hAnsi="' + (i % 3 === 1 ? 'Courier New' : 'Arial') + '"/></w:rPr>' : '') + '</w:lvl>'; };
    const levels = function (bullet) { let s = ''; for (let i = 0; i < 9; i++) s += lvl(i, bullet); return s; };
    const numberingXML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + levels(true) + '</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' + levels(false) + '</w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
      numLists.map(function (n) { return '<w:num w:numId="' + n.id + '"><w:abstractNumId w:val="' + n.abs + '"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>'; }).join('') + '</w:numbering>';
    // ---- 圖片：抓位元組，型別決定副檔名；WebP／其他畫到 canvas 轉 PNG ----
    const fetchImg = function (job) {
      return fetch(job.src, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('image'); return r.blob(); }).then(function (blob) {
        const type = blob.type;
        if (type === 'image/png' || type === 'image/jpeg' || type === 'image/gif') return blob.arrayBuffer().then(function (buf) { return { ext: type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpeg' : 'gif', data: new Uint8Array(buf) }; });
        return new Promise(function (res, rej) {
          const url = URL.createObjectURL(blob), im = new Image();
          im.onload = function () { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); URL.revokeObjectURL(url); c.toBlob(function (b2) { if (!b2) return rej(new Error('png')); b2.arrayBuffer().then(function (buf) { res({ ext: 'png', data: new Uint8Array(buf) }); }); }, 'image/png'); };
          im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('decode')); };
          im.src = url;
        });
      }).then(function (r) { media.push({ name: 'word/media/image' + job.n + '.' + r.ext, data: r.data }); rels.push('<Relationship Id="' + job.rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + job.n + '.' + r.ext + '"/>'); }, function () {
        // 抓不到就放一個 1×1 的透明 PNG，Word 才不會說檔案壞掉
        const px = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), function (c) { return c.charCodeAt(0); });
        media.push({ name: 'word/media/image' + job.n + '.png', data: px }); rels.push('<Relationship Id="' + job.rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + job.n + '.png"/>');
      });
    };
    return Promise.all(imgJobs.map(fetchImg)).then(function () {
      const exts = {};
      media.forEach(function (m) { const e = /\.(\w+)$/.exec(m.name); if (e && e[1] !== 'xml') exts[e[1]] = e[1] === 'jpeg' ? 'image/jpeg' : 'image/' + e[1]; });
      const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        Object.keys(exts).map(function (e) { return '<Default Extension="' + e + '" ContentType="' + exts[e] + '"/>'; }).join('') +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        (headerXML ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '') + (footerXML ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '') +
        (p.skipFirst && headerXML ? '<Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '') + (p.skipFirst && footerXML ? '<Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '') +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
      const relsRoot = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
      const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' + rels.join('') + '</Relationships>';
      const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + xml(title || '') + '</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>';
      const entries = [{ name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: relsRoot }, { name: 'word/_rels/document.xml.rels', data: docRels }, { name: 'word/document.xml', data: documentXML }, { name: 'word/styles.xml', data: stylesXML }, { name: 'word/numbering.xml', data: numberingXML }, { name: 'docProps/core.xml', data: core }];
      if (headerXML) entries.push({ name: 'word/header1.xml', data: headerXML });
      if (footerXML) entries.push({ name: 'word/footer1.xml', data: footerXML });
      media.forEach(function (m) { entries.push(m); });
      return new Blob([zipStore(entries)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    });
  }
  function downloadBlob(name, blob) { const a = document.createElement('a'); const url = URL.createObjectURL(blob); a.href = url; a.download = name; a.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1500); }
  function safeName(t) { return (String(t || '').trim() || '文件').replace(/[\\/:*?"<>|]+/g, '_'); }

  // ---------------- 編輯器 ----------------
  // opts: { container, readOnly, banner, margins, onMargins, page, onPage, getTitle, onChange(html), onUpload(files) → Promise<[{ id, alt }]> }
  function open(content, opts) {
    opts = opts || {};
    const host = opts.container;
    if (!host) return { close: function () {}, discard: function () {}, flush: function () { return Promise.resolve(); } };
    const ro = !!opts.readOnly;
    let closed = false, dirty = false, saveTimer = null, savedRange = null;

    host.classList.add('gd-page');
    host.innerHTML =
      (opts.banner ? '<div class="gd-ro">' + ic('lock') + '<span>' + esc(opts.banner) + '</span></div>' : '') +
      (ro ? '' :
      '<div class="gd-menubar">' + [['file', '檔案'], ['insert', '插入'], ['format', '格式'], ['tools', '工具']].map(function (m) { return '<button class="gd-menu" type="button" data-menu="' + m[0] + '">' + m[1] + '</button>'; }).join('') + '<span class="gd-tb-sp"></span><span class="gd-count"></span><span class="gd-status" aria-live="polite"></span></div>' +
      '<div class="gd-toolbar">' +
      tb('undo', 'undo', '復原 (Ctrl+Z)') + tb('redo', 'redo', '重做 (Ctrl+Y)') + sep() +
      '<select class="gd-sel gd-sel-style" data-sel="style" title="樣式">' + STYLES.map(function (s) { return '<option value="' + s[0] + '">' + s[1] + '</option>'; }).join('') + '</select>' + sep() +
      '<select class="gd-sel gd-sel-font" data-sel="font" title="字型">' + FONTS.map(function (f) { return '<option value="' + esc(f.v) + '" style="font-family:' + esc(f.v) + '">' + esc(f.label) + '</option>'; }).join('') + '</select>' + sep() +
      '<button class="gd-tb gd-size-btn" type="button" data-act="size-" title="縮小字級">' + ic('minus') + '</button>' +
      '<input class="gd-size" type="text" inputmode="numeric" value="11" title="字級（pt）" aria-label="字級">' +
      '<button class="gd-tb gd-size-btn" type="button" data-act="size+" title="放大字級">' + ic('plus') + '</button>' + sep() +
      tb('bold', 'bold', '粗體 (Ctrl+B)') + tb('italic', 'italic', '斜體 (Ctrl+I)') + tb('underline', 'underline', '底線 (Ctrl+U)') + tb('strikeThrough', 'strikethrough', '刪除線') +
      '<button class="gd-tb gd-color-btn" type="button" data-act="color" title="文字顏色">' + ic('type') + '<span class="gd-color-bar" style="background:#000"></span></button>' +
      '<button class="gd-tb gd-color-btn" type="button" data-act="hilite" title="螢光筆顏色">' + ic('highlighter') + '<span class="gd-color-bar" style="background:#ffff00"></span></button>' + sep() +
      tb('link', 'link', '插入連結 (Ctrl+K)') + tb('image', 'image', '插入圖片') + sep() +
      tb('justifyLeft', 'align-left', '靠左對齊') + tb('justifyCenter', 'align-center', '置中對齊') + tb('justifyRight', 'align-right', '靠右對齊') + tb('justifyFull', 'align-justify', '左右對齊') + tb('distribute', 'align-distribute', '分散對齊（字與字拉開撐滿整行，最後一行也是）') + sep() +
      tb('insertUnorderedList', 'list', '項目符號清單') + tb('insertOrderedList', 'list-ordered', '編號清單') + tb('outdent', 'outdent', '減少縮排') + tb('indent', 'indent', '增加縮排') + sep() +
      tb('table', 'table', '插入表格') + tb('hr', 'minus', '分隔線') + tb('pagebreak', 'file-page', '分頁符號 (Ctrl+Enter)') + sep() +
      tb('linespacing', 'arrow-up-down', '行距與段落間距') + tb('code', 'square-code', '程式碼區塊') + tb('superscript', 'superscript', '上標 (Ctrl+.)') + tb('subscript', 'subscript', '下標 (Ctrl+,)') + tb('removeFormat', 'eraser', '清除格式') +
      '</div>') +
      '<div class="gd-scroll">' + (ro ? '' : '<div class="gd-ruler" aria-hidden="true"><div class="gd-ruler-in"><div class="gd-ruler-shade gd-ruler-shade-l"></div><div class="gd-ruler-shade gd-ruler-shade-r"></div><div class="gd-ruler-scale"></div>' +
      '<div class="gd-rm gd-rm-margin-l" data-rm="ml" title="左邊界"></div><div class="gd-rm gd-rm-margin-r" data-rm="mr" title="右邊界"></div>' +
      '<div class="gd-rm gd-rm-first" data-rm="first" title="首行縮排"></div><div class="gd-rm gd-rm-indent" data-rm="indent" title="左縮排"></div></div></div>') +
      '<div class="gd-sheet"><div class="gd-hf gd-hf-top"></div>' +
      '<div class="gd-paper markdown-body"' + (ro ? '' : ' contenteditable="true" spellcheck="true"') + '></div>' +
      '<div class="gd-hf gd-hf-bottom"></div></div></div>';
    function tb(act, icon, title) { return '<button class="gd-tb" type="button" data-act="' + act + '" title="' + title + '">' + ic(icon) + '</button>'; }
    function sep() { return '<span class="gd-tb-sep"></span>'; }

    const paper = host.querySelector('.gd-paper');
    const toolbar = host.querySelector('.gd-toolbar');
    const statusEl = host.querySelector('.gd-status');
    const countEl = host.querySelector('.gd-count');
    const sizeEl = host.querySelector('.gd-size');
    const styleSel = host.querySelector('[data-sel="style"]');
    const fontSel = host.querySelector('[data-sel="font"]');
    paper.innerHTML = toLive(content) || '<p><br></p>';
    // 邊界（meta.docMargins，px）：紙的左右 padding；尺規上的兩個灰色邊界標記拖它
    let margins = Object.assign({ l: MARGIN_DEF, r: MARGIN_DEF }, opts.margins || {});
    function applyMargins() {
      margins.l = Math.max(24, Math.min(PAPER_W / 2 - 60, Math.round(margins.l)));
      margins.r = Math.max(24, Math.min(PAPER_W / 2 - 60, Math.round(margins.r)));
      paper.style.paddingLeft = margins.l + 'px'; paper.style.paddingRight = margins.r + 'px';
      drawRuler();
      if (typeof drawHF === 'function') drawHF();
    }
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); document.execCommand('styleWithCSS', false, true); } catch (e) { /* */ }

    function setStatus(t, cls) { if (statusEl) { statusEl.textContent = t || ''; statusEl.className = 'gd-status' + (cls ? ' ' + cls : ''); } }
    function count() { if (countEl) { const n = (paper.textContent || '').replace(/\s+/g, '').length; countEl.textContent = n ? n + ' 字' : ''; } }
    function emit() {
      clearTimeout(saveTimer);
      if (!dirty || !opts.onChange) return Promise.resolve();
      dirty = false;
      setStatus('儲存中…');
      return Promise.resolve(opts.onChange(toStored(paper))).then(function () { if (!closed && !dirty) setStatus('已儲存', 'is-ok'); }, function () { if (!closed) setStatus('儲存失敗', 'is-err'); });
    }
    function changed() { dirty = true; setStatus('尚未儲存'); clearTimeout(saveTimer); saveTimer = setTimeout(emit, 500); count(); syncCode(false); }

    // ---- 選取範圍：工具列按下去會搶焦點，先記住再還回去 ----
    function saveRange() {
      const s = window.getSelection();
      if (s && s.rangeCount && paper.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
    }
    // 選取還在紙上（按鈕的 mousedown 有 preventDefault，焦點沒跑）就用現在這個；焦點跑到 select／輸入框
    // 去了才把記住的那個放回來
    function restoreRange() {
      const s = window.getSelection();
      if (s && s.rangeCount && paper.contains(s.anchorNode) && document.activeElement === paper) return;
      paper.focus();
      if (!savedRange) return;
      s.removeAllRanges(); s.addRange(savedRange);
    }
    function exec(cmd, val) {
      restoreRange();
      try { document.execCommand(cmd, false, val); } catch (e) { /* */ }
      saveRange();
      changed(); refresh();
    }

    // ---- 程式碼區塊：上色（Custom Highlight API）、行號（區塊自己的 ::before）、右上角的語言列 ----
    // 行號畫在 <pre> 的 ::before，內容是 data-gd-ln（「1\n2\n\n3」：折到下一列的那幾列留白，所以長行折行時號碼還是
    // 對著該行的第一列）；data-gd-lnw 是位數，決定左邊留多寬。兩個屬性都只在編輯器裡，存檔時 toStored 拿掉。
    const sheet = host.querySelector('.gd-sheet');
    const HL = !!(global.CSS && CSS.highlights && typeof global.Highlight === 'function');
    const hlSets = {};
    if (HL) TOKEN_GROUPS.forEach(function (g) { const h = new Highlight(); h.priority = -1; hlSets[g] = h; CSS.highlights.set('gd-t-' + g, h); });
    const codeState = new Map();   // pre → { key: 語言＋行號設定＋文字, ranges: [[群組, Range]] }
    // 區塊的純文字（<br> 算一個換行）與「第 k 個字在 DOM 的哪裡」
    function codeMap(pre) {
      const pieces = [];
      let text = '';
      (function walk(n) {
        Array.prototype.forEach.call(n.childNodes, function (c) {
          if (c.nodeType === 3) { pieces.push({ n: c, s: text.length }); text += c.nodeValue; }
          else if (c.nodeName === 'BR') { pieces.push({ n: c, s: text.length, br: true }); text += '\n'; }
          else if (c.nodeType === 1) walk(c);
        });
      })(pre);
      function at(k) {
        let lo = 0, hi = pieces.length - 1, f = -1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (pieces[mid].s <= k) { f = mid; lo = mid + 1; } else hi = mid - 1; }
        if (f < 0) return { node: pre, offset: 0 };
        const p = pieces[f];
        if (!p.br && k - p.s <= p.n.nodeValue.length) return { node: p.n, offset: k - p.s };
        const idx = Array.prototype.indexOf.call(p.n.parentNode.childNodes, p.n);
        return { node: p.n.parentNode, offset: k === p.s ? idx : idx + 1 };
      }
      return { text: text, at: at };
    }
    // 畫面上看得到幾行：最後一個換行（Chrome 在區塊尾巴放的 <br>）不會多出一行
    function visibleLines(text) { const n = text.split('\n').length; return text.charAt(text.length - 1) === '\n' ? n - 1 : n; }
    function unpaint(pre) { const st = codeState.get(pre); if (st) st.ranges.forEach(function (x) { hlSets[x[0]].delete(x[1]); }); }
    function paintCode(pre, m) {
      unpaint(pre);
      const ranges = [];
      if (HL) codeSegments(m.text, codeLang(pre)).forEach(function (sg) {
        const a = m.at(sg.s), z = m.at(sg.e);
        try { const r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(z.node, z.offset); hlSets[sg.g].add(r); ranges.push([sg.g, r]); } catch (e) { /* */ }
      });
      return ranges;
    }
    function numberCode(pre, m) {
      if (pre.getAttribute('data-ln') === 'off') { pre.removeAttribute('data-gd-ln'); pre.removeAttribute('data-gd-lnw'); return; }
      const n = visibleLines(m.text);
      const w = String(Math.max(2, String(n).length));
      if (pre.getAttribute('data-gd-lnw') !== w) pre.setAttribute('data-gd-lnw', w);
      if (!pre.hasAttribute('data-gd-ln')) pre.setAttribute('data-gd-ln', '1');   // 左邊先留好寬度，量折行才準
      const cs = getComputedStyle(pre), lh = parseFloat(cs.lineHeight) || 19;
      const inner = pre.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      const nums = [];
      if (Math.round(inner / lh) <= n) { for (let i = 1; i <= n; i++) nums.push(i); }
      else {
        // 有行折到下一列：一行一行量它占幾列（每列的 top 不同），折出來的列行號留白
        const parts = m.text.split('\n');
        let off = 0;
        for (let i = 0; i < n; i++) {
          let rows = 1;
          if (parts[i].length) {
            const a = m.at(off), z = m.at(off + parts[i].length), r = document.createRange();
            r.setStart(a.node, a.offset); r.setEnd(z.node, z.offset);
            const tops = [];
            Array.prototype.forEach.call(r.getClientRects(), function (c) {
              if (c.width < 0.5) return;
              if (!tops.some(function (t) { return Math.abs(t - c.top) < lh / 2; })) tops.push(c.top);
            });
            rows = Math.max(1, tops.length);
          }
          nums.push(i + 1);
          for (let k = 1; k < rows; k++) nums.push('');
          off += parts[i].length + 1;
        }
      }
      const v = nums.join('\n');
      if (pre.getAttribute('data-gd-ln') !== v) pre.setAttribute('data-gd-ln', v);
    }
    // 文字或語言變了的區塊重新上色、重算行號；all（紙的寬度變了、剛載入）是每個區塊都重算行號
    function syncCode(all) {
      codeState.forEach(function (st, pre) { if (!paper.contains(pre)) { unpaint(pre); codeState.delete(pre); } });
      Array.prototype.forEach.call(paper.querySelectorAll('pre'), function (pre) {
        if (!pre.classList.contains('gd-code')) pre.classList.add('gd-code');   // 貼進來的 <pre> 也是程式碼區塊
        const m = codeMap(pre), key = codeLang(pre) + '\u0000' + (pre.getAttribute('data-ln') || '') + '\u0000' + m.text;
        const st = codeState.get(pre), fresh = !st || st.key !== key;
        if (fresh) codeState.set(pre, { key: key, ranges: paintCode(pre, m) });
        if (fresh || all) numberCode(pre, m);
      });
      placeCodeBar();
    }
    let lastPaperW = 0;
    const codeRO = typeof ResizeObserver === 'function' ? new ResizeObserver(function () {
      const w = paper.clientWidth;
      if (w !== lastPaperW) { lastPaperW = w; syncCode(true); }
    }) : null;
    if (codeRO) codeRO.observe(paper);

    // 右上角的語言列：游標在區塊裡、或滑鼠停在區塊上時出現。放在 .gd-sheet 裡（不在紙裡），不會變成內容的一部分
    let codeBar = null, langSel = null, barPre = null, hoverPre = null, barTimer = null;
    if (!ro && sheet) {
      codeBar = el('div', 'gd-code-bar');
      codeBar.hidden = true;
      codeBar.innerHTML = '<select class="gd-code-lang" title="程式語言（決定怎麼上色）">' + CODE_LANGS.map(function (x) { return '<option value="' + x[0] + '">' + esc(x[1]) + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="gd-code-btn" data-code="ln" title="顯示／隱藏行號">' + ic('list-ordered') + '</button>' +
        '<button type="button" class="gd-code-btn" data-code="copy" title="複製程式碼">' + ic('copy') + '</button>';
      sheet.appendChild(codeBar);
      langSel = codeBar.querySelector('.gd-code-lang');
      codeBar.addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
      codeBar.addEventListener('mouseenter', function () { clearTimeout(barTimer); });
      codeBar.addEventListener('mouseleave', leaveSoon);
      codeBar.addEventListener('click', function (e) {
        const b = e.target.closest('[data-code]');
        const pre = barPre;
        if (!b || !pre || !paper.contains(pre)) return;
        if (b.getAttribute('data-code') === 'ln') {
          if (pre.getAttribute('data-ln') === 'off') pre.removeAttribute('data-ln'); else pre.setAttribute('data-ln', 'off');
          changed();
          return;
        }
        copyText(preText(pre)).then(function () { b.classList.add('is-done'); setTimeout(function () { b.classList.remove('is-done'); }, 1200); }, function () {});
      });
      langSel.addEventListener('change', function () {
        const pre = barPre;
        if (!pre || !paper.contains(pre)) return;
        if (langSel.value) pre.setAttribute('data-lang', langSel.value); else pre.removeAttribute('data-lang');
        restoreRange(); changed();
      });
      langSel.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape') restoreRange(); });
      paper.addEventListener('mousemove', function (e) {
        const p = e.target.closest ? e.target.closest('pre') : null;
        const hit = p && paper.contains(p) ? p : null;
        if (hit) clearTimeout(barTimer);
        if (hit === hoverPre) return;
        hoverPre = hit; placeCodeBar();
      });
      // 從區塊移到語言列上會先離開紙：晚一點再收，語言列的 mouseenter 來得及取消
      paper.addEventListener('mouseleave', leaveSoon);
    }
    function leaveSoon() { clearTimeout(barTimer); barTimer = setTimeout(function () { hoverPre = null; placeCodeBar(); }, 250); }
    function copyText(t) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove(); restoreRange();
      return ok ? Promise.resolve() : Promise.reject(new Error('copy'));
    }
    function blockPre(n) {
      if (!n) return null;
      if (n.nodeType === 3) n = n.parentNode;
      const p = n && n.closest ? n.closest('pre') : null;
      return p && paper.contains(p) ? p : null;
    }
    function placeCodeBar() {
      if (!codeBar) return;
      let pre = (codeBar.contains(document.activeElement) && barPre && paper.contains(barPre)) ? barPre : null;
      if (!pre && hoverPre && paper.contains(hoverPre)) pre = hoverPre;
      if (!pre && document.activeElement === paper) { const s = window.getSelection(); pre = s && s.rangeCount ? blockPre(s.anchorNode) : null; }
      barPre = pre;
      if (!pre) { codeBar.hidden = true; return; }
      codeBar.hidden = false;
      if (document.activeElement !== langSel) langSel.value = codeLang(pre);
      codeBar.querySelector('[data-code="ln"]').classList.toggle('on', pre.getAttribute('data-ln') !== 'off');
      const sr = sheet.getBoundingClientRect(), pr = pre.getBoundingClientRect();
      codeBar.style.top = Math.round(pr.top - sr.top + 4) + 'px';
      codeBar.style.right = Math.round(sr.right - pr.right + 4) + 'px';
    }

    // ---- 程式碼區塊裡的按鍵：Tab 是四個空白、多行一起縮排，Enter 照上一行的縮排，Backspace 在行首空白一次退一格 ----
    // 全部走 execCommand('insertText'／'delete')：原生的復原一步就能還原，input 事件照樣觸發存檔與上色
    function selPre() {
      const s = window.getSelection();
      if (!s || !s.rangeCount) return null;
      const r = s.getRangeAt(0), pre = blockPre(r.startContainer);
      return pre && pre === blockPre(r.endContainer) ? pre : null;
    }
    function preOffset(pre, node, off) {
      const r = document.createRange();
      r.setStart(pre, 0); r.setEnd(node, off);
      let k = 0;
      (function walk(n) { Array.prototype.forEach.call(n.childNodes, function (c) { if (c.nodeType === 3) k += c.nodeValue.length; else if (c.nodeName === 'BR') k++; else if (c.nodeType === 1) walk(c); }); })(r.cloneContents());
      return k;
    }
    function selOffsets(pre) { const r = window.getSelection().getRangeAt(0); return [preOffset(pre, r.startContainer, r.startOffset), preOffset(pre, r.endContainer, r.endOffset)]; }
    function selectIn(pre, a, z) {
      const m = codeMap(pre), p = m.at(a), q = m.at(z), r = document.createRange();
      r.setStart(p.node, p.offset); r.setEnd(q.node, q.offset);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }
    function codeTab(pre, outdent) {
      const t = codeMap(pre).text, o = selOffsets(pre), a = o[0], z = o[1];
      if (!outdent && a === z) { document.execCommand('insertText', false, '    '); return; }
      // 有選取（或 Shift+Tab）：選到的每一行整行加／減四個空白
      const ls = t.lastIndexOf('\n', a - 1) + 1;
      const z2 = (z > a && t.charAt(z - 1) === '\n') ? z - 1 : z;   // 只選到下一行的開頭，那一行不算
      let le = t.indexOf('\n', z2); if (le < 0) le = t.length;
      const lines = t.slice(ls, le).split('\n'), starts = [], deltas = [];
      let pos = ls;
      const out = lines.map(function (ln) {
        starts.push(pos); pos += ln.length + 1;
        let nl = ln;
        if (!outdent) nl = ln.length ? '    ' + ln : ln;   // 空行不加，跟 VS Code 一樣
        else { const k = /^(\t| {1,4})/.exec(ln); if (k) nl = ln.slice(k[0].length); }
        deltas.push(nl.length - ln.length);
        return nl;
      });
      if (deltas.every(function (d) { return !d; })) return;
      const mapOff = function (p) {
        let q = p;
        for (let i = 0; i < lines.length; i++) {
          const s0 = starts[i], d = deltas[i];
          if (d > 0) { if (s0 < p) q += d; }
          else if (d < 0) { if (p >= s0 - d) q += d; else if (p > s0) q -= p - s0; }
        }
        return q;
      };
      selectIn(pre, ls, le);
      document.execCommand('insertText', false, out.join('\n'));
      selectIn(pre, mapOff(a), mapOff(z));
      saveRange(); refresh();
    }
    function codeEnter(pre) {
      const t = codeMap(pre).text, a = selOffsets(pre)[0];
      const ls = t.lastIndexOf('\n', a - 1) + 1;
      document.execCommand('insertText', false, '\n' + /^[ \t]*/.exec(t.slice(ls, a))[0]);
    }
    function codeBackspace(pre) {
      const t = codeMap(pre).text, o = selOffsets(pre), a = o[0];
      if (a !== o[1]) return false;
      const ls = t.lastIndexOf('\n', a - 1) + 1, col = a - ls;
      if (col < 2 || !/^ +$/.test(t.slice(ls, a))) return false;
      const k = ((col - 1) % 4) + 1;   // 退回上一個四格的位置
      if (k < 2) return false;
      selectIn(pre, a - k, a);
      document.execCommand('delete');
      return true;
    }
    // 字級：execCommand 只認 1–7，先打 7 再把 <font size="7"> 換成 span style（Google 文件的字級單位是 pt）
    const FONT_SIZE_PT = { 1: 8, 2: 10, 3: 12, 4: 14, 5: 18, 6: 24, 7: 36 };
    let pendingPt = null, applyingSize = false;   // applyingSize：setFontSize 自己會把 <font size=7> 換成 span 並選起來，input 事件先別搶著換
    // Chrome 偶爾還是會留下 <font size=N>（例如改字級後才打的字）：一律換成 span style
    function normalizeFonts() {
      let changedAny = false;
      paper.querySelectorAll('font[size]').forEach(function (f) {
        const span = document.createElement('span');
        const n = parseInt(f.getAttribute('size'), 10);
        span.style.fontSize = ((n === 7 && pendingPt) ? pendingPt : (FONT_SIZE_PT[n] || 11)) + 'pt';
        if (f.getAttribute('color')) span.style.color = f.getAttribute('color');
        if (f.getAttribute('face')) span.style.fontFamily = f.getAttribute('face');
        while (f.firstChild) span.appendChild(f.firstChild);
        f.parentNode.replaceChild(span, f);
        changedAny = true;
      });
      return changedAny;
    }
    function setFontSize(pt) {
      pt = Math.max(6, Math.min(96, Math.round(pt)));
      restoreRange();
      pendingPt = pt;
      const sel0 = window.getSelection();
      if (sel0 && sel0.isCollapsed) {
        // 沒選字：放一個帶字級的 span，游標進去，接下來打的字就是這個大小
        document.execCommand('insertHTML', false, '<span style="font-size:' + pt + 'pt">\u200B</span>');
        const s2 = window.getSelection();
        let n = s2 && s2.anchorNode;
        if (n && n.nodeType === 3 && n.nodeValue === '\u200B') { const r = document.createRange(); r.setStart(n, 1); r.collapse(true); s2.removeAllRanges(); s2.addRange(r); }
        saveRange(); changed(); refresh();
        if (sizeEl) sizeEl.value = String(pt);
        return;
      }
      applyingSize = true;
      try {
        document.execCommand('styleWithCSS', false, false);
        document.execCommand('fontSize', false, '7');
      } finally { applyingSize = false; try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* */ } }
      const spans = [];
      paper.querySelectorAll('font[size="7"]').forEach(function (f) {
        const span = document.createElement('span');
        span.style.fontSize = pt + 'pt';
        while (f.firstChild) span.appendChild(f.firstChild);
        f.parentNode.replaceChild(span, f);
        spans.push(span);
      });
      // 選取改成剛換好的那幾個 span，之後量字級量到的才是它們（不是外面的標題）
      if (spans.length) {
        const r = document.createRange();
        r.setStart(spans[0], 0); r.setEnd(spans[spans.length - 1], spans[spans.length - 1].childNodes.length);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      }
      saveRange(); changed(); refresh();
      if (sizeEl) sizeEl.value = String(pt);
    }
    function currentSizePt() {
      const s = window.getSelection();
      let n = s && s.anchorNode;
      if (!n || !paper.contains(n)) return 11;
      if (n.nodeType === 3) n = n.parentNode;
      const px = parseFloat(getComputedStyle(n).fontSize) || 14.67;
      return Math.round(px * 0.75);
    }
    function blockOf() {
      const s = window.getSelection();
      let n = s && s.anchorNode;
      if (!n || !paper.contains(n)) return 'p';
      if (n.nodeType === 3) n = n.parentNode;
      const b = n.closest('h1,h2,h3,h4,h5,h6,blockquote,p,div,li,pre');
      if (!b || b === paper) return 'p';
      const t = b.tagName.toLowerCase();
      return STYLES.some(function (x) { return x[0] === t; }) ? t : 'p';
    }
    // 選取範圍碰到的區塊元素（段落、標題、清單項目…）：對齊、縮排都是作用在它們上
    function blockOf1(n) {
      if (!n) return null;
      if (n.nodeType === 3) n = n.parentNode;
      const b = n.closest ? n.closest('h1,h2,h3,h4,h5,h6,blockquote,p,div,li,pre,td,th') : null;
      return b && b !== paper && paper.contains(b) ? b : null;
    }
    function blocksInSelection() {
      const s = window.getSelection();
      if (!s || !s.rangeCount || !paper.contains(s.anchorNode)) return [];
      const r = s.getRangeAt(0);
      const a = blockOf1(r.startContainer), z = blockOf1(r.endContainer);
      if (!a) return [];
      if (a === z || !z) return [a];
      const out = [];
      const all = paper.querySelectorAll('h1,h2,h3,h4,h5,h6,blockquote,p,div,li,pre,td,th');
      let on = false;
      for (let i = 0; i < all.length; i++) {
        if (all[i] === a) on = true;
        if (on && r.intersectsNode(all[i]) && !all[i].querySelector('p,li,h1,h2,h3,h4,h5,h6')) out.push(all[i]);
        if (all[i] === z) break;
      }
      return out.length ? out : [a];
    }
    // 分散對齊：Google 文件的「分散對齊」是連最後一行也撐滿（text-align-last），跟左右對齊不同
    function distribute() {
      restoreRange();
      const bs = blocksInSelection();
      if (!bs.length) return;
      bs.forEach(function (b) { b.style.textAlign = 'justify'; b.style.textAlignLast = 'justify'; b.style.textJustify = 'inter-character'; });
      saveRange(); changed(); refresh();
    }

    // ---- 尺規：公分刻度、左右邊界（紙的 padding）、目前段落的左縮排與首行縮排 ----
    let rulerListeners = null;
    const ruler = host.querySelector('.gd-ruler'), rulerIn = host.querySelector('.gd-ruler-in');
    function drawRuler() {
      if (!rulerIn) return;
      const scale = rulerIn.querySelector('.gd-ruler-scale');
      if (!scale.children.length) {
        // 刻度從左邊界的 0 往兩邊數；左邊界會動，所以刻度用 transform 整排平移
        let h = '';
        for (let cm = -6; cm <= 30; cm++) {
          for (let q = 0; q < 2; q++) {
            const x = (cm + q / 2) * CM;
            h += '<i class="gd-tick' + (q ? ' is-half' : ' is-cm') + '" style="left:' + x.toFixed(1) + 'px">' + (q ? '' : '<b>' + Math.abs(cm) + '</b>') + '</i>';
          }
        }
        scale.innerHTML = h;
      }
      scale.style.transform = 'translateX(' + margins.l + 'px)';
      rulerIn.querySelector('.gd-ruler-shade-l').style.width = margins.l + 'px';
      rulerIn.querySelector('.gd-ruler-shade-r').style.width = margins.r + 'px';
      rulerIn.querySelector('[data-rm="ml"]').style.left = margins.l + 'px';
      rulerIn.querySelector('[data-rm="mr"]').style.left = (PAPER_W - margins.r) + 'px';
      // 段落縮排：看游標所在的那一個區塊
      const bs = blocksInSelection();
      const b = bs[0];
      const ml = b ? (parseFloat(b.style.marginLeft) || 0) : 0, ti = b ? (parseFloat(b.style.textIndent) || 0) : 0;
      rulerIn.querySelector('[data-rm="indent"]').style.left = (margins.l + ml) + 'px';
      rulerIn.querySelector('[data-rm="first"]').style.left = (margins.l + ml + ti) + 'px';
    }
    if (ruler) {
      let rdrag = null;
      ruler.addEventListener('mousedown', function (e) {
        const m = e.target.closest('[data-rm]');
        if (!m) return;
        e.preventDefault();
        const rect = rulerIn.getBoundingClientRect();
        const bs = blocksInSelection();
        rdrag = { kind: m.getAttribute('data-rm'), x0: e.clientX, rect: rect, m0: Object.assign({}, margins), blocks: bs,
          ml0: bs[0] ? (parseFloat(bs[0].style.marginLeft) || 0) : 0, ti0: bs[0] ? (parseFloat(bs[0].style.textIndent) || 0) : 0 };
        ruler.classList.add('is-dragging');
      });
      const onRulerMove = function (e) {
        if (!rdrag) return;
        const dx = e.clientX - rdrag.x0;
        if (rdrag.kind === 'ml') { margins.l = rdrag.m0.l + dx; applyMargins(); }
        else if (rdrag.kind === 'mr') { margins.r = rdrag.m0.r - dx; applyMargins(); }
        else if (rdrag.kind === 'indent') {
          const v = Math.max(0, Math.min(PAPER_W - margins.l - margins.r - 40, rdrag.ml0 + dx));
          rdrag.blocks.forEach(function (b) { b.style.marginLeft = Math.round(v) + 'px'; });
          drawRuler();
        } else if (rdrag.kind === 'first') {
          const v = Math.max(-rdrag.ml0, Math.min(PAPER_W / 2, rdrag.ti0 + dx));
          rdrag.blocks.forEach(function (b) { b.style.textIndent = Math.round(v) + 'px'; });
          drawRuler();
        }
      };
      const onRulerUp = function () {
        if (!rdrag) return;
        const k = rdrag.kind; rdrag = null;
        ruler.classList.remove('is-dragging');
        if (k === 'ml' || k === 'mr') { if (opts.onMargins) opts.onMargins({ l: margins.l, r: margins.r }); }
        else changed();
      };
      document.addEventListener('mousemove', onRulerMove);
      document.addEventListener('mouseup', onRulerUp);
      rulerListeners = function () { document.removeEventListener('mousemove', onRulerMove); document.removeEventListener('mouseup', onRulerUp); };
    }

    // ---- 表格：拖格線改欄寬（Google 文件的做法：游標靠近直的格線變成 ↔，拖了只動相鄰兩欄） ----
    let colHit = null, colDrag = null;
    function cellAt(e) {
      const td = e.target.closest ? e.target.closest('td,th') : null;
      if (!td || !paper.contains(td)) return null;
      const r = td.getBoundingClientRect();
      const row = td.parentNode;
      let idx = Array.prototype.indexOf.call(row.children, td);
      // 格線是兩格共用的：游標落在這格的右緣，或下一格的左緣（border-collapse 下那 1px 常常算在右邊那格）
      if (Math.abs(e.clientX - r.right) <= 5) { if (idx >= row.children.length - 1) return null; }   // 最右邊那條是表格外框，不動
      else if (Math.abs(e.clientX - r.left) <= 5 && idx > 0) idx -= 1;
      else return null;
      return { table: td.closest('table'), idx: idx };
    }
    paper.addEventListener('mousemove', function (e) {
      if (ro || colDrag) return;
      colHit = cellAt(e);
      paper.classList.toggle('is-colresize', !!colHit);
    });
    paper.addEventListener('mousedown', function (e) {
      if (ro || !colHit || e.button !== 0) return;
      e.preventDefault();
      const t = colHit.table, first = t.rows[0];
      const widths = Array.prototype.map.call(first.children, function (c) { return c.getBoundingClientRect().width; });
      colDrag = { table: t, idx: colHit.idx, x0: e.clientX, widths: widths };
      t.style.tableLayout = 'fixed';
      t.style.width = Math.round(widths.reduce(function (a, b) { return a + b; }, 0)) + 'px';
      Array.prototype.forEach.call(first.children, function (c, i) { c.style.width = Math.round(widths[i]) + 'px'; });
      paper.classList.add('is-colresize');
    });
    const onColMove = function (e) {
      if (!colDrag) return;
      const d = e.clientX - colDrag.x0, i = colDrag.idx, w = colDrag.widths;
      const a = Math.max(24, Math.min(w[i] + w[i + 1] - 24, w[i] + d)), b = w[i] + w[i + 1] - a;
      const first = colDrag.table.rows[0];
      first.children[i].style.width = Math.round(a) + 'px';
      first.children[i + 1].style.width = Math.round(b) + 'px';
    };
    const onColUp = function () {
      if (!colDrag) return;
      colDrag = null; colHit = null;
      paper.classList.remove('is-colresize');
      changed();
    };
    document.addEventListener('mousemove', onColMove);
    document.addEventListener('mouseup', onColUp);

    function refresh() {
      placeCodeBar();
      if (!toolbar) return;
      const cur = blocksInSelection()[0];
      const dist = !!(cur && cur.style.textAlignLast === 'justify');
      ['bold', 'italic', 'underline', 'strikeThrough', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull', 'insertUnorderedList', 'insertOrderedList'].forEach(function (c) {
        const b = toolbar.querySelector('[data-act="' + c + '"]');
        let on = false;
        try { on = document.queryCommandState(c); } catch (e) { on = false; }
        if (c === 'justifyFull' && dist) on = false;
        if (b) b.classList.toggle('on', !!on);
      });
      const db = toolbar.querySelector('[data-act="distribute"]');
      if (db) db.classList.toggle('on', dist);
      ['superscript', 'subscript'].forEach(function (c) { const b = toolbar.querySelector('[data-act="' + c + '"]'); let on = false; try { on = document.queryCommandState(c); } catch (e) { on = false; } if (b) b.classList.toggle('on', !!on); });
      const cb = toolbar.querySelector('[data-act="code"]'); if (cb) cb.classList.toggle('on', !!(cur && cur.tagName === 'PRE'));
      drawRuler();
      if (styleSel) styleSel.value = blockOf();
      if (fontSel) {
        let f = '';
        try { f = (document.queryCommandValue('fontName') || '').replace(/^["']|["']$/g, '').split(',')[0].trim(); } catch (e) { f = ''; }
        const hit = FONTS.find(function (x) { return x.v.split(',')[0].trim().toLowerCase() === f.toLowerCase(); });
        fontSel.value = hit ? hit.v : FONTS[0].v;
      }
      if (sizeEl && document.activeElement !== sizeEl) sizeEl.value = String(currentSizePt());
      count();
    }

    // ---- 工具列 ----
    if (toolbar) {
      toolbar.addEventListener('mousedown', function (e) {
        // 按鈕不搶焦點（select／輸入框要）
        if (e.target.closest('button')) { e.preventDefault(); saveRange(); }
      });
      toolbar.addEventListener('click', function (e) {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const a = b.getAttribute('data-act');
        if (a === 'size-') setFontSize(currentSizePt() - 1);
        else if (a === 'size+') setFontSize(currentSizePt() + 1);
        else if (a === 'color' || a === 'hilite') colorPop(b, a);
        else if (a === 'link') linkPop(b);
        else if (a === 'image') pickImage();
        else if (a === 'table') tablePop(b);
        else if (a === 'hr') exec('insertHorizontalRule');
        else if (a === 'removeFormat') { exec('removeFormat'); exec('formatBlock', 'p'); }
        else if (a === 'distribute') distribute();
        else if (['linespacing', 'code', 'superscript', 'subscript', 'pagebreak'].indexOf(a) >= 0) act(a, b);
        else if (a.indexOf('justify') === 0) { restoreRange(); blocksInSelection().forEach(function (b) { b.style.textAlignLast = ''; b.style.textJustify = ''; }); exec(a); }
        else exec(a);
      });
      styleSel.addEventListener('mousedown', saveRange);
      styleSel.addEventListener('change', function () { exec('formatBlock', styleSel.value); });
      fontSel.addEventListener('mousedown', saveRange);
      fontSel.addEventListener('change', function () { exec('fontName', fontSel.value); });
      sizeEl.addEventListener('focus', saveRange);
      sizeEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); setFontSize(parseInt(sizeEl.value, 10) || 11); }
        if (e.key === 'Escape') { e.preventDefault(); restoreRange(); }
        e.stopPropagation();
      });
      sizeEl.addEventListener('change', function () { setFontSize(parseInt(sizeEl.value, 10) || 11); });
    }
    function colorPop(anchor, which) {
      const p = popupAt(anchor, 'gd-pop-colors');
      const list = which === 'color' ? COLORS : HILITES;
      list.forEach(function (c) {
        const b = el('button', 'gd-swatch' + (c === 'none' ? ' is-none' : '')); b.type = 'button'; b.title = c === 'none' ? '無' : c;
        if (c !== 'none') b.style.background = c;
        b.setAttribute('data-color', c);
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () {
          closePop();
          if (which === 'color') exec('foreColor', c);
          else exec('hiliteColor', c === 'none' ? 'transparent' : c);
          const bar = anchor.querySelector('.gd-color-bar');
          if (bar) bar.style.background = c === 'none' ? 'transparent' : c;
        });
        p.appendChild(b);
      });
    }
    function linkPop(anchor) {
      const p = popupAt(anchor, 'gd-pop-link');
      const s = window.getSelection();
      const a = s && s.anchorNode && paper.contains(s.anchorNode) ? (s.anchorNode.nodeType === 3 ? s.anchorNode.parentNode : s.anchorNode).closest('a') : null;
      p.appendChild(el('div', 'gd-pop-label', '網址'));
      const inp = el('input', 'gd-input'); inp.type = 'url'; inp.placeholder = 'https://…'; inp.value = a ? a.getAttribute('href') : '';
      p.appendChild(inp);
      const row = el('div', 'gd-pop-row');
      const ok = el('button', 'gd-btn gd-btn-primary', '套用'); ok.type = 'button';
      const rm = el('button', 'gd-btn', '移除連結'); rm.type = 'button';
      row.appendChild(ok); row.appendChild(rm);
      p.appendChild(row);
      const apply = function () {
        let u = inp.value.trim();
        if (!u) return;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
        if (!/^(https?:|mailto:)/i.test(u)) return;
        closePop();
        restoreRange();
        const sel = window.getSelection();
        if (sel && sel.isCollapsed && !a) {
          document.execCommand('insertHTML', false, '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>');
        } else {
          document.execCommand('createLink', false, u);
          paper.querySelectorAll('a[href="' + u.replace(/"/g, '\\"') + '"]').forEach(function (x) { x.setAttribute('target', '_blank'); x.setAttribute('rel', 'noopener noreferrer'); });
        }
        saveRange(); changed(); refresh();
      };
      ok.addEventListener('click', apply);
      rm.addEventListener('click', function () { closePop(); exec('unlink'); });
      inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); apply(); } if (e.key === 'Escape') { closePop(); restoreRange(); } });
      setTimeout(function () { inp.focus(); inp.select(); }, 0);
    }
    function tablePop(anchor) {
      const p = popupAt(anchor, 'gd-pop-table');
      p.appendChild(el('div', 'gd-pop-label', '表格大小'));
      const grid = el('div', 'gd-table-grid');
      const hint = el('div', 'gd-pop-hint', '3 × 3');
      for (let r = 1; r <= 6; r++) for (let c = 1; c <= 6; c++) {
        const cell = el('button', 'gd-table-cell'); cell.type = 'button'; cell.setAttribute('data-r', r); cell.setAttribute('data-c', c); cell.title = r + ' × ' + c;
        cell.addEventListener('mouseenter', function () {
          grid.querySelectorAll('.gd-table-cell').forEach(function (x) { x.classList.toggle('on', +x.getAttribute('data-r') <= r && +x.getAttribute('data-c') <= c); });
          hint.textContent = r + ' × ' + c;
        });
        cell.addEventListener('mousedown', function (e) { e.preventDefault(); });
        cell.addEventListener('click', function () { closePop(); insertTable(r, c); });
        grid.appendChild(cell);
      }
      p.appendChild(grid); p.appendChild(hint);
    }
    function insertTable(rows, cols) {
      let h = '<table class="gd-table"><tbody>';
      for (let r = 0; r < rows; r++) { h += '<tr>'; for (let c = 0; c < cols; c++) h += '<td><br></td>'; h += '</tr>'; }
      h += '</tbody></table><p><br></p>';
      exec('insertHTML', h);
    }
    function pickImage() {
      if (!opts.onUpload) return;
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.addEventListener('change', function () { insertFiles(inp.files); });
      inp.click();
    }
    function insertFiles(files) {
      const list = Array.prototype.filter.call(files || [], function (f) { return (f.type || '').indexOf('image/') === 0; });
      if (!list.length || !opts.onUpload) return;
      setStatus('上傳圖片中…');
      Promise.resolve(opts.onUpload(list)).then(function (imgs) {
        const html = (imgs || []).map(function (i) { return '<img data-img-id="' + esc(i.id) + '" src="/api/images/' + esc(i.id) + '" alt="' + esc(i.alt || '') + '">'; }).join('');
        if (html) exec('insertHTML', html);
        else setStatus('已儲存', 'is-ok');
      }, function () { setStatus('上傳失敗', 'is-err'); });
    }

    // ---- 編輯區事件 ----
    paper.addEventListener('input', function () { if (!applyingSize && normalizeFonts()) { /* 換掉的 <font> 已經在 DOM 裡 */ } changed(); });
    paper.addEventListener('keyup', refresh);
    paper.addEventListener('mouseup', function () { saveRange(); refresh(); });
    document.addEventListener('selectionchange', onSel);
    function onSel() { if (!closed && document.activeElement === paper) { saveRange(); refresh(); } }
    paper.addEventListener('keydown', function (e) {
      if (ro) return;
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); e.stopPropagation();
        const cp = selPre();
        if (cp) { codeTab(cp, e.shiftKey); return; }
        exec(e.shiftKey ? 'outdent' : 'indent'); return;
      }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.isComposing) {
        const cp = selPre();
        if (cp && codeBackspace(cp)) { e.preventDefault(); e.stopPropagation(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); saveRange(); linkPop(toolbar.querySelector('[data-act="link"]')); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') { e.preventDefault(); saveRange(); openFind(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); exportPDF(); return; }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); saveRange(); wordCount(toolbar); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === '.') { e.preventDefault(); exec('superscript'); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); exec('subscript'); return; }
      if (e.key === 'Enter' && !e.isComposing) {
        const blk = blocksInSelection()[0];
        if (blk && blk.tagName === 'PRE') {
          // 程式碼區塊：Enter 是換行（新的一行照這一行的縮排），Shift+Enter／Ctrl+Enter 離開區塊往下接一段
          e.preventDefault(); e.stopPropagation();
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            const np = document.createElement('p'); np.innerHTML = '<br>'; blk.parentNode.insertBefore(np, blk.nextSibling);
            const r = document.createRange(); r.setStart(np, 0); r.collapse(true); const sl = window.getSelection(); sl.removeAllRanges(); sl.addRange(r);
            saveRange(); changed(); refresh(); return;
          }
          if (selPre() === blk) codeEnter(blk); else document.execCommand('insertLineBreak');
          return;
        }
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); insertPageBreak(); return; }
      }
      if (e.key === 'Escape' && findEl) { closeFind(); return; }
      if (e.key === 'Escape' && popEl) { closePop(); clearMenus(); return; }
      e.stopPropagation();   // 別讓 app 的快捷鍵接到打字
    });
    // 貼上：有圖就上傳；HTML 清過再放進來；都沒有就是純文字
    paper.addEventListener('paste', function (e) {
      if (ro) return;
      const dt = e.clipboardData;
      if (!dt) return;
      // 貼進程式碼區塊一律是純文字（不帶網頁或 IDE 的格式）
      if (selPre()) { e.preventDefault(); document.execCommand('insertText', false, (dt.getData('text/plain') || '').replace(/\r\n?/g, '\n')); return; }
      const files = Array.prototype.filter.call(dt.files || [], function (f) { return (f.type || '').indexOf('image/') === 0; });
      if (files.length) { e.preventDefault(); insertFiles(files); return; }
      const html = dt.getData('text/html');
      e.preventDefault();
      if (html) document.execCommand('insertHTML', false, toLive(html));
      else document.execCommand('insertText', false, dt.getData('text/plain') || '');
      changed();
    });
    paper.addEventListener('drop', function (e) {
      if (ro) return;
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) { e.preventDefault(); paper.focus(); insertFiles(files); }
    });
    paper.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) e.preventDefault(); });
    // 連結：Ctrl＋點開新分頁（編輯中點一下是把游標放上去）
    paper.addEventListener('click', function (e) {
      const tb2 = e.target.closest('[data-toc]');
      if (tb2) {
        e.preventDefault();
        const nav = tb2.closest('.gd-toc');
        if (tb2.getAttribute('data-toc') === 'remove') { nav.remove(); changed(); refresh(); } else { buildTocList(nav); nav.setAttribute('data-sig', tocSig(nav)); changed(); }
        return;
      }
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (href.charAt(0) === '#') {
        e.preventDefault();
        const target = paper.querySelector('[id="' + href.slice(1).replace(/"/g, '') + '"]');
        if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      if (ro || e.ctrlKey || e.metaKey) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
      else e.preventDefault();
    });

    // ---- 頁面設定（紙張／邊界／頁首頁尾／頁碼）與紙上的頁首頁尾條 ----
    let page = cleanPage(opts.page);
    const hfTop = host.querySelector('.gd-hf-top'), hfBottom = host.querySelector('.gd-hf-bottom');
    function drawHF() {
      if (!hfTop) return;
      const paint = function (box, kind) {
        const text = kind === 'header' ? page.header : page.footer, align = kind === 'header' ? page.headerAlign : page.footerAlign;
        const cells = { left: '', center: '', right: '' };
        if (text) cells[align] = esc(text);
        const hasNum = page.num && page.numPos === kind;
        if (hasNum) cells[page.numAlign] = (cells[page.numAlign] ? cells[page.numAlign] + '  ' : '') + '<span class="gd-hf-num" title="頁碼（列印時每頁不同；這裡顯示起始頁碼）">' + esc(numText(page, page.numStart, null)) + '</span>';
        const any = !!text || hasNum;
        box.classList.toggle('is-empty', !any);
        box.innerHTML = '<span class="gd-hf-l">' + cells.left + '</span><span class="gd-hf-c">' + cells.center + '</span><span class="gd-hf-r">' + cells.right + '</span>' +
          (any || ro ? '' : '<span class="gd-hf-hint">' + (kind === 'header' ? '頁首' : '頁尾') + '：雙擊編輯</span>');
        box.style.paddingLeft = margins.l + 'px'; box.style.paddingRight = margins.r + 'px';
      };
      paint(hfTop, 'header'); paint(hfBottom, 'footer');
    }
    function setPage(patch) { page = cleanPage(Object.assign({}, page, patch)); drawHF(); if (opts.onPage) opts.onPage(Object.assign({}, page)); }
    if (hfTop && !ro) { hfTop.addEventListener('dblclick', function () { pageDialog('header'); }); hfBottom.addEventListener('dblclick', function () { pageDialog('footer'); }); }
    function pageDialog(focus) {
      closePop();
      const ov = el('div', 'modal-overlay gd-dialog-overlay');
      const sel = function (name, list, cur) { return '<select class="gd-input gd-dsel" data-f="' + name + '">' + list.map(function (x) { return '<option value="' + x[0] + '"' + (String(cur) === String(x[0]) ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>'; };
      const ALIGN = [['left', '靠左'], ['center', '置中'], ['right', '靠右']];
      ov.innerHTML = '<div class="modal gd-dialog" role="dialog" aria-modal="true"><div class="modal-title">頁面設定</div><div class="gd-dialog-body">' +
        '<div class="gd-dsec" data-sec="page"><div class="gd-dsec-t">紙張</div><div class="gd-drow"><label>大小</label>' + sel('size', Object.keys(PAGE_SIZES).map(function (k) { return [k, k + '（' + PAGE_SIZES[k][0] + ' × ' + PAGE_SIZES[k][1] + ' mm）']; }), page.size) + '</div>' +
        '<div class="gd-drow"><label>方向</label>' + sel('orient', [['portrait', '直向'], ['landscape', '橫向']], page.orient) + '</div>' +
        '<div class="gd-drow"><label>上邊界</label><input class="gd-input gd-dnum" type="number" min="5" max="80" step="0.1" data-f="mt" value="' + page.mt + '"><span class="gd-dunit">mm</span><label>下邊界</label><input class="gd-input gd-dnum" type="number" min="5" max="80" step="0.1" data-f="mb" value="' + page.mb + '"><span class="gd-dunit">mm</span></div>' +
        '<div class="gd-dhint">左右邊界請拖尺規上的灰色標記（目前 ' + pxToMM(margins.l) + ' mm／' + pxToMM(margins.r) + ' mm）。</div></div>' +
        '<div class="gd-dsec" data-sec="header"><div class="gd-dsec-t">頁首</div><div class="gd-drow"><input class="gd-input" type="text" maxlength="200" data-f="header" placeholder="每一頁最上面的文字（可留空）" value="' + esc(page.header) + '">' + sel('headerAlign', ALIGN, page.headerAlign) + '</div></div>' +
        '<div class="gd-dsec" data-sec="footer"><div class="gd-dsec-t">頁尾</div><div class="gd-drow"><input class="gd-input" type="text" maxlength="200" data-f="footer" placeholder="每一頁最下面的文字（可留空）" value="' + esc(page.footer) + '">' + sel('footerAlign', ALIGN, page.footerAlign) + '</div></div>' +
        '<div class="gd-dsec" data-sec="num"><div class="gd-dsec-t">頁碼</div><div class="gd-drow"><label class="gd-dcheck"><input type="checkbox" data-f="num"' + (page.num ? ' checked' : '') + '> 顯示頁碼</label></div>' +
        '<div class="gd-drow"><label>位置</label>' + sel('numPos', [['header', '頁首'], ['footer', '頁尾']], page.numPos) + sel('numAlign', ALIGN, page.numAlign) + '</div>' +
        '<div class="gd-drow"><label>起始頁碼</label><input class="gd-input gd-dnum" type="number" min="0" max="9999" data-f="numStart" value="' + page.numStart + '"><label>格式</label>' + sel('numFmt', [['n', '1、2、3'], ['page-n', '第 1 頁'], ['n-of-total', '1 / 總頁數']], page.numFmt) + '</div>' +
        '<div class="gd-drow"><label class="gd-dcheck"><input type="checkbox" data-f="skipFirst"' + (page.skipFirst ? ' checked' : '') + '> 第一頁不顯示頁首、頁尾與頁碼</label></div></div>' +
        '</div><div class="modal-actions"><button class="btn gd-dcancel" type="button">取消</button><button class="btn btn-primary gd-dok" type="button">套用</button></div></div>';
      document.body.appendChild(ov);
      const close = function () { ov.remove(); document.removeEventListener('keydown', onKey, true); };
      const apply = function () {
        const o = {};
        ov.querySelectorAll('[data-f]').forEach(function (i) { const f = i.getAttribute('data-f'); o[f] = i.type === 'checkbox' ? i.checked : i.value; });
        setPage(o); close();
      };
      const onKey = function (e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); apply(); }
        e.stopPropagation();
      };
      ov.querySelector('.gd-dok').addEventListener('click', apply);
      ov.querySelector('.gd-dcancel').addEventListener('click', close);
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
      document.addEventListener('keydown', onKey, true);
      const f = ov.querySelector('[data-sec="' + (focus || 'page') + '"] input, [data-sec="' + (focus || 'page') + '"] select');
      setTimeout(function () { if (f) f.focus(); }, 0);
    }

    // ---- 選單列（檔案／插入／格式／工具）----
    const menubar = host.querySelector('.gd-menubar');
    const MENUS = {
      file: [['pdf', '下載 PDF', 'Ctrl+P'], ['docx', '下載 Word（.docx）'], null, ['pagesetup', '頁面設定…'], null, ['print', '列印']],
      insert: [['image', '圖片'], ['link', '連結', 'Ctrl+K'], ['table', '表格'], ['hr', '分隔線'], ['pagebreak', '分頁符號', 'Ctrl+Enter'], null, ['toc', '目錄'], ['code', '程式碼區塊'], ['date', '日期'], null, ['pagenum', '頁碼…'], ['hf', '頁首與頁尾…']],
      format: [['linespacing', '行距與段落間距…'], null, ['superscript', '上標', 'Ctrl+.'], ['subscript', '下標', 'Ctrl+,'], null, ['removeFormat', '清除格式']],
      tools: [['count', '字數統計', 'Ctrl+Shift+C'], ['find', '尋找與取代', 'Ctrl+H']]
    };
    function clearMenus() { if (menubar) menubar.querySelectorAll('.gd-menu.on').forEach(function (m) { m.classList.remove('on'); }); }
    function menuPop(btn) {
      const p = popupAt(btn, 'gd-pop-menu');
      MENUS[btn.getAttribute('data-menu')].forEach(function (it) {
        if (!it) { p.appendChild(el('div', 'gd-menu-sep')); return; }
        const b = el('button', 'gd-menu-item', '<span>' + esc(it[1]) + '</span>' + (it[2] ? '<span class="gd-menu-k">' + esc(it[2]) + '</span>' : ''));
        b.type = 'button'; b.setAttribute('data-a', it[0]);
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () { closePop(); clearMenus(); act(it[0], btn); });
        p.appendChild(b);
      });
      clearMenus(); btn.classList.add('on');
    }
    if (menubar) {
      menubar.addEventListener('mousedown', function (e) { if (e.target.closest('.gd-menu')) { e.preventDefault(); saveRange(); } });
      menubar.addEventListener('click', function (e) {
        const m = e.target.closest('.gd-menu'); if (!m) return;
        if (m.classList.contains('on') && popEl) { closePop(); clearMenus(); } else menuPop(m);
      });
      // 滑過去就換選單（Google 文件開著一個選單時滑到隔壁會切換）
      menubar.addEventListener('mouseover', function (e) { const m = e.target.closest('.gd-menu'); if (m && popEl && menubar.querySelector('.gd-menu.on') && !m.classList.contains('on')) menuPop(m); });
    }
    function onDocDown(e) { if (popEl && !e.target.closest('.gd-pop') && !e.target.closest('.gd-menu')) clearMenus(); }
    document.addEventListener('mousedown', onDocDown, true);
    // 工具列與選單共用的動作
    function act(a, anchor) {
      anchor = anchor || (toolbar && toolbar.querySelector('[data-act="' + a + '"]')) || toolbar || host;
      switch (a) {
        case 'pdf': case 'print': exportPDF(); break;
        case 'docx': exportDocx(); break;
        case 'pagesetup': pageDialog('page'); break;
        case 'pagenum': pageDialog('num'); break;
        case 'hf': pageDialog('header'); break;
        case 'image': pickImage(); break;
        case 'link': linkPop(anchor); break;
        case 'table': tablePop(anchor); break;
        case 'hr': exec('insertHorizontalRule'); break;
        case 'pagebreak': insertPageBreak(); break;
        case 'toc': insertToc(); break;
        case 'code': toggleCode(); break;
        case 'date': exec('insertText', new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' })); break;
        case 'linespacing': spacingPop(anchor); break;
        case 'superscript': exec('superscript'); break;
        case 'subscript': exec('subscript'); break;
        case 'removeFormat': exec('removeFormat'); exec('formatBlock', 'p'); break;
        case 'count': wordCount(anchor); break;
        case 'find': openFind(); break;
      }
    }

    // ---- 插入：分頁符號、目錄、程式碼區塊 ----
    function insertPageBreak() {
      restoreRange();
      exec('insertHTML', '<div class="gd-pagebreak" contenteditable="false"><span>分頁符號</span></div><p><br></p>');
    }
    function toggleCode() {
      restoreRange();
      const bs = blocksInSelection();
      if (bs.length && bs.every(function (b) { return b.tagName === 'PRE'; })) {
        // 轉回一般段落：一行一段
        const s = window.getSelection();
        bs.forEach(function (pre) {
          const lines = preText(pre).split('\n');
          const frag = document.createDocumentFragment(); let last = null;
          lines.forEach(function (ln) { const p = document.createElement('p'); if (ln) p.textContent = ln; else p.innerHTML = '<br>'; frag.appendChild(p); last = p; });
          pre.parentNode.replaceChild(frag, pre);
          if (last) { const r = document.createRange(); r.selectNodeContents(last); r.collapse(false); s.removeAllRanges(); s.addRange(r); }
        });
        saveRange(); changed(); refresh(); return;
      }
      const s = window.getSelection();
      if (!s || !s.rangeCount) return;
      if (bs.length <= 1) {
        exec('formatBlock', 'pre');
        paper.querySelectorAll('pre:not(.gd-code)').forEach(function (p) { p.classList.add('gd-code'); });
        return;
      }
      // 選了好幾段：合成一個區塊，一段一行
      const text = bs.map(function (b) { return b.textContent; }).join('\n');
      const pre = document.createElement('pre'); pre.className = 'gd-code'; pre.textContent = text;
      bs[0].parentNode.insertBefore(pre, bs[0]); bs.forEach(function (b) { b.remove(); });
      const r = document.createRange(); r.selectNodeContents(pre); r.collapse(false); s.removeAllRanges(); s.addRange(r);
      saveRange(); changed(); refresh();
    }
    // 目錄：從標題 1～4 做出來的連結清單，打字時自己更新（標題多了、改了、少了都會跟）
    const TOC_TOOLS = '<span class="gd-toc-tools" contenteditable="false"><button type="button" class="gd-toc-btn" data-toc="refresh" title="更新目錄">' + ic('refresh-cw') + '</button><button type="button" class="gd-toc-btn" data-toc="remove" title="移除目錄">' + ic('x') + '</button></span>';
    function headingsForToc(nav) {
      return Array.prototype.filter.call(paper.querySelectorAll('h1,h2,h3,h4'), function (h) { return (!nav || !nav.contains(h)) && h.textContent.trim(); });
    }
    function buildTocList(nav) {
      const hs = headingsForToc(nav), seen = {};
      hs.forEach(function (h, i) {
        if (!h.id || !/^gd-h-/.test(h.id) || seen[h.id]) h.id = 'gd-h-' + (i + 1) + '-' + Math.random().toString(36).slice(2, 6);
        seen[h.id] = 1;
      });
      let ol = nav.querySelector('ol');
      if (!ol) { ol = document.createElement('ol'); nav.insertBefore(ol, nav.querySelector('.gd-toc-tools')); }
      ol.innerHTML = hs.length ? hs.map(function (h) { return '<li class="lv' + h.tagName[1] + '"><a href="#' + esc(h.id) + '"><span>' + esc(h.textContent.trim()) + '</span></a></li>'; }).join('')
        : '<li class="gd-toc-empty">還沒有標題——用「樣式」把段落設成標題 1～4，目錄會自己出現</li>';
      if (!nav.querySelector('.gd-toc-tools')) nav.insertAdjacentHTML('beforeend', TOC_TOOLS);
    }
    function tocSig(nav) { return headingsForToc(nav).map(function (h) { return h.tagName + ':' + h.textContent.trim(); }).join('|'); }
    function insertToc() {
      restoreRange();
      const have = paper.querySelector('.gd-toc');
      if (have) { have.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      const nav = document.createElement('nav'); nav.className = 'gd-toc'; nav.setAttribute('contenteditable', 'false');
      nav.innerHTML = '<div class="gd-toc-t">目錄</div><ol></ol>' + TOC_TOOLS;
      buildTocList(nav);
      nav.setAttribute('data-sig', tocSig(nav));
      let b = blocksInSelection()[0];
      while (b && b.parentNode !== paper) b = b.parentNode;
      if (b && b !== paper) paper.insertBefore(nav, b); else paper.insertBefore(nav, paper.firstChild);
      if (!nav.nextSibling) { const p = document.createElement('p'); p.innerHTML = '<br>'; paper.appendChild(p); }
      saveRange(); changed(); refresh();
    }
    function ensureToc() { paper.querySelectorAll('.gd-toc').forEach(function (nav) { if (!nav.querySelector('.gd-toc-tools')) nav.insertAdjacentHTML('beforeend', TOC_TOOLS); nav.setAttribute('contenteditable', 'false'); if (!nav.getAttribute('data-sig')) nav.setAttribute('data-sig', tocSig(nav)); }); }
    ensureToc();
    let tocTimer = null;
    function autoToc() {
      const nav = paper.querySelector('.gd-toc'); if (!nav) return;
      const sig = tocSig(nav);
      if (nav.getAttribute('data-sig') === sig) return;
      buildTocList(nav); nav.setAttribute('data-sig', sig); changed();
    }
    paper.addEventListener('input', function () { clearTimeout(tocTimer); tocTimer = setTimeout(autoToc, 700); });

    // ---- 行距與段落間距 ----
    function spacingPop(anchor) {
      const p = popupAt(anchor, 'gd-pop-menu');
      const cur = blocksInSelection()[0];
      const lh = cur && cur.style.lineHeight ? parseFloat(cur.style.lineHeight) : 1.5;
      [['1', '單行'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', '雙倍'], null, ['before', (cur && cur.style.marginTop ? '移除' : '加上') + '段前間距'], ['after', (cur && cur.style.marginBottom ? '移除' : '加上') + '段後間距'], null, ['custom', '自訂行距…']].forEach(function (it) {
        if (!it) { p.appendChild(el('div', 'gd-menu-sep')); return; }
        const b = el('button', 'gd-menu-item' + (/^[\d.]+$/.test(it[0]) && Math.abs(parseFloat(it[0]) - lh) < 0.01 ? ' on' : ''), '<span>' + esc(it[1]) + '</span>'); b.type = 'button'; b.setAttribute('data-a', 'ls-' + it[0]);
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function () {
          closePop(); restoreRange();
          const bs = blocksInSelection(); if (!bs.length) return;
          if (it[0] === 'before') bs.forEach(function (x) { x.style.marginTop = x.style.marginTop ? '' : '10pt'; });
          else if (it[0] === 'after') bs.forEach(function (x) { x.style.marginBottom = x.style.marginBottom ? '' : '10pt'; });
          else if (it[0] === 'custom') {
            const ask = global.App && App.prompt ? App.prompt({ title: '自訂行距', message: '輸入倍數，例如 1.3', value: String(lh), ok: '套用' }) : Promise.resolve(window.prompt('行距', String(lh)));
            ask.then(function (v) { const n = parseFloat(v); if (!n || n < 0.5 || n > 5) return; restoreRange(); blocksInSelection().forEach(function (x) { x.style.lineHeight = String(n); }); saveRange(); changed(); refresh(); });
            return;
          } else bs.forEach(function (x) { x.style.lineHeight = it[0]; });
          saveRange(); changed(); refresh();
        });
        p.appendChild(b);
      });
    }

    // ---- 工具：字數統計、尋找與取代 ----
    function wordCount(anchor) {
      const text = paper.textContent || '';
      const chars = text.replace(/\s+/g, '').length, charsAll = text.replace(/\n/g, '').length;
      const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
      const words = (text.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length;
      const paras = Array.prototype.filter.call(paper.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th'), function (b) { return b.textContent.trim() && !b.querySelector('p,li,h1,h2,h3,h4,h5,h6') && !b.closest('.gd-toc'); }).length;
      const p = popupAt(anchor || host, 'gd-pop-count');
      p.innerHTML = '<div class="gd-pop-label">字數統計</div><table class="gd-count-tb"><tr><td>字數（不含空白）</td><td>' + chars + '</td></tr><tr><td>字元（含空白）</td><td>' + charsAll + '</td></tr><tr><td>詞（中文一字算一詞）</td><td>' + (cjk + words) + '</td></tr><tr><td>段落</td><td>' + paras + '</td></tr></table>';
    }
    let findEl = null;
    const findState = { q: '', matches: [], i: -1 };
    function collectMatches(needle) {
      findState.q = needle; findState.matches = [];
      if (!needle) return;
      const low = needle.toLowerCase();
      const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT, { acceptNode: function (t) { return t.parentNode && t.parentNode.closest && t.parentNode.closest('.gd-toc') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
      let t;
      while ((t = walker.nextNode())) {
        const v = t.nodeValue.toLowerCase(); let i = v.indexOf(low);
        while (i >= 0) { findState.matches.push({ node: t, i: i }); i = v.indexOf(low, i + Math.max(1, low.length)); }
      }
    }
    function openFind() {
      if (findEl) { findEl.querySelector('.gd-find-q').focus(); return; }
      closePop();
      findEl = el('div', 'gd-find');
      findEl.innerHTML = '<div class="gd-find-row"><input class="gd-input gd-find-q" type="text" placeholder="尋找" aria-label="尋找"><span class="gd-find-n"></span>' +
        '<button type="button" class="gd-tb" data-f="prev" title="上一個 (Shift+Enter)">' + ic('chevron-up') + '</button><button type="button" class="gd-tb" data-f="next" title="下一個 (Enter)">' + ic('chevron-down') + '</button><button type="button" class="gd-tb" data-f="close" title="關閉 (Esc)">' + ic('x') + '</button></div>' +
        '<div class="gd-find-row"><input class="gd-input gd-find-r" type="text" placeholder="取代為" aria-label="取代為"><button type="button" class="gd-btn" data-f="replace">取代</button><button type="button" class="gd-btn" data-f="all">全部取代</button></div>';
      host.appendChild(findEl);
      const q = findEl.querySelector('.gd-find-q'), r = findEl.querySelector('.gd-find-r'), n = findEl.querySelector('.gd-find-n');
      const s0 = window.getSelection();
      if (s0 && !s0.isCollapsed && paper.contains(s0.anchorNode)) q.value = s0.toString().replace(/\n/g, ' ').slice(0, 100);
      function show(k) {
        collectMatches(q.value);
        const m = findState.matches;
        if (!m.length) { findState.i = -1; clearHits(); n.textContent = q.value ? '沒有結果' : ''; return; }
        findState.i = ((k % m.length) + m.length) % m.length;
        const hit = m[findState.i];
        const rg = document.createRange(); rg.setStart(hit.node, hit.i); rg.setEnd(hit.node, hit.i + findState.q.length);
        savedRange = rg.cloneRange();
        paintHits();
        const elx = hit.node.parentNode; if (elx && elx.scrollIntoView) elx.scrollIntoView({ block: 'center' });
        n.textContent = (findState.i + 1) + ' / ' + m.length;
      }
      function replaceOne() {
        if (ro) return;
        if (findState.i < 0 || !findState.matches.length) { show(0); if (findState.i < 0) return; }
        const hit = findState.matches[findState.i];
        const rg = document.createRange(); rg.setStart(hit.node, hit.i); rg.setEnd(hit.node, hit.i + findState.q.length);
        paper.focus();
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg);
        document.execCommand('insertText', false, r.value);
        changed();
        show(findState.i);
        q.focus();
      }
      function replaceAll() {
        if (ro) return;
        collectMatches(q.value);
        if (!findState.matches.length) { n.textContent = q.value ? '沒有結果' : ''; return; }
        paper.focus();
        let count = 0;
        findState.matches.slice().reverse().forEach(function (m) {
          const rg = document.createRange(); rg.setStart(m.node, m.i); rg.setEnd(m.node, m.i + findState.q.length);
          const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg);
          document.execCommand('insertText', false, r.value); count++;
        });
        changed(); findState.i = -1;
        n.textContent = '已取代 ' + count + ' 處';
        q.focus();
      }
      findEl.addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
      findEl.addEventListener('click', function (e) {
        const b = e.target.closest('[data-f]'); if (!b) return;
        const f = b.getAttribute('data-f');
        if (f === 'next') show(findState.i + 1); else if (f === 'prev') show(findState.i - 1); else if (f === 'close') { closeFind(); paper.focus(); }
        else if (f === 'replace') replaceOne(); else if (f === 'all') replaceAll();
      });
      q.addEventListener('input', function () { findState.i = -1; show(0); });
      findEl.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); closeFind(); paper.focus(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (e.target === r) replaceOne(); else show(e.shiftKey ? findState.i - 1 : findState.i + 1); }
      });
      q.focus(); q.select();
      if (q.value) show(0);
    }
    // 全部符合的淡黃、目前這個橘色：CSS.highlights（Chrome 105+），沒有就退回用選取範圍標目前那一個
    function paintHits() {
      const m = findState.matches;
      if (global.CSS && CSS.highlights && global.Highlight) {
        const all = new Highlight(), cur = new Highlight();
        m.forEach(function (h, k) { const r = document.createRange(); r.setStart(h.node, h.i); r.setEnd(h.node, h.i + findState.q.length); (k === findState.i ? cur : all).add(r); });
        CSS.highlights.set('gd-find', all); CSS.highlights.set('gd-find-cur', cur);
      } else if (findState.i >= 0 && m[findState.i]) {
        const h = m[findState.i], r = document.createRange(); r.setStart(h.node, h.i); r.setEnd(h.node, h.i + findState.q.length);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      }
    }
    function clearHits() { if (global.CSS && CSS.highlights) { CSS.highlights.delete('gd-find'); CSS.highlights.delete('gd-find-cur'); } }
    function closeFind() { clearHits(); if (findEl) { findEl.remove(); findEl = null; } }

    // ---- 匯出：PDF（paged.js 排版的列印預覽）、Word ----
    function docTitle() { return opts.getTitle ? (opts.getTitle() || '文件') : (opts.title || '文件'); }
    function exportPDF() {
      if (!global.PDF || !PDF.showHTML) return Promise.resolve();
      return flush().then(function () { return PDF.showHTML(buildPrintHTML(paper, page, margins, docTitle()), { title: docTitle() }); });
    }
    function exportDocx() {
      setStatus('產生 Word 檔…');
      return docxFromPaper(paper, page, margins, docTitle()).then(function (blob) {
        downloadBlob(safeName(docTitle()) + '.docx', blob);
        setStatus(dirty ? '尚未儲存' : '已儲存', dirty ? '' : 'is-ok');
        return blob;
      }, function () { setStatus('匯出失敗', 'is-err'); });
    }

    function flush() {
      if (closed) return Promise.resolve();
      if (!dirty) return Promise.resolve();
      return emit();
    }
    function teardown() {
      clearTimeout(saveTimer);
      closePop();
      document.removeEventListener('selectionchange', onSel);
      document.removeEventListener('mousemove', onColMove);
      document.removeEventListener('mouseup', onColUp);
      if (rulerListeners) rulerListeners();
      clearTimeout(tocTimer); closeFind();
      clearTimeout(barTimer);
      if (codeRO) codeRO.disconnect();
      if (HL) TOKEN_GROUPS.forEach(function (g) { if (CSS.highlights.get('gd-t-' + g) === hlSets[g]) CSS.highlights.delete('gd-t-' + g); });
      codeState.clear();
      document.removeEventListener('mousedown', onDocDown, true);
      host.innerHTML = ''; host.classList.remove('gd-page');
    }
    function close() { if (closed) return; emit(); closed = true; teardown(); if (opts.onClose) opts.onClose(); }
    function discard() { if (closed) return; closed = true; dirty = false; teardown(); }
    function setContent(html) { paper.innerHTML = toLive(html) || '<p><br></p>'; ensureToc(); drawHF(); dirty = false; setStatus('已儲存', 'is-ok'); count(); syncCode(true); }

    applyMargins(); drawHF();
    syncCode(true);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (!closed) syncCode(true); });
    count(); refresh();
    if (content) setStatus('已儲存', 'is-ok');
    setTimeout(function () { if (!closed && !ro) paper.focus(); }, 30);
    return { close: close, requestClose: close, discard: discard, flush: flush, setContent: setContent, exportPDF: exportPDF, exportDocx: exportDocx, setPage: setPage, getPage: function () { return Object.assign({}, page); } };
  }

  global.Doc = { isNote: isNote, generate: generate, open: open, sanitize: sanitize, textOf: textOf, toStored: toStored, toLive: toLive, buildPrintHTML: buildPrintHTML, docxFromPaper: docxFromPaper, cleanPage: cleanPage, PAGE_SIZES: PAGE_SIZES,
    staticCode: staticCode, staticCodeHTML: staticCodeHTML, codePrintCSS: codePrintCSS, codeSegments: codeSegments, CODE_LANGS: CODE_LANGS };
})(window);
