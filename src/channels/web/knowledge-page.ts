/**
 * 「知识库」独立页 — GET /knowledge 的页面本体
 *
 * 展示对话中沉淀的全部知识条目：按课程分类导航（对不上课程的落
 * 「未分类」）、关键词搜索（命中高亮 + 按 / 快捷聚焦）、排序切换
 * （最近更新 / 按标题）、长内容折叠展开、两步删除防误删、分批渲染。
 * 数据来自 GET /api/knowledge（纯本地存储，不登录教务、不调模型），
 * 页面每 60 秒与切回标签页时自行刷新。
 *
 * 视觉与课表页 /today 同一套红头档案令牌（暖纸底 + 墨字 + 单一朱砂红）。
 * 演示模式：demo=true 时内嵌虚构数据（demoData），不发任何请求。
 */

import type { KnowledgeEntry } from "../../core/knowledge";

/** 正文超过该长度视为长文，默认折叠、展开收起由用户决定 */
const CLAMP_LEN = 160;
/** 首屏渲染条数，超出部分「显示更多」分批追加 */
const BATCH = 50;

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
    --serif: Georgia, "Times New Roman", "Songti SC", SimSun, serif;
    --kai: "KaiTi", "STKaiti", "Kaiti SC", var(--serif);
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

  /* ── 页头（与课表页同款式） ── */
  .pagehead { display: flex; align-items: center; gap: 16px;
              padding: 18px 28px; border-bottom: 1px solid var(--rule);
              background: var(--paper-deep); }
  .pagehead .seal { flex: none; position: relative; width: 44px; height: 44px;
                    transform: rotate(-7deg); }
  .pagehead .seal::before { content: ""; position: absolute; inset: 0;
                            border: 2px solid var(--accent); border-radius: 50%; opacity: .9; }
  .pagehead .seal img { position: absolute; top: 5px; left: 5px; width: 34px; height: 34px;
                        border-radius: 50%; object-fit: cover; }
  .ph-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 14px; }
  .ph-title h1 { margin: 0; font-family: var(--kai); font-weight: 400;
                 font-size: 24px; letter-spacing: 2px; }
  .ph-title .ph-stamp { font-family: var(--mono); font-size: 12px; color: var(--ink-3);
                        letter-spacing: .1em; }
  .ph-right { display: flex; align-items: center; gap: 10px; }


  /* ── 正文：左栏分类导航 + 右栏条目列表 ── */
  main { max-width: 1240px; margin: 0 auto; padding: 30px 22px 64px;
         display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; }

  .kn-rail { position: sticky; top: 22px; padding: 8px 4px; }
  .rail-kicker { margin: 0 0 6px; color: var(--accent-deep); font-family: var(--mono); font-size: 11px;
                 letter-spacing: .18em; }
  .rail-title { margin: 0; font-family: var(--kai); font-size: 30px; font-weight: 400; line-height: 1.25; }
  .kw-box { width: 100%; margin-top: 16px; padding: 7px 10px; border: 1px solid var(--rule-2);
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
  .card > h2 { display: flex; justify-content: space-between; align-items: baseline;
               margin: 0; padding: 13px 18px 10px; border-bottom: 1px solid var(--rule);
               font-family: var(--mono); font-size: 13px; font-weight: 600;
               letter-spacing: .18em; color: var(--ink-2); }
  .card > h2 .cnote { font-family: var(--mono); font-weight: 400; font-size: 12px;
                      letter-spacing: .03em; color: var(--ink-3); }
  .cbody { padding: 14px 18px 16px; display: grid; gap: 10px; align-content: start; }

  .skel { color: var(--ink-3); font-size: 15px; padding: 8px 2px; }
  .empty { margin: 0; padding: 24px 8px; border: 1px dashed var(--rule-2); text-align: center;
           color: var(--ink-3); font-size: 14px; }

  /* 知识条目：标题行 + 正文，纸质卡片；长文默认折叠可展开。
     悬停微浮起：提示这张纸可以读（长文可展开），也给长列表一点反馈手感 */
  .k-entry { padding: 12px 14px; border: 1px solid var(--rule); background: var(--paper);
             display: grid; gap: 0;
             transition: border-color .15s ease, box-shadow .15s ease; }
  .k-entry:hover { border-color: var(--rule-2); box-shadow: 0 2px 10px rgba(50, 42, 31, .07); }
  .k-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .k-title { margin: 0; font-family: var(--kai); font-size: 17px; font-weight: 600;
             overflow-wrap: anywhere; }
  .k-cat { flex: none; padding: 1px 6px; background: var(--accent-soft); color: var(--accent-deep);
           font-family: var(--mono); font-size: 10.5px; letter-spacing: .04em; white-space: nowrap; }
  .k-cat.none { background: var(--shade); color: var(--ink-3); }
  .k-date { margin-left: auto; flex: none; font-family: var(--mono); font-size: 11px;
            color: var(--ink-3); white-space: nowrap; }
  .k-del { background: none; border: none; padding: 2px 4px; color: var(--ink-3); flex: none;
           font-family: var(--mono); font-size: 12px; cursor: pointer; }
  .k-del:hover { color: var(--accent); text-decoration: underline; }
  .k-del.armed { color: var(--card); background: var(--accent); border-radius: 3px;
                 padding: 2px 8px; }
  .k-content { margin: 6px 0 0; font-size: 14px; line-height: 1.7; color: var(--ink-2);
               white-space: pre-wrap; overflow-wrap: anywhere; }
  .k-content.clamp { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
                     overflow: hidden; }
  .k-toggle { justify-self: start; background: none; border: none; padding: 3px 0;
              color: var(--accent-deep); font-family: var(--mono); font-size: 12px;
              cursor: pointer; }
  .k-toggle:hover { text-decoration: underline; }
  mark { background: var(--accent-soft); color: var(--accent-deep); padding: 0 1px; }
  .k-more { justify-self: center; min-height: 32px; padding: 4px 16px; font-size: 12.5px; }

  @media (max-width: 720px) {
    .pagehead { flex-wrap: wrap; padding: 14px 16px; gap: 10px 12px; }
    .pagehead .seal { width: 38px; height: 38px; }
    .pagehead .seal img { top: 4px; left: 4px; width: 30px; height: 30px; }
    .ph-title h1 { font-size: 20px; }
    .ph-right { width: 100%; justify-content: space-between; }
    main { display: block; padding: 22px 14px 56px; }
    .kn-rail { position: static; padding: 0 0 18px; }
    .cat-nav { flex-direction: row; flex-wrap: wrap; }
    .cat-btn { border: 1px solid var(--rule-2); background: var(--card); }
    .rail-meta { margin-top: 10px; padding-top: 10px; }
  }
  @media print {
    body { background: #fff; }
    .ph-right, .kw-box, .kw-hint, .sort-row, .rail-meta,
    .k-del, .k-toggle, .k-more { display: none !important; }
    .cat-nav { flex-direction: row; flex-wrap: wrap; }
    .k-content.clamp { display: block; -webkit-line-clamp: unset; }
    main { display: block; max-width: none; padding: 0; }
    .card { box-shadow: none; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
    @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
</style>
</head>
<body data-demo="${demo}">
<header class="pagehead">
  <span class="seal" aria-hidden="true"><img src="/logo.png" alt="" width="34" height="34"></span>
  <div class="ph-title">
    <h1>知识库</h1>
    <span class="ph-stamp">COURSERAPTOR · KNOWLEDGE BASE</span>
  </div>
  <div class="ph-right">
    <a class="tbtn" href="/today">今日日程</a>
    <a class="tbtn" href="/">返回对话</a>
  </div>
</header>
<main>
  <aside class="kn-rail" aria-label="知识分类">
    <p class="rail-kicker">KNOWLEDGE BASE</p>
    <h2 class="rail-title">我的知识</h2>
    <input class="kw-box" id="kwBox" type="search" placeholder="搜索标题 / 内容…" aria-label="搜索知识">
    <p class="kw-hint">按 / 聚焦 · Esc 清空</p>
    <div class="sort-row" id="sortRow" role="group" aria-label="排序方式">
      <button type="button" class="sort-btn active" data-sort="updated">最近更新</button>
      <button type="button" class="sort-btn" data-sort="title">按标题</button>
    </div>
    <div class="cat-nav" id="catNav"></div>
    <div class="rail-meta" id="knMeta"></div>
  </aside>
  <section class="card" id="listCard" aria-label="知识条目">
    <h2>条目<span class="cnote" id="listNote"></span></h2>
    <div class="cbody"><p class="skel">…</p></div>
  </section>
</main>
<script>
const CLAMP_LEN = ${CLAMP_LEN};
const BATCH = ${BATCH};
${demo && demoData ? `const DEMO_DATA = ${JSON.stringify(demoData)};` : "const DEMO_DATA = null;"}
const $ = (id) => document.getElementById(id);
let entries = [];
let activeCat = "ALL"; // "ALL" | "NONE"（未分类）| 具体课程名
let keyword = "";
let sortMode = "updated"; // "updated" | "title"
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
  const counts = new Map();
  for (const e of entries) {
    const key = e.category || "";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const cats = [...counts.entries()].filter(([k]) => k)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
  const nav = $("catNav");
  nav.textContent = "";
  nav.appendChild(catBtn("ALL", "全部", entries.length));
  for (const [name, n] of cats) nav.appendChild(catBtn(name, name, n));
  const none = counts.get("") || 0;
  if (none) nav.appendChild(catBtn("NONE", "未分类", none));

  const meta = $("knMeta");
  meta.textContent = "";
  meta.appendChild(el("div", null, "共 " + entries.length + " 条知识"));
  meta.appendChild(el("div", null, cats.length + " 门课程分类"));
  if (!DEMO_DATA) {
    const btn = el("button", "tbtn", "刷新");
    btn.type = "button";
    btn.addEventListener("click", load);
    meta.appendChild(btn);
  }
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
    renderList();
    /* 导航重建后焦点归位到同分类（键盘用户不用重新 Tab） */
    for (const b of document.querySelectorAll("#catNav .cat-btn")) {
      if (b.dataset.cat === key) { b.focus(); break; }
    }
  });
  return btn;
}

function renderSort() {
  for (const btn of $("sortRow").querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.sort === sortMode);
  }
}

function entryEl(item) {
  const card = el("article", "k-entry");
  const head = el("div", "k-head");
  const title = el("h3", "k-title");
  appendMarked(title, item.title, keyword);
  head.appendChild(title);
  head.appendChild(el("span", "k-cat" + (item.category ? "" : " none"), item.category || "未分类"));
  head.appendChild(el("span", "k-date", fmtDay(item.updatedAt)));
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
  appendMarked(content, item.content, keyword);
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

function renderList() {
  const body = $("listCard").querySelector(".cbody");
  const note = $("listNote");
  body.textContent = "";
  if (!entries.length) {
    note.textContent = "";
    body.appendChild(el("p", "empty", "知识库还是空的。在对话页分享你学到的知识点（或说「记住：……」），我会自动记进知识库并按课程归类。"));
    return;
  }
  const list = filtered();
  note.textContent = list.length ? list.length + " 条" : "";
  if (!list.length) {
    body.appendChild(el("p", "empty", "没有匹配的知识条目，换个关键词或分类试试。"));
    return;
  }
  const shown = list.slice(0, visibleCount);
  for (const item of shown) body.appendChild(entryEl(item));
  if (list.length > shown.length) {
    const more = el("button", "tbtn k-more", "显示更多（还有 " + (list.length - shown.length) + " 条）");
    more.type = "button";
    more.addEventListener("click", () => { visibleCount += BATCH; renderList(); });
    body.appendChild(more);
  }
}

function load() {
  if (DEMO_DATA) { entries = DEMO_DATA; renderNav(); renderList(); return; }
  fetch("/api/knowledge", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((d) => { entries = d.entries || []; renderNav(); renderList(); })
    .catch(() => {
      const body = $("listCard").querySelector(".cbody");
      body.textContent = "";
      body.appendChild(el("p", "empty", "知识暂时取不出来，请稍候刷新。"));
    });
}
$("kwBox").addEventListener("input", (ev) => {
  keyword = ev.target.value.trim();
  visibleCount = BATCH;
  renderList();
});
/* 部分浏览器点搜索框原生 × 只发 search 不发 input，兜底同步一次 */
$("kwBox").addEventListener("search", (ev) => {
  keyword = ev.target.value.trim();
  visibleCount = BATCH;
  renderList();
});
$("kwBox").addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && ev.target.value) {
    ev.target.value = "";
    keyword = "";
    visibleCount = BATCH;
    renderList();
  }
});
$("sortRow").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button");
  if (!btn || !btn.dataset.sort || btn.dataset.sort === sortMode) return;
  sortMode = btn.dataset.sort;
  visibleCount = BATCH;
  renderSort();
  renderList();
});
// / 快捷聚焦搜索（正在输入时忽略）
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "/") return;
  const t = ev.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  ev.preventDefault();
  $("kwBox").focus();
});
load();
if (!DEMO_DATA) {
  setInterval(load, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
}
</script>
</body>
</html>`;
}
