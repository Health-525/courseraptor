/**
 * NYTDC 教务系统 - 课表 / 考试抓取
 *
 * 与 NJTECH 同为正方新版，接口路径与学期编码（xnm=学年起始年，xqm=3 秋 / 12 春）
 * 完全一致；本文件保留两处**通达特有**的差异：
 *
 * 1. 节次作息表：通达一天 12 节、五大节，上午 7:50 开始（南工大 10 节、8:10 开始）
 * 2. 周次展开：见下方「周次位掩码」一节——正方随课表下发的 oldzc 字段是
 *    周次位掩码，是比 zcd 文本更硬的真值，且证明单双周是**分段生效**的
 */

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
  WeekGroup,
} from "../../core/model";
import { BASE } from "./auth";
import { isSessionExpired } from "./session";
import { currentWeekOf as resolveCurrentWeek } from "./term-dates";

export type { AnnotatedWeekGroup } from "../../core/academic-utils";
export { parseSemesterString, segmentsOverlap, WEEKDAY_NAMES } from "../../core/academic-utils";
export { expandWeeks, termLabel, WEEKDAY_CN };
export const candidateXnxqList = candidateTerms;

/** 会话失效哨兵：fetchXxxFor 向 Smart 层传递用 */
const SESSION_DOWN = SESSION_EXPIRED_MESSAGE;

export type { ExamResult, ScheduleResult, SkwjSegment, WeekGroup } from "../../core/model";
export {
  parseTermRef,
  parseTermStartDate,
  recordWeek1Monday,
  resolveWeek1Monday,
} from "./term-dates";

/** 当前教学周（真值来自 term-dates 单一数据源，返回值带 source） */
export function currentWeekOf(year: number, semester: number, now: Date = new Date()) {
  return resolveCurrentWeek(year, semester, now);
}

// ── NYTDC 节次时间表 ───────────────────────────────────────────
// 来源：教务处官网《南京邮电大学通达学院作息时间表》
// （jwc.nytdc.edu.cn「常用查询 → 作息时间」）。一天 12 节，分五大节：
//   第一大节 1-2 节 / 第二大节 3-5 节 / 第三大节 6-7 节 / 第四大节 8-9 节 / 第五大节 10-12 节
export const NYTDC_PERIOD_TIMES: Record<string, string> = {
  "1": "07:50-08:35",
  "2": "08:40-09:25",
  "3": "09:40-10:25",
  "4": "10:30-11:15",
  "5": "11:20-12:05",
  "6": "14:00-14:45",
  "7": "14:50-15:35",
  "8": "15:45-16:30",
  "9": "16:35-17:20",
  "10": "18:30-19:15",
  "11": "19:20-20:05",
  "12": "20:10-20:55",
};

/** 节次号 -> 上课时间段，如 [3,4] -> "09:40-11:15"（作息表是本校规则） */
export function periodTimeRange(periods: number[]): string | undefined {
  return periodTimeRangeOf(NYTDC_PERIOD_TIMES, periods);
}

// ── 周次：oldzc 位掩码优先 ─────────────────────────────────────
//
// 正方 kbList 每条课同时给两份周次信息：
//   zcd   = 人类可读文本，如 "1-3周,7周,11-17周(单)"
//   oldzc = 周次位掩码，bit(周号-1) = 1 表示该周有课
//
// 实机对照 37 条真实课表记录（2025-2026-2 / 2026-2027-1）结论：
// - 位掩码 37/37 等于「单双周**分段**生效」的展开结果
// - 有 2 条（"1-3周,7周,11-17周(单)" 与 "1-3周(单),6-7周,10-18周"）不等于
//   「单双周作用于整串」的展开结果——后者的第 2 周会被错误滤掉、或第 2 周
//   被错误保留，学生照着看课表就会走错教室
//
// 因此本适配器以位掩码为准，落成不含单双周标记的显式周次串（如 "1-3,7,11,13,15,17"），
// core 的 expandWeeks 对显式串的展开与位掩码逐位一致。

/** 位掩码 -> 周号数组（最多看 40 周；BigInt 避免 32 位位移溢出） */
export function decodeWeekMask(mask: string): number[] {
  const text = String(mask ?? "").trim();
  if (!/^\d+$/.test(text)) return [];
  let n: bigint;
  try {
    n = BigInt(text);
  } catch {
    return [];
  }
  if (n <= 0n) return [];
  const weeks: number[] = [];
  for (let w = 1; w <= 40; w++) {
    if ((n >> BigInt(w - 1)) & 1n) weeks.push(w);
  }
  return weeks;
}

/** 周号数组 -> 紧凑串，如 [1,2,3,7] -> "1-3,7"（无单双周标记，展开即相同集合） */
export function compactWeeks(weeks: number[]): string {
  if (!weeks.length) return "";
  const sorted = [...weeks].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = cur;
    prev = cur;
  }
  return parts.join(",");
}

/**
 * zcd 文本 -> 周号数组，单双周**按段**生效（与正方位掩码语义一致）。
 * 仅在 oldzc 缺失/异常时作为兜底使用。
 */
export function expandWeeksPerSegment(spec: string): number[] {
  if (!spec) return [];
  const out = new Set<number>();
  for (const seg of spec.split(",")) {
    const oddOnly = /[（(]单[)）]/.test(seg);
    const evenOnly = /[（(]双[)）]/.test(seg);
    const m = seg.match(/(\d+)\s*[-~]\s*(\d+)|(\d+)/);
    if (!m) continue;
    const start = parseInt(m[1] ?? m[3], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (let w = Math.min(start, end); w <= Math.max(start, end); w++) {
      if (oddOnly && w % 2 === 0) continue;
      if (evenOnly && w % 2 === 1) continue;
      out.add(w);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 取一条课表记录的周次串：优先位掩码，退化到 zcd 的分段展开。
 * 返回的是显式周次串（"1-3,7"），不是原始 zcd。
 */
export function weeksSpecOf(item: Record<string, unknown>): string {
  const masked = decodeWeekMask(String(item.oldzc ?? ""));
  if (masked.length) return compactWeeks(masked);

  const zcd = String(item.zcd ?? "")
    .replace(/周/g, "")
    .trim();
  const weeks = expandWeeksPerSegment(zcd);
  return weeks.length ? compactWeeks(weeks) : zcd;
}

// ── sksj（上课时间字符串）解析 ────────────────────────────────

/**
 * 解析 sksj（上课时间）字符串为结构化时段数组。
 * 输入格式形如 "星期一第5-6节{2-17周};星期四第5-6节{2-17周}"
 * 每段以 ; 分隔，分别给出星期、节次区间、周次区间。无法解析的段跳过，不抛错。
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

/** 课程行去掉星期后的主体（节次 · 时间 · 课程 · 地点 · 教师） */
export function courseLineBody(c: CourseData): string {
  return courseLineWith(c, periodTimeRange);
}

/** 按周预分组课表：week -> 该周实际要上的课（只含有课的周） */
export function buildWeekIndex(courses: CourseData[]): WeekGroup[] {
  return buildIndexWith(courses, periodTimeRange);
}

/**
 * 把假期/调休叠加到 buildWeekIndex 的周分组上（实现在 core/academic-utils，
 * 节次时间段按本校作息表渲染）。返回新数组（不改入参）。
 */
export function annotateWeekGroups(
  courses: CourseData[],
  week1Monday: string,
  groups: WeekGroup[],
): AnnotatedWeekGroup[] {
  return annotateWith(courses, week1Monday, groups, periodTimeRange);
}

// ── 课表抓取 ────────────────────────────────────────────────

/**
 * 智能课表抓取：未指定学期时按候选列表探测，返回第一个有数据的学期。
 *
 * 语义约定：
 * - ok=false：全部候选学期都没拿到数据（断网/会话失效/接口改版），调用方如实上报
 * - ok=true 且 courses 为空：确实查到了、但就是没排课（假期属正常）
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
        weeks: weeksSpecOf(item),
        location: (item.cdmc as string) || (item.xqmc as string) || "",
        teacher: (item.xm as string) || "",
        ...item,
      })),
    };
  }

  // 学期末正方可能返回空课表 -> 从考试数据反向生成课表
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

    for (const seg of sksj.split(";").filter(Boolean)) {
      const weekdayMatch = seg.match(/星期([一二三四五六日天])/);
      const periodMatch = seg.match(/第(\d+)-?(\d+)?节/);
      const weeksMatch = seg.match(/\{([^}]+)周\}/);

      if (!weekdayMatch) continue;

      const weekday = WEEKDAY_CN[weekdayMatch[1]] || 0;
      const startPeriod = periodMatch ? parseInt(periodMatch[1], 10) : 0;
      const endPeriod = periodMatch?.[2] ? parseInt(periodMatch[2], 10) : startPeriod;
      const periods: number[] = [];
      for (let i = startPeriod; i <= endPeriod; i++) periods.push(i);

      const weeks = weeksMatch ? weeksMatch[1] : "";

      const teacher = ((exam as Record<string, unknown>).jsxx as string) || "";
      const teacherName = teacher.split("/").pop() || teacher;
      const location = ((exam as Record<string, unknown>).cdmc as string) || "";

      courses.push({ title, weekday, periods, weeks, location, teacher: teacherName });
    }
  }

  return courses;
}

function parsePeriods(jc: string): number[] {
  const text = String(jc ?? "");
  const match = text.match(/(\d+)-(\d+)/);
  if (match) {
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    const periods: number[] = [];
    for (let i = start; i <= end; i++) periods.push(i);
    return periods;
  }
  const single = parseInt(text, 10);
  if (single > 0) return [single];
  return [];
}

// ── 考试抓取 ────────────────────────────────────────────────

/**
 * 通达考试接口把日期与时间打包在一个字段里：kssj = "2026-07-04(13:30-15:20)"。
 * 这里拆成 core 约定的 date / time 两段；解析不出括号时间时整串当日期、时间留空。
 */
export function splitExamTime(kssj: string): { date: string; time: string } {
  const text = String(kssj ?? "").trim();
  const m = text.match(/^(\d{4}-\d{1,2}-\d{1,2})\s*(?:[（(]\s*([^)）]+?)\s*[)）])?/);
  if (!m) return { date: text, time: "" };
  return { date: m[1], time: (m[2] ?? "").trim() };
}

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
      data: items.map((item: Record<string, unknown>) => {
        const { date, time } = splitExamTime((item.kssj as string) || "");
        return {
          subject: (item.kcmc as string) || "",
          date: date || (item.ksrq as string) || "",
          time: time || (item.kssj as string) || "",
          location: (item.cdmc as string) || "",
          seatNumber: (item.zwh as string) || "",
          ...item,
        };
      }),
    };
  } catch {
    return { ok: false, error: "考试接口响应非 JSON（页面结构可能已改版）" };
  }
}
