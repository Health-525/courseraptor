/**
 * 课表与校历工具：get_schedule / set_holidays
 */

import { tool } from "ai";
import { z } from "zod";
import {
  buildWeekIndex,
  currentWeekOf,
  fetchScheduleSmart,
  parseSemesterString,
  periodTimeRange,
  resolveWeek1Monday,
  WEEKDAY_NAMES,
} from "../jwgl/academics";
import {
  annotateWeekGroups,
  listSpecialDays,
  loadHolidayStore,
  recordSpecialDays,
  removeSpecialDays,
  type SpecialDayRecord,
  specialOnDate,
} from "../jwgl/term-holidays";
import { saveScheduleCache } from "../schedule-cache";
import { getCookie } from "./session";

export const scheduleTools = {
  /** 课表查询 */
  get_schedule: tool({
    description:
      "查询课表，返回每门课的上课时间、地点、教师、周次。默认自动探测最新有课表的学期（学期交界期也不会查错）；也可指定学期，如「2026-2027-1」。返回的 byWeek 是按周预分组好的索引（week -> 该周的课，已格式化可直接引用）：用户问「第一周的课」「第 5 周有什么」「这周哪几天有课」时，直接查 byWeek 对应 week 即可，不要自己解析 courses[].weeks 里的周次表达式。byWeek 里没有的周次即该周无课。注意：week 里带 holiday 字段表示该周放假日（普通课表作废，直接按放假安排回答），带 makeup 字段是调休补课日按被换周几课表补出的行——这两类覆盖普通课表，别按原始周一~周日回答。specialDays 是已落盘的全部放假/调休安排，todaySpecial 是今天的。",
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
      const cookie = await getCookie();
      const r = await fetchScheduleSmart(cookie, parsed?.year, parsed?.semester);
      // 拿不到 ≠ 没有：断网/会话失效必须如实说，不能让用户以为这学期没课
      if (!r.ok) {
        return {
          error: `课表查询失败：${r.error}。这与「课表为空」不是一回事，请检查网络或稍后重试。`,
        };
      }
      const term = r.data;
      // 未指定学期（即自动探测的最新学期）时顺带刷新本地缓存，
      // TUI 启动面板读缓存就够，不必每次登录都请求教务系统
      if (!semester) saveScheduleCache(term);
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
            ? `⚠️ 开学日期是估算值（${week.evidence ?? "未见校历原文"}），把报到注册通知链接发我可校准`
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
         * 用户问「第一周的课」「第 5 周有什么」时直接查表，不要再自己解析
         * weeks 字段里的 "2-6,8-12" 这类表达式——那部分已由工具层算好。
         * 只含有课的周；缺失的周次即该周无课。
         * holiday=该周放假日（课表作废）；makeup=调休补课行（按被换周几的课表）。
         */
        byWeek: annotateWeekGroups(term.courses, week1Monday, buildWeekIndex(term.courses)),
        /** 已落盘的放假/调休安排（空数组 = 教务处还没发通知，没记录） */
        specialDays,
        specialDaysSource: loadHolidayStore().source,
        // 放假/调休的唯一合法来源是教务处通知：没有落盘记录时明确提醒模型
        // 去查通知，而不是让它拿校历或印象回答「国庆放几天」这类问题
        specialDaysNote: specialDays.length
          ? undefined
          : "尚无放假/调休落盘记录。法定节假日（国庆/元旦/清明/五一/端午/中秋/寒暑假）的具体安排以教务处通知为准：用户问放假安排、或问的课表周临近节假日时，先 get_news 查「放假/调休」相关通知，读到就 read_notice + set_holidays 落盘；查无通知再按「按国务院文件执行、另行通知」回答。",
        todaySpecial: today ? { date: todayIso, ...today } : undefined,
        note:
          term.courses.length === 0 ? "课表已查通但无排课（假期或学期未排课属正常）" : undefined,
      };
    },
  }),

  /** 放假/调休落盘 */
  set_holidays: tool({
    description:
      "记录放假/调休安排到本地日历（get_schedule 之后的查询会自动叠加）。触发时机：教务处发布放假安排通知（get_news 标题含「放假」「调休」「节假日」）或用户转述放假安排时。流程：先 read_notice 读通知正文，把安排逐日拆成 days——放假日传 type=holiday + name（节日名）；调休补课日（如「10月10日（星期六）上课」）传 type=makeup + follows=按周几的课表上课（1-7=周一～周日）。同日期重复写入以新记录为准；通知更正/撤回某天时传 remove 数组删除。",
    inputSchema: z.object({
      days: z
        .array(
          z.object({
            date: z.string().describe("日期，YYYY-MM-DD"),
            type: z.enum(["holiday", "makeup"]),
            name: z.string().optional().describe("holiday：节日名，如「国庆节」"),
            follows: z
              .number()
              .int()
              .min(1)
              .max(7)
              .optional()
              .describe("makeup 必填：按周几的课表上课（1-7=周一～周日）"),
          }),
        )
        .min(1)
        .describe("逐日安排（通知里的每一天一条）"),
      remove: z.array(z.string()).optional().describe("要删除记录的日期（通知更正/撤回时用）"),
      source: z.string().optional().describe("依据：通知标题或文号"),
    }),
    execute: async ({ days, remove, source }) => {
      const removed = remove?.length ? removeSpecialDays(remove) : 0;
      const r = recordSpecialDays(days as SpecialDayRecord[], source);
      if (r.rejected.length) {
        return {
          recorded: r.recorded,
          removed,
          error: `以下日期无效（格式应为 YYYY-MM-DD，且 makeup 必须带 follows）：${r.rejected.join("、")}。请核对通知原文后重试。`,
        };
      }
      const holidays = days.filter((d) => d.type === "holiday").length;
      return {
        recorded: r.recorded,
        removed,
        summary: `已落盘 ${r.recorded} 天（放假 ${holidays} 天、调休补课 ${r.recorded - holidays} 天）${source ? `，依据：${source}` : ""}。之后 get_schedule 会自动叠加。`,
      };
    },
  }),
};
