/* graph.js — Obsidian 風格的關聯圖：把 [[wikilink]] 反向連結跟 #hashtag 畫成一張
 * 可拖曳、可縮放的力導向網絡圖。筆記本身跟標籤都是節點，連結是邊——這是
 * 唯一呈現「反向連結」跟「標籤」關聯的地方，故意不放進首頁儀表板。
 *
 * 資料來源：呼叫端（app.js）傳整份 state.notes（每筆已經帶 content），這裡用
 * MD.extractLinks / MD.extractTags 從內文重新抽取一次，跟編輯器裡 [[title]]
 * 真正解析出來的連結、跟儀表板標籤篩選用的是同一套規則（normTitle 大小寫、
 * 前後空白不分）。開圖時只算一次——這是瀏覽用的快照，筆記內容變動不會即時
 * 反映，要看最新關聯圖就重新打開。
 *
 *   Graph.open(notes, { container, onOpenNote(note), onOpenTag(tag), onClose() })
 *
 * 畫在呼叫端給的容器裡（app.js 的 #graph-wrap），是一個整頁的檢視，跟垃圾桶／
 * 區域頁／關聯分析同一套「接管 #main」的做法，不是浮在畫面上的對話框。
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function normTitle(t) { return String(t || '').trim().toLowerCase(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // 節點／連線的顏色、彎曲方向都是「看資料算出來的固定值」，不是隨機——同一張圖
  // 重畫（切換顯示標籤、視窗大小改變）顏色跟彎法要一樣，不能每次都跳動。用 id
  // 算一個穩定的雜湊當種子。
  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  const NODE_COLORS = ['#e0c674', '#6fa8dc', '#e08a52', '#5fb88a', '#d97a9c', '#9a86d6', '#5cc2c2', '#d66a6a'];
  // 邊的配色刻意偏重橘棕：參考圖裡絕大多數的線是橘棕色虛線，只有少數幾條是藍／紅／
  // 紫／青的重點線——調色盤裡橘棕多放幾份，雜湊出來的分布才會是「一片暖色底、
  // 零星幾條彩色」，不是每種顏色平均分配的彩虹。
  const EDGE_COLORS = ['#c9822a', '#c9822a', '#c9822a', '#b8702a', '#a86a2c', '#4f8fd6', '#d65f6b', '#8e6fd6', '#4fb0a8'];
  // 標籤與「演員」（影片關聯圖，js/videos.js）這類節點顏色固定（CSS 的 .graph-node-<kind>），
  // 其餘（筆記、影片）每顆用 id 雜湊出自己的顏色。
  const FIXED_KINDS = { tag: true, actor: true };
  function nodeColor(n) { return FIXED_KINDS[n.kind] ? null : NODE_COLORS[hash(n.id) % NODE_COLORS.length]; }
  function edgeColor(e) { return EDGE_COLORS[hash(e.a + '|' + e.b) % EDGE_COLORS.length]; }

  // 二次貝茲曲線：控制點從邊的中點沿垂直方向偏移，偏移量隨線長縮放、方向照雜湊
  // 奇偶交替（有的往左彎有的往右彎），整張圖才會有機、不會每條線都彎同一邊。
  function curvePath(ax, ay, bx, by, seed) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const bend = (seed % 2 === 0 ? 1 : -1) * Math.min(len * 0.18, 70);
    const mx = (ax + bx) / 2 + (-dy / len) * bend;
    const my = (ay + by) / 2 + (dx / len) * bend;
    return 'M' + ax + ',' + ay + ' Q' + mx + ',' + my + ' ' + bx + ',' + by;
  }

  // ---- 從筆記內容建圖：節點 = 筆記 + 標籤，邊 = wikilink 解析結果 + 標籤歸屬 ----
  function buildGraph(notes) {
    const nodes = [];
    const byId = {};
    const byTitle = {};
    notes.forEach(function (n) {
      const node = { id: 'note:' + n.id, kind: 'note', label: n.title || '未命名筆記', note: n, deg: 0 };
      byId[node.id] = node;
      nodes.push(node);
      const k = normTitle(n.title);
      if (k && !byTitle[k]) byTitle[k] = n;
    });
    const edges = [];
    const edgeSeen = {};
    function addEdge(a, b, kind) {
      if (a === b) return;
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (edgeSeen[key]) return;
      edgeSeen[key] = true;
      edges.push({ a: a, b: b, kind: kind });
      byId[a].deg++; byId[b].deg++;
    }
    notes.forEach(function (n) {
      const aId = 'note:' + n.id;
      const links = (global.MD && MD.extractLinks) ? MD.extractLinks(n.content || '') : [];
      links.forEach(function (target) {
        const hit = byTitle[normTitle(target)];
        if (hit) addEdge(aId, 'note:' + hit.id, 'link');
      });
      const tags = (global.MD && MD.noteTags) ? MD.noteTags(n) : [];
      tags.forEach(function (tag) {
        const tid = 'tag:' + tag.toLowerCase();
        if (!byId[tid]) { byId[tid] = { id: tid, kind: 'tag', label: '#' + tag, deg: 0 }; nodes.push(byId[tid]); }
        addEdge(aId, tid, 'tag');
      });
    });
    return { nodes: nodes, edges: edges };
  }

  // Vogel 螺旋：用黃金角把初始位置攤開成螺旋狀，避免完美對稱的圓形排列讓
  // 排斥力永遠互相抵銷（那樣模擬出來的圖會一直維持成一個呆板的正圓環）。
  // 係數比早期版本大：起始佈局本身就不擁擠，物理模擬穩定後也不會擠成一團。
  const GOLDEN_ANGLE = 2.399963;
  function seedPositions(nodes) {
    nodes.forEach(function (n, i) {
      if (typeof n.x === 'number') return;
      const r = 42 * Math.sqrt(i + 1);
      const a = i * GOLDEN_ANGLE;
      n.x = r * Math.cos(a);
      n.y = r * Math.sin(a);
      n.vx = 0; n.vy = 0;
    });
  }

  function open(notes, opts) {
    opts = opts || {};
    // opts.data：呼叫端自己算好的 { nodes: [{id, kind, label, note?, deg}], edges: [{a, b, kind}] }
    // （影片關聯圖 js/videos.js 用：節點是影片／演員／hashtag，不是筆記）；沒給就從筆記內文建圖。
    const data = opts.data || buildGraph(notes || []);
    const legend = opts.legend || [['is-note', '筆記'], ['is-tag', '標籤']];

    // 畫進呼叫端給的容器（整頁），不是自己往 body 塞一層疊層。close() 只負責拆掉
    // 自己的東西（動畫、事件、DOM 內容），容器本身歸 app.js 管；「返回」與 Esc 走
    // opts.onClose，由 app.js 決定要切回哪個畫面——close() 不回呼，才不會兜回來。
    const host = opts.container;
    if (!host) return { close: function () {} };
    // 「顯示名稱」：勾起來每個節點都標名字，取消就全部不標（滑過去還是看得到，
    // 那是既有的 is-hover）。預設值與記憶由呼叫端給（app.js 的 localStorage）。
    let showLabels = opts.showLabels !== false;
    host.innerHTML =
      '<div class="graph-editor">' +
      '<header class="graph-bar">' +
      '<span class="graph-bar-t">' + esc(opts.title || '關聯圖') + '</span>' +
      '<span class="graph-bar-hint">' + esc(opts.hint || '拖曳調整位置・滾輪縮放・點一下看關聯・雙擊開啟筆記或篩選標籤') + '</span>' +
      '<label class="graph-tag-toggle"><input type="checkbox" class="graph-tags-cb" checked> 顯示標籤</label>' +
      '<label class="graph-tag-toggle"><input type="checkbox" class="graph-labels-cb"' + (showLabels ? ' checked' : '') + '> 顯示名稱</label>' +
      '<span class="graph-bar-sp"></span>' +
      // 圖例跟著節點走：節點是小圓點了，圖例就用同樣的小圓點，不再放圖示
      '<span class="graph-legend">' + legend.map(function (l) { return '<i class="graph-legend-dot ' + l[0] + '"></i>' + esc(l[1]); }).join('') + '</span>' +
      '<button class="btn graph-close" type="button">' + esc(opts.closeLabel || '返回') + '</button>' +
      '</header>' +
      '<div class="graph-canvas" tabindex="0">' +
      '<div class="graph-zoom-ctrl">' +
      '<button class="graph-ctrl-btn graph-zo" type="button" title="縮小">' + (global.Icons ? Icons.svg('minus') : '') + '</button>' +
      '<button class="graph-ctrl-btn graph-zi" type="button" title="放大">' + (global.Icons ? Icons.svg('plus') : '') + '</button>' +
      '<button class="graph-ctrl-btn graph-zfit" type="button" title="縮放置中，讓整張圖剛好塞進畫面">' + (global.Icons ? Icons.svg('maximize') : '') + '</button>' +
      '</div>' +
      '<button class="graph-reset-btn" type="button" title="還原成一開始的佈局，重新跑一次模擬">重置視圖</button>' +
      '</div>' +
      '</div>';

    const canvas = host.querySelector('.graph-canvas');
    const closeBtn = host.querySelector('.graph-close');
    const zoomOutBtn = host.querySelector('.graph-zo');
    const zoomInBtn = host.querySelector('.graph-zi');
    const zoomFitBtn = host.querySelector('.graph-zfit');
    const resetBtn = host.querySelector('.graph-reset-btn');
    const tagsCb = host.querySelector('.graph-tags-cb');
    const labelsCb = host.querySelector('.graph-labels-cb');
    const hintEl = host.querySelector('.graph-bar-hint');
    const HINT_DEFAULT = hintEl ? hintEl.textContent : '';
    function back() { if (opts.onClose) opts.onClose(); }

    if (!data.nodes.length) {
      canvas.innerHTML = '<div class="graph-empty">' + esc(opts.emptyText || '還沒有任何筆記可以畫成關聯圖。') + '</div>';
      const onKeyEmpty = function (e) { if (e.key === 'Escape') back(); };
      document.addEventListener('keydown', onKeyEmpty);
      closeBtn.addEventListener('click', back);
      host.querySelector('.graph-tag-toggle').hidden = true;
      host.querySelector('.graph-legend').hidden = true;
      return { close: function () { document.removeEventListener('keydown', onKeyEmpty); host.innerHTML = ''; } };
    }

    const svg = svgEl('svg', { class: 'graph-svg' });
    const stage = svgEl('g', { class: 'graph-stage' });
    const edgeLayer = svgEl('g', { class: 'graph-edges' });
    const nodeLayer = svgEl('g', { class: 'graph-nodes' });
    stage.appendChild(edgeLayer);
    stage.appendChild(nodeLayer);
    svg.appendChild(stage);
    canvas.appendChild(svg);

    seedPositions(data.nodes);

    let showTags = true;
    let zoom = 1, panX = 0, panY = 0;
    let raf = null, active = true;
    let hoverId = null, selectedId = null;

    function visibleNodes() { return showTags ? data.nodes : data.nodes.filter(function (n) { return n.kind !== 'tag'; }); }
    function visibleEdges() { return showTags ? data.edges : data.edges.filter(function (e) { return e.kind !== 'tag'; }); }

    // ---- DOM：每個節點/邊固定對應一個元素，之後每個 tick 只更新屬性 ----
    // 邊是彎的（curvePath），節點顏色跟邊顏色都是雜湊出來的固定值。名稱標不標由
    // 頂欄的「顯示名稱」決定（畫布上的 .hide-labels，純 CSS，不重建 DOM）。
    const edgeEls = {}, nodeEls = {};
    function rebuildDom() {
      edgeLayer.innerHTML = ''; nodeLayer.innerHTML = '';
      Object.keys(edgeEls).forEach(function (k) { delete edgeEls[k]; });
      Object.keys(nodeEls).forEach(function (k) { delete nodeEls[k]; });
      visibleEdges().forEach(function (e) {
        const path = svgEl('path', { class: 'graph-edge graph-edge-' + e.kind });
        path.style.stroke = edgeColor(e);
        edgeLayer.appendChild(path);
        edgeEls[e.a + '|' + e.b] = { el: path, edge: e, seed: hash(e.a + '|' + e.b) };
      });
      visibleNodes().forEach(function (n) {
        // 小圓點就好。之前是「白底圓盤＋中間一個小圖示」，圓盤為了塞得下圖示只好放大，
        // 整張圖就變成一堆大盤子——節點大小在這種圖上是用來表示「這篇連得多不多」的，
        // 不是用來當圖示的容器。圖示拿掉，半徑改成小一號的級距（連結多的還是明顯大顆），
        // 筆記與標籤靠顏色分（標籤固定 --folder），名字就寫在下面。
        const r = n.kind === 'tag' ? 3.5 : (4 + Math.min(n.deg * 0.7, 5));
        const g = svgEl('g', { class: 'graph-node graph-node-' + n.kind, 'data-id': n.id });
        const c = svgEl('circle', { r: r, class: 'graph-node-dot' });
        const ring = nodeColor(n);
        if (ring) { c.style.fill = ring; g.style.color = ring; }
        const t = svgEl('text', { class: 'graph-node-label', x: 0, y: r + 12 });
        t.textContent = n.label.length > 40 ? n.label.slice(0, 39) + '…' : n.label;
        const title = svgEl('title', {});
        title.textContent = n.label;
        g.appendChild(c); g.appendChild(t); g.appendChild(title);
        nodeLayer.appendChild(g);
        n.r = r;
        nodeEls[n.id] = { el: g, dot: c, node: n };
        bindNodeDrag(g, n);
      });
      // 這裡把 DOM 整個換掉，class 也跟著沒了——選取是釘住的狀態，重建後要再貼回去。
      // 取消勾「顯示標籤」時被選取的那顆可能已經不在畫面上，那就當作沒選。
      if (selectedId && !nodeEls[selectedId]) selectedId = null;
      if (hoverId && !nodeEls[hoverId]) hoverId = null;
      applyFocus();
    }
    rebuildDom();

    function neighborsOf(id) {
      const set = { };
      set[id] = true;
      visibleEdges().forEach(function (e) {
        if (e.a === id) set[e.b] = true;
        else if (e.b === id) set[e.a] = true;
      });
      return set;
    }

    // 點一下節點＝把「跟它有關的」釘起來：它自己跟直接相鄰的節點維持原樣，其餘整片
    // 調暗，滑鼠移開也不會散掉（滑過去的預覽是既有的 hoverId，只是暫時蓋過選取的那顆，
    // 滑走就還原）。所以「現在在看誰」永遠只有一顆：滑鼠指著的優先，沒有才輪到選取的。
    function focusId() { return hoverId || selectedId; }
    function applyFocus() {
      const fid = focusId();
      const near = fid ? neighborsOf(fid) : null;
      Object.keys(nodeEls).forEach(function (id) {
        const el = nodeEls[id].el;
        el.classList.toggle('is-dim', !!near && !near[id]);
        // is-near 是「這顆要看得清楚」：關掉「顯示名稱」時，只有這些節點的名字會現形
        // （見 app.css 的 hide-labels 規則）——點一下就想知道相關的是「哪幾篇」。
        el.classList.toggle('is-near', !!near && !!near[id]);
        el.classList.toggle('is-hover', id === hoverId);
        el.classList.toggle('is-sel', id === selectedId);
      });
      Object.keys(edgeEls).forEach(function (k) {
        const e = edgeEls[k].edge;
        edgeEls[k].el.classList.toggle('is-dim', !!near && !(near[e.a] && near[e.b]));
        // 直接連到焦點那幾條才加粗：相鄰節點彼此之間的線沒被調暗（看得到這一小群的
        // 形狀），但「從這顆連出去的」要一眼分得出來。
        edgeEls[k].el.classList.toggle('is-hi', !!fid && (e.a === fid || e.b === fid));
      });
      updateHint();
    }
    // 選取時頂欄那行提示換成「選了誰、有幾個相關、怎麼取消」——點下去沒有任何文字
    // 回饋的話，使用者只會看到畫面暗了一片，不知道是自己點出來的還是壞掉了。
    function updateHint() {
      if (!hintEl) return;
      if (!selectedId || !nodeEls[selectedId]) {
        hintEl.textContent = HINT_DEFAULT;
        hintEl.classList.remove('is-sel');
        return;
      }
      const n = nodeEls[selectedId].node;
      const cnt = Object.keys(neighborsOf(selectedId)).length - 1;
      hintEl.textContent = '「' + n.label + '」' + (cnt ? '有 ' + cnt + ' 個相關' : '沒有相關的節點') + '・Esc 或點空白處取消';
      hintEl.classList.add('is-sel');
    }
    function selectNode(id) {
      selectedId = selectedId === id ? null : id;   // 再點同一顆＝取消
      applyFocus();
    }
    function clearSelection() {
      if (selectedId === null) return false;
      selectedId = null;
      applyFocus();
      return true;
    }

    // ---- 力導向模擬：排斥＋沿邊彈簧＋微弱回中，速度阻尼到穩定就停 ----
    function tick() {
      const vn = visibleNodes(), ve = visibleEdges();
      let maxV = 0;
      // 拖曳中的節點還是留在模擬裡（其他節點會照樣被它排斥／牽動），只是
      // 它自己的速度每格都清空、位置直接交給滑鼠決定，放開後才重新累積速度。
      for (let i = 0; i < vn.length; i++) {
        for (let j = i + 1; j < vn.length; j++) {
          const a = vn[i], b = vn[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          const f = 4200 / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }
      ve.forEach(function (e) {
        const a = nodeEls[e.a] && nodeEls[e.a].node, b = nodeEls[e.b] && nodeEls[e.b].node;
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const rest = e.kind === 'tag' ? 140 : 200;
        const f = (d - rest) * 0.02;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      });
      vn.forEach(function (n) {
        if (n.dragging) { n.vx = 0; n.vy = 0; return; }
        n.vx += -n.x * 0.0016; n.vy += -n.y * 0.0016;
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
        maxV = Math.max(maxV, Math.abs(n.vx), Math.abs(n.vy));
      });
      render();
      if (maxV > 0.05 || draggingId) { raf = requestAnimationFrame(tick); }
      else {
        active = false; raf = null;
        if (!hasAutoFit) { hasAutoFit = true; fitView(); }
      }
    }
    function kick() { if (!active) { active = true; raf = requestAnimationFrame(tick); } }

    // 縮放置中：量出目前所有節點（含半徑跟標籤大概的高度）的邊界框，算出剛好能
    // 把整張圖塞進畫布的縮放與位移。模擬第一次穩定下來時自動呼叫一次——不然
    // 一開始一大片空白畫布中間擠一小球，看起來像沒東西可看；使用者拖亂／
    // 縮亂之後也可以按「置中」鈕手動再呼叫一次，抓的是當下位置，不是初始佈局。
    function fitView() {
      const vn = visibleNodes();
      if (!vn.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      vn.forEach(function (n) {
        const pad = (n.r || 8) + 44; // 給標籤跟節點本身留邊
        minX = Math.min(minX, n.x - pad); maxX = Math.max(maxX, n.x + pad);
        minY = Math.min(minY, n.y - pad); maxY = Math.max(maxY, n.y + pad);
      });
      const w = Math.max(maxX - minX, 60), h = Math.max(maxY - minY, 60);
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      zoom = clamp(Math.min(rect.width / w, rect.height / h), 0.15, 2.5);
      panX = -((minX + maxX) / 2) * zoom;
      panY = -((minY + maxY) / 2) * zoom;
      render();
    }
    let hasAutoFit = false;

    // 重置視圖跟「置中」不一樣：置中只是重新對焦當下的位置；這裡連位置本身都
    // 丟掉，回到一開始的螺旋佈局重新跑模擬，等於把拖曳過的節點全部復原。
    function resetView() {
      data.nodes.forEach(function (n) { n.x = undefined; n.y = undefined; n.vx = 0; n.vy = 0; });
      seedPositions(data.nodes);
      hasAutoFit = false;
      kick();
    }
    function zoomStep(factor) { zoom = clamp(zoom * factor, 0.15, 3); render(); }

    function render() {
      Object.keys(edgeEls).forEach(function (k) {
        const rec = edgeEls[k];
        const a = nodeEls[rec.edge.a] && nodeEls[rec.edge.a].node;
        const b = nodeEls[rec.edge.b] && nodeEls[rec.edge.b].node;
        if (!a || !b) return;
        rec.el.setAttribute('d', curvePath(a.x, a.y, b.x, b.y, rec.seed));
      });
      Object.keys(nodeEls).forEach(function (id) {
        const rec = nodeEls[id];
        rec.el.setAttribute('transform', 'translate(' + rec.node.x + ',' + rec.node.y + ')');
      });
      const rect = canvas.getBoundingClientRect();
      stage.setAttribute('transform',
        'translate(' + (rect.width / 2 + panX) + ',' + (rect.height / 2 + panY) + ') scale(' + zoom + ')');
    }
    render();

    // ---- 拖曳節點：拖的那顆暫時退出模擬（固定跟著滑鼠），放開再回去 ----
    // dragMoved 用位移量判斷，不是「滑鼠有沒有動過」——按下瞬間滑鼠幾乎一定會
    // 抖動個 1px 左右（尤其是自動化測試送出的合成事件），門檻抓太低的話，
    // 每次點筆記想開啟都會被誤判成一次極小的拖曳而打不開。
    const DRAG_THRESHOLD = 4;
    let draggingId = null, dragMoved = false, dragStart = null;
    function toWorld(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left, sy = clientY - rect.top;
      return { x: (sx - (rect.width / 2 + panX)) / zoom, y: (sy - (rect.height / 2 + panY)) / zoom };
    }
    function bindNodeDrag(g, n) {
      g.addEventListener('mousedown', function (e) {
        e.stopPropagation();
        draggingId = n.id; dragMoved = false; n.dragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        n.vx = 0; n.vy = 0;
        kick();
      });
      g.addEventListener('mouseenter', function () { hoverId = n.id; applyFocus(); });
      g.addEventListener('mouseleave', function () { if (hoverId === n.id) { hoverId = null; applyFocus(); } });
      // 單擊＝看關聯（釘住），雙擊才是開啟。以前單擊就直接離開關聯圖去開那篇筆記，
      // 等於整張圖只能看不能查——想知道「這篇跟哪些有關」得一直把滑鼠壓在那顆點上。
      g.addEventListener('click', function () {
        if (dragMoved) return;
        selectNode(n.id);
      });
      g.addEventListener('dblclick', function (e) {
        e.preventDefault();
        if (dragMoved) return;
        // onOpenNode：呼叫端自己決定每種節點雙擊要做什麼（影片關聯圖）；沒給就是筆記／標籤的老規矩
        if (opts.onOpenNode) { close(); opts.onOpenNode(n); }
        else if (n.kind === 'note' && opts.onOpenNote) { close(); opts.onOpenNote(n.note); }
        else if (n.kind === 'tag' && opts.onOpenTag) { close(); opts.onOpenTag(n.label.replace(/^#/, '')); }
      });
    }
    let panning = false, panStart = null, panMoved = false;
    canvas.addEventListener('mousedown', function (e) {
      if (e.target !== canvas && e.target !== svg) return;
      panning = true; panMoved = false; panStart = { x: e.clientX, y: e.clientY, panX: panX, panY: panY };
    });
    // 點空白處＝取消選取。目標必須真的是畫布或 svg 本身（節點的圓點／名字都是它們的
    // 子元素，所以節點上的點擊不會落到這裡），而且拖過畫面平移不算——平移完手一放
    // 就把剛剛選的清掉會很惱人。
    canvas.addEventListener('click', function (e) {
      if (e.target !== canvas && e.target !== svg) return;
      if (panMoved) return;
      clearSelection();
    });
    function onWindowMove(e) {
      if (draggingId) {
        if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > DRAG_THRESHOLD) dragMoved = true;
        const w = toWorld(e.clientX, e.clientY);
        const n = nodeEls[draggingId].node;
        n.x = w.x; n.y = w.y;
        render();
      } else if (panning) {
        if (Math.hypot(e.clientX - panStart.x, e.clientY - panStart.y) > DRAG_THRESHOLD) panMoved = true;
        panX = panStart.panX + (e.clientX - panStart.x);
        panY = panStart.panY + (e.clientY - panStart.y);
        render();
      }
    }
    function onWindowUp() {
      if (draggingId) { const n = nodeEls[draggingId].node; n.dragging = false; kick(); }
      draggingId = null; panning = false;
    }
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const wx = (sx - (rect.width / 2 + panX)) / zoom, wy = (sy - (rect.height / 2 + panY)) / zoom;
      zoom = clamp(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.15, 3);
      panX = sx - rect.width / 2 - wx * zoom;
      panY = sy - rect.height / 2 - wy * zoom;
      render();
    }, { passive: false });

    tagsCb.addEventListener('change', function () {
      showTags = tagsCb.checked;
      rebuildDom();
      kick();
    });
    // 名稱顯示與否純粹是 CSS 的事（.graph-node-label 的 opacity），不用重建 DOM 也
    // 不用重跑模擬——節點位置一點都沒變。
    function applyLabels() { canvas.classList.toggle('hide-labels', !showLabels); }
    applyLabels();
    labelsCb.addEventListener('change', function () {
      showLabels = labelsCb.checked;
      applyLabels();
      if (opts.onLabels) opts.onLabels(showLabels);
    });

    // Esc 先取消選取，沒有選取才離開關聯圖——選了一顆看得正起勁時按 Esc，想取消的
    // 是那片變暗，不是整張圖。
    function onKey(e) { if (e.key === 'Escape') { if (clearSelection()) return; back(); } }
    document.addEventListener('keydown', onKey);
    closeBtn.addEventListener('click', back);
    zoomOutBtn.addEventListener('click', function () { zoomStep(1 / 1.25); });
    zoomInBtn.addEventListener('click', function () { zoomStep(1.25); });
    zoomFitBtn.addEventListener('click', fitView);
    resetBtn.addEventListener('click', resetView);

    function close() {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onWindowUp);
      host.innerHTML = '';
    }

    raf = requestAnimationFrame(tick);
    return { close: close };
  }

  global.Graph = { open: open };
})(window);
