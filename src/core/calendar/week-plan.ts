/**
 * 周计划：某天实际要上的课 — 课表周视图的单一换算真值
 *
 * 从 today-brief.ts 提取：网页今日/课表页与课表 SVG 导出（core/schedule-svg.ts）
 * 需要同一份「放假日清空、调休日按被补周几换课表、单双周按周次过滤」的
 * 换算逻辑，放 core 里共用，避免两处实现各自漂移。
 */

import type { CourseData } from "../model";
import { school } from "../school";
import { specialOnDate } from "./holidays";

const DAY_MS = 86400000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地时区的 YYYY-MM-DD（教学周换算按本地日历日，不跨时区） */
export function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** JS 周日=0 -> 教学周 weekday（周一=1 … 周日=7） */
export function weekdayOf(d: Date): number {
  return ((d.getDay() + 6) % 7) + 1;
}

/** 某天在本学期的教学周号；开学前/无法归周返回 null */
export function weekOfDate(iso: string, week1Monday: string): number | null {
  const diff = Math.floor(
    (new Date(`${iso}T00:00:00`).getTime() - new Date(`${week1Monday}T00:00:00`).getTime()) /
      DAY_MS,
  );
  return diff < 0 ? null : Math.floor(diff / 7) + 1;
}

export interface DayPlan {
  holiday?: string;
  makeup?: boolean;
  /** 该日按调休换算后要上的课 */
  courses: CourseData[];
}

/** 某天实际要上的课：放假日清空，调休日按被补周几的课表（都叠上周次过滤） */
export function planForDate(courses: CourseData[], iso: string, week1Monday: string): DayPlan {
  const special = specialOnDate(iso);
  if (special?.type === "holiday") return { holiday: special.name ?? "放假", courses: [] };
  const weekday =
    special?.type === "makeup" && special.follows
      ? special.follows
      : weekdayOf(new Date(`${iso}T00:00:00`));
  const week = weekOfDate(iso, week1Monday);
  if (week == null) return { courses: [] };
  const effective = courses.filter(
    (c) => c.weekday === weekday && school().terms.expandWeeks(c.weeks).includes(week),
  );
  effective.sort((a, b) => (a.periods[0] ?? 99) - (b.periods[0] ?? 99));
  return {
    ...(special?.type === "makeup" ? { makeup: true } : {}),
    courses: effective,
  };
}
