/* markdown.js — GitHub-flavored markdown + callouts + syntax highlight + image refs */
(function (global) {
  'use strict';

  const CALLOUTS = {
    note:      { title: 'Note' },
    tip:       { title: 'Tip' },
    important: { title: 'Important' },
    warning:   { title: 'Warning' },
    caution:   { title: 'Caution' }
  };

  // CodiMD/HackMD `:::` container names mapped onto the callout types above, so
  // `:::info` renders identically to `> [!NOTE]`. The GitHub names also pass
  // straight through, so `:::tip` etc. work too.
  const CONTAINER_ALIAS = {
    info: 'note', success: 'tip', warning: 'warning', danger: 'caution',
    note: 'note', tip: 'tip', important: 'important', caution: 'caution'
  };

  // The one place callout HTML is built, shared by both the `> [!NOTE]` block
  // and the `:::info` container so the two syntaxes are pixel-identical.
  function calloutHTML(calloutType, title, innerHTML) {
    const meta = CALLOUTS[calloutType] || CALLOUTS.note;
    const label = title ? title : meta.title;
    return '<div class="callout callout-' + calloutType + '">' +
      '<div class="callout-title">' + escapeHtml(label) + '</div>' +
      '<div class="callout-content">' + innerHTML + '</div></div>\n';
  }

  // Findings written as `> [!RISK:HIGH] Title`. rank drives the summary sort.
  const RISK_LEVELS = {
    critical: { label: 'Critical', rank: 0 },
    high:     { label: 'High',     rank: 1 },
    medium:   { label: 'Medium',   rank: 2 },
    low:      { label: 'Low',      rank: 3 },
    info:     { label: 'Info',     rank: 4 }
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slugify(text) {
    let slug = String(text)
      .toLowerCase()
      .trim()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\w一-鿿\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
    // Ensure the id is a valid CSS selector (must not start with a digit or '-'),
    // otherwise paged.js target-counter resolution (querySelector('#'+id)) throws.
    if (/^[0-9-]/.test(slug)) slug = 'sec-' + slug;
    return slug;
  }

  // ---- Callout block extension -------------------------------------------
  const calloutExtension = {
    name: 'callout',
    level: 'block',
    start: function (src) {
      const m = src.match(/^ {0,3}> ?\[!/m);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const rule = /^( {0,3}> ?\[!(note|tip|important|warning|caution)\]([^\n]*)(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*))/i;
      const match = rule.exec(src);
      if (!match) return;
      const type = match[2].toLowerCase();
      const title = (match[3] || '').trim();
      const lines = match[0].replace(/\n+$/, '').split('\n');
      lines.shift(); // drop the [!TYPE] marker line
      const body = lines.map(function (l) { return l.replace(/^ {0,3}> ?/, ''); }).join('\n');
      const token = {
        type: 'callout',
        raw: match[0],
        calloutType: type,
        title: title,
        tokens: []
      };
      this.lexer.blockTokens(body, token.tokens);
      return token;
    },
    renderer: function (token) {
      return calloutHTML(token.calloutType, token.title, this.parser.parse(token.tokens));
    }
  };

  // ---- Container block: :::info … ::: (CodiMD/HackMD) ---------------------
  // Same output as the callout above. Supports an optional title on the marker
  // line (`:::info 標題`), nested containers, and an unclosed block runs to EOF.
  const containerExtension = {
    name: 'container',
    level: 'block',
    start: function (src) {
      const m = src.match(/^ {0,3}:::/m);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const nl0 = src.indexOf('\n');
      const first = nl0 < 0 ? src : src.slice(0, nl0);
      const open = /^ {0,3}:::[ \t]*([A-Za-z][\w-]*)[ \t]*(.*)$/.exec(first);
      if (!open) return;
      const mapped = CONTAINER_ALIAS[open[1].toLowerCase()];
      if (!mapped) return;                     // unknown container: leave it alone
      const title = (open[2] || '').trim();

      // Walk the following lines to the matching bare `:::`, tracking nesting.
      const bodyStart = nl0 < 0 ? src.length : nl0 + 1;
      let idx = bodyStart, depth = 1, bodyEnd = -1, rawEnd = src.length;
      while (idx < src.length) {
        const nl = src.indexOf('\n', idx);
        const lineEnd = nl < 0 ? src.length : nl;
        const next = nl < 0 ? src.length : nl + 1;
        const line = src.slice(idx, lineEnd);
        if (/^ {0,3}:::[ \t]*$/.test(line)) {                 // bare ::: → close
          if (--depth === 0) { bodyEnd = idx; rawEnd = next; break; }
        } else if (/^ {0,3}:::[ \t]*[A-Za-z]/.test(line)) {   // nested open
          depth++;
        }
        idx = next;
      }
      if (bodyEnd < 0) { bodyEnd = src.length; rawEnd = src.length; }   // unclosed → EOF
      const token = {
        type: 'container',
        raw: src.slice(0, rawEnd),
        calloutType: mapped,
        title: title,
        tokens: []
      };
      this.lexer.blockTokens(src.slice(bodyStart, bodyEnd), token.tokens);
      return token;
    },
    renderer: function (token) {
      return calloutHTML(token.calloutType, token.title, this.parser.parse(token.tokens));
    }
  };

  // ---- Risk finding block: > [!RISK:HIGH] Title ---------------------------
  // Each finding gets a stable id so the PDF summary table can point at it and
  // resolve its page number with target-counter().
  let findingSeq = 0;   // reset per render, like usedSlugs below
  // Position of each to-do checkbox in document order. app.js uses it to find
  // the matching `- [ ]` line in the source when someone ticks one off.
  let taskSeq = 0;      // reset per render

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  const riskExtension = {
    name: 'risk',
    level: 'block',
    start: function (src) {
      const m = src.match(/^ {0,3}> ?\[!RISK:/im);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const rule = /^( {0,3}> ?\[!RISK:(critical|high|medium|low|info)\]([^\n]*)(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*))/i;
      const match = rule.exec(src);
      if (!match) return;
      const level = match[2].toLowerCase();
      const lines = match[0].replace(/\n+$/, '').split('\n');
      lines.shift(); // drop the [!RISK:x] marker line
      const body = lines.map(function (l) { return l.replace(/^ {0,3}> ?/, ''); }).join('\n');
      const token = {
        type: 'risk',
        raw: match[0],
        level: level,
        title: (match[3] || '').trim(),
        tokens: []
      };
      this.lexer.blockTokens(body, token.tokens);
      return token;
    },
    renderer: function (token) {
      const meta = RISK_LEVELS[token.level] || RISK_LEVELS.info;
      const n = ++findingSeq;
      const id = 'finding-' + n;
      const title = token.title || (meta.label + ' finding');
      const inner = this.parser.parse(token.tokens);
      return '<div class="finding finding-' + token.level + '" id="' + id + '"' +
        ' data-risk="' + token.level + '" data-finding="' + n + '">' +
        '<div class="finding-head">' +
        '<span class="risk-badge">' + escapeHtml(meta.label.toUpperCase()) + '</span>' +
        '<span class="finding-no">F-' + pad2(n) + '</span>' +
        '<span class="finding-title">' + escapeHtml(title) + '</span>' +
        '</div>' +
        '<div class="finding-content">' + inner + '</div></div>\n';
    }
  };

  // Pull the findings out of rendered HTML: [{id, level, rank, no, title}]
  function extractFindings(container) {
    return Array.prototype.map.call(container.querySelectorAll('.finding'), function (f) {
      const level = f.getAttribute('data-risk') || 'info';
      const meta = RISK_LEVELS[level] || RISK_LEVELS.info;
      const titleEl = f.querySelector('.finding-title');
      return {
        id: f.id,
        level: level,
        label: meta.label,
        rank: meta.rank,
        no: parseInt(f.getAttribute('data-finding'), 10) || 0,
        title: titleEl ? titleEl.textContent : ''
      };
    });
  }

  // ---- Wiki-link extension: [[筆記標題]] / [[筆記標題|顯示文字]] ------------
  // Resolution needs the live note list, which lives in app.js. It hands us a
  // lookup(title) -> note|null here; without one, links render as unresolved.
  let noteLookup = null;
  function setNoteLookup(fn) { noteLookup = fn; }

  const WIKI_RE = /^\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]+))?\]\]/;

  const wikiLinkExtension = {
    name: 'wikilink',
    level: 'inline',
    start: function (src) {
      const m = src.match(/\[\[/);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const m = WIKI_RE.exec(src);
      if (!m) return;
      return {
        type: 'wikilink',
        raw: m[0],
        target: m[1].trim(),
        alias: (m[2] || '').trim()
      };
    },
    renderer: function (token) {
      const text = escapeHtml(token.alias || token.target);
      const note = noteLookup ? noteLookup(token.target) : null;
      if (note) {
        return '<a class="note-link" href="#" data-note-id="' + escapeHtml(note.id) + '"' +
          ' title="' + escapeHtml(note.title || '') + '">' + text + '</a>';
      }
      return '<a class="note-link missing" href="#" data-note-title="' + escapeHtml(token.target) + '"' +
        ' title="筆記「' + escapeHtml(token.target) + '」不存在——點擊建立">' + text + '</a>';
    }
  };

  // ---- Hashtag extension: #標籤 / #tag ------------------------------------
  // 標籤字元：英數、底線、連字號、斜線，以及中日文。須至少含一個「字母」，
  // 以排除 #123 這類純數字（純數字通常是 issue 編號而非標籤）。
  const TAG_CH = '0-9A-Za-z_/\\-\\u00c0-\\u024f\\u4e00-\\u9fff\\u3040-\\u30ff';
  const TAG_L  = 'A-Za-z_\\u00c0-\\u024f\\u4e00-\\u9fff\\u3040-\\u30ff';
  const HASHTAG_RE = new RegExp('^#([' + TAG_CH + ']*[' + TAG_L + '][' + TAG_CH + ']*)');

  const hashtagExtension = {
    name: 'hashtag',
    level: 'inline',
    start: function (src) {
      const m = src.match(/#/);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const m = HASHTAG_RE.exec(src);
      if (!m) return;
      return { type: 'hashtag', raw: m[0], tag: m[1] };
    },
    renderer: function (token) {
      const t = escapeHtml(token.tag);
      return '<a class="hashtag" href="#" data-tag="' + t + '">#' + t + '</a>';
    }
  };

  // Collect every #tag in a markdown source (deduped, in first-seen order).
  // Requires a boundary before '#' so mid-word '#' (URLs, C#) is ignored.
  // 一篇筆記的全部標籤：內文裡的 #標籤，加上 meta.tags（筆記選單的「標籤…」存的；看板、起始頁、
  // 文件、drawio 這些沒有 Markdown 內文的種類只能靠它）。大小寫不同的算同一個，保留先看到的寫法。
  function noteTags(note) {
    const out = [], seen = {};
    const add = function (t) { t = String(t || '').replace(/^#/, '').trim(); if (!t) return; const k = t.toLowerCase(); if (!seen[k]) { seen[k] = true; out.push(t); } };
    extractTags(note && note.content || '').forEach(add);
    if (note && note.meta && Array.isArray(note.meta.tags)) note.meta.tags.forEach(add);
    return out;
  }
  function extractTags(md) {
    const stripped = String(md || '')
      .replace(/```[\s\S]*?(?:```|$)/g, '')
      .replace(/`[^`\n]*`/g, '');
    const re = new RegExp('(^|[\\s(\\[（【「\'"])#([' + TAG_CH + ']*[' + TAG_L + '][' + TAG_CH + ']*)', 'g');
    const out = [], seen = {};
    let m;
    while ((m = re.exec(stripped))) {
      const tag = m[2];
      const key = tag.toLowerCase();
      if (!seen[key]) { seen[key] = true; out.push(tag); }
    }
    return out;
  }

  // Collect every [[target]] in a markdown source, in document order.
  // Fenced / inline code is stripped first so sample code never yields links.
  function extractLinks(md) {
    const stripped = String(md || '')
      .replace(/```[\s\S]*?(?:```|$)/g, '')
      .replace(/`[^`\n]*`/g, '');
    const re = /\[\[([^\[\]|\n]+)(?:\|[^\[\]\n]+)?\]\]/g;
    const out = [];
    let m;
    while ((m = re.exec(stripped))) out.push(m[1].trim());
    return out;
  }

  // Split hljs-highlighted HTML into one fragment per source line, re-closing
  // and re-opening any <span> that straddles a line break so each fragment is
  // valid on its own. hljs's HTML renderer only ever emits <span class="...">,
  // so a small tag-aware scan is enough here — no general HTML parser needed.
  function splitHighlightedLines(html) {
    const openTags = [];
    const lines = [];
    let cur = '';
    const re = /<span([^>]*)>|<\/span>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[2] !== undefined) {
        const parts = m[2].split('\n');
        parts.forEach(function (part, i) {
          cur += part;
          if (i < parts.length - 1) {
            for (let j = openTags.length - 1; j >= 0; j--) cur += '</span>';
            lines.push(cur);
            cur = '';
            for (let j = 0; j < openTags.length; j++) cur += '<span' + openTags[j] + '>';
          }
        });
      } else if (m[0] === '</span>') {
        cur += m[0];
        openTags.pop();
      } else {
        cur += m[0];
        openTags.push(m[1]);
      }
    }
    lines.push(cur);
    return lines;
  }

  // ---- [toc] extension: inline table of contents --------------------------
  // A line holding just `[toc]` (CodiMD / HackMD style) turns into a nested list
  // of every h1–h3 in the note — the same levels the sidebar and the PDF use.
  // The headings after the marker are not known yet when it is rendered, so the
  // renderer leaves a placeholder and render() swaps the real list in once the
  // whole document has been parsed.
  const TOC_PLACEHOLDER = '<!--md-toc-placeholder-->';
  const TOC_MAX_LEVEL = 3;
  let headingList = [];   // [{ level, text, id }] in document order, reset per render

  const tocExtension = {
    name: 'toc',
    level: 'block',
    start: function (src) {
      const m = src.match(/^ {0,3}\[toc\][ \t]*$/im);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const match = /^ {0,3}\[toc\][ \t]*(?:\n+|$)/i.exec(src);
      if (match) return { type: 'toc', raw: match[0] };
    },
    renderer: function () { return TOC_PLACEHOLDER + '\n'; }
  };

  // Inline [toc]: only the note's top heading level is listed (normally `#`).
  // Everything deeper is tucked into a collapsed sub-list under its parent and
  // appears only when the reader opens it. The toggle is a plain <button> —
  // app.js delegates the click, keys the open state by the *parent's* id (so the
  // side panel and this list stay in step) and restores it after each re-render.
  function buildInlineTOC() {
    const items = headingList.filter(function (h) { return h.level <= TOC_MAX_LEVEL; });
    if (!items.length) {
      return '<nav class="md-toc md-toc-empty">這份筆記還沒有標題，加上 # 標題後會自動列在這裡</nav>';
    }
    // A note that starts at ## (no h1 at all) should still show something, so
    // the always-visible level is whatever the shallowest heading happens to be.
    let top = 6;
    items.forEach(function (h) { if (h.level < top) top = h.level; });

    // Build a proper tree first: rendering straight from the flat list makes the
    // "1.1.1" numbering lie as soon as a level is skipped.
    const roots = [];
    const stack = [];
    items.forEach(function (h) {
      const node = { h: h, kids: [] };
      while (stack.length && stack[stack.length - 1].h.level >= h.level) stack.pop();
      if (stack.length) stack[stack.length - 1].kids.push(node);
      else roots.push(node);
      stack.push(node);
    });

    function renderList(nodes, cls) {
      let s = '<ul' + (cls ? ' class="' + cls + '"' : '') + '>';
      nodes.forEach(function (n) {
        s += '<li class="toc-l' + n.h.level + '"><a href="#' + n.h.id + '">' + n.h.text + '</a>';
        if (n.kids.length) {
          // Only the top level is shown; its whole subtree hides behind a toggle.
          if (n.h.level === top) {
            s += '<button type="button" class="md-toc-toggle" data-toc="' + n.h.id + '" ' +
              'aria-label="展開子標題"></button>' + renderList(n.kids, 'md-toc-kids');
          } else {
            s += renderList(n.kids, '');
          }
        }
        s += '</li>';
      });
      return s + '</ul>';
    }
    return '<nav class="md-toc">' + renderList(roots, 'md-toc-top') + '</nav>';
  }

  // ---- Link preview card: {%preview https://… %} -------------------------
  // HackMD-style embed syntax, alone on its own line. The markup is only the
  // frame showing the address; resolveLinkCards() asks the server for the page's
  // title / description / image afterwards and fills it in, and a site that
  // cannot be read simply leaves the address showing.
  const linkCardExtension = {
    name: 'linkcard',
    level: 'block',
    start: function (src) {
      const m = src.match(/^ {0,3}\{%\s*preview\s/im);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      const m = /^ {0,3}\{%\s*preview\s+(https?:\/\/\S+?)\s*%\}[ \t]*(?:\n+|$)/i.exec(src);
      if (m) return { type: 'linkcard', raw: m[0], url: m[1] };
    },
    renderer: function (token) {
      const url = escapeHtml(token.url);
      let host = token.url;
      try { host = new URL(token.url).hostname; } catch (e) { /* keep the raw text */ }
      return '<div class="link-card" data-link-url="' + url + '">' +
        '<a class="link-card-a" href="' + url + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="link-card-body">' +
        '<span class="link-card-title">' + escapeHtml(host) + '</span>' +
        '<span class="link-card-desc"></span>' +
        '<span class="link-card-url"><span class="link-card-icon"></span>' +
        '<span class="link-card-href">' + url + '</span></span>' +
        '</span><span class="link-card-thumb"></span></a></div>\n';
    }
  };

  // ---- 影片嵌入：YouTube 與 Google Drive（使用者：「Google Drive、Youtube 的影片如果有嵌入，要可以在預覽裡面播放」）----
  // 三種寫法都通：貼 YouTube／Drive「嵌入」給的 <iframe …>、HackMD 的 {%youtube ID %}／{%gdrive ID %}、
  // 或影片網址自己一行。不管哪一種，最後進到頁面的 <iframe src> 都是這裡用 id 重新組出來的網址
  // （youtube-nocookie.com/embed/<11 碼>、drive.google.com/file/d/<id>/preview），別人貼的原始 src 永遠不會原樣
  // 落地——這是 CSP frame-src 之外的第二道：連同站的 src="/" 都進不來（會變成把整個 app 框進筆記裡）。
  // 匯出（PDF、電子書、公開連結）播不了影片，換成一行連結（data-video-url 是給人看的網頁）。
  function videoEmbed(url) {
    const s = String(url || '').trim();
    let m = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i.exec(s);
    if (m) {
      const t = /[?&](?:t|start)=(\d+)/.exec(s);
      return { kind: 'youtube', src: 'https://www.youtube-nocookie.com/embed/' + m[1] + '?rel=0' + (t ? '&start=' + t[1] : ''), page: 'https://www.youtube.com/watch?v=' + m[1] + (t ? '&t=' + t[1] : '') };
    }
    m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#\s]*&)?id=)([A-Za-z0-9_-]{15,})/i.exec(s);
    if (m) return { kind: 'gdrive', src: 'https://drive.google.com/file/d/' + m[1] + '/preview', page: 'https://drive.google.com/file/d/' + m[1] + '/view' };
    return null;
  }
  function videoHTML(v) {
    return '<div class="video-embed is-' + v.kind + '"><iframe data-video-src="' + escapeHtml(v.src) + '" data-video-url="' + escapeHtml(v.page) + '" title="' + (v.kind === 'youtube' ? 'YouTube 影片' : 'Google Drive 影片') + '"></iframe></div>\n';
  }
  const videoExtension = {
    name: 'video',
    level: 'block',
    start: function (src) {
      const m = src.match(/^ {0,3}(?:\{%\s*(?:youtube|gdrive|video)\s|https?:\/\/(?:www\.|m\.)?(?:youtube(?:-nocookie)?\.com|youtu\.be|drive\.google\.com)\/)/im);
      return m ? m.index : undefined;
    },
    tokenizer: function (src) {
      let m = /^ {0,3}\{%\s*youtube\s+([A-Za-z0-9_-]{11})\s*%\}[ \t]*(?:\n+|$)/i.exec(src);
      if (m) return { type: 'video', raw: m[0], video: videoEmbed('https://www.youtube.com/watch?v=' + m[1]) };
      m = /^ {0,3}\{%\s*gdrive\s+([A-Za-z0-9_-]{15,})\s*%\}[ \t]*(?:\n+|$)/i.exec(src);
      if (m) return { type: 'video', raw: m[0], video: videoEmbed('https://drive.google.com/file/d/' + m[1] + '/view') };
      m = /^ {0,3}(?:\{%\s*video\s+)?(https?:\/\/\S+?)\s*(?:%\})?[ \t]*(?:\n+|$)/i.exec(src);
      if (m && /^ {0,3}(\{%|https?:\/\/)/.test(src)) { const v = videoEmbed(m[1]); if (v) return { type: 'video', raw: m[0], video: v }; }
      return undefined;
    },
    renderer: function (token) { return videoHTML(token.video); }
  };

  // Attachment link: [名稱](file:<id>) for any upload, [名稱](pdf:<id>) for a PDF
  // shown as a file rather than embedded. resolveImages() points the href at the
  // file; the server decides whether it opens (PDF) or downloads (anything else).
  function fileChipHTML(kind, id, labelHtml) {
    const plain = String(labelHtml || '').replace(/<[^>]*>/g, '').trim();
    const ext = kind === 'pdf' ? 'PDF' : ((/\.([a-z0-9]{1,8})$/i.exec(plain) || [])[1] || '').toUpperCase();
    return '<a class="file-chip" href="#" data-file-id="' + escapeHtml(id) + '" data-file-kind="' + kind + '"' +
      (kind === 'pdf' ? ' target="_blank" rel="noopener"' : '') +
      ' title="' + (kind === 'pdf' ? '在新分頁開啟' : '下載這個檔案') + '">' +
      (global.Icons ? Icons.svg(kind === 'pdf' ? 'file-text' : 'paperclip') : '') +
      '<span class="file-chip-name">' + (labelHtml || escapeHtml(id)) + '</span>' +
      (ext ? '<span class="file-chip-type">' + escapeHtml(ext) + '</span>' : '') + '</a>';
  }

  // ---- Switching how an embed is shown (js/embedswitch.js) ----------------
  // Rewrites the first matching construct within source lines start..end
  // (1-based, fenced code skipped) and returns the new text, or the same text
  // when nothing there matches:
  //   { type:'pdf', id, to:'file'|'preview' }  ![名稱](pdf:id) <-> [名稱](pdf:id)
  //   { type:'link' }                          a line that is just a link -> {%preview url %}
  //   { type:'card', title }                   {%preview url %} -> [title](url), or <url>
  const FENCE_LINE = /^\s{0,3}(?:```|~~~)/;
  // 圖片黑框：![說明](img:<id>) <-> ![說明](img:<id>#frame)，把第 index 張站內圖片的
  // 黑框打開／關掉（index 由呼叫端依預覽裡 <img> 的文件順序算出來，見 app.js 的
  // toggleImageFrame）。兩個對應關係一定要跟渲染端一致，才不會點 A 改到 B：
  //   1. 只認 `!` 開頭的——沒有驚嘆號的 [名稱](img:id) 走的是 link renderer，不會變成 <img>。
  //   2. 跳過圍籬程式碼區塊——教學文章裡「示範」的那行 ![x](img:…) 不會被渲染成圖片，
  //      也就不該佔掉一個序號。待辦清單的 toggleTask 用的是同一套對應方式。
  const IMG_FRAME = 'frame';
  const IMG_REF = /!\[[^\]\n]*\]\(img:[\w.-]+(#frame)?\)/g;
  function toggleImageFrame(text, index) {
    const lines = String(text).split('\n');
    let fence = false, seen = 0;
    for (let i = 0; i < lines.length; i++) {
      if (FENCE_LINE.test(lines[i])) { fence = !fence; continue; }
      if (fence) continue;
      IMG_REF.lastIndex = 0;
      let m;
      while ((m = IMG_REF.exec(lines[i]))) {
        if (seen++ !== index) continue;
        const ref = m[0];
        const next = m[1]
          ? ref.slice(0, -(IMG_FRAME.length + 2)) + ')'      // 去掉結尾的「#frame)」，補回「)」
          : ref.slice(0, -1) + '#' + IMG_FRAME + ')';        // 把結尾的「)」換成「#frame)」
        lines[i] = lines[i].slice(0, m.index) + next + lines[i].slice(m.index + ref.length);
        return lines.join('\n');
      }
    }
    return String(text);
  }
  function standaloneLinkUrl(line) {
    const s = line.trim();
    let m = /^\[[^\]\n]*\]\((https?:\/\/\S+?)(?:\s+"[^"\n]*")?\)$/.exec(s);
    if (m) return m[1];
    m = /^<(https?:\/\/[^\s>]+)>$/.exec(s);
    if (m) return m[1];
    m = /^(https?:\/\/\S+)$/.exec(s);
    return m ? m[1] : null;
  }
  function switchEmbed(text, start, end, spec) {
    const lines = String(text).split('\n');
    let fence = false;
    for (let i = 0; i < start - 1 && i < lines.length; i++) if (FENCE_LINE.test(lines[i])) fence = !fence;
    for (let i = Math.max(0, start - 1); i < end && i < lines.length; i++) {
      if (FENCE_LINE.test(lines[i])) { fence = !fence; continue; }
      if (fence) continue;
      const line = lines[i];
      const indent = line.match(/^\s*/)[0];
      let next = null, m;
      if (spec.type === 'pdf') {
        const id = String(spec.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        m = new RegExp('(!?)\\[([^\\]\\n]*)\\]\\(pdf:' + id + '\\)').exec(line);
        if (m && (m[1] === '!') === (spec.to === 'file')) {
          next = line.slice(0, m.index) + (spec.to === 'file' ? '' : '!') + '[' + m[2] + '](pdf:' + spec.id + ')' +
            line.slice(m.index + m[0].length);
        }
      } else if (spec.type === 'card') {
        m = /^\s*\{%\s*preview\s+(\S+?)\s*%\}\s*$/i.exec(line);
        if (m) {
          const title = String(spec.title || '').replace(/[\[\]\n]/g, '').trim();
          next = indent + (title ? '[' + title + '](' + m[1] + ')' : '<' + m[1] + '>');
        }
      } else if (spec.type === 'link') {
        const url = standaloneLinkUrl(line);
        if (url) next = indent + '{%preview ' + url + ' %}';
      }
      if (next != null) { lines[i] = next; return lines.join('\n'); }
    }
    return String(text);
  }

  // ---- Custom renderer overrides -----------------------------------------
  const usedSlugs = {};
  const renderer = {
    heading: function (text, level) {
      let base = slugify(text);
      let slug = base, i = 1;
      while (usedSlugs[slug]) { slug = base + '-' + (i++); }
      usedSlugs[slug] = true;
      // Plain-text copy (already HTML-escaped by marked) for the inline [toc]
      headingList.push({ level: level, text: text.replace(/<[^>]*>/g, ''), id: slug });
      return '<h' + level + ' id="' + slug + '">' + text + '</h' + level + '>\n';
    },
    // Notion-style to-do items. marked's default emits a disabled checkbox with
    // no hook back to the source; ours carries the index of the task in document
    // order, which is all app.js needs to find and flip the matching `- [ ]` in
    // the textarea. The counter is reset per render, in render() below.
    checkbox: function (checked) {
      return '<input class="task-check" type="checkbox" data-task="' + (taskSeq++) + '"' +
        (checked ? ' checked' : '') + '>';
    },
    listitem: function (text, task, checked) {
      if (!task) return '<li>' + text + '</li>\n';
      return '<li class="task-item' + (checked ? ' task-done' : '') + '">' + text + '</li>\n';
    },

    // A wiki link alone on its own line is a sub-page, the way Notion separates
    // an inline page mention from a sub-page block. Inline `[[x]]` inside a
    // sentence is untouched, and the markup stays a plain `[[標題]]` in the
    // source, so nothing new has to be understood to read the raw note.
    paragraph: function (text) {
      // 連結裡面不能再有 </a>：原本是貪婪的 [\s\S]*，一段「[[某篇]] 與 #標籤」會一路吃到
      // 最後那個 </a>，整段被當成子頁面卡片
      const m = String(text).trim().match(
        /^<a class="note-link( missing)?" href="#" (data-note-id|data-note-title)="([^"]*)"[^>]*>((?:(?!<\/a>)[\s\S])*)<\/a>$/);
      if (!m) return '<p>' + text + '</p>\n';
      const missing = !!m[1];
      return '<a class="page-card note-link' + (missing ? ' missing' : '') + '" href="#" ' +
        m[2] + '="' + m[3] + '">' +
        '<span class="page-card-ic">' + (global.Icons ? Icons.svg(missing ? 'file-plus' : 'file-page') : '') + '</span>' +
        '<span class="page-card-t">' + m[4] + '</span>' +
        '<span class="page-card-hint">' + (missing ? '點擊建立' : '子頁面') + '</span></a>\n';
    },

    code: function (code, infostring) {
      // CodiMD-style options in the info string: ```js=  or  ```js=10  (line numbers, optional start)
      const info = (infostring || '').trim();
      // ```mindmap holds an indented outline, rendered as a diagram. The outline
      // stays the source of truth — searchable, mergeable, and readable as text
      // if anything ever fails to draw.
      if (info === 'mindmap' && global.MindMap) {
        let svg = '';
        try { svg = MindMap.renderSVG(code); } catch (e) { svg = ''; }
        if (svg) {
          return '<div class="mindmap-block" data-mindmap="' + escapeHtml(code) + '">' +
            '<button class="mm-edit-btn" type="button" title="在全螢幕編輯器裡打開">' +
            (global.Icons ? Icons.svg('mind-map') : '') + ' 全螢幕</button>' + svg +
            '<div class="mm-hint">點節點選取，再按 Tab 加子項目、Enter 加同層、F2 改字，' +
            '直接拖曳可換上層</div></div>';
        }
      }
      // ```relmap 是關聯分析（js/relmap.js）：自由畫布的節點／連線圖，DSL 存節點
      // 位置跟連線，SVG 每次都重新畫。跟心智圖同一個做法，唯讀渲染只給看，要編輯
      // 按「全螢幕」進 RelMap.open()。
      if (info === 'relmap' && global.RelMap) {
        let svg = '';
        try { svg = RelMap.renderSVG(code); } catch (e) { svg = ''; }
        if (svg) {
          return '<div class="relmap-block" data-relmap="' + escapeHtml(code) + '">' +
            '<button class="rm-edit-btn" type="button" title="在全螢幕編輯器裡打開">' +
            (global.Icons ? Icons.svg('network') : '') + ' 全螢幕</button>' + svg + '</div>';
        }
      }
      // ```drawio 是自己做的繪圖工具（js/drawio.js）：圍欄裡是圖的 DSL（一行一個圖形或連線），
      // SVG 每次都重新畫，跟關聯分析、心智圖同一個做法。要編輯是打開那篇 meta.drawio 的筆記。
      if (info === 'drawio' && global.DrawIO) return DrawIO.blockHTML(code);
      // ```board 是看板（js/board.js）：圍欄裡是看板的 JSON，畫成靜態的列表與卡片（預覽、PDF、電子書）
      if (info === 'board' && global.Board) return Board.blockHTML(code);
      // ```startpage 是起始頁（js/startpage.js）：圍欄裡是那一頁的 JSON，畫成靜態的欄位與書籤
      if (info === 'startpage' && global.StartPage) return StartPage.blockHTML(code);
      // ```xmind 是心智圖（js/xmind.js）：圍欄裡是 JSON，畫成靜態的 SVG（多張工作表就一張一張）
      if (info === 'xmind' && global.XMind) return XMind.blockHTML(code);
      // ```timetree 是行事曆（js/timetree.js）：圍欄裡是 JSON，畫成這個月的月曆加接下來兩週
      if (info === 'timetree' && global.TimeTree) return TimeTree.blockHTML(code);
      // ```progress 是課程進度（js/progress.js）：圍欄裡是 JSON，畫成進度條加章節清單
      if (info === 'progress' && global.Progress) return Progress.blockHTML(code);
      // ```video 是個人區的一部影片（js/videos.js）：圍欄裡是它的欄位 JSON，畫成一張靜態卡片
      if (info === 'video' && global.Videos) return Videos.blockHTML(code);
      let requested = info, lineNumbers = false, startLine = 1;
      const opt = info.match(/^([^\s=]*)=(\d*)$/);
      if (opt) {
        requested = opt[1];
        lineNumbers = true;
        if (opt[2]) startLine = parseInt(opt[2], 10);
      }
      // ```linux（含 linux=）當成 shell 高亮，並標記 code-linux 讓 CSS 套用 Kali 終端配色。
      const ALIAS = { linux: 'bash', kali: 'bash' };
      const isKali = requested === 'linux' || requested === 'kali';
      // 沒標語言時預設用 bash 文法上色：滲透報告裡沒標語言的區塊絕大多數是指令。bash 文法
      // 很保守——只認得 # 註解、"字串"、$變數、少數內建指令，所以貼進來的「終端輸出」（nmap
      // 結果、whoami 表格、雜湊、mimikatz dump）幾乎一個 span 都不會有、維持純文字，指令才會
      // 上到色。這正是之前拿掉 highlightAuto 想要的效果：highlightAuto 會自信地把 whoami 輸出
      // 判成 SQL、把雜湊判成 Ruby 整片塗錯；bash 因為保守，同樣的輸出只會是純文字。ignoreIllegals
      // 讓奇怪內容不會丟例外。標籤留空——使用者沒說這是 bash，右上角就不寫，免得把輸出誤標成指令。
      const autoShell = !requested;
      const hlLang = ALIAS[requested] || (autoShell ? 'bash' : requested);
      const lang = requested;   // 標籤永遠顯示使用者寫的字（例如 linux）；沒標就不顯示
      let out;
      try {
        if (hlLang && global.hljs && global.hljs.getLanguage(hlLang)) {
          out = global.hljs.highlight(code, { language: hlLang, ignoreIllegals: autoShell }).value;
        } else {
          out = escapeHtml(code);
        }
      } catch (e) {
        out = escapeHtml(code);
      }
      const langSpan = lang ? '<span class="code-lang">' + escapeHtml(lang) + '</span>' : '';
      const tools = '<div class="code-tools">' +
        '<button class="code-copy" type="button" title="複製程式碼">複製</button>' + langSpan + '</div>';
      const kaliCls = isKali ? ' code-linux' : '';
      if (lineNumbers) {
        // Each source line becomes its own <li data-ln="N">, gutter number and
        // code sharing one CSS grid row — so a long line can wrap (needed in
        // print, which has no horizontal scroll) without pulling the numbers
        // out of sync with the lines after it, the way a single shared gutter
        // column would.
        const count = code.replace(/\n$/, '').split('\n').length;
        let htmlLines = splitHighlightedLines(out);
        if (htmlLines.length > count) htmlLines = htmlLines.slice(0, count);
        while (htmlLines.length < count) htmlLines.push('');
        const items = htmlLines.map(function (lineHtml, i) {
          return '<li data-ln="' + (startLine + i) + '"><code class="hljs language-' +
            escapeHtml(lang || 'plaintext') + '">' + lineHtml + '</code></li>';
        }).join('');
        return '<div class="code-block code-ln' + kaliCls + '">' + tools +
          '<pre class="code-pre"><ol class="code-lines">' + items + '</ol></pre></div>\n';
      }
      return '<div class="code-block' + kaliCls + '">' + tools +
        '<pre><code class="hljs language-' + escapeHtml(lang || 'plaintext') + '">' + out + '</code></pre></div>\n';
    },
    // [名稱](file:<id>) / [名稱](pdf:<id>) are attachment links. Returning false
    // hands every other link back to marked's own renderer.
    link: function (href, title, text) {
      const m = /^(pdf|file):([\w.-]+)$/.exec(href || '');
      return m ? fileChipHTML(m[1], m[2], text) : false;
    },
    image: function (href, title, text) {
      // ![名稱](file:<id>): a non-image file has nothing to embed, so it is the same link.
      if (href && href.indexOf('file:') === 0) return fileChipHTML('file', href.slice(5), escapeHtml(text || ''));
      // Embedded PDF attachment: ![檔名](pdf:<id>) → same-origin <iframe> viewer.
      if (href && href.indexOf('pdf:') === 0) {
        const id = href.slice(4);
        const name = escapeHtml(text || 'PDF');
        return '<span class="pdf-embed">' +
          '<span class="pdf-embed-bar">' +
          '<span class="pdf-embed-name">📎 ' + name + '</span>' +
          '<a class="pdf-embed-open" data-pdf-id="' + escapeHtml(id) + '" href="#" target="_blank" rel="noopener">Open in new tab ↗</a>' +
          '</span>' +
          '<iframe class="pdf-embed-frame" data-pdf-id="' + escapeHtml(id) + '" title="' + name + '" loading="lazy"></iframe>' +
          '</span>';
      }
      // ![名稱](relmap:<noteId>)：把另一篇「關聯分析」筆記嵌進來。存的是那篇筆記的 id，
      // 不是圖的副本——原圖改了，所有引用它的筆記下次渲染就跟著更新。畫面上是可以
      // 拖曳平移、滾輪縮放的（resolveRelMaps 會接上 RelMap.attachPanZoom）。
      if (href && href.indexOf('relmap:') === 0) {
        const rid = href.slice(7);
        const rname = escapeHtml(text || '關聯分析');
        return '<span class="relmap-embed" data-relmap-note="' + escapeHtml(rid) + '">' +
          '<span class="relmap-embed-bar">' +
          '<span class="relmap-embed-name">' + rname + '</span>' +
          '<button class="relmap-embed-btn" type="button" data-relmap-zoom="out" title="縮小">−</button>' +
          '<button class="relmap-embed-btn" type="button" data-relmap-zoom="in" title="放大">＋</button>' +
          '<button class="relmap-embed-btn" type="button" data-relmap-zoom="reset" title="回到剛好塞滿">重置</button>' +
          '<button class="relmap-embed-btn" type="button" data-relmap-open="' + escapeHtml(rid) + '">全螢幕</button>' +
          '</span>' +
          '<span class="relmap-embed-canvas"></span></span>';
      }
      // ![名稱](drawio:<noteId>)：把一張 drawio 圖表（meta.drawio 的筆記）嵌進來。同樣只存
      // id；圖由 resolveDrawios 填進去，「編輯」會跳到那張圖的編輯器。
      if (href && href.indexOf('drawio:') === 0) {
        const did = href.slice(7);
        return '<span class="drawio-embed" data-drawio-note="' + escapeHtml(did) + '">' +
          '<span class="drawio-embed-bar">' +
          '<span class="drawio-embed-name">' + escapeHtml(text || '圖表') + '</span>' +
          '<button class="drawio-embed-btn" type="button" data-drawio-open="' + escapeHtml(did) + '">編輯</button>' +
          '</span>' +
          '<span class="drawio-embed-canvas"></span></span>';
      }
      if (href && href.indexOf('img:') === 0) {
        // ![說明](img:<id>) 是一般圖片，結尾多一個 #frame 表示這張要加黑框（報告裡的截圖
        // 底色常常跟紙一樣白，沒有框會糊成一片）。標記寫在 markdown 裡而不是 note.meta，
        // 所以預覽、PDF、電子書讀的是同一份來源，複製貼上整段也跟著走。id 只會是 [\w.-]
        // （server/api.js 的 MEDIA_REF 也照這個切），「#」之後的東西吃不進 id，伺服器判斷
        // 圖片可見性用的 `img:<id>` 子字串比對也不受影響。
        const raw = href.slice(4);
        const hash = raw.indexOf('#');
        const id = hash < 0 ? raw : raw.slice(0, hash);
        const framed = hash >= 0 && raw.slice(hash + 1) === IMG_FRAME;
        const isLogo = (text === '__cover_logo__');
        const cls = isLogo ? 'cover-logo' : (framed ? 'img-framed' : '');
        const img = '<img data-img-id="' + escapeHtml(id) + '"' + (cls ? ' class="' + cls + '"' : '') +
          ' alt="' + escapeHtml(text || '') + '"' +
          (title ? ' title="' + escapeHtml(title) + '"' : '') + '>';
        // The cover logo is centred as a block and never annotated, so leave it bare.
        if (isLogo) return img;
        // Stored images get a wrapper so the hover tools can sit over them.
        return '<span class="img-wrap">' + img +
          '<span class="img-tools">' +
          '<button class="img-annotate" type="button" data-annotate="' + escapeHtml(id) +
          '" title="標註這張圖片">✎ 標註</button>' +
          '<button class="img-frame-btn" type="button" data-frame="' + escapeHtml(id) + '"' +
          (framed ? ' aria-pressed="true"' : '') +
          ' title="' + (framed ? '移除黑框' : '加上黑框') + '">▢ 黑框</button>' +
          '</span></span>';
      }
      return '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(text || '') + '"' +
        (title ? ' title="' + escapeHtml(title) + '"' : '') + '>';
    }
  };

  // breaks: true — HackMD semantics, which this editor is modelled on: a newline in
  // the source is a <br> in the output, so "one sentence per line" reads the same
  // in the preview as in the editor. CommonMark's default (a single newline is a
  // soft break that collapses to a space) is what people switching from HackMD
  // report as "the preview merged my lines".
  marked.use({
    gfm: true, breaks: true,
    extensions: [tocExtension, riskExtension, calloutExtension, containerExtension, linkCardExtension, videoExtension, wikiLinkExtension, hashtagExtension],
    renderer: renderer
  });

  // 清單往下一層打子項目時，還沒打內容的那一行只有「-」。CommonMark 把「一行字＋底下單獨
  // 一行 -」當成 setext 二級標題，上一層的字就突然變成大標題加底線。筆記裡單獨一個 - 幾乎
  // 都是這種情況（真要 setext 標題會寫 --- 或 ===），所以只排除「底線只有一個 -」，其餘照舊：
  // 回傳 false 交回 marked 原本的規則，回傳 undefined 表示這裡不是標題、改當段落處理。
  marked.use({
    tokenizer: {
      lheading: function (src) {
        let at = src.indexOf('\n');
        while (at >= 0) {
          const next = src.indexOf('\n', at + 1);
          const line = src.slice(at + 1, next < 0 ? src.length : next);
          if (!line.trim()) return false;   // setext 標題不跨空行
          if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) return line.trim() === '-' ? undefined : false;
          at = next;
        }
        return false;
      }
    }
  });

  // <iframe> is only in the sanitizer's tag allow-list (below) for the PDF-embed
  // feature, and that markup never carries its own `src` — js/pdf.js's viewer sets
  // `.src` from a validated `data-pdf-id` *after* sanitizing. If a note author instead
  // types a literal `<iframe src="...">` in raw markdown, DOMPurify's URL check blocks
  // javascript:/data: but happily keeps a plain same-origin src — and CSP's
  // `frame-src 'self'` explicitly allows framing this app's own pages, so `src="/"`
  // would nest the whole authenticated app inside another user's note (clickjacking:
  // the note owner/editor could overlay it to trick a viewer into clicking real
  // buttons in their own session). Strip src/srcdoc from every <iframe> unconditionally
  // so a typed-in one is always inert, regardless of what the raw markdown asked for.
  if (global.DOMPurify) {
    DOMPurify.addHook('uponSanitizeElement', function (node, data) {
      if (data.tagName === 'iframe' && node.removeAttribute) {
        // 例外只有一種：認得出是 YouTube／Google Drive 的影片。就算是，也不留原始 src——用 id 重組
        // 一個我們自己的網址放在 data-video-src，下面的 afterSanitizeAttributes 再搬回 src。
        const v = videoEmbed(node.getAttribute('src') || node.getAttribute('data-video-src') || '');
        node.removeAttribute('src');
        node.removeAttribute('srcdoc');
        if (v) { node.setAttribute('data-video-src', v.src); node.setAttribute('data-video-url', v.page); }
        else { node.removeAttribute('data-video-src'); node.removeAttribute('data-video-url'); }
      }
    });
    // 連到外面的網址一律開新分頁：在同一個分頁裡跟著連結走，等於把整個 app 換掉，
    // 回來還要重新載入。隨筆的卡片、預覽、電子書都是同一條渲染路，所以在這裡做一次就好。
    DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      if (node.tagName === 'IFRAME' && node.getAttribute('data-video-src')) {
        // 屬性檢查已經過了，這裡放的值全是上面自己組的
        node.setAttribute('src', node.getAttribute('data-video-src'));
        node.setAttribute('class', 'video-frame');
        node.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
        node.setAttribute('allowfullscreen', '');
        node.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        node.setAttribute('loading', 'lazy');
        if (!node.getAttribute('title')) node.setAttribute('title', '影片');
        return;
      }
      if (node.tagName !== 'A') return;
      const href = node.getAttribute('href') || '';
      if (/^(https?:)?\/\//i.test(href) || /^mailto:/i.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  // 匯出（PDF、電子書、公開連結）播不了影片：把每個播放器換成一行連到影片網頁的字
  function replaceVideosForExport(root, where) {
    Array.prototype.forEach.call(root.querySelectorAll('iframe.video-frame, iframe[data-video-src]'), function (f) {
      const url = f.getAttribute('data-video-url') || f.getAttribute('data-video-src') || '';
      const p = document.createElement('p');
      p.className = 'video-note';
      const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = url;
      p.appendChild(document.createTextNode('影片（' + (where || '匯出檔') + '中無法播放）：'));
      p.appendChild(a);
      const box = f.closest('.video-embed');
      (box || f).replaceWith(p);
    });
  }

  // 文件（js/doc.js）的內容是一整段 HTML，marked 把它當成一個 HTML 區塊原樣放行——但 HTML 區塊在空行就結束，
  // 程式碼區塊裡只要有空行，後半段就被當成 Markdown（* 變斜體、<pre> 裡長出 <p>）。區塊裡的換行改寫成 &#10;：
  // 對 HTML 是同一個字，對 marked 就沒有空行了。只動 gd-code 的 <pre>，而且內容要是 HTML 開頭（文件一定是）。
  function protectDocCode(md) {
    if (md.indexOf('gd-code') < 0 || !/^\s*</.test(md)) return md;
    return md.replace(/(<pre\b[^>]*\bgd-code\b[^>]*>)([\s\S]*?)(<\/pre>)/g, function (m, a, body, z) { return a + body.replace(/\r?\n/g, '&#10;') + z; });
  }

  // ---- Public render -----------------------------------------------------
  function render(md) {
    for (const k in usedSlugs) delete usedSlugs[k]; // reset per render
    findingSeq = 0;
    taskSeq = 0;
    headingList = [];
    let raw = marked.parse(protectDocCode(md || ''));
    // Every [toc] gets the same full list, built now that all headings are known.
    if (raw.indexOf(TOC_PLACEHOLDER) >= 0) raw = raw.split(TOC_PLACEHOLDER).join(buildInlineTOC());
    // 文件（js/doc.js，內容是 HTML）的程式碼區塊：上色與行號在這裡變成靜態的 span（電子書、公開連結、版本都走這條）。
    // 在 DOMPurify 之前做，清理還是最後一關。
    if (raw.indexOf('gd-code') >= 0 && global.Doc && Doc.staticCodeHTML) raw = Doc.staticCodeHTML(raw);
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['id', 'data-img-id', 'data-note-id', 'data-note-title', 'data-annotate',
        'data-frame', 'aria-pressed',   // 圖片黑框的切換鈕
        'data-risk', 'data-finding', 'type', 'target', 'data-pdf-id', 'loading', 'data-tag',
        'data-toc',    // [toc] 的展開鈕
        'data-task',   // 待辦清單：勾選框在文件中的序號，用來回寫原始 markdown
        'data-mindmap', 'data-i',    // 心智圖：原始大綱文字，以及節點索引
        'data-relmap',    // 關聯分析：原始 DSL 文字（js/relmap.js）
        'data-relmap-note', 'data-relmap-open', 'data-relmap-zoom',   // 嵌入別篇關聯分析
        'data-drawio-note', 'data-drawio-open',   // 嵌入 drawio 圖表（js/drawio.js）
        'data-link-url', 'data-file-id', 'data-file-kind', 'rel',   // 網址預覽卡片、附件連結
        'data-video-src', 'data-video-url', 'title'],   // YouTube／Google Drive 影片（videoEmbed）
      ADD_TAGS: ['input', 'button', 'iframe'] // checkboxes, annotate button, PDF embed
    });
  }

  // Resolve <img data-img-id> placeholders to object URLs from IndexedDB.
  const urlCache = {}; // id -> objectURL

  // Drop a cached object URL so the next render re-reads the blob. The
  // annotation editor calls this after saving, otherwise the stale URL would
  // keep showing the un-annotated picture.
  function invalidateImage(id) {
    // Drop the shared blob too, or the next fetch returns the pre-annotation bytes.
    if (global.Store && Store.invalidateImage) Store.invalidateImage(id);
    if (!urlCache[id]) return;
    try { URL.revokeObjectURL(urlCache[id]); } catch (e) {}
    delete urlCache[id];
  }

  function resolveImages(container) {
    const imgs = container.querySelectorAll('img[data-img-id]');
    imgs.forEach(function (img) {
      const id = img.getAttribute('data-img-id');
      if (!id) return;
      if (urlCache[id]) { img.src = urlCache[id]; return; }
      Store.getImageBlob(id).then(function (blob) {
        if (blob) {
          const url = URL.createObjectURL(blob);
          urlCache[id] = url;
          img.src = url;
        } else {
          img.alt = '[Missing image]';
        }
      });
    });
    // Embedded PDFs load straight from the same-origin API URL (works with the
    // frame-src 'self' CSP; the browser sends the session cookie automatically).
    container.querySelectorAll('iframe[data-pdf-id]').forEach(function (f) {
      const id = f.getAttribute('data-pdf-id');
      if (id && !f.src) f.src = '/api/images/' + encodeURIComponent(id);
    });
    container.querySelectorAll('a[data-pdf-id]').forEach(function (a) {
      const id = a.getAttribute('data-pdf-id');
      if (id) a.href = '/api/images/' + encodeURIComponent(id);
    });
    // Attachment links go straight to the file too: a PDF opens in a new tab, and
    // the server sends anything else as a download under its uploaded name.
    container.querySelectorAll('a.file-chip[data-file-id]').forEach(function (a) {
      const id = a.getAttribute('data-file-id');
      if (id) a.href = '/api/images/' + encodeURIComponent(id);
    });
    resolveLinkCards(container);
    resolveRelMaps(container);
    resolveDrawios(container);
  }

  // Fill {%preview url %} cards from /api/link-preview. Resolves once every card
  // in `container` has its answer (the PDF export waits for that); a card whose
  // site cannot be read keeps showing its address. Every value is set with
  // textContent — it is another site's text.
  function previewImageUrl(u) { return '/api/link-preview/image?url=' + encodeURIComponent(u); }
  function resolveLinkCards(container) {
    const cards = Array.prototype.slice.call(container.querySelectorAll('.link-card[data-link-url]'));
    if (!cards.length || !global.Store || !Store.getLinkPreview) return Promise.resolve();
    return Promise.all(cards.map(function (card) {
      if (card.classList.contains('is-loaded') || card.classList.contains('is-failed')) return null;
      return Store.getLinkPreview(card.getAttribute('data-link-url')).then(function (info) {
        if (!info || info.error) { card.classList.add('is-failed'); return; }
        card.classList.add('is-loaded');
        const put = function (sel, v) { const n = card.querySelector(sel); if (n && v) n.textContent = v; };
        put('.link-card-title', info.title);
        put('.link-card-desc', info.description);
        let host = '';
        try { host = new URL(info.finalUrl || info.url).hostname; } catch (e) { host = ''; }
        put('.link-card-href', info.siteName && host ? info.siteName + ' · ' + host : (info.siteName || host));
        const thumb = card.querySelector('.link-card-thumb');
        if (thumb && info.image && !thumb.firstChild) {
          const img = document.createElement('img');
          img.alt = '';
          img.loading = 'lazy';
          img.setAttribute('data-link-img', '1');
          img.addEventListener('error', function () { img.remove(); });
          img.src = previewImageUrl(info.image);
          thumb.appendChild(img);
        }
        const icon = card.querySelector('.link-card-icon');
        if (icon && info.icon && !icon.firstChild) {
          const ic = document.createElement('img');
          ic.alt = '';
          ic.setAttribute('data-link-img', '1');
          ic.addEventListener('error', function () { ic.remove(); });
          ic.src = previewImageUrl(info.icon);
          icon.appendChild(ic);
        }
      });
    }));
  }

  // ---- 嵌入別篇關聯分析 ![名稱](relmap:<noteId>) ------------------------------
  // 引用的是筆記 id，所以每次渲染都去拿那篇的現況——原圖改了，引用它的筆記自然跟著新。
  // 快取存的是「進行中的 promise」而不是拿回來的值，理由跟圖片快取一模一樣：同一張圖
  // 在一篇筆記裡被引用好幾次時，resolveRelMaps 是同步走訪每一個嵌入框的，只快取結果
  // 會讓它們全部錯過空的快取、各自發一次請求。失敗的那筆會把自己從快取刪掉，下次才
  // 有機會重試，不會被一個 null 永久毒死。
  const relNoteCache = {};
  function relNoteText(id) {
    if (!global.Store || !Store.getNote) return Promise.resolve(null);
    if (relNoteCache[id]) return relNoteCache[id];
    const p = Store.getNote(id).then(function (n) { return n ? (n.content || '') : null; })
      .catch(function () { if (relNoteCache[id] === p) delete relNoteCache[id]; return null; });
    relNoteCache[id] = p;
    return p;
  }
  function invalidateRelNote(id) { delete relNoteCache[id]; }
  function resolveRelMaps(container) {
    const boxes = Array.prototype.slice.call(container.querySelectorAll('.relmap-embed[data-relmap-note]'));
    if (!boxes.length) return Promise.resolve();
    return Promise.all(boxes.map(function (box) {
      if (box.classList.contains('is-loaded') || box.classList.contains('is-failed')) return null;
      const canvas = box.querySelector('.relmap-embed-canvas');
      if (!canvas) return null;
      return relNoteText(box.getAttribute('data-relmap-note')).then(function (text) {
        const svg = (text != null && global.RelMap) ? RelMap.renderSVG(text) : '';
        if (!svg) {
          box.classList.add('is-failed');
          canvas.textContent = text == null ? '找不到這張關聯分析（可能已刪除，或你沒有權限）' : '這張關聯分析還沒有任何節點。';
          return;
        }
        box.classList.add('is-loaded');
        canvas.innerHTML = svg;
        // 拖曳平移／滾輪縮放只有在真的瀏覽器裡才接：PDF 與電子書拿到的是同一段 SVG，
        // 但那邊是靜態文件，沒有（也不需要）任何事件。
        if (global.RelMap && RelMap.attachPanZoom) RelMap.attachPanZoom(canvas.querySelector('svg'));
      });
    }));
  }

  // ---- 嵌入 drawio 圖表 ![名稱](drawio:<noteId>) --------------------------------
  // 跟上面的關聯分析同一套（連筆記快取都共用——快取的是「某篇筆記的內容」，不分種類）：
  // 存的是那篇圖表筆記的 id，渲染時才去拿現況，再由 DrawIO.htmlOf() 把它的 DSL 畫成 SVG。
  // 那段 SVG 是我們自己從 DSL 一個欄位一個欄位組出來的（數字是數字、顏色只收 #rrggbb、
  // 文字都跳脫過），不是把別人給的標記原樣塞進來。
  function resolveDrawios(container) {
    const boxes = Array.prototype.slice.call(container.querySelectorAll('.drawio-embed[data-drawio-note]'));
    if (!boxes.length) return Promise.resolve();
    return Promise.all(boxes.map(function (box) {
      if (box.classList.contains('is-loaded') || box.classList.contains('is-failed')) return null;
      const canvas = box.querySelector('.drawio-embed-canvas');
      if (!canvas) return null;
      const nameEl = box.querySelector('.drawio-embed-name');
      return relNoteText(box.getAttribute('data-drawio-note')).then(function (text) {
        const img = (text != null && global.DrawIO) ? DrawIO.htmlOf(text, nameEl ? nameEl.textContent : '') : '';
        if (!img) {
          box.classList.add('is-failed');
          canvas.textContent = text == null ? '找不到這張圖表（可能已刪除，或你沒有權限）' : '這張圖表還是空白的。';
          return;
        }
        box.classList.add('is-loaded');
        canvas.innerHTML = img;
      });
    }));
  }

  // ---- Table column widths --------------------------------------------------
  // Markdown has no column-width concept, so widths live in note.meta.tableWidths
  // (an array indexed by the table's document order; each entry an array of
  // per-column percentages) — a legacy, read-only setting from the removed Blog
  // mode; nothing writes new values here any more, but a note that already has
  // some keeps rendering with them. They are applied to the RENDERED DOM here, not
  // in the markdown, so the preview, the PDF and the book all show the same widths
  // by calling applyColWidths on their own rendered container. A table with no
  // stored widths (or a stored entry whose length no longer matches the columns —
  // a column was added or removed) is left in its default content-sized layout.
  function setTableCols(table, pct) {
    if (!table) return false;
    const head = table.rows && table.rows[0];
    const ncol = head ? head.cells.length : 0;
    const old = table.querySelector(':scope > colgroup[data-cols]');
    if (!ncol || !Array.isArray(pct) || pct.length !== ncol) {
      if (old) old.remove();
      table.style.tableLayout = ''; table.style.width = ''; table.style.display = '';
      table.removeAttribute('data-colw');
      return false;
    }
    const total = pct.reduce(function (a, b) { return a + (Number(b) || 0); }, 0) || ncol;
    const cg = document.createElement('colgroup');
    cg.setAttribute('data-cols', '1');
    pct.forEach(function (x) {
      const col = document.createElement('col');
      col.style.width = (100 * (Number(x) || 0) / total).toFixed(3) + '%';
      cg.appendChild(col);
    });
    if (old) old.remove();
    table.insertBefore(cg, table.firstChild);
    // A fixed layout is what makes <col> widths authoritative; without it the
    // browser still sizes columns to content and ignores them.
    table.style.display = 'table';
    table.style.tableLayout = 'fixed';
    table.style.width = '100%';
    table.setAttribute('data-colw', '1');   // CSS 用它讓內容過長的欄改為換行而不是撐破
    return true;
  }
  function applyColWidths(container, widths) {
    if (!container) return;
    const tables = container.querySelectorAll('table');
    for (let i = 0; i < tables.length; i++) setTableCols(tables[i], widths && widths[i]);
  }

  // Build TOC entries from rendered container: [{level, text, id}]
  function extractHeadings(container) {
    const nodes = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const list = [];
    nodes.forEach(function (h) {
      list.push({ level: parseInt(h.tagName.slice(1), 10), text: h.textContent, id: h.id });
    });
    return list;
  }

  // Convert data-img-id images inside a cloned node to data: URLs (for PDF export)
  function inlineImagesAsDataURL(container) {
    const imgs = Array.prototype.slice.call(container.querySelectorAll('img[data-img-id]'));
    const stored = Promise.all(imgs.map(function (img) {
      const id = img.getAttribute('data-img-id');
      return Store.getImageBlob(id).then(function (blob) {
        if (!blob) return;
        return blobToDataURL(blob).then(function (durl) {
          img.setAttribute('src', durl);
          img.removeAttribute('data-img-id');
        });
      });
    }));
    // Link cards: wait for their text, then inline the proxied thumbnail and icon —
    // the print document and the published book (CSP default-src 'none') cannot
    // fetch them later.
    const cards = resolveLinkCards(container).then(function () {
      const pics = Array.prototype.slice.call(container.querySelectorAll('img[data-link-img]'));
      return Promise.all(pics.map(function (img) {
        return fetch(img.getAttribute('src'), { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.blob() : null; })
          .then(function (blob) {
            if (!blob) { img.remove(); return; }
            return blobToDataURL(blob).then(function (durl) {
              img.setAttribute('src', durl);
              img.removeAttribute('data-link-img');
            });
          })
          .catch(function () { img.remove(); });
      }));
    });
    // 嵌入的關聯分析同理：SVG 是現場向伺服器要那篇筆記才畫得出來的，列印文件與
    // 出版檔都抓不到（電子書的 CSP 連 same-origin 都不准 fetch），所以要在這裡等它畫完。
    // drawio 圖裡的圖示（<image data-img-id>）要等嵌入的圖畫出來之後才找得到，所以排在
    // resolveDrawios 後面，不是跟它並排。
    const drawios = resolveDrawios(container).then(function () { return inlineSvgImages(container); });
    return Promise.all([stored, cards, resolveRelMaps(container), drawios]);
  }
  // drawio 圖裡的圖示：畫面上是直接跟伺服器要（href="/api/images/<id>"），要帶走的文件
  // 就得把圖片本身包進去。同一個圖示在一張圖裡用十次也只抓一次（getImageBlob 自己有快取）。
  function inlineSvgImages(container) {
    const els = Array.prototype.slice.call(container.querySelectorAll('svg image[data-img-id]'));
    return Promise.all(els.map(function (el) {
      return Store.getImageBlob(el.getAttribute('data-img-id')).then(function (blob) {
        if (!blob) return;
        return blobToDataURL(blob).then(function (durl) {
          el.setAttribute('href', durl);
          el.removeAttribute('data-img-id');
        });
      });
    }));
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  global.MD = {
    videoEmbed: videoEmbed, replaceVideosForExport: replaceVideosForExport,
    render: render,
    resolveImages: resolveImages,
    extractHeadings: extractHeadings,
    inlineImagesAsDataURL: inlineImagesAsDataURL,
    slugify: slugify,
    escapeHtml: escapeHtml,
    setNoteLookup: setNoteLookup,
    extractLinks: extractLinks,
    extractTags: extractTags,
    noteTags: noteTags,
    invalidateImage: invalidateImage,
    resolveLinkCards: resolveLinkCards,
    resolveRelMaps: resolveRelMaps,
    resolveDrawios: resolveDrawios,
    invalidateRelNote: invalidateRelNote,
    switchEmbed: switchEmbed,
    toggleImageFrame: toggleImageFrame,
    applyColWidths: applyColWidths,
    setTableCols: setTableCols,
    extractFindings: extractFindings,
    riskLevels: RISK_LEVELS
  };
})(window);
