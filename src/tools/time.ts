/**
 * 时间工具：get_time
 */

import { tool } from "ai";
import { z } from "zod";

import { getTimeReport, SCHOOL_TIMEZONE } from "../time";

export const timeTools = {
  /** 时间查询：模型的唯一时钟 */
  get_time: tool({
    description:
      "查当前时间：日期、星期几、时刻、时区换算，以及本学期教学周（第几周、本周一~周日日期、距开学倒计时）。你没有内置时钟，训练数据里的「今天」必然过时——凡涉及时间的判断都必须先调本工具拿真实时间：今天几号/周几、现在第几周、明天/后天/下周三几号、距离某截止日还有几天、通知是否已过期，一律先查再说，禁止凭印象推「今天」。查别国时间传 timezone（IANA 名，如 America/New_York、UTC），默认北京时间。",
    inputSchema: z.object({
      timezone: z
        .string()
        .optional()
        .describe("IANA 时区名，如「America/New_York」「UTC」；不填默认北京时间"),
    }),
    execute: async ({ timezone }) => {
      const tz = timezone?.trim() || SCHOOL_TIMEZONE;
      const r = getTimeReport(tz);
      if (!r.ok) {
        // 与课表/天气同一套契约：时区不认识就如实报错，不许猜一个时间
        return { error: r.error };
      }
      return r.data;
    },
  }),
};
