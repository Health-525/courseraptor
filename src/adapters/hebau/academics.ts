/**
 * 河北农大学期规则与课表/考试 Smart 抓取
 *
 * 跨校通用件（学期候选探测、学期串解析、周次展开、课表周分组）全部来自
 * core/academic-utils，这里只包一层河北农大的差异：
 * - 学期叫法是「秋冬/春夏学期」（与南工大「第一/第二学期」不同）
 * - 节次作息表不同（第 1 节 08:00，下午 14:30 起）
 * - URP 用 XNXQDM 字符串学期编码（换算在 urp.ts）
 */

import {
  type AnnotatedWeekGroup,
  annotateWeekGroups as annotateWith,
  buildWeekIndex as buildIndexWith,
  candidateTerms,
  termLabel as coreTermLabel,
  courseLineBody as courseLineOf,
  expandWeeks,
  parseSemesterString as parseSemesterStringCore,
  periodTimeRangeOf,
  WEEKDAY_NAMES,
} from "../../core/academic-utils";
import { RaptorError, SESSION_EXPIRED_MESSAGE } from "../../core/errors";
import type { FetchResult } from "../../core/fetch-result";
import type {
  CourseData,
  ExamData,
  ExamResult,
  ScheduleResult,
  TermCandidate,
  WeekGroup,
} from "../../core/model";
import { fetchHebauExams } from "./exams";
import { HEBAU_PERIOD_TIMES } from "./period-times";
import { fetchHebauSchedule } from "./schedule";
import { currentWeekOf as resolveCurrentWeek, resolveWeek1Monday } from "./term-dates";

export type { AnnotatedWeekGroup } from "../../core/academic-utils";
export { expandWeeks, WEEKDAY_NAMES };

/** 解析学期串（core 通用实现：「2026-2027-1」「2025-2026第2学期」这类格式都认） */
export function parseSemesterString(s: string): TermCandidate | null {
  return parseSemesterStringCore(s);
}

/** 学期候选（core 通用实现：两学期制 3=秋、12=春，交界月优先探新学期） */
export const candidateXnxqList = candidateTerms;

/**
 * 河北农大的学期叫法：秋冬学期 / 春夏学期（校历口径），不是「第一/第二学期」。
 * core 的 termLabel 给的是后者，这里覆写成本校口径。
 */
export function termLabel(year: number, semester: number): string {
  const core = coreTermLabel(year, semester);
  if (semester === 3) return core.replace("第一学期", "秋冬学期");
  if (semester === 12) return core.replace("第二学期", "春夏学期");
  return core;
}

export function currentWeekOf(year: number, semester: number, now: Date = new Date()) {
  return resolveCurrentWeek(year, semester, now);
}

export { resolveWeek1Monday };

// ── 节次作息（河北农大：第 1 节 08:00，下午 14:30 起，晚自习 18:40 起）──────

export const HEBAU_PERIOD_TIMES_TABLE = HEBAU_PERIOD_TIMES;

/** 节次号 -> 上课时间段，如 [7,8] -> "16:20-17:05"（作息表是本校规则） */
export function periodTimeRange(periods: number[]): string | undefined {
  return periodTimeRangeOf(HEBAU_PERIOD_TIMES, periods);
}

export function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? `周${weekday}`;
}

/** 课程行去掉星期后的主体（节次 · 时间 · 课程 · 地点 · 教师），供周分组复用 */
export function courseLineBody(c: CourseData): string {
  return courseLineOf(c, periodTimeRange);
}

/** 按周预分组课表：week -> 该周实际要上的课（只含有课的周） */
export function buildWeekIndex(courses: CourseData[]): WeekGroup[] {
  return buildIndexWith(courses, periodTimeRange);
}

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

// ── Smart 抓取：候选学期探测 + 错误归类 ──────────────────────

/**
 * 智能课表抓取：未指定学期时按候选列表探测，返回第一个有数据的学期。
 *
 * 语义约定（与 njtech 一致）：
 * - 会话失效抛 SESSION_EXPIRED（withAuthRetry 换 cookie 自动重试）
 * - ok=false：全部候选学期都没拿到数据（断网/接口改版），调用方必须如实上报 error，
 *   不许降级成「课表为空」
 * - ok=true 且 courses 为空：确实查到了、但就是没排课（假期属正常）
 */
export async function fetchScheduleSmart(
  cookie: string,
  xnm?: number,
  xqm?: number,
): Promise<FetchResult<ScheduleResult>> {
  const candidates: TermCandidate[] =
    xnm && xqm ? [{ year: xnm, semester: xqm }] : candidateXnxqList();

  const failures: string[] = [];

  for (const c of candidates) {
    let courses: CourseData[];
    try {
      courses = await fetchHebauSchedule(cookie, c.year, c.semester);
    } catch (e) {
      if (e instanceof RaptorError && e.code === "SESSION_EXPIRED") throw e;
      failures.push(`${termLabel(c.year, c.semester)}：${(e as Error).message}`);
      continue;
    }
    if (courses.length > 0) {
      return { ok: true, data: { ...c, label: termLabel(c.year, c.semester), courses } };
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

/** 智能考试抓取：同上语义 */
export async function fetchExamsSmart(
  cookie: string,
  xnm?: number,
  xqm?: number,
): Promise<FetchResult<ExamResult>> {
  const candidates: TermCandidate[] =
    xnm && xqm ? [{ year: xnm, semester: xqm }] : candidateXnxqList();

  const failures: string[] = [];

  for (const c of candidates) {
    let exams: ExamData[];
    try {
      exams = await fetchHebauExams(cookie, c.year, c.semester);
    } catch (e) {
      if (e instanceof RaptorError && e.code === "SESSION_EXPIRED") throw e;
      failures.push(`${termLabel(c.year, c.semester)}：${(e as Error).message}`);
      continue;
    }
    if (exams.length > 0) {
      return { ok: true, data: { ...c, label: termLabel(c.year, c.semester), exams } };
    }
  }

  if (failures.length === candidates.length) {
    return { ok: false, error: `考试查询失败：${failures.join("；")}` };
  }

  const first = candidates[0];
  return {
    ok: true,
    data: { ...first, label: termLabel(first.year, first.semester), exams: [] },
  };
}

// 会话失效哨兵：urp 层抛的 SESSION_EXPIRED 冒泡到这里直接上抛，
// 由 session.withAuthRetry 换新 cookie 重试（哨兵值保留给可能的结构化消费方）
export const SESSION_DOWN = SESSION_EXPIRED_MESSAGE;
