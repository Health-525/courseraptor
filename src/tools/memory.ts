/**
 * 长期记忆工具：save_memory
 */

import { tool } from "ai";
import { z } from "zod";

import {
  addMemory,
  archiveMemory,
  deleteMemory,
  loadMemory,
  updateMemory,
} from "../memory/longterm";

export const memoryTools = {
  /** 长期记忆维护 */
  save_memory: tool({
    description:
      "长期记忆维护（跨会话持久，存于本地 memory.json，启动时自动注入新会话）。值得跨会话记住的信息出现时主动调用：用户偏好（年级/作息）、要抢/盯的目标课程、重要时间结论（选课考试安排）、任务状态。用户说「记住××」必须立即调用。",
    inputSchema: z.object({
      action: z
        .enum(["add", "update", "delete", "list", "archive"])
        .describe(
          "add=新增条目，update=按 id 改内容，delete=按 id 删除，list=列出全部，archive=按 id 归档（事情办完但想留档时用，归档后不再进入提示词）",
        ),
      content: z.string().optional().describe("条目内容（add 必填；update 时为新内容）"),
      category: z
        .string()
        .optional()
        .describe("分类，如「用户偏好」「选课」「任务」（add 可选，默认「事实」）"),
      id: z
        .string()
        .optional()
        .describe("目标条目 id（update/delete/archive 必填，来自 list 或提示词里的 [id]）"),
      expiresAt: z
        .string()
        .optional()
        .describe(
          "过期时间（ISO 日期，如 2026-09-15）。到点后自动不再进入提示词，适合一次性安排/任务类记忆",
        ),
    }),
    execute: async ({ action, content, category, id, expiresAt }) => {
      if (action === "add") {
        if (!content?.trim()) return { error: "add 需要 content" };
        const { entry, total, merged } = await addMemory(
          content.trim(),
          category?.trim() || undefined,
          expiresAt,
        );
        return {
          ok: true,
          saved: entry,
          totalEntries: total,
          merged,
          note: merged ? "与已有条目重复，已合并为较新的表述" : undefined,
        };
      }
      if (action === "archive") {
        if (!id) return { error: "archive 需要 id" };
        const entry = await archiveMemory(id);
        return entry
          ? { ok: true, archived: entry, note: "已归档，后续会话不再注入" }
          : { error: `未找到条目 ${id}` };
      }
      if (action === "update") {
        if (!id || !content?.trim()) return { error: "update 需要 id 和 content（新内容）" };
        const entry = await updateMemory(id, content.trim());
        return entry ? { ok: true, updated: entry } : { error: `未找到条目 ${id}` };
      }
      if (action === "delete") {
        if (!id) return { error: "delete 需要 id" };
        const ok = await deleteMemory(id);
        return ok ? { ok: true, deletedId: id } : { error: `未找到条目 ${id}` };
      }
      const entries = await loadMemory();
      return { total: entries.length, entries };
    },
  }),
};
