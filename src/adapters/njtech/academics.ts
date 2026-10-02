/**
 * NJTECH 教务系统 - 课表/考试抓取
 * 移植自 ScholarFlow lib/schools/njtech/jwgl.ts（课表/考试部分）
 */

// ── 跨校通用工具（周次展开/学期解析/周分组/假期叠加）收在 core/academic-utils，
//    这里 re-export 保持 njtech 侧旧调用点不动；带节次作息的函数包一层本校作息表。
import {
  type AnnotatedWeekGroup,
  annotateWeekGroups as annotateWith,
  buildWeekIndex as buildIndexWith,
  candidateTerms,
  courseLineBody as courseLineWith,
  expandWeeks,
  periodTimeRangeOf,
  termLabel,
  WEEKDAY_CN,
} from "../../core/academic-utils";
import { RaptorError, SESSION_EXPIRED_MESSAGE } from "../../core/errors";
import { createClient, type FetchResult, httpFailure } from "../../core/http";
import type {
  CourseData,
  ExamData,
  ExamResult,
  ScheduleResult,
  SkwjSegment,
  TermRef,
  WeekGroup,
} from "../../core/model";
import { BASE } from "./auth";
import { currentWeekOf as resolveCurrentWeek } from "./term-dates";
import { isSessionExpired } from "./xk";

export type { AnnotatedWeekGroup } from "../../core/academic-utils";
export { parseSemesterString, segmentsOverlap, WEEKDAY_NAMES } from "../../core/academic-utils";
export { expandWeeks, termLabel, WEEKDAY_CN };
export const candidateXnxqList = candidateTerms;

/** 会话失效哨兵：fetchXxxFor 向 Smart 层传递用，Smart 层据此抛 SESSION_EXPIRED，
    供 session.withAuthRetry 换新 cookie 自动重试 */
const SESSION_DOWN = SESSION_EXPIRED_MESSAGE;

export type { ExamResult, ScheduleResult, SkwjSegment, TermRef, WeekGroup } from "../../core/model";
export {
  parseTermRef,
  parseTermStartDate,
  recordWeek1Monday,
  resolveWeek1Monday,
} from "./term-dates";

/**
 * 当前教学周。真值来自 term-dates 单一数据源；
 * 返回值带 source —— 估算出来的必须如实标注，不能当既定事实讲。
 */
export function currentWeekOf(year: number, semester: number, now: Date = new Date()) {
  return resolveCurrentWeek(year, semester, now);
}

// ── NJTECH 节次时间表 ──────────────────────────────────────────
// 南京工业大学标准作息时间（每节课45分钟，课间休息10分钟）。
// 注意两处大间隔：上午 09:50-10:20 与 下午 15:40-16:10 都是 30 分钟
// （2026-10 同学对照实际作息核对：下午第二节与第三节之间是 30 分钟，
// 不是普通 10 分钟课间）。
export const NJTECH_PERIOD_TIMES: Record<string, string> = {
  "1": "08:10-08:55",
  "2": "09:05-09:50",
  "3": "10:20-11:05",
  "4": "11:15-12:00",
  "5": "14:00-14:45",
  "6": "14:55-15:40",
  "7": "16:10-16:55",
  "8": "17:05-17:50",
  "9": "19:00-19:45",
  "10": "19:55-20:40",
};

/** 节次号 -> 上课时间段，如 [7,8] -> "16:10-17:50"（作息表是本校规则） */
export function periodTimeRange(periods: number[]): string | undefined {
  return periodTimeRangeOf(NJTECH_PERIOD_TIMES, periods);
}

// ── sksj（上课时间字符串）解析 ────────────────────────────────

/** 中文星期 → 数字（1=周一…7=周日）；表在 core/academic-utils，此处 re-export */

/**
 * 解析 sksj（上课时间）字符串为结构化时段数组。
 * 输入格式形如 "星期一第5-6节{2-17周};星期四第5-6节{2-17周}"
 * 每段以 ; 分隔，分别给出星期、节次区间、周次区间。
 * 无法解析的段跳过，不抛错。
 */
export function parseSksjSegments(sksj: string): SkwjSegment[] {
  if (!sksj) return [];
  const out: SkwjSegment[] = [];
  for (const seg of sksj.split(";").filter(Boolean)) {
    const weekdayMatch = seg.match(/星期([一二三四五六日天])/);
    const periodMatch = seg.match(/第(\d+)-?(\d+)?节/);
    const weeksMatch = seg.match(/\{([^}]+)周\}/);
    if (!weekdayMatch) continue;
    const weekday = WEEKDAY_CN[weekdayMatch[1]] ?? 0;
    const startPeriod = periodMatch ? parseInt(periodMatch[1], 10) : 0;
    const endPeriod = periodMatch?.[2] ? parseInt(periodMatch[2], 10) : startPeriod;
    const periods: number[] = [];
    for (let i = startPeriod; i <= endPeriod; i++) periods.push(i);
    const weeks = weeksMatch ? weeksMatch[1] : "";
    out.push({ weekday, periods, weeks, expandedWeeks: expandWeeks(weeks) });
  }
  return out;
}

/** 课程行去掉星期后的主体（节次 · 时间 · 课程 · 地点 · 教师），供周分组与调休覆盖行复用 */
export function courseLineBody(c: CourseData): string {
  return courseLineWith(c, periodTimeRange);
}

/**
 * 按周预分组课表：week -> 该周实际要上的课。
 * 只含有课的周；周次解析在工具层完成，模型查表即可。
 */
export function buildWeekIndex(courses: CourseData[]): WeekGroup[] {
  return buildIndexWith(courses, periodTimeRange);
}

/**
 * 学期参数与「当前学期」探测
 *
 * 正方不提供当前学期查询接口（无参数请求返回 0 条，页面接口无 HTML），
 * 按日历日期推断在学期交界期（如 8 月下旬新学期课表已生成）必然出错，
 * 因此改为候选学期探测：从最新可能学期开始逐个查询，取第一个有数据的。
 *
 * xnm = 学年起始年；第一学期(秋季) xqm=3，第二学期(春季) xqm=12
 */

// ── 课表抓取 ────────────────────────────────────────────────

/**
 * 智能课表抓取：未指定学期时按候选列表探测，返回第一个有数据的学期
 * （同时带上年份与学期标签，解决交界期「年+学期」双双推断错误的问题）
 *
 * 语义约定（重要）：
 * - ok=false：全部候选学期都没拿到数据（断网/会话失效/接口改版），
 *   调用方必须如实上报 error，不许降级成「课表为空」。
 * - ok=true 且 courses 为空：确实查到了、但就是没排课（假期属正常）。
 */
export async function fetchScheduleSmart(
  cookie: string,
  xnm?: number,
  xqm?: number,
): Promise<FetchResult<ScheduleResult>> {
  const candidates = xnm && xqm ? [{ year: xnm, semester: xqm }] : candidateXnxqList();

  const failures: string[] = [];

  for (const c of candidates) {
    const r = await fetchScheduleFor(cookie, c.year, c.semester);
    if (!r.ok) {
      if (r.error === SESSION_DOWN) {
        throw new RaptorError("SESSION_EXPIRED", "教务会话已失效（可能被服务端提前下线）");
      }
      failures.push(`${termLabel(c.year, c.semester)}：${r.error}`);
      continue;
    }
    if (r.data.length > 0) {
      return { ok: true, data: { ...c, label: termLabel(c.year, c.semester), courses: r.data } };
    }
  }

  if (failures.length === candidates.length) {
    return { ok: false, error: `课表查询失败：${failures.join("；")}` };
  }

  // 至少有一个学期查通了但没排课：保持「假期空课表」语义
  const first = candidates[0];
  return {
    ok: true,
    data: { ...first, label: termLabel(first.year, first.semester), courses: [] },
  };
}

/** 抓取指定单个学期的课表（kbList 为空时回退用考试数据反推） */
async function fetchScheduleFor(
  cookie: string,
  year: number,
  semester: number,
): Promise<FetchResult<CourseData[]>> {
  const client = createClient(BASE, cookie);

  const resp = await client.req("/kbcx/xskbcx_cxXsKb.html?gnmkdm=N253508", {
    method: "POST",
    body: `xnm=${year}&xqm=${semester}`,
  });

  const failure = httpFailure(resp);
  if (failure) return { ok: false, error: failure };
  if (!resp.body || resp.body.length < 10) {
    return { ok: false, error: `课表接口返回空响应（HTTP ${resp.status}）` };
  }
  // 会话被服务端提前踢掉时正方 302 回登录页——必须显式区分，
  // 否则会被当成「页面改版」误导排障方向，也错过自动重登的时机
  if (isSessionExpired(resp.body)) {
    return { ok: false, error: SESSION_DOWN };
  }

  let data: { kbList?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(resp.body) as { kbList?: Array<Record<string, unknown>> };
  } catch {
    return { ok: false, error: "课表接口响应非 JSON（页面结构可能已改版）" };
  }

  const kbList = data?.kbList || [];
  if (kbList.length > 0) {
    return {
      ok: true,
      data: kbList.map((item: Record<string, unknown>) => ({
        title: (item.kcmc as string) || "",
        weekday: parseInt(item.xqj as string, 10) || 0,
        periods: parsePeriods(item.jc as string),
        weeks: cleanWeekSpec((item.zcd as string) || ""),
        location: (item.cdmc as string) || (item.xqmc as string) || "",
        teacher: (item.xm as string) || "",
        ...item,
      })),
    };
  }

  // JWGL 返回空课表（学期末常见）-> 从考试数据反向生成课表
  return { ok: true, data: await buildScheduleFromExams(cookie, year, semester) };
}

/**
 * 从考试数据的 sksj（上课时间）字段反向生成课表
 * sksj 格式: "星期一第5-6节{2-17周};星期四第5-6节{2-17周}"
 */
async function buildScheduleFromExams(
  cookie: string,
  year: number,
  semester: number,
): Promise<CourseData[]> {
  // 回退路径只作补充：拿不到就算了，不把错误冒泡成「课表查询失败」
  const r = await fetchExamsFor(cookie, year, semester);
  if (!r.ok) return [];
  const exams = r.data;
  if (!exams.length) return [];

  const courses: CourseData[] = [];
  const seen = new Set<string>();

  for (const exam of exams) {
    const title = exam.subject || ((exam as Record<string, unknown>).kcmc as string) || "";
    if (!title || seen.has(title)) continue;
    seen.add(title);

    const sksj = ((exam as Record<string, unknown>).sksj as string) || "";
    if (!sksj) continue;

    const segments = sksj.split(";").filter(Boolean);

    for (const seg of segments) {
      const weekdayMatch = seg.match(/星期([一二三四五六日天])/);
      const periodMatch = seg.match(/第(\d+)-?(\d+)?节/);
      const weeksMatch = seg.match(/\{(\d+)-(\d+)周\}/);

      if (!weekdayMatch) continue;

      const weekdayMap = WEEKDAY_CN;
      const weekday = weekdayMap[weekdayMatch[1]] || 0;

      const startPeriod = periodMatch ? parseInt(periodMatch[1], 10) : 0;
      const endPeriod = periodMatch?.[2] ? parseInt(periodMatch[2], 10) : startPeriod;
      const periods: number[] = [];
      for (let i = startPeriod; i <= endPeriod; i++) periods.push(i);

      const weeks = weeksMatch ? `${weeksMatch[1]}-${weeksMatch[2]}` : "";

      const teacher = ((exam as Record<string, unknown>).jsxx as string) || "";
      const teacherName = teacher.split("/").pop() || teacher;
      const location = ((exam as Record<string, unknown>).cdmc as string) || "";

      courses.push({
        title,
        weekday,
        periods,
        weeks,
        location,
        teacher: teacherName,
      });
    }
  }

  return courses;
}

/**
 * 清理周次规格字符串 - 去掉"周"字后缀
 */
function cleanWeekSpec(spec: string): string {
  return spec.replace(/周/g, "").trim();
}

function parsePeriods(jc: string): number[] {
  const match = jc.match(/(\d+)-(\d+)/);
  if (match) {
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    const periods: number[] = [];
    for (let i = start; i <= end; i++) periods.push(i);
    return periods;
  }
  const single = parseInt(jc, 10);
  if (single > 0) return [single];
  return [];
}

// ── 考试抓取 ────────────────────────────────────────────────

/** 智能考试安排抓取：未指定学期时按候选列表探测（与课表同一套学期策略） */
export async function fetchExamsSmart(
  cookie: string,
  xnm?: number,
  xqm?: number,
): Promise<FetchResult<ExamResult>> {
  const candidates = xnm && xqm ? [{ year: xnm, semester: xqm }] : candidateXnxqList();

  const failures: string[] = [];

  for (const c of candidates) {
    const r = await fetchExamsFor(cookie, c.year, c.semester);
    if (!r.ok) {
      if (r.error === SESSION_DOWN) {
        throw new RaptorError("SESSION_EXPIRED", "教务会话已失效（可能被服务端提前下线）");
      }
      failures.push(`${termLabel(c.year, c.semester)}：${r.error}`);
      continue;
    }
    if (r.data.length > 0) {
      return { ok: true, data: { ...c, label: termLabel(c.year, c.semester), exams: r.data } };
    }
  }

  if (failures.length === candidates.length) {
    return { ok: false, error: `考试查询失败：${failures.join("；")}` };
  }

  const first = candidates[0];
  return { ok: true, data: { ...first, label: termLabel(first.year, first.semester), exams: [] } };
}

/** 抓取指定单个学期的考试安排 */
async function fetchExamsFor(
  cookie: string,
  year: number,
  semester: number,
): Promise<FetchResult<ExamData[]>> {
  const client = createClient(BASE, cookie);

  const resp = await client.req("/kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358105", {
    method: "POST",
    body: `xnm=${year}&xqm=${semester}&_search=false&nd=${Date.now()}&queryModel.showCount=100&queryModel.currentPage=1`,
  });

  const failure = httpFailure(resp);
  if (failure) return { ok: false, error: failure };
  if (isSessionExpired(resp.body)) {
    return { ok: false, error: SESSION_DOWN };
  }

  try {
    const data = JSON.parse(resp.body) as { items?: Array<Record<string, unknown>> };
    const items = data?.items || [];
    return {
      ok: true,
      data: items.map((item: Record<string, unknown>) => ({
        subject: (item.kcmc as string) || "",
        date: (item.ksrq as string) || "",
        time: (item.kssj as string) || "",
        location: (item.cdmc as string) || "",
        seatNumber: (item.zwh as string) || "",
        ...item,
      })),
    };
  } catch {
    return { ok: false, error: "考试接口响应非 JSON（页面结构可能已改版）" };
  }
}

// ── 叠加到课表周分组 ─────────────────────────────────────────

/**
 * 把假期/调休叠加到 buildWeekIndex 的周分组上（实现在 core/academic-utils，
 * 节次时间段按本校作息表渲染）。返回新数组（不改入参）；没有特殊日的周与
 * 原分组完全一致。
 */
export function annotateWeekGroups(
  courses: CourseData[],
  week1Monday: string,
  groups: WeekGroup[],
): AnnotatedWeekGroup[] {
  return annotateWith(courses, week1Monday, groups, periodTimeRange);
}
