/**
 * 「本周课表」独立页 — GET /today 的页面本体
 *
 * 与对话页分离的课表界面：只展示本周课表。
 * 数据来自 GET /api/today（纯本地缓存，不登录教务、不调模型），页面每
 * 60 秒与切回标签页时自行刷新，以便教学周跨日时自然更新。
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
<title>本周课表 · CourseRaptor</title>
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
    --ink-3: #898274;
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
  .tbtn { background: none; border: 1px solid var(--rule-2); color: var(--ink-2);
          min-height: 38px; font-size: 14px; padding: 7px 14px; border-radius: 4px;
          cursor: pointer; text-decoration: none; display: inline-flex;
          align-items: center; font-family: inherit;
          transition: border-color .15s ease, color .15s ease, background .15s ease; }
  .tbtn:hover { border-color: var(--accent); color: var(--accent); background: var(--card); }
  .tbtn:active { transform: translateY(1px); }

  .wordmark { display: inline-flex; align-items: baseline; font-family: var(--sans);
              font-weight: 500; letter-spacing: -.035em; white-space: nowrap; }
  .wordmark .course { color: var(--ink-2); }
  .wordmark .raptor { color: var(--accent); font-weight: 750; }

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

  /* ── 正文 ── */
  main { max-width: 1240px; margin: 0 auto; padding: 30px 22px 64px;
         display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 24px; align-items: start; }

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

  .card { border: 1px solid var(--rule-2); border-top: 2px solid var(--accent);
          background: var(--card); box-shadow: var(--shadow-sm);
          margin-bottom: 26px; }
  .card > h2 { display: flex; justify-content: space-between; align-items: baseline;
               margin: 0; padding: 13px 18px 10px; border-bottom: 1px solid var(--rule);
               font-family: var(--mono); font-size: 13px; font-weight: 600;
               letter-spacing: .18em; color: var(--ink-2); }
  .card > h2 .cnote { font-family: var(--mono); font-weight: 400; font-size: 12px;
                      letter-spacing: .03em; color: var(--ink-3); }
  .cbody { padding: 14px 18px 16px; }

  .daynote { margin: 0; font-size: 15px; color: var(--ink-2); }

  /* 本周概览：节次 × 星期的周课表；窄屏横向滚动保持每格可读 */
  .weekwrap { overflow-x: auto; scrollbar-width: thin; padding-bottom: 2px; }
  .week-timetable { --period-count: 10; display: grid;
                    grid-template-columns: 78px repeat(7, minmax(118px, 1fr));
                    grid-template-rows: 46px repeat(var(--period-count), minmax(54px, auto));
                    gap: 1px; min-width: 920px; border: 1px solid var(--rule-2);
                    background: var(--rule); }
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
  .tt-period { color: var(--ink-2); font-size: 12px; }
  .tt-range { color: var(--ink-3); font-size: 10.5px; }
  .tt-empty { min-width: 0; }
  .tt-course { z-index: 1; display: flex; flex-direction: column; justify-content: center;
               min-width: 0; margin: 4px; padding: 6px 7px; border-left: 3px solid var(--accent);
               background: var(--card); box-shadow: 0 2px 8px rgba(50, 42, 31, .08); }
  .tt-course-name { font-family: var(--kai); font-size: 14px; font-weight: 600; line-height: 1.35;
                    overflow-wrap: anywhere; }
  .tt-course-meta { margin-top: 2px; font-family: var(--mono); font-size: 10.5px; line-height: 1.35;
                    color: var(--ink-3); overflow-wrap: anywhere; }
  .tt-holiday { z-index: 1; display: flex; align-items: center; justify-content: center; margin: 4px;
                border: 1px dashed var(--rule-2); color: var(--accent-deep); font-family: var(--kai);
                font-size: 15px; writing-mode: vertical-rl; letter-spacing: .12em; }
  .week-unscheduled { margin: 12px 0 0; padding-top: 10px; border-top: 1px dashed var(--rule);
                      font-family: var(--mono); font-size: 12px; color: var(--ink-3); }

  .skel { color: var(--ink-3); font-size: 15px; padding: 8px 2px; }

  @media (max-width: 720px) {
    .pagehead { flex-wrap: wrap; padding: 14px 16px; gap: 10px 12px; }
    .pagehead .seal { width: 38px; height: 38px; }
    .pagehead .seal img { top: 4px; left: 4px; width: 30px; height: 30px; }
    .ph-title h1 { font-size: 20px; }
    .ph-right { width: 100%; justify-content: space-between; }
    main { display: block; padding: 22px 14px 56px; }
    .schedule-rail { position: static; padding: 0 0 18px; }
    .rail-meta { margin-top: 10px; padding-top: 10px; }
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
    <h1>本周课表</h1>
    <span class="ph-stamp">COURSERAPTOR · WEEKLY SCHEDULE</span>
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
  <aside class="schedule-rail" aria-label="课表信息">
    <p class="rail-kicker">COURSE SCHEDULE</p>
    <h2 class="rail-title" id="railWeek">本周</h2>
    <div class="week-nav" aria-label="切换教学周">
      <button class="tbtn" id="prevWeek" type="button">← 上一周</button>
      <button class="tbtn" id="nextWeek" type="button">下一周 →</button>
      <button class="tbtn" id="currentWeek" type="button">回到本周</button>
    </div>
    <div class="rail-meta" id="scheduleMeta"></div>
  </aside>
  <section class="card" id="weekCard" aria-label="本周课表">
    <h2>课表<span class="cnote" id="weekNote"></span></h2>
    <div class="cbody"><p class="skel">…</p></div>
  </section>
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
function renderWeek(b) {
  const body = $("weekCard").querySelector(".cbody");
  const note = $("weekNote");
  body.textContent = "";
  if (!b.schedule.available) {
    body.appendChild(el("p", "daynote", "暂无数据。"));
    note.textContent = "";
    return;
  }
  if (!b.week) {
    body.appendChild(el("p", "daynote", "当前不在教学周内（假期或未开学），周概览歇一档。"));
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
    const time = el("div", "tt-time");
    time.style.gridColumn = "1";
    time.style.gridRow = String(period + 1);
    time.appendChild(el("span", "tt-period", "第 " + period + " 节"));
    time.appendChild(el("span", "tt-range", periodTimes[String(period)] || "时间待定"));
    timetable.appendChild(time);
    for (let day = 0; day < b.week.days.length; day++) {
      const empty = el("div", "tt-empty");
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
      const course = el("div", "tt-course");
      course.style.gridColumn = String(day + 2);
      course.style.gridRow = String(start + 1) + " / " + String(end + 2);
      course.title = [c.title, c.time, c.location, c.teacher, c.weeks].filter(Boolean).join(" · ");
      course.appendChild(el("div", "tt-course-name", c.title));
      course.appendChild(el("div", "tt-course-meta", "节次：第 " + start + (end === start ? "" : "–" + end) + " 节" + (c.time ? " · " + c.time : "")));
      course.appendChild(el("div", "tt-course-meta", "地点：" + (c.location || "待定")));
      course.appendChild(el("div", "tt-course-meta", "教师：" + (c.teacher || "待定")));
      course.appendChild(el("div", "tt-course-meta", "周次：" + (c.weeks || "待定")));
      timetable.appendChild(course);
    }
  }
  wrap.appendChild(timetable);
  body.appendChild(wrap);
  if (unscheduled.length) body.appendChild(el("p", "week-unscheduled", "未能定位节次：" + unscheduled.join("；")));
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
  const week = $("phWeek");
  week.textContent = "";
  week.appendChild(document.createTextNode(b.term.label ? b.term.label + " · " + b.term.weekLabel : b.term.weekLabel));
  if (b.term.weekSource === "estimated") {
    week.appendChild(el("span", "warn", "（周次为估算）"));
  }
  renderWeek(b);
  renderSrc(b);
  document.title = "本周课表 · " + b.dateLabel;
}

function load() {
  if (DEMO_DATA) { render(DEMO_DATA); return; }
  const endpoint = "/api/today" + (selectedWeek ? "?week=" + selectedWeek : "");
  fetch(endpoint, { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(render)
    .catch(() => {
      const body = $("weekCard").querySelector(".cbody");
      body.textContent = "";
      body.appendChild(el("p", "daynote", "课表暂时取不出来，请稍候刷新。"));
    });
}
$("prevWeek").addEventListener("click", () => {
  if (displayedWeek && displayedWeek > 1) { selectedWeek = displayedWeek - 1; load(); }
});
$("nextWeek").addEventListener("click", () => {
  if (displayedWeek) { selectedWeek = displayedWeek + 1; load(); }
});
$("currentWeek").addEventListener("click", () => { selectedWeek = null; load(); });
load();
if (!DEMO_DATA) {
  setInterval(load, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
}
</script>
</body>
</html>`;
}
