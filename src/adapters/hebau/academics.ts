/**
 * 河北农大教务规则与智能抓取：学期口径（秋冬/春夏）、候选学期探测、节次作息、
 * 课表/考试的 Smart 层（候选学期逐个试，取第一个有数据的）。
 *
 * 跨校通用的纯计算（周次展开/学期解析/周分组/假期叠加）都在 core/academic-utils，
 * 这里只持有本校规则：春夏学期占 2～7 月（比南工大宽一个月，7 月还在考试周，
 * 不能像南工大那样 7 月就探秋学期）、自己的节次表与开学日期真值。
 */

import {
  type AnnotatedWeekGroup,
  annotateWeekGroups as annotateWith,
  buildWeekIndex as buildIndexWith,
  courseLineBody as courseLineWith,
  periodTimeRangeOf,
} from "../../core/academic-utils";
import { RaptorError } from "../../core/errors";
import type { FetchResult } from "../../core/fetch-result";
import type { CourseData, ExamResult, ScheduleResult, WeekGroup } from "../../core/model";
import { fetchHebauExams } from "./exams";
import { fetchHebauSchedule } from "./schedule";

export type { AnnotatedWeekGroup } from "../../core/academic-utils";
export { expandWeeks, parseSemesterString, WEEKDAY_NAMES } from "../../core/academic-utils";
export { currentWeekOf, resolveWeek1Monday } from "./term-dates";

// ── 节次作息表 ────────────────────────────────────────────────

/** 河北农业大学：第 1 节 08:00，下午 14:30 起，晚自习 18:40 起（与南工大不同，勿共用） */
export const HEBAU_PERIOD_TIMES: Record<string, string> = {
  "1": "08:00-08:45",
  "2": "08:55-09:40",
  "3": "10:10-10:55",
  "4": "11:05-11:50",
  "5": "14:30-15:15",
  "6": "15:25-16:10",
  "7": "16:20-17:05",
  "8": "17:15-18:00",
  "9": "18:40-19:25",
  "10": "19:35-20:20",
};

/** 节次号 -> 上课时间段，如 [7,8] -> "16:20-18:00"（作息表是本校规则） */
export function periodTimeRange(periods: number[]): string | undefined {
  return periodTimeRangeOf(HEBAU_PERIOD_TIMES, periods);
}

// ── 学期口径 ──────────────────────────────────────────────────

/** 河北农大的学期展示名用「秋冬/春夏」（URP 官方口径），不是「第一/第二」 */
export function hebauTermLabel(year: number, semester: number): string {
  return `${year}-${year + 1}学年${semester === 3 ? "秋冬" : "春夏"}学期`;
}

/** 春夏学期覆盖的月份区间（含端点）：2～7 月（7 月初还有考试周） */
export const HEBAU_SECOND_SEMESTER_MONTHS = [2, 7] as const;

/**
 * 候选学期（新到旧）。与 core 的 candidateTerms 分支结构一致，差别只在
 * 春夏学期的月份区间换成学校自己的：
 * - m >= 9：秋冬学期进行中
 * - hi < m < 9：假期/交界（河农大仅 8 月），新学期课表通常已生成，先探秋冬
 * - m <= hi：春夏学期进行中（学年始于上一年）
 * 参数化的 window 版本供测试逐月对照南工大口径。
 */
export function candidateTermsIn(
  months: readonly [number, number],
  now: Date = new Date(),
): Array<{ year: number; semester: number }> {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const [, hi] = months;
  if (m >= 9) {
    return [
      { year: y, semester: 3 },
      { year: y - 1, semester: 12 },
    ];
  }
  if (m > hi) {
    return [
      { year: y, semester: 3 },
      { year: y - 1, semester: 12 },
      { year: y - 1, semester: 3 },
    ];
  }
  return [
    { year: y - 1, semester: 12 },
    { year: y - 1, semester: 3 },
  ];
}

export function hebauCandidateTerms(now: Date = new Date()) {
  return candidateTermsIn(HEBAU_SECOND_SEMESTER_MONTHS, now);
}

// ── 周分组与课表行渲染（core 通用实现 + 本校节次表）────────────

/** 课程行去掉星期后的主体（节次 · 时间 · 课程 · 地点 · 教师） */
export function courseLineBody(c: CourseData): string {
  return courseLineWith(c, periodTimeRange);
}

/** 按周预分组课表：week -> 该周实际要上的课（core 实现，本校节次表渲染） */
export function buildWeekIndex(courses: CourseData[]): WeekGroup[] {
  return buildIndexWith(courses, periodTimeRange);
}

/** 把假期/调休叠加到周分组上（core 实现，本校节次表渲染） */
export function annotateWeekGroups(
  courses: CourseData[],
  week1Monday: string,
  groups: WeekGroup[],
): AnnotatedWeekGroup[] {
  return annotateWith(courses, week1Monday, groups, periodTimeRange);
}

// ── 智能抓取（候选学期探测）──────────────────────────────────

/** URP 会话失效的可读信号（urp.ts 的错误文案里带这两个词） */
function isSessionDown(error: string): boolean {
  return /会话已失效|重新登录/.test(error);
}

/**
 * 智能课表抓取：未指定学期时按候选列表探测，返回第一个有数据的学期。
 * 语义约定与 njtech 一致：
 * - ok=false：全部候选学期都没拿到数据（断网/会话失效/接口改版），如实上报；
 * - ok=true 且 courses 为空：确实查到了、但就是没排课（假期属正常）。
 */
export async function fetchScheduleSmart(
  cookie: string,
  xnm?: number,
  xqm?: number,
): Promise<FetchResult<ScheduleResult>> {
  const candidates = xnm && xqm ? [{ year: xnm, semester: xqm }] : hebauCandidateTerms();

  const failures: string[] = [];

  for (const c of candidates) {
    const r = await fetchHebauSchedule(cookie, c.year, c.semester);
    if (!r.ok) {
      if (isSessionDown(r.error)) {
        throw new RaptorError("SESSION_EXPIRED", "河北农大教务会话已失效（可能被服务端提前下线）");
      }
      failures.push(`${hebauTermLabel(c.year, c.semester)}：${r.error}`);
      continue;
    }
    if (r.data.length > 0) {
      return {
        ok: true,
        data: { ...c, label: hebauTermLabel(c.year, c.semester), courses: r.data },
      };
    }
  }

  if (failures.length === candidates.length) {
    return { ok: false, error: `课表查询失败：${failures.join("；")}` };
  }

  // 至少有一个学期查通了但没排课：保持「假期空课表」语义
  const first = candidates[0];
  return {
    ok: true,
    data: { ...first, label: hebauTermLabel(first.year, first.semester), courses: [] },
  };
}

/** 智能考试安排抓取：未指定学期时按候选列表探测（与课表同一套学期策略） */
export async function fetchExamsSmart(
  cookie: string,
  xnm?: number,
  xqm?: number,
): Promise<FetchResult<ExamResult>> {
  const candidates = xnm && xqm ? [{ year: xnm, semester: xqm }] : hebauCandidateTerms();

  const failures: string[] = [];

  for (const c of candidates) {
    const r = await fetchHebauExams(cookie, c.year, c.semester);
    if (!r.ok) {
      if (isSessionDown(r.error)) {
        throw new RaptorError("SESSION_EXPIRED", "河北农大教务会话已失效（可能被服务端提前下线）");
      }
      failures.push(`${hebauTermLabel(c.year, c.semester)}：${r.error}`);
      continue;
    }
    if (r.data.length > 0) {
      return { ok: true, data: { ...c, label: hebauTermLabel(c.year, c.semester), exams: r.data } };
    }
  }

  if (failures.length === candidates.length) {
    return { ok: false, error: `考试查询失败：${failures.join("；")}` };
  }

  const first = candidates[0];
  return {
    ok: true,
    data: { ...first, label: hebauTermLabel(first.year, first.semester), exams: [] },
  };
}
