/**
 * NJTech 教务无头查询 CLI（CourseRaptor 技能 njtech-jwgl 的子命令入口）
 *
 * 设计原则：
 * - 只读封装 src/jwgl 的已验证纯函数，不在本文件复制教务协议逻辑。
 * - 不提供任何真实写操作（抢课/退课）——那些只走交互式 agent 且需用户二次确认。
 * - 「拿不到」≠「没有」：传输失败直接以非零退出码报错，绝不静默降级成空数据。
 * - 输出 Markdown，方便直接贴给同学或喂给 agent。
 *
 * 运行（在 courseraptor 项目根目录）：
 *   npx tsx skills/njtech-jwgl/scripts/query.ts <命令> [参数]
 */

import { getCookie, getXkSession, sleep } from "../../../src/jwgl/session";
import {
  fetchScheduleSmart,
  fetchExamsSmart,
  parseSemesterString,
  currentWeekOf,
  WEEKDAY_NAMES,
  periodTimeRange,
} from "../../../src/jwgl/academics";
import { fetchAllGrades } from "../../../src/jwgl/grades";
import {
  fetchProfile,
  fetchEnrolledClasses,
  fetchRetakeCourses,
  fetchLabGradesSmart,
} from "../../../src/jwgl/portal";
import { fetchJwcNews } from "../../../src/jwgl/news";
import {
  inspectXk,
  searchCourses,
  fetchJxbList,
  roundRefOf,
  type XkCourse,
} from "../../../src/jwgl/xk";
import { config } from "../../../src/config";

// ── 小工具 ────────────────────────────────────────────────

function die(msg: string, code = 1): never {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(code);
}

/** 解析可选学期参数（"2026-2027-1" -> { year, semester }），非法则报错退出 */
function parseTerm(arg?: string): { year: number; semester: number } | null {
  if (!arg) return null;
  const p = parseSemesterString(arg);
  if (!p) die(`学期格式无法解析：「${arg}」，应为「2026-2027-1」这类格式`);
  return p;
}

function maskSensitive(record: Record<string, string>): Record<string, string> {
  const SENSITIVE = /证件号码|银行卡|考生号/;
  const out: Record<string, string> = {};
  let masked = 0;
  for (const [k, v] of Object.entries(record)) {
    if (SENSITIVE.test(k) && v.length > 8) {
      out[k] = `${v.slice(0, 4)}****${v.slice(-4)}`;
      masked++;
    } else out[k] = v;
  }
  if (masked) process.stderr.write(`ℹ️ 已对 ${masked} 个敏感字段打码\n`);
  return out;
}

function table(headers: string[], rows: (string | undefined)[][]): string {
  const esc = (s: string | undefined) => (s ?? "").replace(/\|/g, "／").replace(/\n/g, " ");
  const lines = [
    `| ${headers.map(esc).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ];
  return lines.join("\n");
}

// ── 命令实现 ──────────────────────────────────────────────

async function cmdSchedule(term?: { year: number; semester: number }) {
  const cookie = await getCookie();
  const r = await fetchScheduleSmart(cookie, term?.year, term?.semester);
  if (!r.ok) die(`课表查询失败：${r.error}（这不是「课表为空」）`);
  const t = r.data;
  let week = "";
  try {
    const w = currentWeekOf(t.year, t.semester) as { week?: number; source?: string; evidence?: string };
    if (w && w.week) {
      week = `\n\n**当前教学周**：第 ${w.week} 周` +
        (w.source === "estimated" ? `（开学日期为估算：${w.evidence ?? "未见校历原文"}）` : "");
    }
  } catch {
    /* 假期或不在教学周内，跳过 */
  }
  if (t.courses.length === 0) {
    console.log(`# 课表 · ${t.label}\n\n（已查通但无排课，假期或学期未排课属正常）${week}`);
    return;
  }
  const rows = t.courses.map((c) => [
    WEEKDAY_NAMES[c.weekday] ?? `周${c.weekday}`,
    c.periods.join(","),
    periodTimeRange(c.periods),
    c.title,
    c.teacher,
    c.location,
    c.weeks,
  ]);
  console.log(
    `# 课表 · ${t.label}\n\n共 ${t.courses.length} 门课。\n\n` +
      table(["星期", "节次", "时间", "课程", "教师", "地点", "周次"], rows) +
      week,
  );
}

async function cmdGrades() {
  const cookie = await getCookie();
  const res = await fetchAllGrades(cookie, config.jwglUsername);
  const rows = res.allCourses.map((g) => [g.course, g.score, g.credit, g.type, g.semester]);
  console.log(
    `# 成绩与 GPA\n\n` +
      `- **GPA**：${res.gpa}（${res.gpaBasis ?? ""}）\n` +
      `- **计入 GPA 的必修课学分**：${res.requiredCredits}（注意：不是总修学分）\n` +
      `- **通过型不计绩点学分**：${res.passFailCredits ?? 0}\n` +
      `- **课程总数**：${res.allCourses.length}\n` +
      (res.failedTerms?.length ? `- ⚠️ 以下学期查询失败（重试后仍无数据）：${res.failedTerms.join("；")}\n` : "") +
      `\n${table(["课程", "成绩", "学分", "性质", "学期"], rows)}`,
  );
}

async function cmdExams(term?: { year: number; semester: number }) {
  const cookie = await getCookie();
  const r = await fetchExamsSmart(cookie, term?.year, term?.semester);
  if (!r.ok) die(`考试查询失败：${r.error}（不是「暂无考试」）`);
  const { label, exams } = r.data;
  if (exams.length === 0) {
    console.log(`# 考试安排 · ${label}\n\n该学期暂无考试安排`);
    return;
  }
  const rows = exams.map((e) => [e.subject, e.date, e.time, e.location, e.seatNumber || "—"]);
  console.log(`# 考试安排 · ${label}\n\n${table(["科目", "日期", "时间", "考场", "座位"], rows)}`);
}

async function cmdLabGrades(term?: { year: number; semester: number }) {
  const cookie = await getCookie();
  const { label, items } = await fetchLabGradesSmart(cookie, term?.year, term?.semester);
  if (items.length === 0) {
    console.log(`# 实验成绩 · ${label}\n\n该学期暂无实验成绩（无实验课属正常）`);
    return;
  }
  const rows = items.slice(0, 30).map((i: Record<string, unknown>) => [
    String(i.kcmc ?? ""),
    String(i.cj ?? ""),
    String(i.xf ?? ""),
    String(i.xqmmc ?? ""),
  ]);
  console.log(`# 实验成绩 · ${label}\n\n${table(["课程", "成绩", "学分", "学期"], rows)}`);
}

async function cmdNews(category?: string, limit = 10) {
  const items = await fetchJwcNews([], 30);
  const filtered = category ? items.filter((i) => i.category === category) : items;
  const rows = filtered.slice(0, limit).map((i) => [
    i.title,
    i.date,
    i.category ?? "",
    i.restricted ? `${i.url}（限权）` : i.url,
  ]);
  console.log(
    `# 教务处通知${category ? ` · ${category}` : ""}\n\n` +
      `共抓到 ${filtered.length} 条，显示前 ${Math.min(limit, filtered.length)} 条。\n\n` +
      table(["标题", "日期", "板块", "链接"], rows),
  );
}

async function cmdStudentInfo() {
  const cookie = await getCookie();
  const profile = maskSensitive(await fetchProfile(cookie));
  const keys = Object.keys(profile);
  if (keys.length === 0) die("个人信息页解析失败（页面结构可能变化）");
  const rows = keys.map((k) => [k, profile[k]]);
  console.log(`# 学籍信息\n\n${table(["字段", "值"], rows)}`);
}

async function cmdEnrolled() {
  const cookie = await getCookie();
  const classes = await fetchEnrolledClasses(cookie);
  if (classes.length === 0) {
    console.log("# 已选课程\n\n暂无已选课程（学期初未选课属正常）");
    return;
  }
  const rows = classes.map((c) => [c.courseName, c.className, c.teacher, c.time, c.place, c.credit, c.nature]);
  console.log(`# 已选教学班（${classes.length}）\n\n${table(["课程", "教学班", "教师", "时间", "地点", "学分", "性质"], rows)}`);
}

async function cmdRetake(keyword?: string) {
  const cookie = await getCookie();
  const all = await fetchRetakeCourses(cookie);
  const filtered = keyword ? all.filter((c) => c.courseName.includes(keyword)) : all;
  if (filtered.length === 0) {
    console.log(`# 可重修课程${keyword ? ` · 含「${keyword}」` : ""}\n\n无匹配结果`);
    return;
  }
  const rows = filtered.slice(0, 40).map((c) => [c.courseName, c.courseCode, c.credit, c.department, c.semester]);
  console.log(
    `# 可重修课程（共 ${all.length} 门，显示 ${filtered.length}）\n\n` +
      table(["课程", "课程号", "学分", "开课学院", "学期"], rows),
  );
}

async function cmdSelectionStatus() {
  const res = await inspectXk(config.jwglUsername, config.jwglPassword);
  const okRounds = res.rounds.filter((r) => r.status === "ok");
  const rows = res.rounds.map((r) => [r.tabName, r.status, String(r.sentXkkzXh), String(r.courseCount), r.message || ""]);
  console.log(
    `# 选课模块状态\n\n` +
      `- **选课是否开放**：${res.isXkOpen ? "是（选课开放中）" : "否（当前非选课阶段）"}\n` +
      `- **xkkzId**：${res.xkkzId ?? "未下发（选课未开放时不发放）"}\n` +
      `- **课程查询拦截**：${res.courseQueryBlocked ? "是（加密串错误）" : "否"}\n\n` +
      table(["轮次", "状态", "带加密串", "课程数", "说明"], rows) +
      (res.courseQueryBlocked ? "\n\n⚠️ 课程查询接口被加密串拦截，需复测。" : ""),
  );
}

async function cmdSearchCourses(keyword: string) {
  if (!keyword) die("用法：search-courses <课程名关键词>");
  const session = await getXkSession();
  const courses = await searchCourses(session, keyword);
  if (courses.length === 0) {
    console.log(
      `# 搜课：${keyword}\n\n未查询到课程。` +
        (session.isXkOpen ? "若已开放仍为空，可能是接口被「加密串」拦截。" : "当前选课未开放，接口不可查属正常。"),
    );
    return;
  }
  const rows = courses.slice(0, 30).map((c: XkCourse) => [
    c.courseName,
    c.teacher,
    String(c.capacity),
    String(c.selected),
    String(c.remain),
    c.jxbId,
  ]);
  console.log(
    `# 搜课：${keyword}（${courses.length} 个教学班）\n\n` +
      table(["课程", "教师", "容量", "已选", "剩余", "教学班ID"], rows),
  );
}

async function cmdSearchClasses(courseName: string) {
  if (!courseName) die("用法：search-classes <课程名关键词>");
  let session = await getXkSession();
  const courses = await searchCourses(session, courseName);
  const byCode = new Map<string, XkCourse>();
  for (const c of courses) if (c.courseCode && !byCode.has(c.courseCode)) byCode.set(c.courseCode, c);
  const picked = [...byCode.values()].slice(0, 3);
  if (picked.length === 0) die("未查到该课程（选课未开放时接口不可查，可先 selection-status）");
  const blocks: string[] = [];
  for (const course of picked) {
    const ref = roundRefOf(course, session);
    let list: XkCourse[];
    try {
      list = await fetchJxbList(session, { ...ref, courseCode: course.courseCode });
    } catch (e) {
      blocks.push(`## ${course.courseName || course.courseCode}\n\n查询教学班失败：${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    const rows = list.map((c) => [c.teacher, c.credit, String(c.capacity), String(c.selected), String(c.remain), c.jxbId]);
    blocks.push(
      `## ${course.courseName || course.courseCode}（${list.length} 个班）\n\n` +
        table(["教师", "学分", "容量", "已选", "剩余", "教学班ID"], rows),
    );
  }
  console.log(`# 教学班明细：${courseName}\n\n${blocks.join("\n\n")}`);
}

async function cmdWatch(courseName: string, durationSec = 60) {
  if (!courseName) die("用法：watch <课程名关键词> [秒]");
  const session = await getXkSession();
  const deadline = Date.now() + durationSec * 1000;
  const events: string[] = [];
  let rounds = 0;
  console.log(`# 盯课监控：${courseName}（${durationSec}s，只观察不提交）\n`);
  while (Date.now() < deadline) {
    rounds++;
    const courses = await searchCourses(session, courseName);
    const matched = courses.filter((c) => c.courseName.includes(courseName) || courseName.includes(c.courseName));
    const avail = matched.filter((c) => (c.remain ?? 0) > 0 || c.unlimited);
    if (avail.length > 0) {
      const msg = `第 ${rounds} 轮发现余量：${avail.map((c) => `${c.courseName}（${c.teacher}）余 ${c.remain}`).join("；")}`;
      events.push(`- ${msg}`);
      console.log(msg);
    }
    await sleep(3000);
  }
  console.log(
    `\n监控结束：${rounds} 轮，共 ${events.length} 次余量事件。` +
      (events.length ? "\n\n" + events.join("\n") : "\n目标课程始终无余量。"),
  );
}

// ── 入口 ───────────────────────────────────────────────────

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "schedule":
      return await cmdSchedule(parseTerm(args[0]));
    case "grades":
      return await cmdGrades();
    case "exams":
      return await cmdExams(parseTerm(args[0]));
    case "lab-grades":
      return await cmdLabGrades(parseTerm(args[0]));
    case "news":
      return await cmdNews(args[0], Number.parseInt(args[1] ?? "10", 10));
    case "student-info":
      return await cmdStudentInfo();
    case "enrolled-courses":
      return await cmdEnrolled();
    case "retake-courses":
      return await cmdRetake(args[0]);
    case "selection-status":
      return await cmdSelectionStatus();
    case "search-courses":
      return await cmdSearchCourses(args[0]);
    case "search-classes":
      return await cmdSearchClasses(args[0]);
    case "watch":
      return await cmdWatch(args[0], Number.parseInt(args[1] ?? "60", 10));
    case "help":
    case undefined:
      console.log(
        "NJTech 教务查询（njtech-jwgl 技能）\n\n" +
          "用法：npx tsx skills/njtech-jwgl/scripts/query.ts <命令> [参数]\n\n" +
          "命令：schedule [学期] | grades | exams [学期] | lab-grades [学期] | news [板块] [条数]\n" +
          "      student-info | enrolled-courses | retake-courses [关键词] | selection-status\n" +
          "      search-courses <关键词> | search-classes <课程名> | watch <课程名> [秒]\n\n" +
          "示例：query.ts schedule\n       query.ts grades\n       query.ts news 公告通知 5\n" +
          "注意：抢课/退课不在本脚本内，仅走交互式 raptor agent 且需用户确认。",
      );
      return;
    default:
      die(`未知命令：「${cmd}」。运行不带参数查看帮助。`);
  }
}

main().catch((e) => die((e as Error).message || String(e)));
