/**
 * 放假/调休落盘工具：set_holidays
 *
 * 从 njtech/tools/schedule.ts 抽出的跨校通用工具：假期日历（core/calendar）
 * 不属于任何学校，自定义学校（手动课表）同样需要「放假那周课表作废、
 * 调休按周几补课」的叠加能力。njtech 侧 re-export 保持工具名不变。
 */

import { tool } from "ai";
import { z } from "zod";
import {
  listSpecialDays,
  loadHolidayStore,
  recordSpecialDays,
  removeSpecialDays,
  type SpecialDayRecord,
} from "../calendar/holidays";

export const holidaysTools = {
  /** 放假/调休落盘 */
  set_holidays: tool({
    description:
      "记录放假/调休安排到本地日历（get_schedule 之后的查询会自动叠加）。触发时机：教务处发布放假安排通知（get_news 标题含「放假」「调休」「节假日」）或用户转述放假安排时。流程：先把安排逐日拆成 days——放假日传 type=holiday + name（节日名）；调休补课日（如「10月10日（星期六）上课」）传 type=makeup + follows=按周几的课表上课（1-7=周一～周日）。同日期重复写入以新记录为准；通知更正/撤回某天时传 remove 数组删除。",
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
        specialDays: listSpecialDays(),
        specialDaysSource: loadHolidayStore().source,
      };
    },
  }),
};
