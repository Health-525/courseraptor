/**
 * 「待办」独立页 — GET /todos 的页面本体
 *
 * 从今日日程页（/today）拆出的待办界面：按 逾期 / 今天 / 明天 / 以后
 * 分组的纸质清单，勾选完成（乐观更新）、两步删除防误删、已完成折叠区
 * 可撤销，每条可导出 .ics 到手机日历。数据来自 GET /api/today 的 todos
 * 段（纯本地存储，不登录教务、不调模型），页面每 60 秒与切回标签页时
 * 自行刷新，跨日翻转后逾期分组自然更新。
 *
 * 视觉与 /today 页同一套红头档案令牌（暖纸底 + 墨字 + 单一朱砂红）。
 * 演示模式：demo=true 时内嵌虚构数据（demoData），不发任何请求。
 */

import type { TodayBrief } from "./today-brief";

export function todosPage(options: { demo?: boolean; demoData?: TodayBrief } = {}): string {
  const demo = options.demo === true;
  const demoData = options.demoData;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/logo.png">
<title>待办 · CourseRaptor</title>
<style>
  /* 与 chat-page 同源的设计令牌：红头档案（编辑部排版风） */
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

  /* ── 页头 ── */
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
  .ph-right { display: flex; align-items: center; gap: 14px; }

  /* ── 正文：左栏统计导航 + 右栏清单 ── */
  main { max-width: 980px; margin: 0 auto; padding: 30px 22px 64px;
         display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; }

  .todos-rail { position: sticky; top: 22px; padding: 8px 4px; }
  .rail-kicker { margin: 0 0 6px; color: var(--accent-deep); font-family: var(--mono); font-size: 11px;
                 letter-spacing: .18em; }
  .rail-title { margin: 0; font-family: var(--kai); font-size: 30px; font-weight: 400; line-height: 1.25; }
  .rail-meta { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--rule-2);
               font-family: var(--mono); font-size: 12px; line-height: 1.7; color: var(--ink-3); }
  .rail-meta .stale { color: var(--accent-deep); }
  .rail-meta .tbtn { margin-top: 12px; min-height: 30px; padding: 3px 12px; font-size: 12px; }

  .card { border: 1px solid var(--rule-2); border-top: 2px solid var(--accent);
          background: var(--card); box-shadow: var(--shadow-sm); }
  .card > h2 { display: flex; justify-content: space-between; align-items: baseline;
               margin: 0; padding: 13px 18px 10px; border-bottom: 1px solid var(--rule);
               font-family: var(--mono); font-size: 13px; font-weight: 600;
               letter-spacing: .18em; color: var(--ink-2); }
  .card > h2 .cnote { font-family: var(--mono); font-weight: 400; font-size: 12px;
                      letter-spacing: .03em; color: var(--ink-3); }
  .cbody { padding: 14px 18px 16px; }

  .skel { color: var(--ink-3); font-size: 15px; padding: 8px 2px; }

  /* 待办清单：按 逾期 / 今天 / 明天 / 以后 分组的纸质清单行。
     题注 = 等宽小字 + 计数徽章 + 虚线引到行尾，编辑部目录页的语言 */
  .todo-group { display: flex; align-items: center; gap: 8px; margin: 12px 0 6px;
                font-family: var(--mono); font-size: 11.5px;
                letter-spacing: .12em; color: var(--ink-3); }
  .todo-group:first-child { margin-top: 0; }
  .todo-group::after { content: ""; flex: 1; border-top: 1px dashed var(--rule); }
  .todo-group.overdue { color: var(--accent-deep); }
  .todo-count { display: inline-flex; align-items: center; justify-content: center;
                min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
                background: var(--shade); color: var(--ink-2);
                font-size: 10.5px; letter-spacing: 0; line-height: 1; }
  .todo-group.overdue .todo-count { background: var(--accent-soft); color: var(--accent-deep); }
  /* 已完成折叠开关：题注变身按钮，保持等宽小字外观 */
  .todo-group.toggle { border: 0; background: none; padding: 0; cursor: pointer;
                       text-align: left; font: inherit; font-family: var(--mono);
                       font-size: 11.5px; letter-spacing: .12em; width: 100%; }
  .todo-group.toggle:hover { color: var(--ink-2); }
  .todo-list { display: grid; gap: 6px; }
  /* [hidden] 必须显式赢过上面的 display: grid，否则已完成折叠区收不起来 */
  .todo-list[hidden] { display: none; }
  /* 条目行：圆角纸片，逾期压一条朱砂左线（与课表 .tt-course 同一语言），
     悬停浮起一点阴影；左线用 transparent 占位，保证四组行内文本对齐 */
  .todo-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto auto; gap: 10px;
               align-items: center; padding: 9px 12px; border: 1px solid var(--rule);
               border-left: 3px solid transparent; border-radius: 4px;
               background: var(--paper);
               transition: border-color .15s ease, box-shadow .15s ease; }
  .todo-item:hover, .todo-item:focus-within {
    border-color: var(--rule-2);
    box-shadow: 0 2px 10px rgba(50, 42, 31, .07);
  }
  .todo-item.overdue, .todo-item.overdue:hover,
  .todo-item.overdue:focus-within { border-left-color: var(--accent); }
  /* 勾选框：自绘纸片方框，选中后朱砂底 + 纸色勾，与全站单色朱砂语言统一 */
  .todo-chk { appearance: none; -webkit-appearance: none; position: relative;
              width: 18px; height: 18px; margin: 0;
              border: 1.5px solid var(--rule-2); border-radius: 4px;
              background: var(--card); cursor: pointer;
              transition: border-color .15s ease, background .15s ease; }
  .todo-chk:hover { border-color: var(--accent); }
  .todo-chk:checked { background: var(--accent); border-color: var(--accent); }
  .todo-chk:checked::after { content: ""; position: absolute; left: 5px; top: 1.5px;
                             width: 4px; height: 9px;
                             border: solid var(--paper); border-width: 0 2px 2px 0;
                             transform: rotate(45deg); }
  .todo-chk:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .todo-chk:disabled { cursor: default; }
  .todo-title { font-size: 15px; overflow-wrap: anywhere; }
  /* 截止时间：小胶囊徽标一眼分层；逾期换朱砂软底，已完成文字较长不封胶囊 */
  .todo-due { font-family: var(--mono); font-size: 11.5px; color: var(--ink-2);
              background: var(--shade); padding: 2px 9px; border-radius: 999px;
              white-space: nowrap; }
  .todo-item.overdue .todo-due { background: var(--accent-soft); color: var(--accent-deep);
                                 font-weight: 600; }
  /* 已完成条目：整行退后（灰显 + 标题删除线），与对话页同一语言 */
  .todo-item.finished .todo-title { text-decoration: line-through; color: var(--ink-3); }
  .todo-item.finished .todo-due { background: none; padding: 2px 0; color: var(--ink-3); }
  .todo-ics, .todo-del { background: none; border: none; padding: 2px 4px; color: var(--ink-3);
                         font-family: var(--mono); font-size: 12px; cursor: pointer;
                         text-decoration: none; white-space: nowrap; }
  .todo-ics:hover, .todo-del:hover { color: var(--accent); text-decoration: underline; }
  .todo-del.armed { color: var(--card); background: var(--accent); border-radius: 3px;
                    padding: 2px 8px; text-decoration: none; }
  .todo-empty { margin: 0; padding: 18px 8px; border: 1px dashed var(--rule-2);
                border-radius: 4px; text-align: center;
                color: var(--ink-3); font-size: 14px; }

  /* ── 手机：左栏统计落为横向一排 ── */
  @media (max-width: 720px) {
    .pagehead { flex-wrap: wrap; padding: 14px 16px; gap: 10px 12px; }
    .pagehead .seal { width: 38px; height: 38px; }
    .pagehead .seal img { top: 4px; left: 4px; width: 30px; height: 30px; }
    .ph-title h1 { font-size: 20px; }
    .ph-right { width: 100%; justify-content: space-between; }
    main { display: block; padding: 22px 14px 56px; }
    .todos-rail { position: static; padding: 0 0 18px; }
    .rail-meta { margin-top: 10px; padding-top: 10px; }
    .todo-item { grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 8px; }
    .todo-ics { display: none; }
  }
  @media print {
    body { background: #fff; }
    .ph-right, .todo-ics, .todo-del, .todo-group.toggle { display: none !important; }
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
    <h1>待办</h1>
    <span class="ph-stamp">COURSERAPTOR · TODOS</span>
  </div>
  <div class="ph-right">
    <a class="tbtn" href="/today">今日日程</a>
    <a class="tbtn" href="/">返回对话</a>
  </div>
</header>
<main>
  <aside class="todos-rail" aria-label="待办统计">
    <p class="rail-kicker">TODOS</p>
    <h2 class="rail-title">我的待办</h2>
    <div class="rail-meta" id="todosMeta"></div>
  </aside>
  <section class="card" id="todoCard" aria-label="待办清单">
    <h2>清单<span class="cnote" id="todoNote"></span></h2>
    <div class="cbody"><p class="skel">…</p></div>
  </section>
</main>
<script>
${demo && demoData ? `const DEMO_DATA = ${JSON.stringify(demoData)};` : "const DEMO_DATA = null;"}
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function pad(x) { return (x < 10 ? "0" : "") + x; }
function fmtStamp(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad(d.getHours()) + ":" + pad(d.getMinutes());
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

function todoItem(t) {
  const row = el("div", "todo-item" + (t.overdue ? " overdue" : ""));
  const chk = el("input", "todo-chk");
  chk.type = "checkbox";
  chk.setAttribute("aria-label", "完成待办：" + t.title);
  if (!DEMO_DATA) {
    chk.addEventListener("change", () => {
      fetch("/api/reminders/" + encodeURIComponent(t.id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: true }),
      }).then(() => load()).catch(() => load());
    });
  } else {
    chk.disabled = true;
  }
  row.appendChild(chk);
  const title = el("span", "todo-title", t.title);
  if (t.notes) title.title = t.notes;
  row.appendChild(title);
  row.appendChild(el("span", "todo-due", (t.overdue ? "⚠ " : "") + t.dueLabel));
  if (!DEMO_DATA && t.id) {
    const ics = el("a", "todo-ics", ".ics");
    ics.href = "/api/reminders/" + encodeURIComponent(t.id) + ".ics";
    ics.title = "导出到手机日历";
    ics.setAttribute("aria-label", "导出待办到日历：" + t.title);
    row.appendChild(ics);
  }
  if (!DEMO_DATA) {
    const del = el("button", "todo-del", "删除");
    del.type = "button";
    del.addEventListener("click", () => {
      armDelete(del, () => {
        fetch("/api/reminders/" + encodeURIComponent(t.id), { method: "DELETE" }).then(() => load()).catch(() => load());
      });
    });
    row.appendChild(del);
  }
  return row;
}

/* 已完成条目：取消勾选即恢复为未完成；默认收进「已完成」折叠区，不抢今天的注意力 */
let todoDoneOpen = false;
function todoDoneItem(t) {
  const row = el("div", "todo-item finished");
  const chk = el("input", "todo-chk");
  chk.type = "checkbox"; chk.checked = true;
  chk.title = "取消勾选就恢复为未完成";
  chk.setAttribute("aria-label", "恢复未完成：" + t.title);
  if (!DEMO_DATA) {
    chk.addEventListener("change", () => {
      chk.checked = true;
      chk.disabled = true;
      fetch("/api/reminders/" + encodeURIComponent(t.id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: false }),
      }).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        load();
      }).catch(() => { chk.disabled = false; });
    });
  } else {
    chk.disabled = true;
  }
  row.appendChild(chk);
  row.appendChild(el("span", "todo-title", t.title));
  row.appendChild(el("span", "todo-due",
    (t.doneAt ? "完成于 " + fmtStamp(t.doneAt) + " · " : "") + "原截止 " + t.dueLabel));
  if (!DEMO_DATA) {
    const del = el("button", "todo-del", "删除");
    del.type = "button";
    del.addEventListener("click", () => {
      armDelete(del, () => {
        fetch("/api/reminders/" + encodeURIComponent(t.id), { method: "DELETE" }).then(() => load()).catch(() => load());
      });
    });
    row.appendChild(del);
  }
  return row;
}

/* 待办按 逾期 / 今天 / 明天 / 以后 分组，扫一眼就知道今天要干嘛 */
function renderTodos(b) {
  const body = $("todoCard").querySelector(".cbody");
  const note = $("todoNote");
  body.textContent = "";
  const todos = b.todos || {};
  const items = todos.items || [];
  const doneList = todos.done || [];
  note.textContent = items.length ? items.length + " 项未完成" : "";
  if (!items.length) {
    body.appendChild(el("p", "todo-empty", "没有未完成的待办。在对话页对我说「我这周要……」即可记录。"));
  }
  const groups = [["逾期", true, []], ["今天", false, []], ["明天", false, []], ["以后", false, []]];
  for (const t of items) {
    if (t.overdue) groups[0][2].push(t);
    else if (t.isToday) groups[1][2].push(t);
    else if (t.dueLabel.indexOf("明天") === 0) groups[2][2].push(t);
    else groups[3][2].push(t);
  }
  for (const item of groups) {
    if (!item[2].length) continue;
    /* 题注 = 组名 + 计数徽章，虚线由 CSS ::after 引到行尾 */
    const head = el("p", item[1] ? "todo-group overdue" : "todo-group");
    head.appendChild(document.createTextNode(item[0]));
    head.appendChild(el("span", "todo-count", String(item[2].length)));
    body.appendChild(head);
    const list = el("div", "todo-list");
    for (const t of item[2]) list.appendChild(todoItem(t));
    body.appendChild(list);
  }
  if (!doneList.length) return;
  /* 已完成折叠区：点题注就地展开/收起，不重新取数 */
  const head = el("button", "todo-group toggle");
  head.type = "button";
  head.dataset.doneToggle = "1";
  head.setAttribute("aria-expanded", todoDoneOpen ? "true" : "false");
  head.textContent = "已完成 · " + doneList.length + (todoDoneOpen ? " ▾" : " ▸");
  const list = el("div", "todo-list");
  list.hidden = !todoDoneOpen;
  for (const t of doneList) list.appendChild(todoDoneItem(t));
  head.addEventListener("click", () => {
    todoDoneOpen = !todoDoneOpen;
    list.hidden = !todoDoneOpen;
    head.textContent = "已完成 · " + list.querySelectorAll(".todo-item").length
      + (todoDoneOpen ? " ▾" : " ▸");
    head.setAttribute("aria-expanded", todoDoneOpen ? "true" : "false");
  });
  body.appendChild(head);
  body.appendChild(list);
}

/* 左栏统计：未完成 / 逾期 / 最近完成，逾期朱砂提级 */
function renderSrc(b) {
  const n = $("todosMeta");
  n.textContent = "";
  const todos = b.todos || {};
  const items = todos.items || [];
  const overdue = items.filter((t) => t.overdue).length;
  n.appendChild(el("div", null, "今天 " + b.dateLabel));
  n.appendChild(el("div", null, items.length + " 项未完成"));
  if (overdue) n.appendChild(el("div", "stale", "⚠ " + overdue + " 项已逾期"));
  if (todos.done && todos.done.length) {
    n.appendChild(el("div", null, "最近完成 " + todos.done.length + " 项"));
  }
  if (!DEMO_DATA) {
    const btn = el("button", "tbtn", "刷新");
    btn.type = "button";
    btn.addEventListener("click", load);
    n.appendChild(btn);
  }
}

function render(b) {
  renderTodos(b);
  renderSrc(b);
}

function load() {
  if (DEMO_DATA) { render(DEMO_DATA); return; }
  fetch("/api/today", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(render)
    .catch(() => {
      const body = $("todoCard").querySelector(".cbody");
      body.textContent = "";
      body.appendChild(el("p", "todo-empty", "待办暂时取不出来，请稍候刷新。"));
    });
}
load();
if (!DEMO_DATA) {
  setInterval(load, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
}
</script>
</body>
</html>`;
}
