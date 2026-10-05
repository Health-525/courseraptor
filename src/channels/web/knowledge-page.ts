/**
 * 「知识库」独立页 — GET /knowledge 的页面本体
 *
 * 三种视图共一套筛选（搜索 / 分类 / 排序）：
 *  · 条目：朴素卡片列表（分类小胶囊徽章 + 长文折叠 + 两步删除）；
 *  · 导图：SVG 横向树（我的知识 → 课程分类 → 条目），点击节点跳回
 *    条目视图并高亮展开，每分类最多 12 个节点、超出折进「还有 N 条」；
 *  · 时间线：按月分组 + 左缘时间轴竖线，条目卡与列表视图同款。
 * 数据来自 GET /api/knowledge（纯本地存储，不登录教务、不调模型），
 * 页面每 60 秒与切回标签页时自行刷新；视图选择经 URL hash 记忆。
 *
 * 视觉走工具风（参照 memos / 思源笔记：系统无衬线、信息优先、无装饰
 * 排版）——无楷体、无竖排、无旋转印章、无英文小标签、无大数字统计；
 * 日期直接用相对时间（今天 / 昨天 / N 天前）。朱砂只保留容器顶线与
 * 导图根节点等功能性用色。
 * 演示模式：demo=true 时内嵌虚构数据（demoData），不发任何请求。
 */

import type { KnowledgeEntry } from "../../core/knowledge";

/** 正文超过该长度视为长文，默认折叠、展开收起由用户决定 */
const CLAMP_LEN = 160;
/** 首屏渲染条数，超出部分「显示更多」分批追加 */
const BATCH = 50;
/** 导图里每个分类最多渲染的条目节点数，超出折进「还有 N 条」 */
const GRAPH_MAX = 12;

export function knowledgePage(
  options: { demo?: boolean; demoData?: KnowledgeEntry[] } = {},
): string {
  const demo = options.demo === true;
  const demoData = options.demoData;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F6F4ED">
<link rel="icon" type="image/png" href="/logo.png">
<title>知识库 · CourseRaptor</title>
<style>
  /* 与 today-page 同源的设计令牌：红头档案（编辑部排版风） */
  :root {
    color-scheme: light;
    --paper: #F6F4ED;
    --paper-deep: #F0EDE4;
    --card: #FCFBF7;
    --shade: #ECE8DD;
    --ink: #25221C;
    --ink-2: #5A554A;
    /* 旧值 #898274 在纸底上仅 ~3.5:1，调深以满足 WCAG AA（小字 ≥4.5:1） */
    --ink-3: #6E6656;
    --rule: #E1DCCF;
    --rule-2: #C9C1AF;
    --accent: #AD392C;
    --accent-deep: #852B22;
    --accent-soft: #F3E3DE;
    --shadow-sm: 0 8px 24px rgba(50, 42, 31, 0.055);
    --sans: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --mono: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink);
         font-family: var(--sans); font-size: 16px; line-height: 1.7;
         -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  ::selection { background: var(--accent-soft); }
  a { color: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tbtn { background: none; border: 1px solid var(--rule-2); color: var(--ink-2);
          min-height: 38px; font-size: 14px; padding: 7px 14px; border-radius: 4px;
          cursor: pointer; text-decoration: none; display: inline-flex;
          align-items: center; font-family: inherit;
          transition: border-color .15s ease, color .15s ease, background .15s ease; }
  .tbtn:hover { border-color: var(--accent); color: var(--accent); background: var(--card); }
  .tbtn:active { transform: translateY(1px); }

  /* ── 页头：工具风，无印章无英文小标签 ── */
  .pagehead { display: flex; align-items: center; gap: 16px;
              padding: 16px 28px; border-bottom: 1px solid var(--rule);
              background: var(--paper-deep); }
  .ph-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 14px; }
  .ph-title h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: 0; }
  .ph-right { display: flex; align-items: center; gap: 10px; }

  /* ── 正文：左栏分类导航 + 右栏内容卡 ── */
  main { max-width: 1240px; margin: 0 auto; padding: 24px 22px 64px;
         display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; }

  .kn-rail { position: sticky; top: 22px; padding: 8px 4px; }
  .kw-box { width: 100%; padding: 7px 10px; border: 1px solid var(--rule-2);
            border-radius: 4px; background: var(--card); color: var(--ink); font-size: 14px;
            font-family: inherit; }
  .kw-box:focus { outline: none; border-color: var(--accent); }
  .kw-hint { margin: 5px 2px 0; font-family: var(--mono); font-size: 11px;
             color: var(--ink-3); letter-spacing: .04em; }
  .sort-row { display: flex; gap: 6px; margin-top: 12px; }
  .sort-btn { flex: 1; background: none; border: 1px solid var(--rule-2); padding: 4px 8px;
              border-radius: 4px; color: var(--ink-2); font-size: 12px; cursor: pointer;
              font-family: var(--mono); letter-spacing: .04em; }
  .sort-btn:hover { border-color: var(--accent); color: var(--accent); }
  .sort-btn.active { border-color: var(--accent); background: var(--accent-soft);
                     color: var(--accent-deep); }
  .cat-nav { display: flex; flex-direction: column; gap: 4px; margin-top: 14px; }
  .cat-btn { display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
             background: none; border: 1px solid transparent; padding: 6px 8px; border-radius: 4px;
             color: var(--ink-2); font-size: 14px; cursor: pointer; font-family: inherit;
             text-align: left; }
  .cat-btn:hover { background: var(--card); color: var(--ink); }
  .cat-btn.active { border-color: var(--rule-2); background: var(--card); color: var(--accent-deep); }
  .cat-count { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
  .rail-meta { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--rule-2);
               font-family: var(--mono); font-size: 12px; line-height: 1.7; color: var(--ink-3); }
  .rail-meta .tbtn { margin-top: 12px; min-height: 30px; padding: 3px 12px; font-size: 12px; }

  .card { border: 1px solid var(--rule-2); border-top: 2px solid var(--accent);
          background: var(--card); box-shadow: var(--shadow-sm); }
  .card > h2 { display: flex; justify-content: space-between; align-items: center; gap: 10px;
               margin: 0; padding: 10px 18px; border-bottom: 1px solid var(--rule);
               font-family: var(--mono); font-size: 13px; font-weight: 600;
               letter-spacing: .18em; color: var(--ink-2); }
  .card > h2 .cnote { font-family: var(--mono); font-weight: 400; font-size: 12px;
                      letter-spacing: .03em; color: var(--ink-3); }
  .view-tabs { display: flex; gap: 6px; }
  .vtab { background: none; border: 1px solid var(--rule-2); padding: 4px 12px;
          border-radius: 4px; color: var(--ink-2); font-size: 12px; cursor: pointer;
          font-family: var(--mono); letter-spacing: .04em;
          transition: border-color .15s ease, color .15s ease, background .15s ease; }
  .vtab:hover { border-color: var(--accent); color: var(--accent); }
  .vtab.active { border-color: var(--accent); background: var(--accent-soft);
                 color: var(--accent-deep); }
  .cbody { padding: 14px 18px 16px; display: grid; gap: 10px; align-content: start; }

  .skel { color: var(--ink-3); font-size: 15px; padding: 8px 2px; }
  .empty { margin: 0; padding: 24px 8px; border: 1px dashed var(--rule-2); text-align: center;
           color: var(--ink-3); font-size: 14px; }

  /* 知识条目：标题行 + 正文，朴素卡片；长文默认折叠可展开 */
  .k-entry { padding: 12px 14px; border: 1px solid var(--rule); background: var(--paper);
             display: grid; gap: 0;
             transition: border-color .15s ease, box-shadow .15s ease; }
  .k-entry:hover { border-color: var(--rule-2); box-shadow: 0 2px 10px rgba(50, 42, 31, .07); }
  .k-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .k-title { margin: 0; font-size: 15px; font-weight: 600;
             overflow-wrap: anywhere; }
  /* 分类小胶囊徽章：长名省略号 + 悬停全名（memos 的 tag 形态） */
  .k-cat { flex: none; max-width: 40%; padding: 1px 8px; background: var(--shade);
           color: var(--ink-2); font-size: 12px; border-radius: 999px;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k-date { margin-left: auto; flex: none; font-family: var(--mono); font-size: 11px;
            color: var(--ink-3); white-space: nowrap; }
  .k-del { background: none; border: none; padding: 2px 4px; color: var(--ink-3); flex: none;
           font-family: var(--mono); font-size: 12px; cursor: pointer; }
  .k-del:hover { color: var(--accent); text-decoration: underline; }
  .k-del.armed { color: var(--card); background: var(--accent); border-radius: 3px;
                 padding: 2px 8px; }
  .k-content { margin: 6px 0 0; font-size: 14px; line-height: 1.7; color: var(--ink-2);
               white-space: pre-wrap; overflow-wrap: anywhere; }
  /* 正文里的自动链接：朱砂深色 + 下划线区分正文，新标签打开 */
  .k-content a { color: var(--accent-deep); text-decoration: underline;
                 text-underline-offset: 2px; }
  .k-content a:hover { color: var(--accent); }
  .k-content.clamp { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
                     overflow: hidden; }
  .k-toggle { justify-self: start; background: none; border: none; padding: 3px 0;
              color: var(--accent-deep); font-family: var(--mono); font-size: 12px;
              cursor: pointer; }
  .k-toggle:hover { text-decoration: underline; }
  mark { background: var(--accent-soft); color: var(--accent-deep); padding: 0 1px; }
  .k-more { justify-self: center; min-height: 32px; padding: 4px 16px; font-size: 12.5px; }
  /* 导图节点点击跳回条目后的落点脉冲提示 */
  @keyframes kf-flash { 0%, 55% { background: var(--accent-soft); }
                        100% { background: var(--paper); } }
  .k-entry.flash { animation: kf-flash 1.8s ease both; }

  /* ── 时间线视图：按月分组 + 左缘时间轴 ── */
  .tl-group { position: relative; padding-left: 26px; margin: 2px 0 4px; }
  .tl-group::before { content: ""; position: absolute; left: 7px; top: 10px; bottom: 10px;
                      width: 1px; background: var(--rule-2); }
  .tl-head { display: flex; align-items: baseline; gap: 10px; margin: 0 0 12px; }
  .tl-head .tl-month { font-size: 15px; font-weight: 600; }
  .tl-head .tl-count { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
  .tl-item { position: relative; }
  .tl-item::before { content: ""; position: absolute; left: -23px; top: 14px; width: 9px;
                     height: 9px; border-radius: 50%; border: 2px solid var(--accent);
                     background: var(--paper); }

  /* ── 导图视图：SVG 横向树，窄屏横向滚动 ── */
  .graph-wrap { display: flex; overflow: auto; padding: 12px 2px 4px; }
  .graph-wrap svg { flex: none; margin: 0 auto; display: block; }
  .graph-wrap text { dominant-baseline: middle; }
  .gn-root-r { fill: var(--accent); }
  .gn-root-t { fill: var(--card); font-size: 14px; font-weight: 600; }
  .gn-cat-r { fill: var(--accent-soft); stroke: var(--rule-2); }
  .gn-cat-r.none { fill: var(--shade); }
  .gn-cat-t { fill: var(--accent-deep); font-size: 13px; font-weight: 600; }
  .gn-cat-t.none { fill: var(--ink-2); }
  .gn-item-r { fill: var(--card); stroke: var(--rule); }
  .gn-item-t { fill: var(--ink); font-family: var(--sans); font-size: 12.5px; }
  .gn-more-r { fill: none; stroke: var(--rule-2); stroke-dasharray: 4 3; }
  .gn-more-t { fill: var(--ink-3); font-family: var(--mono); font-size: 11.5px; }
  .gn-link { fill: none; stroke: var(--accent); stroke-width: 1.4; opacity: .5; }
  .gn-link2 { fill: none; stroke: var(--rule-2); stroke-width: 1; }
  .gn-hit { cursor: pointer; }
  .gn-hit:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .gn-hit:hover rect { stroke: var(--accent); stroke-width: 1.4; }

  @media (max-width: 720px) {
    .pagehead { flex-wrap: wrap; padding: 14px 16px; gap: 10px 12px; }
    .ph-right { width: 100%; flex-wrap: wrap; justify-content: flex-end; }
    .ph-right .tbtn { flex: none; white-space: nowrap; }
    main { display: block; padding: 22px 14px 56px; }
    .kn-rail { position: static; padding: 0 0 18px; }
    .cat-nav { flex-direction: row; flex-wrap: wrap; }
    .cat-btn { border: 1px solid var(--rule-2); background: var(--card); }
    .rail-meta { margin-top: 10px; padding-top: 10px; }
  }
  /* 触屏：搜索框提到 16px 防 iOS 聚焦缩放；小字按钮放大到能点的尺寸 */
  @media (hover: none) {
    .kw-box { font-size: 16px; }
    .sort-btn { min-height: 38px; }
    .vtab { min-height: 38px; }
    .cat-btn { min-height: 40px; }
    .k-del { min-height: 36px; padding: 6px 12px; }
    .k-toggle { min-height: 36px; padding: 8px 0; }
    .k-more { min-height: 38px; }
  }
  @media print {
    body { background: #fff; }
    .ph-right, .kw-box, .kw-hint, .sort-row, .view-tabs, .rail-meta,
    .k-del, .k-toggle, .k-more { display: none !important; }
    .cat-nav { flex-direction: row; flex-wrap: wrap; }
    .k-content.clamp { display: block; -webkit-line-clamp: unset; }
    main { display: block; max-width: none; padding: 0; }
    .card { box-shadow: none; }
    .graph-wrap { overflow: visible; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
    @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
    .k-entry.flash { animation: none; background: var(--accent-soft); }
  }
</style>
</head>
<body data-demo="${demo}">
<header class="pagehead">
  <div class="ph-title">
    <h1>知识库</h1>
  </div>
  <div class="ph-right">
    <a class="tbtn" href="/today">今日日程</a>
    <a class="tbtn" href="/">返回对话</a>
  </div>
</header>
<main>
  <aside class="kn-rail" aria-label="知识分类">
    <input class="kw-box" id="kwBox" type="search" enterkeyhint="search" placeholder="搜索标题 / 内容…" aria-label="搜索知识">
    <p class="kw-hint">按 / 聚焦 · Esc 清空</p>
    <div class="sort-row" id="sortRow" role="group" aria-label="排序方式">
      <button type="button" class="sort-btn active" data-sort="updated">最近更新</button>
      <button type="button" class="sort-btn" data-sort="title">按标题</button>
    </div>
    <div class="cat-nav" id="catNav"></div>
    <div class="rail-meta" id="knMeta"></div>
  </aside>
  <section class="card" id="listCard" aria-label="知识条目">
    <h2>
      <span class="view-tabs" id="viewRow" role="group" aria-label="视图方式">
        <button type="button" class="vtab active" data-view="list" aria-pressed="true">条目</button>
        <button type="button" class="vtab" data-view="graph" aria-pressed="false">导图</button>
        <button type="button" class="vtab" data-view="timeline" aria-pressed="false">时间线</button>
      </span>
      <span class="cnote" id="listNote"></span>
    </h2>
    <div class="cbody"><p class="skel">…</p></div>
  </section>
</main>
<script>
const CLAMP_LEN = ${CLAMP_LEN};
const BATCH = ${BATCH};
const GRAPH_MAX = ${GRAPH_MAX};
${demo && demoData ? `const DEMO_DATA = ${JSON.stringify(demoData)};` : "const DEMO_DATA = null;"}
const $ = (id) => document.getElementById(id);
let entries = [];
let activeCat = "ALL"; // "ALL" | "NONE"（未分类）| 具体课程名
let keyword = "";
let sortMode = "updated"; // "updated" | "title"
let viewMode = "list"; // "list" | "graph" | "timeline"（经 URL hash 记忆）
let visibleCount = BATCH;
const expandedIds = new Set();

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function fmtDay(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}
/* 相对时间：今天 / 昨天 / N 天前 / M月D日（工具产品的常规日期形态） */
function fmtAgo(ts) {
  if (!ts) return "—";
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(new Date(ts))) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 30) return diff + " 天前";
  return fmtDay(ts);
}
/* 命中高亮：纯 DOM 拼接（不走 innerHTML），把关键词片段包进 <mark> */
function appendMarked(parent, text, kw) {
  if (!kw) { parent.appendChild(document.createTextNode(text)); return; }
  const lower = text.toLowerCase();
  const k = kw.toLowerCase();
  let i = 0;
  let at = lower.indexOf(k);
  while (at >= 0) {
    if (at > i) parent.appendChild(document.createTextNode(text.slice(i, at)));
    parent.appendChild(el("mark", null, text.slice(at, at + k.length)));
    i = at + k.length;
    at = lower.indexOf(k, i);
  }
  parent.appendChild(document.createTextNode(text.slice(i)));
}
/* 正文里的长链接自动识别成可点链接（新标签打开）：先按 URL 切片，
   链接段整段成 <a>、纯文本段再走命中高亮；与大厅知识面板同一套口径。
   URL 字符走 RFC 3986 白名单，紧跟其后的中文天然终止匹配 */
const URL_RE =
  /(https?:\\/\\/[A-Za-z0-9._~:\\/?#\\[\\]@!$&'()*+,;=%-]+|www\\.[A-Za-z0-9._~:\\/?#\\[\\]@!$&'()*+,;=%-]+)/gi;
function appendRich(parent, text, kw) {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?'")\\]]+$/, "");
    const at = m.index;
    const end = at + url.length;
    if (end <= at) continue;
    if (at > last) appendMarked(parent, text.slice(last, at), kw);
    const a = document.createElement("a");
    a.href = /^www\\./i.test(url) ? "https://" + url : url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    appendMarked(a, url, kw);
    parent.appendChild(a);
    last = end;
  }
  if (last < text.length) appendMarked(parent, text.slice(last), kw);
}
/* 两步删除：第一次点变身「确认删除」，3 秒内再点才执行，超时还原 */
function armDelete(btn, onConfirm) {
  if (btn.dataset.armed === "1") { onConfirm(); return; }
  btn.dataset.armed = "1";
  const label = btn.textContent;
  btn.textContent = "确认删除";
  btn.classList.add("armed");
  setTimeout(() => {
    btn.dataset.armed = "";
    btn.textContent = label;
    btn.classList.remove("armed");
  }, 3000);
}

/* ── 导图工具：SVG 节点全走 createElementNS + textContent，不拼 HTML ── */
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
/* 中文按 13px、ASCII 按 7px 估宽，超宽截断加省略号 */
function dispLen(s) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xFF ? 13 : 7;
  return w;
}
function ellipsize(s, maxW) {
  if (dispLen(s) <= maxW) return s;
  let out = "";
  for (const ch of s) {
    if (dispLen(out + ch + "…") > maxW) return out + "…";
    out += ch;
  }
  return out;
}

function catCounts() {
  const m = new Map();
  for (const e of entries) {
    const key = e.category || "";
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
}
function filtered() {
  let list = entries;
  if (activeCat === "NONE") list = list.filter((e) => !e.category);
  else if (activeCat !== "ALL") list = list.filter((e) => e.category === activeCat);
  if (keyword) {
    const kw = keyword.toLowerCase();
    list = list.filter((e) =>
      (e.title + "\\n" + e.content + "\\n" + (e.category || "未分类")).toLowerCase().includes(kw));
  }
  const sorted = [...list];
  if (sortMode === "title") sorted.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  else sorted.sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted;
}

function renderNav() {
  const counts = catCounts();
  const cats = [...counts.entries()].filter(([k]) => k)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
  const nav = $("catNav");
  nav.textContent = "";
  nav.appendChild(catBtn("ALL", "全部", entries.length));
  for (const [name, n] of cats) nav.appendChild(catBtn(name, name, n));
  const none = counts.get("") || 0;
  if (none) nav.appendChild(catBtn("NONE", "未分类", none));
}

function catBtn(key, label, count) {
  const btn = el("button", "cat-btn" + (activeCat === key ? " active" : ""), label);
  btn.type = "button";
  btn.dataset.cat = key;
  btn.appendChild(el("span", "cat-count", String(count)));
  btn.addEventListener("click", () => {
    activeCat = key;
    visibleCount = BATCH;
    renderNav();
    renderView();
    /* 导航重建后焦点归位到同分类（键盘用户不用重新 Tab） */
    for (const b of document.querySelectorAll("#catNav .cat-btn")) {
      if (b.dataset.cat === key) { b.focus(); break; }
    }
  });
  return btn;
}

function renderRailMeta() {
  const meta = $("knMeta");
  meta.textContent = "";
  if (DEMO_DATA) {
    meta.appendChild(el("div", null, "演示数据 · 只读"));
    return;
  }
  meta.appendChild(el("div", null, "每 60 秒自动刷新"));
  const btn = el("button", "tbtn", "刷新");
  btn.type = "button";
  btn.addEventListener("click", load);
  meta.appendChild(btn);
}

function renderSort() {
  for (const btn of $("sortRow").querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.sort === sortMode);
  }
}

function entryEl(item) {
  const card = el("article", "k-entry");
  card.dataset.kid = item.id;
  const head = el("div", "k-head");
  const title = el("h3", "k-title");
  appendMarked(title, item.title, keyword);
  head.appendChild(title);
  const cat = el("span", "k-cat", item.category || "未分类");
  if (item.category) cat.title = item.category;
  head.appendChild(cat);
  head.appendChild(el("span", "k-date", fmtAgo(item.updatedAt)));
  if (!DEMO_DATA) {
    const del = el("button", "k-del", "删除");
    del.type = "button";
    del.addEventListener("click", () => {
      armDelete(del, () => {
        fetch("/api/knowledge/" + item.id, { method: "DELETE" }).then(load).catch(load);
      });
    });
    head.appendChild(del);
  }
  card.appendChild(head);

  const content = el("p", "k-content");
  appendRich(content, item.content, keyword);
  if (item.content.length > CLAMP_LEN) {
    if (!expandedIds.has(item.id)) content.classList.add("clamp");
    card.appendChild(content);
    const toggle = el("button", "k-toggle", expandedIds.has(item.id) ? "收起" : "展开全文");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", expandedIds.has(item.id) ? "true" : "false");
    toggle.addEventListener("click", () => {
      if (expandedIds.has(item.id)) {
        expandedIds.delete(item.id);
        content.classList.add("clamp");
        toggle.textContent = "展开全文";
        toggle.setAttribute("aria-expanded", "false");
      } else {
        expandedIds.add(item.id);
        content.classList.remove("clamp");
        toggle.textContent = "收起";
        toggle.setAttribute("aria-expanded", "true");
      }
    });
    card.appendChild(toggle);
  } else {
    card.appendChild(content);
  }
  return card;
}

function emptyEl(text) {
  return el("p", "empty", text);
}
function moreBtn(list, shown) {
  const more = el("button", "tbtn k-more", "显示更多（还有 " + (list.length - shown.length) + " 条）");
  more.type = "button";
  more.addEventListener("click", () => { visibleCount += BATCH; renderView(); });
  return more;
}

/* ── 视图一：条目列表 ── */
function renderList() {
  const body = $("listCard").querySelector(".cbody");
  const note = $("listNote");
  body.textContent = "";
  if (!entries.length) {
    note.textContent = "";
    body.appendChild(emptyEl("知识库还是空的。在对话页分享你学到的知识点（或说「记住：……」），我会自动记进知识库并按课程归类。"));
    return;
  }
  const list = filtered();
  note.textContent = list.length ? list.length + " 条" : "";
  if (!list.length) {
    body.appendChild(emptyEl("没有匹配的知识条目，换个关键词或分类试试。"));
    return;
  }
  const shown = list.slice(0, visibleCount);
  for (const item of shown) body.appendChild(entryEl(item));
  if (list.length > shown.length) body.appendChild(moreBtn(list, shown));
}

/* ── 视图二：导图（SVG 横向树：我的知识 → 分类 → 条目） ── */
const GX_ROOT = 20, GW_ROOT = 112, GH_ROOT = 42;
const GX_CAT = 208, GW_CAT = 150, GH_CAT = 34;
const GX_ITEM = 428, GW_ITEM = 256, GH_ITEM = 30;
const GROW = 40, GGAP = 30;
function bezier(x1, y1, x2, y2) {
  const mx = (x1 + x2) / 2;
  return "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2;
}
function graphNode(x, y, w, h, rCls, tCls, text, full) {
  const g = svgEl("g", {});
  g.appendChild(svgEl("rect", { x: x, y: y, width: w, height: h, rx: 4, class: rCls }));
  const t = svgEl("text", { x: x + 12, y: y + h / 2, class: tCls });
  t.textContent = text;
  g.appendChild(t);
  const tip = svgEl("title", {});
  tip.textContent = full || text;
  g.appendChild(tip);
  return g;
}
function hitify(g, label, onClick) {
  g.setAttribute("class", "gn-hit");
  g.setAttribute("tabindex", "0");
  g.setAttribute("role", "link");
  g.setAttribute("aria-label", label);
  g.addEventListener("click", onClick);
  g.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onClick(); }
  });
  return g;
}
/* 导图节点点击：回到条目视图、展开并滚动到该条目，脉冲提示落点 */
function focusEntry(id) {
  const list = filtered();
  const at = list.findIndex((e) => e.id === id);
  if (at >= visibleCount) visibleCount = at + 1;
  expandedIds.add(id);
  setView("list");
  const node = document.querySelector('.k-entry[data-kid="' + id + '"]');
  if (node) {
    node.scrollIntoView({ block: "center" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1900);
  }
}
function renderGraph() {
  const body = $("listCard").querySelector(".cbody");
  const note = $("listNote");
  body.textContent = "";
  if (!entries.length) {
    note.textContent = "";
    body.appendChild(emptyEl("知识库还是空的。在对话页分享你学到的知识点（或说「记住：……」），我会自动记进知识库并按课程归类。"));
    return;
  }
  const list = filtered();
  note.textContent = list.length + " 条";
  if (!list.length) {
    body.appendChild(emptyEl("没有匹配的知识条目，换个关键词或分类试试。"));
    return;
  }
  const byCat = new Map();
  for (const e of list) {
    const key = e.category || "";
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(e);
  }
  const groups = [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh"));
  let y = 12;
  const groupY = new Map();
  for (const [name, items] of groups) {
    groupY.set(name, y);
    const shown = items.slice(0, GRAPH_MAX);
    y += (shown.length + (items.length > GRAPH_MAX ? 1 : 0)) * GROW + GGAP;
  }
  const H = y - GGAP + 12;
  const W = GX_ITEM + GW_ITEM + 20;
  const svg = svgEl("svg", {
    viewBox: "0 0 " + W + " " + H, width: W, height: H,
    role: "img", "aria-label": "知识分类导图：" + list.length + " 条",
  });
  const rootY = H / 2 - GH_ROOT / 2;
  /* 连线在节点下层：根→分类（朱砂细线），分类→条目（墨色细线） */
  for (const [name, items] of groups) {
    const gy = groupY.get(name);
    svg.appendChild(svgEl("path", {
      d: bezier(GX_ROOT + GW_ROOT, rootY + GH_ROOT / 2, GX_CAT, gy + GH_CAT / 2),
      class: "gn-link",
    }));
    const shown = items.slice(0, GRAPH_MAX);
    for (let i = 0; i < shown.length; i++) {
      const iy = gy + i * GROW + (GROW - GH_ITEM) / 2 + 2;
      svg.appendChild(svgEl("path", {
        d: bezier(GX_CAT + GW_CAT, gy + GH_CAT / 2, GX_ITEM, iy + GH_ITEM / 2),
        class: "gn-link2",
      }));
    }
    if (items.length > GRAPH_MAX) {
      const iy = gy + shown.length * GROW + (GROW - GH_ITEM) / 2 + 2;
      svg.appendChild(svgEl("path", {
        d: bezier(GX_CAT + GW_CAT, gy + GH_CAT / 2, GX_ITEM, iy + GH_ITEM / 2),
        class: "gn-link2",
      }));
    }
  }
  /* 根节点 */
  svg.appendChild(graphNode(GX_ROOT, rootY, GW_ROOT, GH_ROOT, "gn-root-r", "gn-root-t", "我的知识"));
  /* 分类与条目节点 */
  for (const [name, items] of groups) {
    const gy = groupY.get(name);
    const none = !name;
    const catNode = graphNode(
      GX_CAT, gy, GW_CAT, GH_CAT,
      "gn-cat-r" + (none ? " none" : ""), "gn-cat-t" + (none ? " none" : ""),
      name || "未分类", name || "未分类条目",
    );
    svg.appendChild(catNode);
    const shown = items.slice(0, GRAPH_MAX);
    for (let i = 0; i < shown.length; i++) {
      const item = shown[i];
      const iy = gy + i * GROW + (GROW - GH_ITEM) / 2 + 2;
      const node = graphNode(
        GX_ITEM, iy, GW_ITEM, GH_ITEM, "gn-item-r", "gn-item-t",
        ellipsize(item.title, GW_ITEM - 26), item.title,
      );
      hitify(node, "条目：" + item.title, () => focusEntry(item.id));
      svg.appendChild(node);
    }
    if (items.length > GRAPH_MAX) {
      const iy = gy + shown.length * GROW + (GROW - GH_ITEM) / 2 + 2;
      const rest = items.length - GRAPH_MAX;
      const cat = none ? "NONE" : name;
      const node = graphNode(
        GX_ITEM, iy, GW_ITEM, GH_ITEM, "gn-more-r", "gn-more-t",
        "还有 " + rest + " 条，回列表看全部",
      );
      hitify(node, "还有 " + rest + " 条", () => {
        activeCat = cat;
        visibleCount = BATCH;
        renderNav();
        setView("list");
      });
      svg.appendChild(node);
    }
  }
  const wrap = el("div", "graph-wrap");
  wrap.appendChild(svg);
  body.appendChild(wrap);
}

/* ── 视图三：时间线（按月分组 + 左缘轴点） ── */
function renderTimeline() {
  const body = $("listCard").querySelector(".cbody");
  const note = $("listNote");
  body.textContent = "";
  if (!entries.length) {
    note.textContent = "";
    body.appendChild(emptyEl("知识库还是空的。在对话页分享你学到的知识点（或说「记住：……」），我会自动记进知识库并按课程归类。"));
    return;
  }
  const list = filtered().sort((a, b) => b.updatedAt - a.updatedAt);
  note.textContent = "按更新时间 · " + list.length + " 条";
  if (!list.length) {
    body.appendChild(emptyEl("没有匹配的知识条目，换个关键词或分类试试。"));
    return;
  }
  const shown = list.slice(0, visibleCount);
  const byMonth = [];
  for (const item of shown) {
    const d = new Date(item.updatedAt);
    const key = d.getFullYear() + "-" + (d.getMonth() + 1);
    if (!byMonth.length || byMonth[byMonth.length - 1].key !== key) {
      byMonth.push({ key: key, label: d.getFullYear() + "年" + (d.getMonth() + 1) + "月", items: [] });
    }
    byMonth[byMonth.length - 1].items.push(item);
  }
  for (const m of byMonth) {
    const grp = el("div", "tl-group");
    const head = el("div", "tl-head");
    head.appendChild(el("span", "tl-month", m.label));
    head.appendChild(el("span", "tl-count", m.items.length + " 条"));
    grp.appendChild(head);
    for (const item of m.items) {
      const it = el("div", "tl-item");
      it.appendChild(entryEl(item));
      grp.appendChild(it);
    }
    body.appendChild(grp);
  }
  if (list.length > shown.length) body.appendChild(moreBtn(list, shown));
}

/* ── 视图切换：tab 状态 + URL hash 记忆 ── */
function renderView() {
  if (viewMode === "graph") renderGraph();
  else if (viewMode === "timeline") renderTimeline();
  else renderList();
}
function applyView() {
  for (const btn of $("viewRow").querySelectorAll("button")) {
    const on = btn.dataset.view === viewMode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  renderView();
}
function setView(v) {
  viewMode = v;
  const h = v === "list" ? "" : "#" + v;
  if (location.hash !== h) location.hash = h;
  applyView();
}

function load() {
  if (DEMO_DATA) { entries = DEMO_DATA; renderNav(); renderRailMeta(); renderView(); return; }
  fetch("/api/knowledge", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((d) => { entries = d.entries || []; renderNav(); renderRailMeta(); renderView(); })
    .catch(() => {
      const body = $("listCard").querySelector(".cbody");
      body.textContent = "";
      body.appendChild(emptyEl("知识暂时取不出来，请稍候刷新。"));
    });
}
$("kwBox").addEventListener("input", (ev) => {
  keyword = ev.target.value.trim();
  visibleCount = BATCH;
  renderView();
});
/* 部分浏览器点搜索框原生 × 只发 search 不发 input，兜底同步一次 */
$("kwBox").addEventListener("search", (ev) => {
  keyword = ev.target.value.trim();
  visibleCount = BATCH;
  renderView();
});
$("kwBox").addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && ev.target.value) {
    ev.target.value = "";
    keyword = "";
    visibleCount = BATCH;
    renderView();
  }
});
$("sortRow").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (!btn || !btn.dataset.sort || btn.dataset.sort === sortMode) return;
  sortMode = btn.dataset.sort;
  visibleCount = BATCH;
  renderSort();
  renderView();
});
$("viewRow").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (!btn || !btn.dataset.view || btn.dataset.view === viewMode) return;
  setView(btn.dataset.view);
});
window.addEventListener("hashchange", () => {
  const h = location.hash.replace("#", "");
  const v = h === "graph" || h === "timeline" ? h : "list";
  if (v !== viewMode) { viewMode = v; applyView(); }
});
// / 快捷聚焦搜索（正在输入时忽略）
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "/") return;
  const t = ev.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  ev.preventDefault();
  $("kwBox").focus();
});
const initHash = location.hash.replace("#", "");
if (initHash === "graph" || initHash === "timeline") viewMode = initHash;
load();
if (!DEMO_DATA) {
  setInterval(load, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
}
</script>
</body>
</html>`;
}
