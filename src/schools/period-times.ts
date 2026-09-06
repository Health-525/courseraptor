/**
 * 各校节次时间表 —— 唯一真值
 *
 * 为什么单独一个叶子模块：节次号 → 上课时间这件事看起来归「课表抓取」管，
 * 但真正用到它的是三处下游（get_schedule 的 time 字段、buildWeekIndex 的预格式化行、
 * 日历导出与 TUI 启动面板）。如果让抓取模块去 import 学校注册表拿表，就成环了
 * （academics → registry → njtech 适配器 → academics）。所以把表放叶子模块：
 * 下游只 import 这里，适配器也从这里取，谁都不绕。
 *
 * 南工大与河北农大的第 1 节差 10 分钟、下午差 30 分钟。共用一张表的话，
 * 河农大的课会集体早/晚 10-30 分钟出现在日历里——这种错很难被肉眼发现。
 */

import { config } from "../config";

/** 南京工业大学：每节 45 分钟，课间 10 分钟（第 1 节 08:10） */
export const NJTECH_PERIOD_TIMES: Record<string, string> = {
  "1": "08:10-08:55",
  "2": "09:05-09:50",
  "3": "10:20-11:05",
  "4": "11:15-12:00",
  "5": "14:00-14:45",
  "6": "14:55-15:40",
  "7": "16:00-16:45",
  "8": "16:55-17:40",
  "9": "19:00-19:45",
  "10": "19:55-20:40",
};

/** 河北农业大学：第 1 节 08:00，下午 14:30 起，晚自习 18:40 起 */
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

const TABLES: Record<string, Record<string, string>> = {
  njtech: NJTECH_PERIOD_TIMES,
  hebau: HEBAU_PERIOD_TIMES,
};

/** 按学校取节次表；未登记的学校退回南工大表（当前只有这两套教务） */
export function periodTableFor(schoolId: string): Record<string, string> {
  return TABLES[schoolId] ?? NJTECH_PERIOD_TIMES;
}

/** 当前生效学校的节次表 */
export function activePeriodTable(): Record<string, string> {
  return periodTableFor(config.school);
}

/** 节次号 -> 起止时间，如 [7,8] -> "16:00-17:40"。表里没有该节次时返回 undefined */
export function periodTimeRangeWith(
  table: Record<string, string>,
  periods: number[],
): string | undefined {
  if (!periods.length) return undefined;
  const first = table[String(periods[0])];
  const last = table[String(periods[periods.length - 1])];
  if (!first || !last) return undefined;
  return `${first.split("-")[0]}-${last.split("-")[1]}`;
}
