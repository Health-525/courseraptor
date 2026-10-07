/**
 * 手动课表模式的课表工具：get_schedule（本地缓存）+ set_holidays（通用）
 *
 * 没有教务在线链路——课表来自用户在设置页导入的
 * data/schedule-cache.json，查不到就抛「请先配置」口径的错（网页端
 * NEED_SETUP_RE 命中后自动推出设置面板，用户顺着「学校」栏目去导入）。
 */

import { tool } from "ai";
import { z } from "zod";
import { annotateWeekGroups, buildWeekIndex } from "../../../core/academic-utils";
import { listSpecialDays, loadHolidayStore, specialOnDate } from "../../../core/calendar/holidays";
import type { ScheduleResult } from "../../../core/model";
import { loadScheduleCache } from "../../../core/schedule-cache";
import { holidaysTools } from "../../../core/tools/holidays";
import * as academics from "../academics";

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

export const customScheduleTools = {
  /** 课表查询（手动导入的本地缓存） */
  get_schedule: tool({
    description:
      "查询课表（用户手动导入的本地缓存，非教务在线数据），返回每门课的上课时间、地点、教师、周次。byWeek 是按周预分组好的索引（week -> 该周的课，已格式化可直接引用）：用户问「第一周的课」「这周哪几天有课」时直接查 byWeek，不要自己解析 courses[].weeks。week 里带 holiday 字段表示该周放假日（普通课表作废），makeup 是调休补课日按被换周几课表补出的行。指定 semester 只在恰好对上缓存学期时有效（本地只存一份课表）。",
    inputSchema: z.object({
      semester: z
        .string()
        .optional()
        .describe("指定学期，格式如「2026-2027-1」；不填则用当前缓存里的学期"),
    }),
    execute: async ({ semester }) => {
      const cached = loadScheduleCache();
      if (!cached) {
        // 「请先配置」口径：网页端据此自动推出设置面板
        throw new Error(
          "尚未导入课表：请先配置——功能大厅 → 设置 → 学校 → 导入课表，粘贴文字课表或上传文件，AI 解析后即可查询",
        );
      }
      const term: ScheduleResult = cached.schedule;
      if (semester) {
        const parsed = academics.parseSemesterString(semester);
        if (!parsed) {
          return { error: `学期格式无法解析：「${semester}」，应为「2026-2027-1」这类格式` };
        }
        if (parsed.year !== term.year || parsed.semester !== term.semester) {
          return {
            error: `本地只有「${term.label}」的导入课表；要换学期请到 设置 → 学校 → 导入课表 重新导入`,
          };
        }
      }
      const week = academics.currentWeekOf(term.year, term.semester);
      const week1Monday =
        week?.week1Monday ?? academics.resolveWeek1Monday(term.year, term.semester).week1Monday;
      const today = specialOnDate(todayIso());
      const specialDays = listSpecialDays();
      return {
        term: term.label,
        source: "manual",
        currentWeek: week ? `第 ${week.week} 周` : "未开学或不在教学周内",
        week1Monday: week?.week1Monday,
        /** recorded=导入时记录 / estimated=按日历估算 */
        weekSource: week?.source,
        weekNote:
          week?.source === "estimated"
            ? "⚠️ 开学日期是估算值，在 设置 → 学校 → 导入课表 里填开学日期即可校准"
            : week?.evidence,
        total: term.courses.length,
        courses: term.courses.map((c) => ({
          title: c.title,
          weekday: academics.weekdayName(c.weekday),
          periods: c.periods.join(","),
          time: academics.periodTimeRange(c.periods),
          weeks: c.weeks,
          location: c.location,
          teacher: c.teacher,
        })),
        byWeek: annotateWeekGroups(
          term.courses,
          week1Monday,
          buildWeekIndex(term.courses, academics.periodTimeRange),
          academics.periodTimeRange,
        ),
        specialDays,
        specialDaysSource: loadHolidayStore().source,
        specialDaysNote: specialDays.length
          ? undefined
          : "尚无放假/调休落盘记录。用户转述放假安排时调 set_holidays 落盘，之后课表自动叠加。",
        todaySpecial: today ? { date: todayIso(), ...today } : undefined,
        note: !term.courses.length ? "导入的课表为空（可以重新导入）" : undefined,
      };
    },
  }),

  ...holidaysTools,
};
