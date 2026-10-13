/**
 * 「人物图谱」独立页 — GET /graph 的页面本体
 *
 * 左边书与统计 / 右边关系图画板。与其他页同源的红头档案视觉（暖纸底 +
 * 墨字 + 单一朱砂红），但画板区是深一档的纸灰，让节点卡浮起来。
 *
 * 为什么自己写布局而不引 React Flow/dagre：本项目零前端框架（无 react /
 * vite / d3 / cytoscape），所有页面都是 TS 模板字符串吐自包含 HTML。引
 * 框架就得引构建链，与「tsx 直跑、零构建」的部署前提冲突。所以布局用手
 * 写的分层算法（BFS 分层 + 层内排序 + 重心对齐），输出 SVG——功能上够用，
 * 且顺手拿到矢量缩放与打印清晰度。
 *
 * 数据来自 GET /api/graph（纯本地 data/graph.json，不登录教务、不调模型），
 * 删除走 POST /api/graph/person|relation/delete。页面每 60 秒与切回标签页
 * 时自行刷新；拖动节点的位置记在内存（刷新即复位，不落盘——图谱本体才是
 * 权威，布局是视图状态）。
 */

import { GRAPH_CATEGORIES } from "../../core/graph-categories";
import type { GraphSnapshot } from "../../core/graph-store";

export function graphPage(
  options: { demo?: boolean; demoData?: GraphSnapshot | null } = {},
): string {
  const demo = options.demo === true;
  const demoData = options.demoData ?? null;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F6F4ED">
<link rel="icon" type="image/png" href="/logo.png">
<title>人物图谱 · CourseRaptor</title>
<style>
  :root {
    color-scheme: light;
    --paper: #F6F4ED;
    --paper-deep: #F0EDE4;
    --card: #FFFFFF;
    --shade: #ECE8DD;
    --ink: #25221C;
    --ink-2: #5A554A;
    --ink-3: #6E6656;
    --rule: #E1DCCF;
    --rule-2: #C9C1AF;
    --accent: #AD392C;
    --accent-deep: #852B22;
    --accent-soft: #F3E3DE;
    --serif: Georgia, "Times New Roman", "Songti SC", SimSun, serif;
    --kai: "KaiTi", "STKaiti", "Kaiti SC", var(--serif);
    --sans: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --mono: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
    --head-h: 64px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink);
         font-family: var(--sans); font-size: 16px; line-height: 1.7;
         -webkit-font-smoothing: antialiased; }
  ::selection { background: var(--accent-soft); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tbtn { background: none; border: 1px solid var(--rule-2); color: var(--ink-2);
          min-height: 36px; font-size: 14px; padding: 6px 14px; border-radius: 8px;
          cursor: pointer; font-family: inherit; display: inline-flex; align-items: center;
          transition: border-color .15s ease, color .15s ease, background .15s ease; }
  .tbtn:hover { border-color: var(--accent); color: var(--accent); background: var(--card); }
  .tbtn:active { transform: translateY(1px); }

  .pagehead { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 16px;
              padding: 10px 28px; height: var(--head-h); border-bottom: 1px solid var(--rule);
              background: rgba(246, 244, 237, 0.92);
              -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
  .pagehead .seal { flex: none; position: relative; width: 44px; height: 44px; transform: rotate(-7deg); }
  .pagehead .seal::before { content: ""; position: absolute; inset: 0;
                            border: 2px solid var(--accent); border-radius: 50%; opacity: .9; }
  .pagehead .seal img { position: absolute; top: 5px; left: 5px; width: 34px; height: 34px;
                        border-radius: 50%; object-fit: cover; }
  .ph-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 14px; }
  .ph-title h1 { margin: 0; font-family: var(--kai); font-weight: 400; font-size: 24px; letter-spacing: 2px; }
  .ph-title .ph-stamp { font-family: var(--mono); font-size: 12px; color: var(--ink-3); letter-spacing: .1em; }
  .ph-right { display: flex; align-items: center; gap: 10px; }

  main { display: grid; grid-template-columns: 272px minmax(0, 1fr); align-items: stretch;
         min-height: calc(100vh - var(--head-h)); background: var(--paper-deep); }

  .gn-rail { background: var(--card); border-right: 1px solid var(--rule);
             padding: 20px 18px; position: sticky; top: var(--head-h); align-self: start;
             min-height: calc(100vh - var(--head-h)); max-height: calc(100vh - var(--head-h));
             overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }

  .gn-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .gn-stat { background: var(--paper); border-radius: 10px; padding: 12px; text-align: center; }
  .gn-stat b { display: block; font-size: 26px; font-weight: 500; line-height: 1.2; }
  .gn-stat span { font-size: 12px; color: var(--ink-3); }

  .gn-h { font-size: 12px; color: var(--ink-3); letter-spacing: .14em; margin: 0 0 8px;
          font-family: var(--mono); text-transform: uppercase; }

  .gn-books { display: flex; flex-direction: column; gap: 6px; }
  .gn-book { display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
             padding: 9px 12px; border-radius: 8px; cursor: pointer; border: 1px solid transparent;
             background: none; font-family: inherit; font-size: 14px; color: var(--ink-2); text-align: left;
             transition: background .15s ease, border-color .15s ease; }
  .gn-book:hover { background: var(--paper); }
  .gn-book[aria-current="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-deep); }
  .gn-book i { font-style: normal; font-family: var(--mono); font-size: 11px; color: var(--ink-3); flex: none; }

  .gn-cats { display: flex; flex-direction: column; gap: 2px; }
  .gn-cat { display: flex; align-items: center; gap: 9px; padding: 7px 10px; border-radius: 8px;
            cursor: pointer; border: none; background: none; font-family: inherit; font-size: 13px;
            color: var(--ink-2); text-align: left; width: 100%;
            transition: background .15s ease, opacity .15s ease; }
  .gn-cat:hover { background: var(--paper); }
  .gn-cat[aria-pressed="false"] { opacity: .42; }
  .gn-cat .sw { width: 11px; height: 11px; border-radius: 3px; flex: none; }
  .gn-cat .cnt { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--ink-3); }

  .gn-meta { margin-top: auto; padding-top: 14px; border-top: 1px solid var(--rule);
             font-family: var(--mono); font-size: 11px; color: var(--ink-3); line-height: 1.9; }
  .gn-meta a { color: var(--ink-2); }

  /* ── 画板 ── */
  .board { position: relative; display: flex; flex-direction: column; min-width: 0; }
  .board-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
               padding: 12px 20px; border-bottom: 1px solid var(--rule); background: var(--paper); }
  .board-bar .bb-title { font-family: var(--kai); font-size: 17px; letter-spacing: 1px; }
  .board-bar .bb-count { font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
  .board-bar .bb-spacer { flex: 1; }
  .board-hint { font-size: 12px; color: var(--ink-3); padding: 0 20px; background: var(--paper); }

  .canvas-wrap { flex: 1; position: relative; overflow: hidden; background: var(--shade); touch-action: none; }
  .canvas-wrap svg { display: block; width: 100%; height: 100%; cursor: grab; }
  .canvas-wrap svg.dragging { cursor: grabbing; }

  .edge { fill: none; stroke-width: 1.6; }
  .edge-hit { fill: none; stroke: transparent; stroke-width: 14; cursor: pointer; }
  .edge-label { font-family: var(--sans); font-size: 10px; fill: #5C5142; text-anchor: middle;
                dominant-baseline: central; pointer-events: none; }
  .edge-label-bg { fill: #FBF7EC; fill-opacity: .96; stroke: #E1DCCF; stroke-width: .5; }

  .node { cursor: move; }
  .node-box { fill: var(--card); stroke: var(--rule-2); stroke-width: 1; rx: 9; }
  .node.sel .node-box { stroke: var(--accent); stroke-width: 2; }
  .node-name { font-family: var(--kai); font-size: 14px; fill: var(--ink); text-anchor: middle; pointer-events: none; }
  .node-alias { font-family: var(--mono); font-size: 9px; fill: var(--ink-3); text-anchor: middle; pointer-events: none; }
  .node-note { font-family: var(--sans); font-size: 9px; fill: var(--ink-3); text-anchor: middle; pointer-events: none; }
  .node-imp { fill: var(--accent); }

  .empty { position: absolute; inset: 0; display: flex; flex-direction: column;
           align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 24px; }
  .empty h2 { margin: 0; font-family: var(--kai); font-size: 19px; font-weight: 400; letter-spacing: 1px; }
  .empty p { margin: 0; font-size: 14px; color: var(--ink-3); max-width: 420px; line-height: 1.9; }
  .empty code { font-family: var(--mono); font-size: 12px; background: var(--paper);
                padding: 2px 6px; border-radius: 4px; color: var(--ink-2); }

  .delbar { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%);
            display: flex; gap: 10px; align-items: center; background: var(--card);
            border: 1px solid var(--rule-2); border-radius: 999px; padding: 8px 10px 8px 18px;
            box-shadow: 0 10px 28px rgba(50, 42, 31, 0.12); font-size: 13px; max-width: calc(100% - 40px); }
  .delbar b { font-weight: 500; }
  .delbar .tbtn { min-height: 30px; padding: 3px 12px; font-size: 13px; border-radius: 999px; }
  .delbar .tbtn.danger { border-color: var(--accent); color: var(--accent); }
  .delbar .tbtn.danger:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
  .delbar .tbtn.ghost { border-color: transparent; color: var(--ink-3); }
  .delbar .tbtn.ghost:hover { background: var(--paper); border-color: var(--rule-2); }

  .toast { position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
           background: var(--ink); color: var(--paper); font-size: 13px; padding: 8px 18px;
           border-radius: 999px; opacity: 0; pointer-events: none; transition: opacity .2s ease; }
  .toast.on { opacity: .94; }

  @media (max-width: 860px) {
    main { grid-template-columns: 1fr; }
    .gn-rail { position: static; max-height: none; min-height: 0; border-right: none;
               border-bottom: 1px solid var(--rule); }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
</style>
</head>
<body data-demo="${demo}">
<header class="pagehead">
  <div class="seal"><img src="/logo.png" alt=""></div>
  <div class="ph-title">
    <h1>人物图谱</h1>
    <span class="ph-stamp">CHARACTER ATLAS</span>
  </div>
  <div class="ph-right">
    <button class="tbtn" id="btn-export" type="button">导出 JSON</button>
    <a class="tbtn" href="/">回到对话</a>
  </div>
</header>

<main>
  <aside class="gn-rail">
    <div>
      <p class="gn-h">概览</p>
      <div class="gn-stats">
        <div class="gn-stat"><b id="s-person">0</b><span>人物</span></div>
        <div class="gn-stat"><b id="s-rel">0</b><span>关系</span></div>
      </div>
    </div>
    <div>
      <p class="gn-h">书目</p>
      <div class="gn-books" id="books"></div>
    </div>
    <div>
      <p class="gn-h">关系类别（点击隐藏）</p>
      <div class="gn-cats" id="cats"></div>
    </div>
    <div class="gn-meta">
      数据全部留在本机<br>
      ${demo ? "演示数据 · 不发请求" : '写入对话即可增删 · <a href="/graph">本页</a> 与 <a href="/">对话页</a> 同源'}
    </div>
  </aside>

  <section class="board">
    <div class="board-bar">
      <span class="bb-title" id="bb-title">—</span>
      <span class="bb-count" id="bb-count"></span>
      <span class="bb-spacer"></span>
      <button class="tbtn" id="btn-relayout" type="button">重新布局</button>
      <button class="tbtn" id="btn-fit" type="button">适应窗口</button>
    </div>
    <p class="board-hint" id="hint">拖动人物可调整位置；点选人物或连线后可删除。位置只在本页有效，刷新即复位。</p>
    <div class="canvas-wrap" id="wrap">
      <div class="toast" id="toast"></div>
    </div>
  </section>
</main>

<script>
(function () {
  "use strict";
  var DEMO = ${demo ? "true" : "false"};
  var DEMO_DATA = ${JSON.stringify(demoData)};
  var CATEGORIES = ${JSON.stringify(GRAPH_CATEGORIES)};

  var NODE_W = 150, NODE_H = 58, RANK_GAP = 130, NODE_GAP = 22, PAD = 40;
  var SVG_NS = "http://www.w3.org/2000/svg";

  var el = function (id) { return document.getElementById(id); };
  var wrap = el("wrap"), booksEl = el("books"), catsEl = el("cats");
  var toastEl = el("toast"), titleEl = el("bb-title"), countEl = el("bb-count");
  var hintEl = el("hint");

  var state = { bookId: null, snapshot: null, books: [], hidden: {}, sel: null };
  var view = { x: 0, y: 0, k: 1 };
  var svg = null, gRoot = null, pos = {}, drag = null, panning = null, busy = false;

  function el1(tag, cls) { var n = document.createElementNS(SVG_NS, tag); if (cls) n.setAttribute("class", cls); return n; }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("on");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove("on"); }, 2200);
  }

  function csrf() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute("content") : "";
  }

  function api(path, init) {
    var o = init || {};
    o.headers = o.headers || {};
    o.headers["x-csrf-token"] = csrf();
    if (o.body) o.headers["content-type"] = "application/json";
    return fetch(path, o).then(function (res) {
      return res.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        if (!res.ok) throw new Error((data && data.error) || ("请求失败 " + res.status));
        return data;
      });
    });
  }

  /* ── 数据 ── */

  function load() {
    if (DEMO) return Promise.resolve(DEMO_DATA);
    return api("/api/graph").then(function (d) { return d.snapshot; });
  }

  function loadBooks() {
    if (DEMO) return Promise.resolve(DEMO_DATA ? [DEMO_DATA.book] : []);
    return api("/api/graph/books");
  }

  function activeBook() {
    for (var i = 0; i < state.books.length; i++) {
      if (state.books[i].id === state.bookId) return state.books[i];
    }
    return state.books[0] || null;
  }

  /* ── 分层布局：BFS 定层 + 层内重心对齐
     替代 dagre：图规模（几百节点）下够用，且不引依赖。
     无向关系入度出度都算，避免孤立成孤岛 */
  function layout(snapshot, persons, edges) {
    var byId = {};
    for (var i = 0; i < persons.length; i++) byId[persons[i].id] = persons[i];

    var deg = {}, adj = {};
    for (var k in byId) { deg[k] = 0; adj[k] = []; }
    var pairs = [];
    for (var j = 0; j < edges.length; j++) {
      var e = edges[j];
      if (!byId[e.source] || !byId[e.target] || e.source === e.target) continue;
      pairs.push([e.source, e.target]);
      deg[e.source]++; deg[e.target]++;
      adj[e.source].push(e.target);
      adj[e.target].push(e.source);
    }

    // 重要度高的当根，起点更贴近真实中心
    var roots = Object.keys(byId).sort(function (a, b) {
      return deg[b] - deg[a] || byId[b].importance - byId[a].importance;
    }).slice(0, Math.max(1, Math.ceil(Object.keys(byId).length / 8)));

    var rank = {}, queue = [], qi = 0;
    for (var r = 0; r < roots.length; r++) { if (rank[roots[r]] === undefined) { rank[roots[r]] = 0; queue.push(roots[r]); } }
    while (qi < queue.length) {
      var id = queue[qi++];
      var nb = adj[id];
      for (var n = 0; n < nb.length; n++) {
        if (rank[nb[n]] === undefined) { rank[nb[n]] = rank[id] + 1; queue.push(nb[n]); }
      }
    }
    // 环外孤立节点全塞到最后一层，不留浮空的第 0 层
    var maxRank = 0, orphanRank = null;
    for (var key in byId) {
      if (rank[key] === undefined) { if (orphanRank === null) orphanRank = Math.max.apply(null, Object.keys(rank).map(function (x) { return rank[x]; })) + 1; rank[key] = orphanRank; }
      else if (rank[key] > maxRank) maxRank = rank[key];
    }

    var layers = [];
    for (var id2 in rank) {
      var lv = rank[id2];
      (layers[lv] || (layers[lv] = [])).push(id2);
    }
    for (var l = 0; l < layers.length; l++) {
      if (!layers[l]) continue;
      // 层内按重要度降序，次序稳定
      layers[l].sort(function (a, b) {
        return byId[b].importance - byId[a].importance || byId[a].createdAt - byId[b].createdAt;
      });
      // 初值只按层内序号铺开，纵向居中留到重心收敛后统一做——
      // 这里先算层高是为了让初始分布不至于全挤在顶部
      for (var m = 0; m < layers[l].length; m++) {
        var id3 = layers[l][m];
        pos[id3] = {
          x: PAD + l * (NODE_W + RANK_GAP),
          y: PAD + m * (NODE_H + NODE_GAP) + 200,
        };
      }
    }

    // 重心对齐：把每个节点向它所有邻居的平均纵向位置靠拢，迭代收敛。
    // 关键是要参考**所有已定位的邻居**（前后层都算），不能只看上一层——
    // 只看上一层时，某个中心节点（宝玉）连着十几个同侧邻居，对齐逻辑
    // 完全失效，所有连线会挤成一束"面条"。
    for (var pass = 0; pass < 8; pass++) {
      // 前后交替扫，两向都推一遍，避免单向漂移
      for (var dir = 0; dir < 2; dir++) {
        for (var li = 0; li < layers.length; li++) {
          var l2 = dir === 0 ? li : layers.length - 1 - li;
          var cur = layers[l2];
          if (!cur) continue;
          for (var m2 = 0; m2 < cur.length; m2++) {
            var id4 = cur[m2], nb2 = adj[id4], sum = 0, cnt = 0;
            for (var t = 0; t < nb2.length; t++) {
              // 任何一层的已定位邻居都算，重心才准
              if (rank[nb2[t]] !== undefined && pos[nb2[t]]) { sum += pos[nb2[t]].y; cnt++; }
            }
            if (cnt) pos[id4].y = sum / cnt;
          }
          // 同层去重叠：按纵向序扫描，压不开就整体下推
          cur.sort(function (a2, b2) { return pos[a2].y - pos[b2].y; });
          for (var m3 = 1; m3 < cur.length; m3++) {
            var need = NODE_H + NODE_GAP;
            if (pos[cur[m3]].y - pos[cur[m3 - 1]].y < need)
              pos[cur[m3]].y = pos[cur[m3 - 1]].y + need;
          }
        }
      }
    }

    // 各层整体垂直居中对齐到共同中线：分层布局不居中会整体偏上
    var center = 0;
    for (var idc in pos) center += pos[idc].y + NODE_H / 2;
    center = center / Math.max(1, Object.keys(pos).length);
    for (var idd in pos) pos[idd].y = pos[idd].y + center - NODE_H / 2 - PAD;

    var maxX = 0, minY = 1e9, maxY = -1e9;
    for (var id5 in pos) {
      maxX = Math.max(maxX, pos[id5].x + NODE_W);
      minY = Math.min(minY, pos[id5].y);
      maxY = Math.max(maxY, pos[id5].y + NODE_H);
    }
    return { w: maxX + PAD, h: maxY - minY + PAD * 2, pairs: pairs };
  }

  /* ── 渲染 ── */

  function visibleData() {
    var s = state.snapshot;
    if (!s) return { persons: [], relations: [] };
    var rels = s.relations.filter(function (r) { return !state.hidden[r.category]; });
    var used = {};
    for (var i = 0; i < rels.length; i++) { used[rels[i].sourceId] = 1; used[rels[i].targetId] = 1; }
    // 图谱完全空时也展示孤立人物，否则新建的书什么都看不到
    var persons = s.persons.filter(function (p) { return used[p.id] || s.relations.length === 0; });
    return { persons: persons, relations: rels };
  }

  function render() {
    var s = state.snapshot;
    el("s-person").textContent = s ? s.persons.length : 0;
    el("s-rel").textContent = s ? s.relations.length : 0;

    var book = activeBook();
    titleEl.textContent = book ? "《" + book.title + "》" : "未选择";
    var vd = visibleData();
    var shown = vd.relations.length;
    countEl.textContent = vd.persons.length + " 人物 · " + shown + " 关系" + (s && shown < s.relations.length ? "（已隐藏 " + (s.relations.length - shown) + " 条）" : "");

    renderBooks();
    renderCats();
    renderEmpty(vd);
    drawBoard(vd);
  }

  function renderEmpty(vd) {
    var old = wrap.querySelector(".empty");
    if (old) old.remove();
    if (vd.persons.length) { if (emptyOn) { hintEl.style.display = ""; emptyOn = false; } return; }
    emptyOn = true;
    hintEl.style.display = "none";
    var d = document.createElement("div");
    d.className = "empty";
    var h = document.createElement("h2");
    h.textContent = state.snapshot && state.snapshot.relations.length ? "当前类别全部被隐藏了" : "图谱还是空的";
    var p = document.createElement("p");
    p.textContent = "回到对话里告诉 agent 书中的人物关系，比如「宝玉是贾母的孙子」，图谱会当场长出节点与连线。也可以说「宝玉又叫宝二爷」合并别名。";
    var c = document.createElement("p");
    var code = document.createElement("code");
    code.textContent = "例：张三是李四的父亲";
    c.appendChild(code);
    d.appendChild(h); d.appendChild(p); d.appendChild(c);
    wrap.appendChild(d);
    if (svg) { svg.remove(); svg = null; }
  }
  var emptyOn = false;

  function renderBooks() {
    booksEl.textContent = "";
    for (var i = 0; i < state.books.length; i++) {
      var b = state.books[i];
      var btn = document.createElement("button");
      btn.className = "gn-book";
      btn.type = "button";
      btn.setAttribute("aria-current", b.id === state.bookId ? "true" : "false");
      var nm = document.createElement("span");
      nm.textContent = "《" + b.title + "》";
      var ct = document.createElement("i");
      ct.textContent = b.personCount + "/" + b.relationCount;
      btn.appendChild(nm); btn.appendChild(ct);
      (function (id) {
        btn.addEventListener("click", function () {
          if (state.bookId === id || busy) return;
          state.bookId = id;
          fetchBook();
        });
      })(b.id);
      booksEl.appendChild(btn);
    }
  }

  function renderCats() {
    var s = state.snapshot;
    catsEl.textContent = "";
    for (var key in CATEGORIES) {
      var c = CATEGORIES[key];
      var n = 0;
      if (s) for (var i = 0; i < s.relations.length; i++) if (s.relations[i].category === key) n++;
      var btn = document.createElement("button");
      btn.className = "gn-cat";
      btn.type = "button";
      btn.setAttribute("aria-pressed", state.hidden[key] ? "false" : "true");
      var sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = c.color;
      var nm = document.createElement("span");
      nm.textContent = c.name;
      var ct = document.createElement("span");
      ct.className = "cnt";
      ct.textContent = String(n);
      btn.appendChild(sw); btn.appendChild(nm); btn.appendChild(ct);
      (function (k) {
        btn.addEventListener("click", function () {
          state.hidden[k] = !state.hidden[k];
          render();
        });
      })(key);
      catsEl.appendChild(btn);
    }
  }

  function drawBoard(vd) {
    if (!svg) {
      svg = el1("svg");
      gRoot = el1("g");
      svg.appendChild(gRoot);
      wrap.appendChild(svg);
      bindBoardEvents();
    }
    gRoot.textContent = "";

    if (!vd.persons.length) { applyView(); return; }

    pos = {};
    var lay = layout(state.snapshot, vd.persons, vd.relations);
    // 标签占位表：每轮重绘重建，用于关系词之间的纵向避让
    var labelSlots = [];

    // 连线在下、节点在上：SVG 无 z-index，全靠插入顺序
    var byId = {};
    for (var i = 0; i < vd.persons.length; i++) byId[vd.persons[i].id] = vd.persons[i];

    for (var j = 0; j < vd.relations.length; j++) {
      var r = vd.relations[j];
      var a = pos[r.sourceId], b = pos[r.targetId];
      if (!a || !b) continue;
      var cat = CATEGORIES[r.category] || CATEGORIES.other;
      var x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
      var x2 = b.x, y2 = b.y + NODE_H / 2;
      // 从右侧出、左侧入：目标在左侧时改走左侧出线，线不会从卡片里穿出来
      var flip = false;
      if (x2 < x1) { flip = true; x1 = a.x; x2 = b.x + NODE_W; y1 = a.y + NODE_H / 2; y2 = b.y + NODE_H / 2; }
      var mid = (x1 + x2) / 2;
      var d = flip
        ? "M" + x1 + " " + y1 + " C" + (x1 - 45) + " " + y1 + " " + (x2 + 45) + " " + y2 + " " + x2 + " " + y2
        : "M" + x1 + " " + y1 + " C" + mid + " " + y1 + " " + mid + " " + y2 + " " + x2 + " " + y2;

      var hit = el1("path", "edge-hit");
      hit.setAttribute("d", d);
      hit.addEventListener("click", (function (rel) {
        return function (ev) { ev.stopPropagation(); selectRel(rel.id); };
      })(r.id));
      gRoot.appendChild(hit);

      var path = el1("path", "edge");
      path.setAttribute("d", d);
      path.setAttribute("stroke", cat.color);
      if (r.directed) {
        var mk = el1("marker");
        mk.setAttribute("id", "arw-" + r.id);
        mk.setAttribute("viewBox", "0 0 10 10");
        mk.setAttribute("refX", "9"); mk.setAttribute("refY", "5");
        mk.setAttribute("markerWidth", "5"); mk.setAttribute("markerHeight", "5");
        mk.setAttribute("orient", "auto-start-reverse");
        var mp = el1("path", "");
        mp.setAttribute("d", "M0 0 L10 5 L0 10 z");
        mp.setAttribute("fill", cat.color);
        mk.appendChild(mp);
        gRoot.appendChild(mk);
        path.setAttribute("marker-end", "url(#arw-" + r.id + ")");
      }
      gRoot.appendChild(path);

      // 关系词标签：落在曲线 38% 处而非正中。加白底免得压线看不清。
      // 中点对「多边共用同一端点」是重灾区——宝玉连着十几个人，中点全撞在
      // 一处变成一团糊字，所以按 x/y 占位做纵向避让。
      var lx = a.x + (x2 - a.x) * 0.38 + NODE_W / 2;
      var ly = a.y + (y2 - a.y) * 0.38 + NODE_H / 2;
      var label = r.label || "";
      var wpx = label.length * 11 + 12;
      for (var guard = 0; guard < 12; guard++) {
        var clash = false;
        for (var si = 0; si < labelSlots.length; si++) {
          var sl = labelSlots[si];
          if (Math.abs(sl.x - lx) < (wpx + sl.w) / 2 && Math.abs(sl.y - ly) < 20) { clash = true; break; }
        }
        if (!clash) break;
        ly += 21;
      }
      labelSlots.push({ x: lx, y: ly, w: wpx });
      var bg = el1("rect", "edge-label-bg");
      bg.setAttribute("x", lx - wpx / 2); bg.setAttribute("y", ly - 9);
      bg.setAttribute("width", wpx); bg.setAttribute("height", 18);
      bg.setAttribute("rx", 4);
      gRoot.appendChild(bg);
      var tx = el1("text", "edge-label");
      tx.setAttribute("x", lx); tx.setAttribute("y", ly);
      tx.textContent = label;
      gRoot.appendChild(tx);
    }

    for (var m = 0; m < vd.persons.length; m++) {
      var p = vd.persons[m];
      var p0 = pos[p.id];
      if (!p0) continue;
      var g = el1("g", "node");
      if (state.sel && state.sel.kind === "person" && state.sel.id === p.id) g.classList.add("sel");
      g.setAttribute("transform", "translate(" + p0.x + "," + p0.y + ")");

      var box = el1("rect", "node-box");
      box.setAttribute("width", NODE_W);
      box.setAttribute("height", NODE_H);
      g.appendChild(box);

      var nm2 = el1("text", "node-name");
      nm2.setAttribute("x", NODE_W / 2);
      nm2.setAttribute("y", p.note ? 21 : 25);
      nm2.textContent = p.name;
      g.appendChild(nm2);

      var second = "", third = "";
      if (p.note) { second = p.note; }
      else if (p.aliases && p.aliases.length) { second = p.aliases.join(" · "); }
      if (second) {
        var t2 = el1("text", "node-note");
        t2.setAttribute("x", NODE_W / 2); t2.setAttribute("y", 37);
        t2.textContent = second.length > 16 ? second.slice(0, 16) + "…" : second;
        g.appendChild(t2);
      }
      if (p.aliases && p.aliases.length && p.note) {
        var t3 = el1("text", "node-alias");
        t3.setAttribute("x", NODE_W / 2); t3.setAttribute("y", 49);
        var al = p.aliases.join(" · ");
        t3.textContent = al.length > 20 ? al.slice(0, 20) + "…" : al;
        g.appendChild(t3);
      }
      // 重要度：右上角朱砂点，1-3 个，一眼看出主要人物
      for (var d2 = 0; d2 < Math.min(3, Math.max(1, p.importance || 1)); d2++) {
        var dot = el1("circle", "node-imp");
        dot.setAttribute("cx", NODE_W - 10 - d2 * 7);
        dot.setAttribute("cy", 11);
        dot.setAttribute("r", 2.4);
        g.appendChild(dot);
      }

      g.addEventListener("pointerdown", (function (pid, pp) {
        return function (ev) { startNodeDrag(ev, pid, pp); };
      })(p.id, p));
      gRoot.appendChild(g);
    }

    state._board = { w: lay.w, h: lay.h };
    applyView();
  }

  function applyView() {
    if (!svg) return;
    gRoot.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")");
  }

  function fit() {
    var b = state._board;
    if (!b || !svg) return;
    var r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var k = Math.min(r.width / b.w, r.height / b.h, 1.1);
    k = Math.max(k, 0.12);
    view.k = k;
    view.x = (r.width - b.w * k) / 2;
    view.y = (r.height - b.h * k) / 2;
    applyView();
  }

  /* ── 交互 ── */

  function bindBoardEvents() {
    svg.addEventListener("pointerdown", function (ev) {
      if (ev.target.closest(".node")) return;
      clearSel();
      panning = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
      svg.classList.add("dragging");
      svg.setPointerCapture(ev.pointerId);
    });
    svg.addEventListener("pointermove", function (ev) {
      if (!panning) return;
      view.x = panning.vx + (ev.clientX - panning.x);
      view.y = panning.vy + (ev.clientY - panning.y);
      applyView();
    });
    var endPan = function (ev) {
      if (!panning) return;
      panning = null;
      svg.classList.remove("dragging");
      try { svg.releasePointerCapture(ev.pointerId); } catch (e) {}
    };
    svg.addEventListener("pointerup", endPan);
    svg.addEventListener("pointercancel", endPan);
    svg.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      var r = wrap.getBoundingClientRect();
      var mx = ev.clientX - r.left, my = ev.clientY - r.top;
      var k2 = Math.min(2.5, Math.max(0.12, view.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
      // 以指针为锚点缩放：view.x/y 按新旧比例补偿，图形不会从指针下飘走
      view.x = mx - (mx - view.x) * (k2 / view.k);
      view.y = my - (my - view.y) * (k2 / view.k);
      view.k = k2;
      applyView();
    }, { passive: false });
  }

  function startNodeDrag(ev, pid, person) {
    ev.stopPropagation();
    selectPerson(pid, person);
    var p0 = pos[pid];
    drag = { pid: pid, sx: ev.clientX, sy: ev.clientY, ox: p0.x, oy: p0.y, moved: false };
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add("dragging");
  }

  function moveNode(ev) {
    if (!drag) return;
    var dx = (ev.clientX - drag.sx) / view.k;
    var dy = (ev.clientY - drag.sy) / view.k;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    pos[drag.pid].x = drag.ox + dx;
    pos[drag.pid].y = drag.oy + dy;
    drawBoard(visibleData());
    svg.classList.add("dragging");
  }

  function endNodeDrag(ev) {
    if (!drag) return;
    var wasMoved = drag.moved;
    drag = null;
    svg.classList.remove("dragging");
    try { svg.releasePointerCapture(ev.pointerId); } catch (e) {}
    if (!wasMoved) return;
    // 拖完重排连线：整图重绘但保留 pos（布局函数只在 relayout 时重置）
    drawBoard(visibleData());
  }

  function selectPerson(id, person) {
    state.sel = { kind: "person", id: id, name: person.name };
    renderDelBar();
    render();
  }

  function selectRel(id) {
    var s = state.snapshot;
    if (!s) return;
    var r = null;
    for (var i = 0; i < s.relations.length; i++) if (s.relations[i].id === id) r = s.relations[i];
    if (!r) return;
    state.sel = { kind: "relation", id: id, label: r.label, from: r.sourceName, to: r.targetName };
    renderDelBar();
    render();
  }

  function clearSel() {
    if (!state.sel) return;
    state.sel = null;
    renderDelBar();
    render();
  }

  function renderDelBar() {
    var old = wrap.querySelector(".delbar");
    if (old) old.remove();
    if (!state.sel) return;
    var bar = document.createElement("div");
    bar.className = "delbar";
    var txt = document.createElement("b");
    txt.textContent = state.sel.kind === "person"
      ? "人物：" + state.sel.name
      : "关系：" + (state.sel.from || "?") + " —" + (state.sel.label || "?") + "→ " + (state.sel.to || "?");
    var yes = document.createElement("button");
    yes.className = "tbtn danger";
    yes.type = "button";
    yes.textContent = "删除";
    yes.addEventListener("click", doDelete);
    var no = document.createElement("button");
    no.className = "tbtn ghost";
    no.type = "button";
    no.textContent = "取消";
    no.addEventListener("click", clearSel);
    bar.appendChild(txt); bar.appendChild(yes); bar.appendChild(no);
    wrap.appendChild(bar);
  }

  function doDelete() {
    if (!state.sel || busy || DEMO) { toast("演示模式不能删除"); return; }
    var sel = state.sel;
    var path = sel.kind === "person" ? "/api/graph/person/delete" : "/api/graph/relation/delete";
    busy = true;
    api(path, { method: "POST", body: JSON.stringify({ bookId: state.bookId, id: sel.id }) })
      .then(function () {
        state.sel = null;
        toast(sel.kind === "person" ? "已删除人物及其关系" : "已删除关系");
        return refresh();
      })
      .catch(function (e) { toast(e.message || "删除失败"); })
      .finally(function () { busy = false; renderDelBar(); render(); });
  }

  /* ── 刷新 ── */

  function fetchBook() {
    if (DEMO) { state.snapshot = DEMO_DATA; state.books = DEMO_DATA ? [{ id: DEMO_DATA.bookId, title: "红楼梦", personCount: DEMO_DATA.persons.length, relationCount: DEMO_DATA.relations.length }] : []; render(); return Promise.resolve(); }
    return api("/api/graph?bookId=" + encodeURIComponent(state.bookId || ""))
      .then(function (d) { state.snapshot = d.snapshot; render(); });
  }

  function refresh() {
    if (DEMO) return fetchBook();
    return loadBooks()
      .then(function (books) {
        state.books = books || [];
        if (!state.bookId && state.books.length) state.bookId = state.books[0].id;
        var b = activeBook();
        if (b && b.title === "未命名" && state.books.length > 1) state.bookId = state.books[1].id;
        return fetchBook();
      })
      .then(function () { if (state._board) fit(); });
  }

  el("btn-relayout").addEventListener("click", function () {
    state._board = null;
    render();
    fit();
  });
  el("btn-fit").addEventListener("click", fit);
  el("btn-export").addEventListener("click", function () {
    if (DEMO) { toast("演示模式没有可导出的数据"); return; }
    window.open("/api/graph/export?bookId=" + encodeURIComponent(state.bookId || ""), "_blank");
  });

  // 节点拖动的 move/up 挂在 svg 上（指针捕获后事件仍指向 svg）
  document.addEventListener("pointermove", moveNode);
  document.addEventListener("pointerup", endNodeDrag);

  window.addEventListener("resize", function () { if (state._board) fit(); });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !busy) refresh();
  });

  refresh().then(function () {
    if (state._board) fit();
    setInterval(function () { if (!document.hidden && !busy && !drag) refresh(); }, 60000);
  });
})();
</script>
</body>
</html>`;
}
