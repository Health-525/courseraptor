/**
 * 待办工具：manage_todos
 *
 * 读写网页侧同一份 web-workspace.json 待办（课表页 /today 与对话页
 * 设置里的「截止日期待办」共享），让用户在对话里随口说的安排落进待办。
 */

import { tool } from "ai";
import { z } from "zod";

import { addReminder, deleteReminder, listReminders, updateReminder } from "../workspace-data";

/** 纯日期（2026-09-16）按当天 23:59 本地截止，避免被当成 UTC 零点偏移 8 小时 */
function normalizeDueAt(raw: string): string | null {
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T23:59:00`;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

export const reminderTools = {
  /** 待办维护 */
  manage_todos: tool({
    description:
      "待办维护（本地持久，课表页 /today 与对话页「设置 → 截止日期待办」都能看到）。用户说出自己的待办（「我这周要交高数作业」「记一下周五交实验报告」）时主动调 add，一次说几件事就一批记全；问「我有哪些待办」用 list；办完了用 update 置 done；不要了用 delete。截止时间必须是绝对时间——相对日期（明天/下周五）先调 get_time 换算再传入；只给日期（如 2026-09-16）按当天 23:59 截止；用户没提截止时间就先问一句再记。",
    inputSchema: z.object({
      action: z
        .enum(["add", "list", "update", "delete"])
        .describe(
          "add=批量记录待办，list=列出待办，update=按 id 修改（完成/改时间/改标题），delete=按 id 删除",
        ),
      items: z
        .array(
          z.object({
            title: z.string().describe("待办内容（≤100 字），如「交高数作业」"),
            dueAt: z
              .string()
              .describe(
                "截止时间（绝对时间，如 2026-09-16T23:59:00；相对日期须先用 get_time 换算）",
              ),
            notes: z.string().optional().describe("补充说明（≤500 字）"),
          }),
        )
        .optional()
        .describe("add 必填：一批待办条目（至多 20 条）"),
      includeDone: z.boolean().optional().describe("list 时是否包含已完成，默认只列未完成"),
      id: z.string().optional().describe("目标待办 id（update/delete 必填，来自 list 结果）"),
      title: z.string().optional().describe("update 时的标题"),
      dueAt: z.string().optional().describe("update 时的新截止时间"),
      notes: z.string().optional().describe("update 时的新备注"),
      done: z.boolean().optional().describe("update 时的完成状态（true=已完成）"),
    }),
    execute: async ({ action, items, includeDone, id, title, dueAt, notes, done }) => {
      if (action === "add") {
        if (!items?.length) return { error: "add 需要 items（至少一条待办）" };
        if (items.length > 20) return { error: "一次最多记录 20 条待办" };
        const created = [];
        for (const item of items) {
          if (!item.title.trim()) return { error: "每条待办都需要 title" };
          const normalized = normalizeDueAt(item.dueAt);
          if (!normalized) return { error: `「${item.title}」的截止时间无效：${item.dueAt}` };
          created.push(
            addReminder({
              title: item.title,
              dueAt: normalized,
              ...(item.notes ? { notes: item.notes } : {}),
              source: "对话",
            }),
          );
        }
        const open = listReminders().filter((r) => !r.done).length;
        return {
          ok: true,
          summary: `已记录 ${created.length} 条待办（共 ${open} 条未完成）`,
          added: created,
        };
      }
      if (action === "list") {
        const all = listReminders();
        const todos = includeDone ? all : all.filter((r) => !r.done);
        return {
          summary: includeDone ? `共 ${todos.length} 条待办` : `${todos.length} 条未完成待办`,
          todos,
          note: todos.length ? undefined : "当前没有待办",
        };
      }
      if (action === "update") {
        if (!id) return { error: "update 需要 id（先 list 拿到）" };
        const patch: Record<string, unknown> = {};
        if (done !== undefined) patch.done = done;
        if (title !== undefined) patch.title = title;
        if (dueAt !== undefined) {
          const normalized = normalizeDueAt(dueAt);
          if (!normalized) return { error: `新的截止时间无效：${dueAt}` };
          patch.dueAt = normalized;
        }
        if (notes !== undefined) patch.notes = notes;
        const updated = updateReminder(id, patch);
        return updated
          ? { ok: true, summary: "待办已更新", updated }
          : { error: `未找到待办 ${id}` };
      }
      // delete
      if (!id) return { error: "delete 需要 id（先 list 拿到）" };
      return deleteReminder(id)
        ? { ok: true, summary: "待办已删除", deletedId: id }
        : { error: `未找到待办 ${id}` };
    },
  }),
};
