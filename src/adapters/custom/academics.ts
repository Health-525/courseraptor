/**
 * 自定义学校（其他学校）的学期规则
 *
 * 没有教务系统可问，真值只有两个来源：用户导入课表时填的开学日期
 * （加密落盘在 credentials）与通用日历估算。作息表用常见大学模式兜底
 * （08:00 起、每节 45 分钟、课间 10 分钟），只影响时间段展示——节次
 * 本身才是课表真值，作息不准不影响排课。
 */

import {
  candidateTerms,
  expandWeeks,
  parseSemesterString,
  periodTimeRangeOf,
  termLabel,
  WEEKDAY_NAMES,
} from "../../core/academic-utils";
import { manualTermKey, manualTermStarts } from "../../core/manual-terms";
import type { TermStartDate } from "../../core/model";
import type { WeekSnapshot } from "../../core/school";

/** 兜底作息表（常见大学模式）：仅用于把节次渲染成时间段 */
export const DEFAULT_PERIOD_TIMES: Record<string, string> = {
  "1": "08:00-08:45",
  "2": "08:55-09:40",
  "3": "10:00-10:45",
  "4": "10:55-11:40",
  "5": "14:00-14:45",
  "6": "14:55-15:40",
  "7": "16:00-16:45",
  "8": "16:55-17:40",
  "9": "19:00-19:45",
  "10": "19:55-20:40",
  "11": "20:50-21:35",
  "12": "21:45-22:30",
};

/** 学期在 customTermStarts 里的键与读写实现在 core/manual-terms（web 提交导入时也要写） */
export {
  manualTermKey as termKey,
  manualTermStarts as customTermStarts,
  recordManualTermStart,
} from "../../core/manual-terms";

/** d 起（含）第一个周一的 ISO 日期 */
function firstMondayOnOrAfter(d: Date): string {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const shift = (8 - date.getDay()) % 7; // 1=周一 → 0
  date.setDate(date.getDate() + shift);
  return isoOf(date);
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** 无记录时按日历估算：秋学期按 9 月 1 日起第一个周一，春学期按 2 月下旬第一个周一 */
function estimateWeek1Monday(year: number, semester: number): TermStartDate {
  return semester === 3
    ? {
        week1Monday: firstMondayOnOrAfter(new Date(year, 8, 1)),
        source: "estimated",
        evidence: "按 9 月 1 日起第一个周一估算；导入课表时填开学日期即可校准",
      }
    : {
        week1Monday: firstMondayOnOrAfter(new Date(year + 1, 1, 17)),
        source: "estimated",
        evidence: "按 2 月中下旬第一个周一估算；导入课表时填开学日期即可校准",
      };
}

/** 某学期第 1 周周一：导入时记录的为准，没有给估算值（如实标 source） */
export function resolveWeek1Monday(year: number, semester: number): TermStartDate {
  const recorded = manualTermStarts()[manualTermKey(year, semester)];
  if (recorded && /^\d{4}-\d{2}-\d{2}$/.test(recorded)) {
    return { week1Monday: recorded, source: "recorded", evidence: "导入课表时记录的开学日期" };
  }
  return estimateWeek1Monday(year, semester);
}

/** 教学周上限：超过按「不在教学周」处理（假期/学期结束） */
const MAX_WEEK = 26;

/** 某学期当前第几教学周；未开学或超上限返回 null */
export function currentWeekOf(
  year: number,
  semester: number,
  now: Date = new Date(),
): WeekSnapshot | null {
  const { week1Monday, source, evidence } = resolveWeek1Monday(year, semester);
  const start = new Date(`${week1Monday}T00:00:00`).getTime();
  const today = new Date(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}T00:00:00`,
  ).getTime();
  const week = Math.floor((today - start) / 86_400_000 / 7) + 1;
  if (week < 1 || week > MAX_WEEK) return null;
  return { week, week1Monday, source, ...(evidence ? { evidence } : {}) };
}

export {
  candidateTerms,
  expandWeeks,
  parseSemesterString,
  periodTimeRangeOf,
  termLabel,
  WEEKDAY_NAMES,
};

export function periodTimeRange(periods: number[]): string | undefined {
  return periodTimeRangeOf(DEFAULT_PERIOD_TIMES, periods);
}

export function periodTime(period: number): string | undefined {
  return DEFAULT_PERIOD_TIMES[String(period)];
}

export function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? `周${weekday}`;
}
