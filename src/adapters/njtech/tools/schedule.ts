/**
 * 课表与校历工具：get_schedule / set_holidays
 * （set_holidays 是跨校通用工具，实现在 core/tools/holidays，此处并入工具集）
 */

import { isDeepStrictEqual } from "node:util";
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
      "查询课表，返回每门课的上课时间、地点、教师、周次。**默认走本地缓存不登录教务**（缓存由上一次显式刷新或首次查询建立）；仅当用户明确说「刷新课表 / 最新的 / 刚改的 / 重新查一下」时才传 refresh=true 强刷。指定 semester 时永远联网（缓存只保最新学期）。返回的 byWeek 是按周预分组好的索引（week -> 该周的课，已格式化可直接引用）：用户问「第一周的课」「第 5 周有什么」「这周哪几天有课」时，直接查 byWeek 对应 week 即可，不要自己解析 courses[].weeks 里的周次表达式。byWeek 里没有的周次即该周无课。注意：week 里带 holiday 字段表示该周放假日（普通课表作废，直接按放假安排回答），带 makeup 字段是调休补课日按被换周几课表补出的行——这两类覆盖普通课表，别按原始周一~周日回答。specialDays 是已落盘的全部放假/调休安排，todaySpecial 是今天的。",
    inputSchema: z.object({
      semester: z
        .string()
        .optional()
        .describe("指定学期，格式如「2026-2027-1」或「2025-2026-2」；不填则自动探测最新学期"),
      refresh: z
        .boolean()
        .optional()
        .describe(
          "true=忽略本地缓存强制登录教务拉最新（仅在用户明确说「刷新/最新/重新查」时传）；不传或 false=优先用本地缓存，缓存不存在才联网",
        ),
    }),
    execute: async ({ semester, refresh }) => {
      const parsed = semester ? parseSemesterString(semester) : null;
      if (semester && !parsed) {
        return { error: `学期格式无法解析：「${semester}」，应为「2026-2027-1」这类格式` };
      }
      let term: ScheduleResult | null = null;
      let staleAt: number | undefined; // 在线失败降级到缓存
      let fromCacheAt: number | undefined; // 主动走缓存（refresh !== true）

      // ── 缓存优先分支：不 refresh 且未指定学期时，先读盘直接返回 ──
      // 指定 semester 时缓存里没有对应学期数据（saveScheduleCache 只写自动探测结果），
      // 必须联网。这是「只有调用才获取」原则下唯一保留的默认联网路径。
      if (!refresh && !semester) {
        const cached = loadScheduleCache();
        if (cached) {
          term = cached.schedule;
          fromCacheAt = cached.savedAt;
        }
      }

      // ── 联网分支：refresh=true / 无缓存 / 指定学期 ──
      if (!term) {
        try {
          // 会话失效自动重登一次：死 cookie 熬满 25 分钟 TTL 期间不再持续报错
          const r = await withAuthRetry((c) =>
            fetchScheduleSmart(c, parsed?.year, parsed?.semester),
          );
          if (r.ok) {
            term = r.data;
            // 未指定学期（即自动探测的最新学期）时才写回缓存；
            // 且与旧缓存做结构化 diff，不同才落盘（避免无意义写盘）
            if (!semester) {
              const old = loadScheduleCache();
              if (!old || !isDeepStrictEqual(old.schedule, term)) {
                saveScheduleCache(term);
              }
            }
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
      }

      const schedule: ScheduleResult = term;
      const week = currentWeekOf(schedule.year, schedule.semester);
      // 假期/调休按日期叠周需要 week1Monday；currentWeekOf 在假期里返回 null，
      // 但周分组照样要标注，所以直接从真值源取
      const week1Monday =
        week?.week1Monday ?? resolveWeek1Monday(schedule.year, schedule.semester).week1Monday;
      const now = new Date();
      const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const today = specialOnDate(todayIso);
      const specialDays = listSpecialDays();
      return {
        term: schedule.label,
        currentWeek: week ? `第 ${week.week} 周` : "未开学或不在教学周内",
        week1Monday: week?.week1Monday,
        /** recorded=通知实测 / known=人工校准 / estimated=按月份估算 */
        weekSource: week?.source,
        weekNote: !week
          ? undefined
          : week.source === "estimated"
            ? `⚠️ 开学日期是估算值（${week.evidence ?? "未见校历原文"}），把报到注册通知链接发我可校准`
            : week.evidence,
        total: schedule.courses.length,
        courses: schedule.courses.map((c) => ({
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
        byWeek: annotateWeekGroups(schedule.courses, week1Monday, buildWeekIndex(schedule.courses)),
        /** 已落盘的放假/调休安排（空数组 = 教务处还没发通知，没记录） */
        specialDays,
        specialDaysSource: loadHolidayStore().source,
        // 放假/调休的唯一合法来源是教务处通知：没有落盘记录时明确提醒模型
        // 去查通知，而不是让它拿校历或印象回答「国庆放几天」这类问题
        specialDaysNote: specialDays.length
          ? undefined
          : "尚无放假/调休落盘记录。法定节假日（国庆/元旦/清明/五一/端午/中秋/寒暑假）的具体安排以教务处通知为准：用户问放假安排、或问的课表周临近节假日时，先 get_news 查「放假/调休」相关通知，读到就 read_notice + set_holidays 落盘；查无通知再按「按国务院文件执行、另行通知」回答。",
        todaySpecial: today ? { date: todayIso, ...today } : undefined,
        /** true = 本次未联网，数据来自本地缓存（主动策略或失败降级） */
        fromCache: fromCacheAt !== undefined || staleAt !== undefined ? true : undefined,
        savedAt: fromCacheAt ?? staleAt,
        staleNote:
          staleAt !== undefined
            ? `⚠️ 教务在线查询失败，这是本地缓存的最后已知课表（保存于 ${new Date(staleAt).toLocaleString("zh-CN")}），可能已过期；网络恢复后再问一次课表即可刷新。`
            : fromCacheAt !== undefined
              ? `ℹ️ 本次未联网，返回本地缓存课表（保存于 ${new Date(fromCacheAt).toLocaleString("zh-CN")}）。用户若明确要「最新/刷新/刚改的」课表，重新调用并传 refresh=true。`
              : undefined,
        note:
          schedule.courses.length === 0
            ? "课表已查通但无排课（假期或学期未排课属正常）"
            : undefined,
      };
    },
  }),

  // set_holidays：放假/调休落盘（跨校通用，实现见 core/tools/holidays）
  ...holidaysTools,
};
