/**
 * 「今日日程」独立页 — GET /today 的页面本体
 *
 * 与对话页分离的日程界面，编辑部头版结构：今日头条（正在上 / 下一节课
 * 倒计时 + 今天课程速览）在前，临近考试其次。周课表、待办与知识已各自
 * 拆出独立界面（/schedule、/todos、/knowledge），由左栏导航直达。
 * 数据来自 GET /api/today（纯本地缓存，不登录教务、不调模型），页面
 * 每 60 秒与切回标签页时自行刷新，以便教学周跨日时自然更新。
 *
 * 视觉与对话页同一套红头档案令牌（暖纸底 + 墨字 + 单一朱砂红）。
 * 演示模式：demo=true 时内嵌虚构数据（demoData），不发任何请求。
 */

import type { TodayBrief } from "./today-brief";

export function todayPage(options: { demo?: boolean; demoData?: TodayBrief } = {}): string {
  const demo = options.demo === true;
  const demoData = options.demoData;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/logo.png">
<title>今日日程 · CourseRaptor</title>
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
  .ph-clock { text-align: right; }
  .ph-date { font-family: var(--mono); font-size: 13px; color: var(--ink-2);
             letter-spacing: .04em; }
  .ph-week { font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
  .ph-week .warn { color: var(--accent-deep); }

  /* ── 正文：左栏日程信息 + 右栏内容 ── */
  main { max-width: 1240px; margin: 0 auto; padding: 30px 22px 64px;
         display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 24px;
         align-items: start; }
  .col { display: grid; gap: 26px; min-width: 0; align-content: start; }

  .schedule-rail { position: sticky; top: 22px; padding: 8px 4px; }
  .rail-kicker { margin: 0 0 6px; color: var(--accent-deep); font-family: var(--mono); font-size: 11px;
                 letter-spacing: .18em; }
  .rail-title { margin: 0; font-family: var(--kai); font-size: 30px; font-weight: 400; line-height: 1.25; }
  .rail-meta { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--rule-2);
               font-family: var(--mono); font-size: 12px; line-height: 1.7; color: var(--ink-3); }
  .rail-meta .stale { color: var(--accent-deep); }
  .rail-meta .tbtn { margin-top: 12px; min-height: 30px; padding: 3px 12px; font-size: 12px; }
  /* 独立界面直达：课表 / 待办 / 知识库各占一行，→ 提示是另一个界面 */
  .rail-nav { display: grid; gap: 6px; margin-top: 14px; }
  .rail-nav .tbtn { justify-content: center; min-height: 32px; padding: 3px 6px; font-size: 12px; }

  .card { border: 1px solid var(--rule-2); border-top: 2px solid var(--accent);
          background: var(--card); box-shadow: var(--shadow-sm); }
  .card > h2 { display: flex; justify-content: space-between; align-items: baseline;
               margin: 0; padding: 13px 18px 10px; border-bottom: 1px solid var(--rule);
               font-family: var(--mono); font-size: 13px; font-weight: 600;
               letter-spacing: .18em; color: var(--ink-2); }
  .card > h2 .cnote { font-family: var(--mono); font-weight: 400; font-size: 12px;
                      letter-spacing: .03em; color: var(--ink-3); }
  .cbody { padding: 14px 18px 16px; }

  .daynote { margin: 0; font-size: 15px; color: var(--ink-2); }
  .empty { margin: 0; padding: 18px 8px; border: 1px dashed var(--rule-2); text-align: center;
           color: var(--ink-3); font-size: 14px; }
  .skel { color: var(--ink-3); font-size: 15px; padding: 8px 2px; }

  /* ── 今日头条：头版式朱砂竖线 + 楷体大标题 ── */
  .lead { border: 1px solid var(--rule-2); border-left: 3px solid var(--accent);
          background: var(--card); box-shadow: var(--shadow-sm); padding: 16px 20px 18px; }
  .lead-kicker { margin: 0 0 8px; color: var(--accent-deep); font-family: var(--mono);
                 font-size: 11px; letter-spacing: .18em; }
  .lead-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .lead-tag { flex: none; padding: 2px 8px; background: var(--accent); color: var(--card);
              font-family: var(--mono); font-size: 11px; letter-spacing: .08em; }
  .lead-tag.next { background: var(--accent-soft); color: var(--accent-deep); }
  .lead-title { margin: 0; font-family: var(--kai); font-size: 24px; font-weight: 600;
                line-height: 1.3; min-width: 0; overflow-wrap: anywhere; }
  .lead-meta { margin: 6px 0 0; font-family: var(--mono); font-size: 12.5px;
               color: var(--ink-2); overflow-wrap: anywhere; }
  .lead-count { margin: 4px 0 0; font-family: var(--kai); font-size: 19px;
                font-weight: 600; letter-spacing: .06em;
                color: var(--accent-deep); }
  .lead-note { margin: 8px 0 0; font-size: 14px; color: var(--ink-2); }
  .today-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px;
                 padding-top: 12px; border-top: 1px dashed var(--rule); }
  .tchip { display: inline-flex; align-items: baseline; gap: 6px; padding: 4px 9px;
           border: 1px solid var(--rule); background: var(--paper);
           font-size: 13px; line-height: 1.5; }
  .tchip-time, .tchip-loc { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
  .tchip.done { opacity: .55; }
  .tchip.current { border-color: var(--accent); background: var(--accent-soft); }
  .tchip.current .tchip-name { color: var(--accent-deep); }

  /* 考试卡：倒计时徽标 + 科目行 */
  .exam-item { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px;
               align-items: baseline; padding: 9px 12px; border: 1px solid var(--rule);
               background: var(--paper); }
  .exam-dday { font-family: var(--mono); font-size: 11px; padding: 2px 7px;
               background: var(--shade); color: var(--ink-2); white-space: nowrap; }
  .exam-dday.soon { background: var(--accent-soft); color: var(--accent-deep); }
  .exam-subject { font-family: var(--kai); font-size: 15px; font-weight: 600;
                  overflow-wrap: anywhere; }
  .exam-meta { margin-top: 2px; font-family: var(--mono); font-size: 11.5px;
               color: var(--ink-3); overflow-wrap: anywhere; }
  .exam-list { display: grid; gap: 8px; }

  /* ── 手机：左栏信息落为页首一截 ── */
  @media (max-width: 720px) {
    .pagehead { flex-wrap: wrap; padding: 14px 16px; gap: 10px 12px; }
    .pagehead .seal { width: 38px; height: 38px; }
    .pagehead .seal img { top: 4px; left: 4px; width: 30px; height: 30px; }
    .ph-title h1 { font-size: 20px; }
    .ph-right { width: 100%; justify-content: space-between; }
    main { display: block; padding: 22px 14px 56px; }
    .schedule-rail { position: static; padding: 0 0 18px; }
    .rail-meta { margin-top: 10px; padding-top: 10px; }
    .rail-nav { display: flex; flex-wrap: wrap; }
    .col { gap: 20px; }
    .lead { padding: 14px 16px 15px; }
    .lead-title { font-size: 20px; }
  }

  /* ── 打印：隐去导航与操作，只留头条与考试 ── */
  @media print {
    body { background: #fff; }
    .ph-right, .schedule-rail, .tbtn { display: none !important; }
    main { display: block; max-width: none; padding: 0; }
    .col { display: block; }
    .card, .lead { box-shadow: none; break-inside: avoid; }
    .card { margin-bottom: 16px; }
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
    <h1>今日日程</h1>
    <span class="ph-stamp">COURSERAPTOR · TODAY</span>
  </div>
  <div class="ph-right">
    <div class="ph-clock">
      <div class="ph-date" id="phDate"></div>
      <div class="ph-week" id="phWeek"></div>
    </div>
    <a class="tbtn" href="/">返回对话</a>
  </div>
</header>
<main>
  <aside class="schedule-rail" aria-label="日程信息">
    <p class="rail-kicker">TODAY</p>
    <h2 class="rail-title" id="railWeek">本周</h2>
    <nav class="rail-nav" aria-label="其他界面">
      <a class="tbtn" href="/schedule">周课表 →</a>
      <a class="tbtn" href="/todos">待办 →</a>
      <a class="tbtn" href="/knowledge">知识库 →</a>
    </nav>
    <div class="rail-meta" id="scheduleMeta"></div>
  </aside>
  <div class="col">
    <section class="lead" id="leadCard" aria-label="今日头条">
      <p class="lead-kicker">TODAY</p>
      <p class="skel">…</p>
    </section>
    <section class="card" id="examCard" aria-label="临近考试">
      <h2>考试<span class="cnote" id="examNote"></span></h2>
      <div class="cbody"><p class="skel">…</p></div>
    </section>
  </div>
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
function fmtStamp(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
}
function fmtCountdown(min) {
  if (min <= 0) return "即将开始";
  if (min < 60) return "还有 " + min + " 分钟开讲";
  const h = Math.floor(min / 60);
  if (h < 24) return "还有 " + h + " 小时" + (min % 60 ? " " + (min % 60) + " 分" : "") + "开讲";
  return Math.floor(h / 24) + " 天后开讲";
}

/* 今日头条：正在上 / 下一节课（倒计时）/ 已收工 / 无课，附今天课程速览条 */
function renderLead(b) {
  const root = $("leadCard");
  root.textContent = "";
  const courses = (b.schedule && b.schedule.courses) || [];
  const current = courses.filter((c) => c.status === "current");
  let tag, tagNext, titleText, metaText = "", countText = "";

  if (!b.schedule.available) {
    tag = "待建档"; tagNext = true;
    titleText = "还没有课表数据";
    metaText = "在对话页问一次课表（如「这学期课表看一下」），我把它缓存到本机后，这个页面就有数据了。";
  } else if (current.length) {
    const c = current[0];
    tag = "正在上课"; tagNext = false;
    titleText = c.title;
    metaText = [c.periods, c.time, c.location, c.teacher].filter(Boolean).join(" · ")
      + (c.time ? "，" + c.time.split("-")[1] + " 下课" : "");
  } else if (b.next) {
    const n = b.next;
    tag = "下一节课"; tagNext = true;
    titleText = n.course.title;
    metaText = [n.dateLabel + (n.makeup ? "（调休补课）" : ""), n.course.periods, n.course.time, n.course.location]
      .filter(Boolean).join(" · ");
    countText = fmtCountdown(n.startsInMin);
  } else if (courses.length) {
    tag = "已结束"; tagNext = true;
    titleText = "今天的课都上完了";
    metaText = "今天共 " + courses.length + " 门课，均已下课。";
  } else {
    tag = "今日无课"; tagNext = true;
    titleText = b.schedule.note || "近期没有排课";
  }

  root.appendChild(el("p", "lead-kicker", "TODAY · " + b.dateLabel));
  const head = el("div", "lead-head");
  head.appendChild(el("span", tagNext ? "lead-tag next" : "lead-tag", tag));
  head.appendChild(el("h2", "lead-title", titleText));
  root.appendChild(head);
  if (metaText) root.appendChild(el("p", "lead-meta", metaText));
  if (countText) root.appendChild(el("p", "lead-count", countText));
  if (b.schedule.note && (current.length || b.next)) {
    root.appendChild(el("p", "lead-note", b.schedule.note));
  }
  if (courses.length) {
    const strip = el("div", "today-strip");
    for (const c of courses) {
      const chip = el("span", "tchip " + c.status);
      chip.title = [c.title, c.periods, c.time, c.location, c.teacher].filter(Boolean).join(" · ");
      chip.appendChild(el("span", "tchip-time", c.time ? c.time.split("-")[0] : c.periods));
      chip.appendChild(el("span", "tchip-name", c.title));
      if (c.location) chip.appendChild(el("span", "tchip-loc", c.location));
      strip.appendChild(chip);
    }
    root.appendChild(strip);
  }
}

/* 临近考试：14 天窗口内的场次，倒计时徽标 + 科目 + 时间地点座位 */
function renderExams(b) {
  const body = $("examCard").querySelector(".cbody");
  const note = $("examNote");
  body.textContent = "";
  const ex = b.exams || { available: false, upcoming: [], note: "" };
  const list = ex.upcoming || [];
  note.textContent = list.length ? list.length + " 场 · 14 天内" : "";
  if (!ex.available || !list.length) {
    body.appendChild(el("p", "empty", ex.note || "14 天内没有考试安排。"));
    return;
  }
  const wrap = el("div", "exam-list");
  for (const e of list) {
    const row = el("div", "exam-item");
    row.appendChild(el("span", e.inDays <= 1 ? "exam-dday soon" : "exam-dday",
      e.inDays === 0 ? "今天" : e.inDays === 1 ? "明天" : e.inDays + " 天后"));
    const mid = el("div");
    mid.appendChild(el("div", "exam-subject", e.subject));
    mid.appendChild(el("div", "exam-meta",
      [e.date, e.time, e.location, e.seatNumber ? "座位 " + e.seatNumber : ""].filter(Boolean).join(" · ")));
    row.appendChild(mid);
    wrap.appendChild(row);
  }
  body.appendChild(wrap);
}

function renderSrc(b) {
  const n = $("scheduleMeta");
  n.textContent = "";
  if (!b.schedule.available) {
    n.appendChild(el("div", null, "尚无本地课表缓存"));
    n.appendChild(el("div", null, "请在对话页查询一次本周课表。"));
  } else {
    const s = el("div", b.schedule.stale ? "stale" : null,
      "课表更新于 " + fmtStamp(b.schedule.cachedAt) + (b.schedule.stale ? "（较旧）" : ""));
    n.appendChild(s);
  }
  if (b.exams && b.exams.available && b.exams.cachedAt) {
    n.appendChild(el("div", null, "考试更新于 " + fmtStamp(b.exams.cachedAt)));
  }
  if (b.term.weekNote) {
    n.appendChild(el("div", "stale", "⚠ " + b.term.weekNote));
  }
  if (!DEMO_DATA) {
    const btn = el("button", "tbtn", "刷新");
    btn.type = "button";
    btn.addEventListener("click", load);
    n.appendChild(btn);
  }
}

function render(b) {
  $("phDate").textContent = b.dateLabel;
  $("railWeek").textContent = b.term.weekLabel || "本周";
  const week = $("phWeek");
  week.textContent = "";
  week.appendChild(document.createTextNode(b.term.label ? b.term.label + " · " + b.term.weekLabel : b.term.weekLabel));
  if (b.term.weekSource === "estimated") {
    week.appendChild(el("span", "warn", "（周次为估算）"));
  }
  renderLead(b);
  renderExams(b);
  renderSrc(b);
  document.title = "今日日程 · " + b.dateLabel;
}

function load() {
  if (DEMO_DATA) { render(DEMO_DATA); return; }
  fetch("/api/today", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(render)
    .catch(() => {
      const lead = $("leadCard");
      lead.textContent = "";
      lead.appendChild(el("p", "lead-kicker", "TODAY"));
      lead.appendChild(el("p", "daynote", "日程暂时取不出来，请稍候刷新。"));
      const body = $("examCard").querySelector(".cbody");
      body.textContent = "";
      body.appendChild(el("p", "daynote", "暂时取不出来，请稍候刷新。"));
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
