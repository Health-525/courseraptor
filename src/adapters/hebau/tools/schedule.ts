/**
 * 课表与校历工具：get_schedule
 * （set_holidays 是跨校通用工具，实现在 core/tools/holidays，此处并入工具集）
 */

import { tool } from "ai";
import { z } from "zod";
import { listSpecialDays, loadHolidayStore, specialOnDate } from "../../../core/calendar/holidays";
import type { ScheduleResult } from "../../../core/model";
import { loadScheduleCache, saveScheduleCache } from "../../../core/schedule-cache";
import { holidaysTools } from "../../../core/tools/holidays";
import {
  annotateWeekGroups,
  buildWeekIndex,
  currentWeekOf,
  fetchScheduleSmart,
  parseSemesterString,
  periodTimeRange,
  resolveWeek1Monday,
  WEEKDAY_NAMES,
} from "../academics";
import { withAuthRetry } from "../session";

export const scheduleTools = {
  /** 课表查询 */
  get_schedule: tool({
    description:
      "查询课表，返回每门课的上课时间、地点、教师、周次。默认自动探测最新有课表的学期（学期交界期也不会查错）；也可指定学期，如「2026-2027-1」。返回的 byWeek 是按周预分组好的索引（week -> 该周的课，已格式化可直接引用）：用户问「第一周的课」「第 5 周有什么」「这周哪几天有课」时，直接查 byWeek 对应 week 即可，不要自己解析 courses[].weeks 里的周次表达式。byWeek 里没有的周次即该周无课。注意：week 里带 holiday 字段表示该周放假日（普通课表作废，直接按放假安排回答），带 makeup 字段是调休补课日按被换周几课表补出的行——这两类覆盖普通课表，别按原始周一~周日回答。",
    inputSchema: z.object({
      semester: z
        .string()
        .optional()
        .describe("指定学期，格式如「2026-2027-1」或「2025-2026-2」；不填则自动探测最新学期"),
    }),
    execute: async ({ semester }) => {
      const parsed = semester ? parseSemesterString(semester) : null;
      if (semester && !parsed) {
        return { error: `学期格式无法解析：「${semester}」，应为「2026-2027-1」这类格式` };
      }
      let term: ScheduleResult;
      let staleAt: number | undefined;
      try {
        // 会话失效自动重登一次：死 cookie 熬满 25 分钟 TTL 期间不再持续报错
        const r = await withAuthRetry((c) => fetchScheduleSmart(c, parsed?.year, parsed?.semester));
        if (r.ok) {
          term = r.data;
          // 未指定学期（即自动探测的最新学期）时顺带刷新本地缓存，
          // TUI 启动面板读缓存就够，不必每次登录都请求教务系统
          if (!semester) saveScheduleCache(term);
        } else {
          // 拿不到 ≠ 没有：优先回退「最后已知课表」（磁盘缓存本来就是它），
          // 完全没有缓存才如实报错，不让用户白跑一趟
          const cached = loadScheduleCache();
          if (!cached) {
            return {
              error: `课表查询失败：${r.error}。这与「课表为空」不是一回事，请检查网络或稍后重试。`,
            };
          }
          term = cached.schedule;
          staleAt = cached.savedAt;
        }
      } catch (e) {
        // 网络/登录层故障但本地有最后已知课表：先给结果，如实标注不新鲜
        const cached = loadScheduleCache();
        if (!cached) throw e;
        term = cached.schedule;
        staleAt = cached.savedAt;
      }
      const week = currentWeekOf(term.year, term.semester);
      // 假期/调休按日期叠周需要 week1Monday；currentWeekOf 在假期里返回 null，
      // 但周分组照样要标注，所以直接从真值源取
      const week1Monday =
        week?.week1Monday ?? resolveWeek1Monday(term.year, term.semester).week1Monday;
      const now = new Date();
      const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const today = specialOnDate(todayIso);
      const specialDays = listSpecialDays();
      return {
        term: term.label,
        currentWeek: week ? `第 ${week.week} 周` : "未开学或不在教学周内",
        week1Monday: week?.week1Monday,
        /** recorded=通知实测 / known=人工校准 / estimated=按月份估算 */
        weekSource: week?.source,
        weekNote: !week
          ? undefined
          : week.source === "estimated"
            ? `⚠️ 开学日期是估算值（${week.evidence ?? "未见校历原文"}），可按学校校历自行修正 data/term-dates-hebau.json`
            : week.evidence,
        total: term.courses.length,
        courses: term.courses.map((c) => ({
          title: c.title,
          weekday: WEEKDAY_NAMES[c.weekday] ?? `周${c.weekday}`,
          periods: c.periods.join(","),
          time: periodTimeRange(c.periods),
          weeks: c.weeks,
          location: c.location,
          teacher: c.teacher,
        })),
        /**
         * 按周预分组索引：week -> 该周要上的课（已格式化，可直接引用）。
         * holiday=该周放假日（课表作废）；makeup=调休补课行（按被换周几的课表）。
         */
        byWeek: annotateWeekGroups(term.courses, week1Monday, buildWeekIndex(term.courses)),
        /** 已落盘的放假/调休安排（空数组 = 教务处还没发通知，没记录） */
        specialDays,
        specialDaysSource: loadHolidayStore().source,
        // 河北农大暂无教务通知抓取能力：放假/调休只能靠用户转述后 set_holidays 落盘
        specialDaysNote: specialDays.length
          ? undefined
          : "尚无放假/调休落盘记录。法定节假日（国庆/元旦/清明/五一/端午/中秋/寒暑假）的具体安排以学校通知为准：本校暂未接入教务通知抓取，用户告知放假/调休安排时用 set_holidays 落盘；查无安排再按「按国务院文件执行、另行通知」回答。",
        todaySpecial: today ? { date: todayIso, ...today } : undefined,
        staleNote:
          staleAt !== undefined
            ? `⚠️ 教务在线查询失败，这是本地缓存的最后已知课表（保存于 ${new Date(staleAt).toLocaleString("zh-CN")}），可能已过期；网络恢复后再问一次课表即可刷新。`
            : undefined,
        note:
          term.courses.length === 0 ? "课表已查通但无排课（假期或学期未排课属正常）" : undefined,
      };
    },
  }),

  // set_holidays：放假/调休落盘（跨校通用，实现见 core/tools/holidays）
  ...holidaysTools,
};
