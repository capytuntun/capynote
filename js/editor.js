/* editor.js — lightweight markdown editing helpers + autocomplete for a textarea */
(function (global) {
  'use strict';

  const OPENERS = { '(': ')', '[': ']', '{': '}', '"': '"' };
  const WRAPPERS = { '*': '*', '_': '_', '`': '`', '~': '~' };
  const CLOSERS = { ')': true, ']': true, '}': true, '"': true };

  const CALLOUTS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION',
    'RISK:CRITICAL', 'RISK:HIGH', 'RISK:MEDIUM', 'RISK:LOW', 'RISK:INFO'];
  // CodiMD/HackMD `:::` container names (offered after typing ':::').
  const CONTAINERS = ['info', 'success', 'warning', 'danger', 'note', 'tip', 'important', 'caution'];
  const LANGS = ['javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx', 'python', 'java', 'c',
    'cpp', 'csharp', 'go', 'rust', 'ruby', 'php', 'kotlin', 'swift', 'dart', 'scala', 'r',
    'html', 'xml', 'css', 'scss', 'less', 'json', 'yaml', 'toml', 'ini', 'markdown', 'sql',
    'bash', 'shell', 'powershell', 'dockerfile', 'makefile', 'lua', 'perl', 'haskell',
    'diff', 'graphql', 'plaintext'];
  const MACHINE_SNIPPET = [
    '## $CURSOR — [IP]',
    '',
    '### Service Enumeration',
    '',
    '| Host | Ports Open |',
    '| --- | --- |',
    '| [IP] | **TCP:** <br> **UDP:** |',
    '',
    '```bash=',
    'nmap -sC -sV -p- [IP]',
    '```',
    '',
    '### Initial Access',
    '',
    '### local.txt',
    '```',
    '[ 在此貼上 local.txt 內容 ]',
    '```',
    '',
    '### Privilege Escalation',
    '',
    '### proof.txt',
    '```',
    '[ 在此貼上 proof.txt 內容 ]',
    '```',
    ''
  ].join('\n');
  const ADSET_SNIPPET = [
    '# Active Directory Set',
    '',
    '**Domain:** `$CURSOR`',
    '',
    '## Overview',
    '',
    '### Host Enumeration',
    '| Hostname | IP | Ports Open |',
    '| --- | --- | --- |',
    '| [HOST] | [IP] | **TCP:** |',
    '',
    '## AD Host — [HOST] ([IP])',
    '',
    '### Enumeration',
    '```bash=',
    'nmap -sC -sV [IP]',
    '```',
    '',
    '### Exploitation / Access',
    '',
    '### Credentials Collected',
    '',
    '### Proof',
    '```',
    '[ 在此貼上 proof 內容 ]',
    '```',
    '',
    '## Domain Compromise',
    ''
  ].join('\n');
  // Supplies note titles for the [[…]] autocomplete. app.js owns the note list
  // and registers a provider(query) -> [{id, title}] here.
  let noteProvider = null;
  function setNoteProvider(fn) { noteProvider = fn; }

  // The user's own templates (templates.js) join the built-in /commands, so a
  // template called "Web App" is also reachable as /webapp.
  let extraSnippets = [];
  function setExtraSnippets(list) { extraSnippets = Array.isArray(list) ? list : []; }
  // Commands that do something instead of inserting text (/file opens the file
  // picker). Each is { cmd, hint, action(textarea) }; app.js registers them.
  let actionSnippets = [];
  function setActionSnippets(list) { actionSnippets = Array.isArray(list) ? list : []; }
  function allSnippets() { return SNIPPETS.concat(actionSnippets, extraSnippets); }

  const SNIPPETS = [
    { cmd: 'machine', hint: '新增機器區塊', text: MACHINE_SNIPPET },
    { cmd: 'wiki', hint: '連結到其他筆記', text: '[[$CURSOR]]' },
    { cmd: 'toc', hint: '目錄（依 # 標題自動產生）', text: '[toc]\n\n$CURSOR' },
    { cmd: 'adset', hint: '新增 AD Set 區塊', text: ADSET_SNIPPET },
    { cmd: 'risk', hint: '弱點（會列入總覽表）', text: '> [!RISK:HIGH] $CURSOR\n> ' },
    { cmd: 'note', hint: 'Note callout', text: '> [!NOTE]\n> $CURSOR' },
    { cmd: 'tip', hint: 'Tip callout', text: '> [!TIP]\n> $CURSOR' },
    { cmd: 'important', hint: 'Important callout', text: '> [!IMPORTANT]\n> $CURSOR' },
    { cmd: 'warning', hint: 'Warning callout', text: '> [!WARNING]\n> $CURSOR' },
    { cmd: 'caution', hint: 'Caution callout', text: '> [!CAUTION]\n> $CURSOR' },
    { cmd: 'info', hint: ':::info 容器（＝ [!NOTE]）', text: ':::info\n$CURSOR\n:::' },
    { cmd: 'success', hint: ':::success 容器（＝ [!TIP]）', text: ':::success\n$CURSOR\n:::' },
    { cmd: 'danger', hint: ':::danger 容器（＝ [!CAUTION]）', text: ':::danger\n$CURSOR\n:::' },
    { cmd: 'code', hint: '程式碼區塊（= 顯示行號，游標處填語言）', text: '```$CURSOR=\n\n```' },
    { cmd: 'table', hint: '表格', text: '| 欄位 A | 欄位 B |\n| --- | --- |\n| $CURSOR |  |' },
    { cmd: 'todo', hint: '待辦清單（預覽可直接勾選）', text: '- [ ] $CURSOR' },
    // A wiki link alone on its own line renders as a sub-page card, so /page is
    // just that with the title pre-selected — type over it and click the card to
    // create the page. `pick` selects the placeholder instead of leaving a caret.
    { cmd: 'page', hint: '子頁面（自成一行的筆記連結）', text: '\n[[子頁面標題]]\n', pick: '子頁面標題' },
    { cmd: 'mindmap', hint: '心智圖（縮排大綱）',
      text: '```mindmap\n中央主題\n  分支一\n  分支二\n```\n', pick: '中央主題' },
    { cmd: 'quote', hint: '引用', text: '> $CURSOR' },
    { cmd: 'hr', hint: '分隔線', text: '\n---\n\n$CURSOR' },
    { cmd: 'h1', hint: '標題 1', text: '# $CURSOR' },
    { cmd: 'h2', hint: '標題 2', text: '## $CURSOR' },
    { cmd: 'h3', hint: '標題 3', text: '### $CURSOR' },
    { cmd: 'link', hint: '連結', text: '[$CURSOR](url)' },
    { cmd: 'preview', hint: '網址預覽卡片（標題、摘要、縮圖）', text: '{%preview $CURSOR %}' },
    { cmd: 'image', hint: '圖片', text: '![$CURSOR](url)' },
    { cmd: 'bold', hint: '粗體', text: '**$CURSOR**' },
    { cmd: 'italic', hint: '斜體', text: '*$CURSOR*' }
  ];

  function attach(ta) {
    let popup = null;      // DOM element
    let items = [];        // current suggestions
    let index = 0;         // active suggestion
    let ctx = null;        // {type, query, from, to}

    ta.addEventListener('keydown', onKeyDown);
    ta.addEventListener('input', onInput);
    // 中文輸入法開著時按反引號鍵，打出來的常常是注音第四聲「ˋ」（U+02CB）或全形「｀」（U+FF40）——在等寬字型裡
    // 跟「`」長得一模一樣，預覽卻不認，行內程式碼整段配錯對（使用者回報過兩次，自己看不出差別）。打字時就換成
    // 真的反引號：直接打進來的在 beforeinput（capture，比多游標的 beforeinput 先）攔下來改送「`」，輸入法組字送出
    // 的在 compositionend 把剛送出的那幾個字換掉。都走 insertText，Ctrl+Z 還原得回來。注音的聲調（「ㄅㄚˋ」，
    // 前一個字是注音符號）不動；貼上的內容也不動。
    const LOOKALIKE = /[ˋ｀]/;
    const BOPOMOFO = /[ㄅ-ㄯㆠ-ㆿ]/;
    function fixTicks(text, prev) {
      let out = '';
      for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i), before = i ? text.charAt(i - 1) : prev;
        out += (ch === '｀' || (ch === 'ˋ' && !BOPOMOFO.test(before || ''))) ? '`' : ch;
      }
      return out;
    }
    ta.addEventListener('beforeinput', function (e) {
      if (e.inputType !== 'insertText' || !e.data || !LOOKALIKE.test(e.data)) return;
      const fixed = fixTicks(e.data, ta.value.charAt(ta.selectionStart - 1));
      if (fixed === e.data) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      document.execCommand('insertText', false, fixed);
    }, true);
    ta.addEventListener('compositionend', function (e) {
      const data = e.data || '';
      if (!LOOKALIKE.test(data)) return;
      const end = ta.selectionStart, start = end - data.length;
      if (start < 0 || ta.selectionEnd !== end || ta.value.slice(start, end) !== data) return;
      const fixed = fixTicks(data, ta.value.charAt(start - 1));
      if (fixed === data) return;
      ta.setSelectionRange(start, end);
      document.execCommand('insertText', false, fixed);
    });
    ta.addEventListener('blur', function () { setTimeout(closePopup, 150); });
    ta.addEventListener('scroll', closePopup);
    ta.addEventListener('click', closePopup);

    let suppressAC = false; // don't reopen the popup for programmatic edits

    function fireChange() { ta.dispatchEvent(new Event('input', { bubbles: true })); }

    function replaceRange(start, end, text, curStart, curEnd) {
      const v = ta.value;
      ta.value = v.slice(0, start) + text + v.slice(end);
      const cs = (curStart == null) ? start + text.length : curStart;
      ta.selectionStart = cs;
      ta.selectionEnd = (curEnd == null) ? cs : curEnd;
      suppressAC = true;
      fireChange();          // runs onInput synchronously
      suppressAC = false;
    }

    // ---------------- key handling ----------------
    function onKeyDown(e) {
      if (popup) {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
        if (e.key === 'Escape') { e.preventDefault(); closePopup(); return; }
        if (e.key === 'Tab') { e.preventDefault(); accept(items[index]); return; }
        // Enter selects the highlighted item in every popup, including the
        // bare-'>' callout menu and the ':::' container menu.
        if (e.key === 'Enter') { e.preventDefault(); accept(items[index]); return; }
      }

      const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
      const key = e.key;
      const printable = key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

      // Enter → smart list / quote continuation
      if (key === 'Enter' && !e.shiftKey && !popup) {
        if (smartEnter(v, s, en)) { e.preventDefault(); return; }
      }

      // Tab → indent / insert spaces
      if (key === 'Tab') {
        e.preventDefault();
        handleTab(e.shiftKey, v, s, en);
        return;
      }

      // Backspace → delete empty auto-pair
      if (key === 'Backspace' && s === en && s > 0) {
        const before = v[s - 1], after = v[s];
        if ((OPENERS[before] && OPENERS[before] === after) ||
            (before === '`' && after === '`') || (before === '"' && after === '"')) {
          e.preventDefault();
          replaceRange(s - 1, s + 1, '', s - 1, s - 1);
          return;
        }
      }

      if (!printable) return;

      // Over-type an auto-inserted closing char
      if (CLOSERS[key] && s === en && v[s] === key) {
        e.preventDefault();
        ta.selectionStart = ta.selectionEnd = s + 1;
        return;
      }

      // Wrap selection with * _ ` ~
      if (WRAPPERS[key] && s !== en) {
        e.preventDefault();
        const sel = v.slice(s, en);
        replaceRange(s, en, key + sel + WRAPPERS[key], s + 1, en + 1);
        return;
      }

      // Auto-pair brackets / quotes
      if (OPENERS[key]) {
        e.preventDefault();
        if (s !== en) {
          const sel = v.slice(s, en);
          replaceRange(s, en, key + sel + OPENERS[key], s + 1, en + 1);
        } else {
          // don't pair a quote right after a word char
          if (key === '"' && /\w/.test(v[s - 1] || '')) return void replaceRange(s, en, key);
          replaceRange(s, en, key + OPENERS[key], s + 1, s + 1);
        }
        return;
      }
    }

    function smartEnter(v, s, en) {
      if (s !== en) return false;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const line = v.slice(lineStart, s);
      let m;
      // task list
      if ((m = line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/))) {
        if (m[4].trim() === '') { replaceRange(lineStart, s, m[1]); return true; }
        replaceRange(s, s, '\n' + m[1] + m[2] + ' [ ] '); return true;
      }
      // bullet list
      if ((m = line.match(/^(\s*)([-*+])\s+(.*)$/))) {
        if (m[3].trim() === '') { replaceRange(lineStart, s, m[1]); return true; }
        replaceRange(s, s, '\n' + m[1] + m[2] + ' '); return true;
      }
      // ordered list
      if ((m = line.match(/^(\s*)(\d+)([.)])\s+(.*)$/))) {
        if (m[4].trim() === '') { replaceRange(lineStart, s, m[1]); return true; }
        replaceRange(s, s, '\n' + m[1] + (parseInt(m[2], 10) + 1) + m[3] + ' '); return true;
      }
      // blockquote (incl. callout body)
      if ((m = line.match(/^(\s*)((?:>\s?)+)(.*)$/))) {
        if (m[3].trim() === '') { replaceRange(lineStart, s, m[1]); return true; }
        const prefix = m[2].replace(/\s*$/, ' ');
        replaceRange(s, s, '\n' + m[1] + prefix); return true;
      }
      return false;
    }

    // One indent level is 4 spaces. On a list item, Tab / Shift+Tab move the whole
    // line in or out a level wherever the caret is: typing "- " and pressing Tab
    // nests that bullet instead of padding the gap after its dash.
    const INDENT = '    ';
    function handleTab(shift, v, s, en) {
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const multi = v.slice(s, en).indexOf('\n') >= 0;
      const lineEnd = v.indexOf('\n', s);
      const listLine = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/.test(v.slice(lineStart, lineEnd < 0 ? v.length : lineEnd));
      if (!shift && !multi && s === en && !listLine) { replaceRange(s, en, INDENT); return; }
      // indent / outdent affected lines
      const endLine = v.indexOf('\n', en);
      const blockEnd = endLine === -1 ? v.length : endLine;
      const block = v.slice(lineStart, blockEnd);
      let changed;
      if (shift) {
        changed = block.replace(/^(?: {1,4}|\t)/gm, '');
      } else {
        changed = block.replace(/^/gm, INDENT);
      }
      // Multi-line: keep the block selected so Tab can be pressed again. Single
      // line: move the caret with the text — selecting the line here meant the
      // next key typed wiped it.
      if (multi) { replaceRange(lineStart, blockEnd, changed, lineStart, lineStart + changed.length); return; }
      const delta = changed.length - block.length;
      replaceRange(lineStart, blockEnd, changed, Math.max(lineStart, s + delta), Math.max(lineStart, en + delta));
    }

    // ---------------- autocomplete ----------------
    function onInput() {
      if (suppressAC) return; // ignore edits we made programmatically
      ctx = detectContext();
      if (!ctx) { closePopup(); return; }
      items = buildItems(ctx);
      if (!items.length) { closePopup(); return; }
      index = 0;
      openPopup();
    }

    // Whether the text before `lineStart` leaves us inside an already-open fence —
    // a bare ``` typed there is someone closing that block, not opening a new one,
    // so it must not offer (and Enter must not accept) the language autocomplete.
    function inFenceBefore(lineStart) {
      const before = ta.value.slice(0, lineStart).split('\n');
      let inFence = false;
      for (let i = 0; i < before.length; i++) {
        if (/^\s*(```|~~~)/.test(before[i])) inFence = !inFence;
      }
      return inFence;
    }

    function detectContext() {
      const caret = ta.selectionStart;
      if (caret !== ta.selectionEnd) return null;
      const v = ta.value;
      const lineStart = v.lastIndexOf('\n', caret - 1) + 1;
      const line = v.slice(lineStart, caret);
      let m;
      if ((m = line.match(/^```([a-zA-Z0-9+#.-]*)$/)) && !inFenceBefore(lineStart)) {
        return { type: 'lang', query: m[1].toLowerCase(), from: lineStart + 3, to: caret };
      }
      // '[[' -> offer note titles to link to
      if ((m = line.match(/\[\[([^\[\]|\n]*)$/))) {
        return { type: 'note', query: m[1], from: caret - m[1].length, to: caret };
      }
      // Fresh blockquote line ('>' or '> ') -> offer callout types
      if ((m = line.match(/^([ \t]*)>[ \t]*$/))) {
        return { type: 'callout', mode: 'quote', query: '', indent: m[1], lineStart: lineStart, from: caret, to: caret };
      }
      // Explicit '[!' partial -> filter callout types (':' so RISK:HIGH matches)
      if ((m = line.match(/\[!([a-zA-Z:]*)$/))) {
        return { type: 'callout', mode: 'bracket', query: m[1].toUpperCase(), from: caret - m[1].length, to: caret };
      }
      // ':::' container fence — a bare ':::' already opens the menu (empty query)
      if ((m = line.match(/^:::[ \t]*([a-zA-Z]*)$/))) {
        return { type: 'container', query: m[1].toLowerCase(), from: lineStart, to: caret };
      }
      if ((m = line.match(/(?:^|\s)\/([a-zA-Z0-9]*)$/))) {
        return { type: 'slash', query: m[1].toLowerCase(), from: caret - m[1].length - 1, to: caret };
      }
      return null;
    }

    function buildItems(c) {
      if (c.type === 'lang') {
        return LANGS.filter(function (l) { return l.indexOf(c.query) === 0; })
          .slice(0, 8).map(function (l) { return { label: l, hint: 'language', kind: 'lang' }; });
      }
      if (c.type === 'callout') {
        return CALLOUTS.filter(function (l) { return l.indexOf(c.query) === 0; })
          .map(function (l) { return { label: l, hint: 'callout', kind: 'callout' }; });
      }
      if (c.type === 'container') {
        return CONTAINERS.filter(function (l) { return l.indexOf(c.query) === 0; })
          .map(function (l) { return { label: l, hint: '容器 :::', kind: 'container' }; });
      }
      if (c.type === 'slash') {
        return allSnippets().filter(function (sn) { return sn.cmd.indexOf(c.query) === 0; })
          .slice(0, 8).map(function (sn) { return { label: '/' + sn.cmd, hint: sn.hint, kind: 'slash', snip: sn }; });
      }
      if (c.type === 'note') {
        if (!noteProvider) return [];
        return noteProvider(c.query).slice(0, 8).map(function (n) {
          return { label: n.title || '未命名筆記', hint: '筆記', kind: 'note' };
        });
      }
      return [];
    }

    function accept(item) {
      if (!item || !ctx) { closePopup(); return; }
      if (item.kind === 'lang') {
        // ```bash= — the '=' turns on line numbers, which every new block gets by default.
        // If the '=' (and the rest of the block) is already there — the /code snippet
        // leaves the caret at ```|=\n\n``` — only fill in the language; appending a
        // second "=\n\n```" used to leave a stray ```= line and an extra empty block.
        const from = ctx.from, to = ctx.to;
        const text = ta.value[to] === '=' ? item.label : item.label + '=\n\n```';
        const caret = from + item.label.length + 2;
        replaceRange(from, to, text, caret, caret);
      } else if (item.kind === 'callout') {
        if (ctx.mode === 'quote') {
          // Replace the whole '> ' line with a complete callout header + body line.
          const text = ctx.indent + '> [!' + item.label + ']\n' + ctx.indent + '> ';
          replaceRange(ctx.lineStart, ctx.to, text);
        } else {
          // Absorb an already-present closing bracket (e.g. from auto-pairing '[')
          // so we don't leave a stray ']' behind.
          let to = ctx.to;
          if (ta.value[to] === ']') to += 1;
          replaceRange(ctx.from, to, item.label + ']\n> ');
        }
      } else if (item.kind === 'note') {
        // Swallow the ']]' auto-pairing already left behind, so we don't end up
        // with '[[Title]]]]', and drop the caret after the closing brackets.
        let to = ctx.to;
        if (ta.value.slice(to, to + 2) === ']]') to += 2;
        else if (ta.value[to] === ']') to += 1;
        replaceRange(ctx.from, to, item.label + ']]');
      } else if (item.kind === 'container') {
        // ':::info' + blank body line + closing ':::', caret on the blank line.
        const text = ':::' + item.label + '\n\n:::';
        const caret = ctx.from + 3 + item.label.length + 1;
        replaceRange(ctx.from, ctx.to, text, caret, caret);
      } else if (item.kind === 'slash') {
        if (typeof item.snip.action === 'function') {
          replaceRange(ctx.from, ctx.to, '');
          closePopup();
          item.snip.action(ta);
          return;
        }
        const t = item.snip.text;
        const idx = t.indexOf('$CURSOR');
        const clean = t.replace('$CURSOR', '');
        // `pick` selects a placeholder word instead of leaving a bare caret, so
        // the next thing typed replaces it. $CURSOR still wins if both are set.
        const pick = item.snip.pick;
        if (idx < 0 && pick) {
          const at = clean.indexOf(pick);
          if (at >= 0) {
            replaceRange(ctx.from, ctx.to, clean, ctx.from + at, ctx.from + at + pick.length);
            closePopup();
            return;
          }
        }
        const cur = ctx.from + (idx < 0 ? clean.length : idx);
        replaceRange(ctx.from, ctx.to, clean, cur, cur);
      }
      closePopup();
    }

    function move(dir) {
      index = (index + dir + items.length) % items.length;
      renderPopup();
    }

    function openPopup() {
      if (!popup) {
        popup = document.createElement('div');
        popup.className = 'ac-popup';
        document.body.appendChild(popup);
      }
      renderPopup();
      positionPopup();
    }

    function renderPopup() {
      if (!popup) return;
      popup.innerHTML = '';
      items.forEach(function (it, i) {
        const el = document.createElement('div');
        el.className = 'ac-item' + (i === index ? ' active' : '');
        // Built with textContent, not innerHTML: a label here can be a note
        // title or a user template name, so it is untrusted text, not markup.
        const name = document.createElement('span');
        name.textContent = it.label;
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = it.hint || '';
        el.appendChild(name);
        el.appendChild(hint);
        el.addEventListener('mousedown', function (e) { e.preventDefault(); accept(it); });
        el.addEventListener('mousemove', function () { index = i; highlight(); });
        popup.appendChild(el);
      });
    }
    function highlight() {
      if (!popup) return;
      Array.prototype.forEach.call(popup.children, function (c, i) {
        c.classList.toggle('active', i === index);
      });
    }

    function positionPopup() {
      const coords = caretCoords(ta, ta.selectionStart);
      const rect = ta.getBoundingClientRect();
      let left = rect.left + coords.left - ta.scrollLeft;
      let top = rect.top + coords.top - ta.scrollTop + coords.height + 4;
      left = Math.min(left, window.innerWidth - 220);
      if (top + 240 > window.innerHeight) top = rect.top + coords.top - ta.scrollTop - 244;
      popup.style.left = Math.max(8, left) + 'px';
      popup.style.top = Math.max(8, top) + 'px';
    }

    function closePopup() {
      if (popup) { popup.remove(); popup = null; }
      items = []; ctx = null;
    }
  }

  // ---- caret coordinates via mirror div ----
  const MIRROR_PROPS = ['boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
    'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace'];

  function caretCoords(el, position) {
    let div = caretCoords._div;
    if (!div) {
      div = document.createElement('div');
      caretCoords._div = div;
      document.body.appendChild(div);
    }
    const style = div.style;
    const computed = getComputedStyle(el);
    // fixed, not absolute: a body-level absolute box escapes body's overflow:clip and
    // grows the viewport's scrollable overflow (the mirror is ~editor height), which is
    // what let scrollIntoView push the topbar off-screen. Fixed never contributes.
    style.position = 'fixed';
    style.top = '0';
    style.left = '0';
    style.pointerEvents = 'none';
    style.visibility = 'hidden';
    style.whiteSpace = 'pre-wrap';
    style.wordWrap = 'break-word';
    MIRROR_PROPS.forEach(function (p) { style[p] = computed[p]; });
    style.overflow = 'hidden';
    div.textContent = el.value.substring(0, position);
    const span = document.createElement('span');
    span.textContent = el.value.substring(position) || '.';
    div.appendChild(span);
    const coords = {
      top: span.offsetTop + parseInt(computed.borderTopWidth, 10),
      left: span.offsetLeft + parseInt(computed.borderLeftWidth, 10),
      height: parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10) * 1.4
    };
    div.textContent = '';
    return coords;
  }

  global.Editor = {
    attach: attach,
    setNoteProvider: setNoteProvider,
    setExtraSnippets: setExtraSnippets,
    setActionSnippets: setActionSnippets,
    // Where the caret sits inside a textarea, for anyone positioning a popup over
    // it (the slash menu here). {top,left,height} are relative to the textarea's
    // top-left; add its getBoundingClientRect() and
    // subtract its scroll for viewport coordinates.
    caretCoords: caretCoords,
    snippets: { machine: MACHINE_SNIPPET, adset: ADSET_SNIPPET }
  };
})(window);
