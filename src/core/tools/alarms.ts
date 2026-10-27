/**
 * 定时提醒工具：manage_alarms
 *
 * 用户明确要到点被提醒的「闹钟」：一次性 / 每天 / 每周。与 manage_todos
 * 的分工——有截止日期的事项（交作业、报名）记待办；到点要做动作的
 * （叫我、提醒我）设定时提醒。数据与功能大厅共用 data/alarms.json。
 */

import { tool } from "ai";
import { z } from "zod";

import {
  type Alarm,
  addAlarm,
  deleteAlarm,
  listAlarms,
  nextDueMoment,
  updateAlarm,
} from "../alarms";

const whenSchema = z.union([
  z.object({
    type: z.literal("once"),
    at: z
      .string()
      .describe("一次性时刻（绝对时间，如 2026-11-02T08:00:00；相对日期先调 get_time 换算）"),
  }),
  z.object({
    type: z.literal("daily"),
    time: z.string().describe("每天的时刻，HH:MM 24 小时制，如 22:30"),
  }),
  z.object({
    type: z.literal("weekly"),
    weekday: z.number().describe("星期几，0=周日、1=周一 … 6=周六"),
    time: z.string().describe("当天的时刻，HH:MM 24 小时制"),
  }),
]);

/** list 时给每条补上下次触发时刻，模型能直接答「下次什么时候提醒我」 */
function withNextDue(alarm: Alarm): Alarm & { nextDue: string | null } {
  const due = nextDueMoment(alarm.trigger, new Date());
  return { ...alarm, nextDue: due ? due.toISOString() : null };
}

export const alarmTools = {
  /** 定时提醒维护 */
  manage_alarms: tool({
    description:
      "定时提醒（定点闹钟）维护（本地持久）。用户要在某个时刻被提醒时主动调 add：「明早 8 点叫我交材料」是一次性（once，at 填绝对时间，相对日期先调 get_time 换算，时刻必须在未来），「每天 22:30 提醒背单词」是 daily，「每周五 17:00 提醒还书」是 weekly（weekday 0=周日…6=周六），一次说几条就一批记全；问「我有哪些提醒/闹钟」用 list（带下次提醒时间）；update 改时间、改内容或启停（enabled=false 暂停）；不要了用 delete。与 manage_todos 分工：有截止日期的事项记待办，到点要做动作的记这里。提醒依赖程序在运行（桌面版缩到托盘也算），没开的时间段错过不补发，一次性过期会自动停用。",
    inputSchema: z.object({
      action: z
        .enum(["add", "list", "update", "delete"])
        .describe(
          "add=批量设定时提醒，list=列出提醒，update=按 id 修改（改时间/内容/启停），delete=按 id 删除",
        ),
      items: z
        .array(
          z.object({
            title: z.string().describe("提醒内容（≤100 字），如「背单词」「交实验报告」"),
            when: whenSchema.describe("什么时候提醒"),
            notes: z.string().optional().describe("补充说明（≤500 字）"),
          }),
        )
        .max(10)
        .optional()
        .describe("add 必填：一批提醒条目（至多 10 条）"),
      includeDisabled: z
        .boolean()
        .optional()
        .describe("list 时是否含已停用/已过期，默认只列启用中"),
      id: z.string().optional().describe("目标提醒 id（update/delete 必填，来自 list 结果）"),
      title: z.string().optional().describe("update 时的新提醒内容"),
      notes: z.string().optional().describe("update 时的新补充说明"),
      enabled: z.boolean().optional().describe("update 时启停：false=暂停，true=恢复"),
      when: whenSchema.optional().describe("update 时的新时间"),
    }),
    execute: async ({ action, items, includeDisabled, id, title, notes, enabled, when }) => {
      if (action === "add") {
        if (!items?.length) return { error: "add 需要 items（至少一条提醒）" };
        // 先整体校验再落盘：不让半批提醒进库
        const created: Alarm[] = [];
        try {
          for (const item of items) {
            if (!item.title.trim()) return { error: "每条提醒都需要 title" };
            try {
              created.push(addAlarm({ title: item.title, notes: item.notes, trigger: item.when }));
            } catch (e) {
              throw new Error(`「${item.title}」${(e as Error).message}`);
            }
          }
        } catch (e) {
          for (const a of created) deleteAlarm(a.id);
          return { error: (e as Error).message };
        }
        const active = listAlarms().length;
        return {
          ok: true,
          summary: `已设定 ${created.length} 条提醒（共 ${active} 条启用中），到点桌面通知 + QQ 推送`,
          added: created.map(withNextDue),
        };
      }
      if (action === "list") {
        const alarms = listAlarms(includeDisabled ?? false).map(withNextDue);
        return {
          summary: includeDisabled
            ? `共 ${alarms.length} 条提醒`
            : `${alarms.length} 条启用中的提醒`,
          alarms,
          note: alarms.length ? undefined : "当前没有定时提醒，用户说出要到点被提醒的事即可添加",
        };
      }
      if (action === "update") {
        if (!id) return { error: "update 需要 id（先 list 拿到）" };
        const patch: Record<string, unknown> = {};
        if (enabled !== undefined) patch.enabled = enabled;
        if (title !== undefined) patch.title = title;
        if (notes !== undefined) patch.notes = notes;
        if (when !== undefined) patch.trigger = when;
        try {
          const updated = updateAlarm(id, patch);
          return updated
            ? { ok: true, summary: "提醒已更新", updated: withNextDue(updated) }
            : { error: `未找到提醒 ${id}` };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
      // delete
      if (!id) return { error: "delete 需要 id（先 list 拿到）" };
      return deleteAlarm(id)
        ? { ok: true, summary: "提醒已删除", deletedId: id }
        : { error: `未找到提醒 ${id}` };
    },
  }),
};
