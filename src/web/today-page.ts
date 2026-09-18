/**
 * 「今日日程」独立页 — GET /today 的页面本体
 *
 * 与对话页分离的日程界面，编辑部头版结构：今日头条（正在上 / 下一节课
 * 倒计时 + 今天课程速览）在前，本周课表网格其次，再往下是临近考试、
 * 待办分组与知识速览。数据来自 GET /api/today（纯本地缓存，不登录教务、
 * 不调模型），页面每 60 秒与切回标签页时自行刷新，以便教学周跨日时自然
 * 更新；所选教学周写入 URL（?week=N），刷新与分享不丢。
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
         -webkit-font-smoothing: antialiased; }
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

  .demo-banner { padding: 10px 28px; border-bottom: 1px solid var(--rule);
                 background: var(--accent-soft); color: var(--accent-deep); font-size: 14px; }
  .demo-banner span { color: var(--ink-2); }

  /* ── 正文：左栏周导航 + 右栏内容 ── */
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
  .week-nav { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 14px; }
  .week-nav .tbtn { justify-content: center; min-height: 32px; padding: 3px 6px; font-size: 12px; }
  .week-nav .tbtn:disabled { cursor: default; opacity: .42; }
  .week-nav .tbtn:disabled:hover { border-color: var(--rule-2); color: var(--ink-2); background: none; }
  .week-sel { grid-column: 1 / -1; min-height: 32px; padding: 3px 8px;
              border: 1px solid var(--rule-2); border-radius: 4px; background: var(--card);
              color: var(--ink); font-size: 12.5px; font-family: inherit; cursor: pointer; }
  .week-sel:focus-visible { border-color: var(--accent); }
  .week-sel:disabled { cursor: default; opacity: .42; }
  .week-nav #currentWeek { grid-column: 1 / -1; }

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
  .lead-count { margin: 4px 0 0; font-family: var(--kai); font-size: 15px;
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

  /* 本周课表：节次 × 星期的周网格。课格只留课名 + 地点，详情进 title 提示；
     正在进行的节次行与课格用朱砂标记「现在」 */
  .weekwrap { overflow-x: auto; scrollbar-width: thin; padding-bottom: 2px; }
  .week-timetable { --period-count: 10; display: grid;
                    grid-template-columns: 84px repeat(7, minmax(118px, 1fr));
                    grid-template-rows: 46px repeat(var(--period-count), minmax(54px, auto));
                    gap: 1px; min-width: 920px; border: 1px solid var(--rule-2);
                    background: var(--rule); position: relative; }
  .tt-corner, .tt-day, .tt-time, .tt-empty, .tt-holiday { background: var(--paper); }
  .tt-corner { display: flex; align-items: center; justify-content: center;
               font-family: var(--mono); font-size: 11px; letter-spacing: .12em; color: var(--ink-3); }
  .tt-day { padding: 6px 8px; display: flex; align-items: baseline; justify-content: space-between;
            gap: 4px; min-width: 0; }
  .tt-day.today { background: var(--accent-soft); box-shadow: inset 0 2px 0 var(--accent); }
  .tt-day-name { font-family: var(--kai); font-size: 16px; color: var(--ink); white-space: nowrap; }
  .tt-day.today .tt-day-name { color: var(--accent-deep); }
  .tt-day-date { font-family: var(--mono); font-size: 11px; color: var(--ink-3); white-space: nowrap; }
  .tt-day-tag { display: inline-block; margin-left: 3px; padding: 1px 4px; background: var(--accent-soft);
                color: var(--accent-deep); font-family: var(--mono); font-size: 10px; letter-spacing: .04em; }
  .tt-time { display: flex; flex-direction: column; justify-content: center; padding: 5px 7px;
             font-family: var(--mono); line-height: 1.35; text-align: right; }
  .tt-period { color: var(--ink-2); font-size: 13px; }
  .tt-range { color: var(--ink-3); font-size: 10.5px; }
  .tt-time.now { background: var(--accent-soft); }
  .tt-time.now .tt-period { color: var(--accent-deep); font-weight: 700; }
  .tt-empty { min-width: 0; }
  .tt-empty.td-today { background: var(--accent-soft); }
  .tt-course { z-index: 1; display: flex; flex-direction: column; justify-content: center;
               min-width: 0; margin: 4px; padding: 6px 7px; border-left: 3px solid var(--accent);
               background: var(--card); box-shadow: 0 2px 8px rgba(50, 42, 31, .08); }
  .tt-course.now { box-shadow: 0 0 0 1px var(--accent), 0 2px 8px rgba(50, 42, 31, .08); }
  .tt-course-name { font-family: var(--kai); font-size: 14px; font-weight: 600; line-height: 1.35;
                    overflow-wrap: anywhere; }
  .tt-course.now .tt-course-name { color: var(--accent-deep); }
  .tt-course-meta { margin-top: 2px; font-family: var(--mono); font-size: 10.5px; line-height: 1.35;
                    color: var(--ink-3); overflow-wrap: anywhere; }
  .tt-holiday { z-index: 1; display: flex; align-items: center; justify-content: center; margin: 4px;
                border: 1px dashed var(--rule-2); color: var(--accent-deep); font-family: var(--kai);
                font-size: 15px; writing-mode: vertical-rl; letter-spacing: .12em; }
  .week-unscheduled { margin: 12px 0 0; padding-top: 10px; border-top: 1px dashed var(--rule);
                      font-family: var(--mono); font-size: 12px; color: var(--ink-3); }

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

  /* 待办卡：按 逾期 / 今天 / 明天 / 以后 分组的纸质清单行 */
  .todo-group { margin: 12px 0 6px; font-family: var(--mono); font-size: 11.5px;
                letter-spacing: .12em; color: var(--ink-3); }
  .todo-group:first-child { margin-top: 0; }
  .todo-group.overdue { color: var(--accent-deep); }
  .todo-list { display: grid; gap: 6px; }
  .todo-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px;
               align-items: center; padding: 9px 12px; border: 1px solid var(--rule);
               background: var(--paper); }
  .todo-chk { width: 17px; height: 17px; margin: 0; accent-color: var(--accent); cursor: pointer; }
  .todo-chk:disabled { cursor: default; }
  .todo-title { font-size: 15px; overflow-wrap: anywhere; }
  .todo-due { font-family: var(--mono); font-size: 12px; color: var(--ink-3); white-space: nowrap; }
  .todo-item.overdue .todo-due { color: var(--accent-deep); }
  .todo-del { background: none; border: none; padding: 2px 4px; color: var(--ink-3);
              font-family: var(--mono); font-size: 12px; cursor: pointer; }
  .todo-del:hover { color: var(--accent); text-decoration: underline; }
  .todo-del.armed { color: var(--card); background: var(--accent); border-radius: 3px;
                    padding: 2px 8px; }
  .todo-empty { margin: 0; padding: 18px 8px; border: 1px dashed var(--rule-2); text-align: center;
                color: var(--ink-3); font-size: 14px; }

  /* 知识卡：最近沉淀的知识点速览，全量在 /knowledge 页 */
  .knowledge-list { display: grid; gap: 8px; }
  .knowledge-item { padding: 9px 12px; border: 1px solid var(--rule); background: var(--paper); }
  .knowledge-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .knowledge-title { font-family: var(--kai); font-size: 15px; font-weight: 600;
                     overflow-wrap: anywhere; }
  .knowledge-cat { flex: none; padding: 1px 6px; background: var(--accent-soft);
                   color: var(--accent-deep); font-family: var(--mono); font-size: 10.5px;
                   letter-spacing: .04em; white-space: nowrap; }
  .knowledge-cat.none { background: var(--shade); color: var(--ink-3); }
  .knowledge-date { margin-left: auto; flex: none; font-family: var(--mono); font-size: 11px;
                    color: var(--ink-3); white-space: nowrap; }
  .knowledge-content { margin: 4px 0 0; font-size: 13.5px; line-height: 1.6; color: var(--ink-2);
                       display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
                       overflow: hidden; }
  .knowledge-more { margin-top: 10px; min-height: 30px; padding: 3px 12px; font-size: 12px; }

  /* ── 手机：整周压进屏宽（节次列只留数字），极窄屏仍可横向滚动 ── */
  @media (max-width: 720px) {
    .pagehead { flex-wrap: wrap; padding: 14px 16px; gap: 10px 12px; }
    .pagehead .seal { width: 38px; height: 38px; }
    .pagehead .seal img { top: 4px; left: 4px; width: 30px; height: 30px; }
    .ph-title h1 { font-size: 20px; }
    .ph-right { width: 100%; justify-content: space-between; }
    main { display: block; padding: 22px 14px 56px; }
    .schedule-rail { position: static; padding: 0 0 18px; }
    .rail-meta { margin-top: 10px; padding-top: 10px; }
    .col { gap: 20px; }
    .lead { padding: 14px 16px 15px; }
    .lead-title { font-size: 20px; }
    .week-timetable { min-width: 0; grid-template-columns: 30px repeat(7, minmax(0, 1fr));
                      grid-template-rows: 42px repeat(var(--period-count), minmax(46px, auto)); }
    #weekCard .cbody { padding: 10px 8px 12px; }
    .tt-range { display: none; }
    .tt-period { font-size: 12px; }
    /* 表头竖排堆叠并允许换行：40px 出头的日列放不下「周六 补课」横排 */
    .tt-day { flex-direction: column; align-items: flex-start; justify-content: center;
              gap: 1px; padding: 3px 2px; }
    .tt-day-name { font-size: 12px; line-height: 1.3; white-space: normal; }
    .tt-day-date { font-size: 10px; line-height: 1.3; white-space: normal; }
    .tt-day-tag { margin-left: 2px; font-size: 9px; padding: 0 2px; }
    .tt-course { margin: 2px; padding: 3px 4px; border-left-width: 2px; }
    .tt-course-name { font-size: 11.5px; }
    .tt-course-meta { font-size: 10px; }
    .tt-holiday { font-size: 12px; }
  }

  /* ── 打印：隐去导航与操作，只留课表、待办等内容 ── */
  @media print {
    body { background: #fff; }
    .ph-right, .demo-banner, .schedule-rail, .week-nav, .tbtn, .todo-del { display: none !important; }
    main { display: block; max-width: none; padding: 0; }
    .col { display: block; }
    .card, .lead { box-shadow: none; break-inside: avoid; }
    .card { margin-bottom: 16px; }
    .weekwrap { overflow: visible; }
    .week-timetable { min-width: 0; }
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
${demo ? '<div class="demo-banner" role="status"><strong>离线演示 · 虚构数据</strong><span>不连接教务或 AI。正式使用请在终端运行 npm start。</span></div>' : ""}
<main>
  <aside class="schedule-rail" aria-label="日程信息">
    <p class="rail-kicker">TODAY · SCHEDULE</p>
    <h2 class="rail-title" id="railWeek">本周</h2>
    <div class="week-nav" aria-label="切换教学周">
      <button class="tbtn" id="prevWeek" type="button">← 上一周</button>
      <button class="tbtn" id="nextWeek" type="button">下一周 →</button>
      <select class="week-sel" id="weekJumpSel" aria-label="直达教学周"></select>
      <button class="tbtn" id="currentWeek" type="button">回到本周</button>
    </div>
    <div class="rail-meta" id="scheduleMeta"></div>
  </aside>
  <div class="col">
    <section class="lead" id="leadCard" aria-label="今日头条">
      <p class="lead-kicker">TODAY</p>
      <p class="skel">…</p>
    </section>
    <section class="card" id="weekCard" aria-label="周课表">
      <h2>课表<span class="cnote" id="weekNote"></span></h2>
      <div class="cbody"><p class="skel">…</p></div>
    </section>
    <section class="card" id="examCard" aria-label="临近考试">
      <h2>考试<span class="cnote" id="examNote"></span></h2>
      <div class="cbody"><p class="skel">…</p></div>
    </section>
    <section class="card" id="todoCard" aria-label="待办事项">
      <h2>待办<span class="cnote" id="todoNote"></span></h2>
      <div class="cbody"><p class="skel">…</p></div>
    </section>
    <section class="card" id="knowledgeCard" aria-label="知识库">
      <h2>知识<span class="cnote" id="knowledgeNote"></span></h2>
      <div class="cbody"><p class="skel">…</p></div>
    </section>
  </div>
</main>
<script>
${demo && demoData ? `const DEMO_DATA = ${JSON.stringify(demoData)};` : "const DEMO_DATA = null;"}
const $ = (id) => document.getElementById(id);
let selectedWeek = null;
let displayedWeek = null;

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
function fmtDay(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}
function fmtCountdown(min) {
  if (min <= 0) return "即将开始";
  if (min < 60) return "还有 " + min + " 分钟开讲";
  const h = Math.floor(min / 60);
  if (h < 24) return "还有 " + h + " 小时" + (min % 60 ? " " + (min % 60) + " 分" : "") + "开讲";
  return Math.floor(h / 24) + " 天后开讲";
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
/* 节次 -> [起, 止] 当天分钟数；作息表没有该节次返回 null */
function periodRange(periodTimes, p) {
  const t = periodTimes[String(p)];
  if (!t) return null;
  const seg = t.split("-");
  const a = seg[0].split(":"); const b = seg[1].split(":");
  return [Number(a[0]) * 60 + Number(a[1]), Number(b[0]) * 60 + Number(b[1])];
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

/* 本周课表：节次 × 星期网格；课格只留课名 + 地点，其余进 title；
   今天列淡朱砂铺底，正在进行的节次行 / 课格加「现在」标记 */
function renderWeek(b) {
  const body = $("weekCard").querySelector(".cbody");
  const note = $("weekNote");
  body.textContent = "";
  if (!b.schedule.available) {
    body.appendChild(el("p", "daynote", "暂无课表数据，指引见上方。"));
    note.textContent = "";
    return;
  }
  if (!b.week) {
    body.appendChild(el("p", "daynote", "当前不在教学周内（假期或未开学），周课表歇一档。"));
    note.textContent = "";
    return;
  }
  note.textContent = b.term.weekLabel;
  const wrap = el("div", "weekwrap");
  const timetable = el("div", "week-timetable");
  const periodTimes = b.periodTimes || {};
  const knownPeriods = Object.keys(periodTimes).map(Number).filter((p) => Number.isInteger(p) && p > 0);
  const coursePeriods = b.week.days.flatMap((d) => d.courses.map((c) => c.pEnd || 0));
  const periodCount = Math.max(10, ...knownPeriods, ...coursePeriods);
  timetable.style.setProperty("--period-count", String(periodCount));

  const nowDate = new Date(b.now);
  const nowMin = nowDate.getHours() * 60 + nowDate.getMinutes();
  let nowCourse = null;
  const today = b.week.days.find((d) => d.isToday && !d.holiday);
  if (today) {
    for (const c of today.courses) {
      const start = c.pStart != null ? periodRange(periodTimes, c.pStart) : null;
      const end = c.pEnd != null ? periodRange(periodTimes, c.pEnd) : null;
      if (start && end && nowMin >= start[0] && nowMin <= end[1]) { nowCourse = c; break; }
    }
  }

  const corner = el("div", "tt-corner", "节次");
  corner.style.gridColumn = "1";
  corner.style.gridRow = "1";
  timetable.appendChild(corner);
  for (let i = 0; i < b.week.days.length; i++) {
    const d = b.week.days[i];
    const day = el("div", "tt-day" + (d.isToday ? " today" : ""));
    day.style.gridColumn = String(i + 2);
    day.style.gridRow = "1";
    const name = el("span", "tt-day-name", d.label);
    if (d.makeup) name.appendChild(el("span", "tt-day-tag", "补课"));
    day.appendChild(name);
    day.appendChild(el("span", "tt-day-date", d.dateShort + (d.isToday ? " ·今" : "")));
    timetable.appendChild(day);
  }
  for (let period = 1; period <= periodCount; period++) {
    const inNow = nowCourse && period >= nowCourse.pStart && period <= nowCourse.pEnd;
    const time = el("div", inNow ? "tt-time now" : "tt-time");
    time.style.gridColumn = "1";
    time.style.gridRow = String(period + 1);
    time.title = "第 " + period + " 节";
    time.appendChild(el("span", "tt-period", String(period)));
    const range = periodTimes[String(period)];
    if (range) {
      time.appendChild(el("span", "tt-range", range));
      time.title = "第 " + period + " 节 · " + range;
    }
    timetable.appendChild(time);
    for (let day = 0; day < b.week.days.length; day++) {
      const empty = el("div", b.week.days[day].isToday ? "tt-empty td-today" : "tt-empty");
      empty.style.gridColumn = String(day + 2);
      empty.style.gridRow = String(period + 1);
      timetable.appendChild(empty);
    }
  }
  const unscheduled = [];
  for (let day = 0; day < b.week.days.length; day++) {
    const d = b.week.days[day];
    if (d.holiday) {
      const holiday = el("div", "tt-holiday", d.holiday + " 放假");
      holiday.style.gridColumn = String(day + 2);
      holiday.style.gridRow = "2 / span " + periodCount;
      timetable.appendChild(holiday);
      continue;
    }
    for (const c of d.courses) {
      const start = c.pStart;
      const end = c.pEnd;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        unscheduled.push(d.label + "：" + c.title + (c.time ? "（" + c.time + "）" : ""));
        continue;
      }
      const course = el("div", c === nowCourse ? "tt-course now" : "tt-course");
      course.style.gridColumn = String(day + 2);
      course.style.gridRow = String(start + 1) + " / " + String(end + 2);
      course.title = [c.title, "第 " + start + (end === start ? "" : "–" + end) + " 节", c.time, c.location, c.teacher, c.weeks]
        .filter(Boolean).join(" · ");
      course.appendChild(el("div", "tt-course-name", c.title));
      course.appendChild(el("div", "tt-course-meta", c.location || "地点待定"));
      timetable.appendChild(course);
    }
  }
  wrap.appendChild(timetable);
  body.appendChild(wrap);
  if (unscheduled.length) body.appendChild(el("p", "week-unscheduled", "未能定位节次：" + unscheduled.join("；")));
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

function todoItem(t) {
  const row = el("div", "todo-item" + (t.overdue ? " overdue" : ""));
  const chk = el("input", "todo-chk");
  chk.type = "checkbox";
  chk.setAttribute("aria-label", "完成待办：" + t.title);
  if (!DEMO_DATA) {
    chk.addEventListener("change", () => {
      fetch("/api/reminders/" + t.id, {
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
  if (!DEMO_DATA) {
    const del = el("button", "todo-del", "删除");
    del.type = "button";
    del.addEventListener("click", () => {
      armDelete(del, () => {
        fetch("/api/reminders/" + t.id, { method: "DELETE" }).then(() => load()).catch(() => load());
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
  const items = (b.todos && b.todos.items) || [];
  note.textContent = items.length ? items.length + " 项未完成" : "";
  if (!items.length) {
    body.appendChild(el("p", "todo-empty", "没有未完成的待办。在对话页对我说「我这周要……」即可记录。"));
    return;
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
    body.appendChild(el("p", item[1] ? "todo-group overdue" : "todo-group", item[0] + " · " + item[2].length));
    const list = el("div", "todo-list");
    for (const t of item[2]) list.appendChild(todoItem(t));
    body.appendChild(list);
  }
}

/* 知识速览：最近沉淀的知识点，全量在 /knowledge 页 */
function renderKnowledge(b) {
  const body = $("knowledgeCard").querySelector(".cbody");
  const note = $("knowledgeNote");
  body.textContent = "";
  const k = b.knowledge || { total: 0, recent: [] };
  note.textContent = k.total ? "共 " + k.total + " 条" : "";
  if (!k.recent.length) {
    body.appendChild(el("p", "todo-empty", "还没有沉淀知识。在对话页分享你学到的知识点（或说「记住：……」），我会记进知识库并按课程归类。"));
    return;
  }
  const list = el("div", "knowledge-list");
  for (const item of k.recent) {
    const row = el("div", "knowledge-item");
    const head = el("div", "knowledge-head");
    head.appendChild(el("span", "knowledge-title", item.title));
    head.appendChild(el("span", "knowledge-cat" + (item.category ? "" : " none"), item.category || "未分类"));
    head.appendChild(el("span", "knowledge-date", fmtDay(item.updatedAt)));
    row.appendChild(head);
    const content = el("p", "knowledge-content", item.content);
    content.title = item.content;
    row.appendChild(content);
    list.appendChild(row);
  }
  body.appendChild(list);
  const more = el("a", "tbtn knowledge-more", "查看全部 →");
  more.href = "/knowledge";
  body.appendChild(more);
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
  displayedWeek = b.term.week;
  $("prevWeek").disabled = DEMO_DATA || !displayedWeek || displayedWeek <= 1;
  $("nextWeek").disabled = DEMO_DATA || !displayedWeek || displayedWeek >= (b.term.maxWeek || displayedWeek);
  $("currentWeek").disabled = DEMO_DATA || !selectedWeek;
  const jump = $("weekJumpSel");
  jump.disabled = DEMO_DATA || !b.term.maxWeek;
  jump.textContent = "";
  const maxWeek = b.term.maxWeek || displayedWeek || 1;
  for (let w = 1; w <= maxWeek; w++) {
    const o = el("option", null, "第 " + w + " 周");
    o.value = String(w);
    if (displayedWeek === w) o.selected = true;
    jump.appendChild(o);
  }
  const week = $("phWeek");
  week.textContent = "";
  week.appendChild(document.createTextNode(b.term.label ? b.term.label + " · " + b.term.weekLabel : b.term.weekLabel));
  if (b.term.weekSource === "estimated") {
    week.appendChild(el("span", "warn", "（周次为估算）"));
  }
  renderLead(b);
  renderWeek(b);
  renderExams(b);
  renderTodos(b);
  renderKnowledge(b);
  renderSrc(b);
  document.title = "今日日程 · " + b.dateLabel;
  if (!DEMO_DATA) {
    // 所选周写进 URL：刷新 / 分享不丢；请求的周次无效时服务端会回落到当前周，跟着对齐
    if (selectedWeek != null && displayedWeek != null && selectedWeek !== displayedWeek) {
      selectedWeek = displayedWeek;
    }
    history.replaceState(null, "", selectedWeek != null ? "?week=" + selectedWeek : location.pathname);
  }
}

function load() {
  if (DEMO_DATA) { render(DEMO_DATA); return; }
  const endpoint = "/api/today" + (selectedWeek ? "?week=" + selectedWeek : "");
  fetch(endpoint, { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(render)
    .catch(() => {
      const lead = $("leadCard");
      lead.textContent = "";
      lead.appendChild(el("p", "lead-kicker", "TODAY"));
      lead.appendChild(el("p", "daynote", "日程暂时取不出来，请稍候刷新。"));
      for (const id of ["weekCard", "examCard", "todoCard", "knowledgeCard"]) {
        const body = $(id).querySelector(".cbody");
        body.textContent = "";
        body.appendChild(el("p", "daynote", "暂时取不出来，请稍候刷新。"));
      }
    });
}

// 深链支持：/today?week=N 直接打开指定教学周
(function () {
  const w = Number(new URLSearchParams(location.search).get("week"));
  if (Number.isInteger(w) && w >= 1) selectedWeek = w;
})();
$("prevWeek").addEventListener("click", () => {
  if (displayedWeek && displayedWeek > 1) { selectedWeek = displayedWeek - 1; load(); }
});
$("nextWeek").addEventListener("click", () => {
  if (displayedWeek) { selectedWeek = displayedWeek + 1; load(); }
});
$("currentWeek").addEventListener("click", () => { selectedWeek = null; load(); });
$("weekJumpSel").addEventListener("change", (ev) => {
  const w = Number(ev.target.value);
  if (Number.isInteger(w) && w >= 1) { selectedWeek = w; load(); }
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
