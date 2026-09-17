/**
 * 知识库工具：manage_knowledge
 *
 * 把对话里值得沉淀的知识写进本地知识库（src/knowledge.ts 落盘
 * data/knowledge.json），课表页 /today 的「知识」卡片与 /knowledge 页
 * 都能看到。课程归属由 matchKnowledgeCategory 统一裁决：只认课表真实
 * 课程，对不上保持未分类。
 */

import { tool } from "ai";
import { z } from "zod";

import { addKnowledge, deleteKnowledge, listKnowledge, updateKnowledge } from "../knowledge";

/** 结果摘要里的分类统计，如「高等数学 ×1、未分类 ×2」 */
function categorySummary(entries: Array<{ category: string | null }>): string {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = e.category ?? "未分类";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} ×${n}`);
  return parts.length ? `（${parts.join("、")}）` : "";
}

export const knowledgeTools = {
  /** 知识库维护 */
  manage_knowledge: tool({
    description:
      "知识库维护（本地持久，课表页 /today 的「知识」卡片与 /knowledge 页都能看到）。用户说出值得长期保留的知识（课程概念、公式、解题方法、结论、经验总结——用户自己讲出的，或明确说「记住这个」）时主动调 add：title 一句话概括、content 写知识本身；能看出属于哪门课就传 subject（优先用课表课程名如「高等数学」，俗称「高数」也能自动对应），看不出来就省略 subject 落「未分类」，不要编造课程名；问「我记过哪些知识」用 list；改内容/归属用 update；删用 delete。闲聊、提问、查询指令、待办安排不要记进知识库；拿不准要不要记时先问用户一句。",
    inputSchema: z.object({
      action: z
        .enum(["add", "list", "update", "delete"])
        .describe(
          "add=批量记录知识，list=列出知识（可按分类/关键词筛），update=按 id 修改，delete=按 id 删除",
        ),
      items: z
        .array(
          z.object({
            title: z.string().describe("知识标题（≤80 字），如「洛必达法则」"),
            content: z.string().describe("知识内容（≤2000 字）：概念/公式/方法/结论本身"),
            subject: z
              .string()
              .optional()
              .describe("所属课程（优先用课表课程名，如「高等数学」；不属于任何课程就省略）"),
          }),
        )
        .optional()
        .describe("add 必填：一批知识条目（至多 10 条）"),
      category: z.string().optional().describe("list 时按课程分类筛选；传空字符串表示只看未分类"),
      keyword: z.string().optional().describe("list 时按关键词检索标题与内容"),
      id: z.string().optional().describe("目标条目 id（update/delete 必填，来自 list 结果）"),
      title: z.string().optional().describe("update 时的新标题"),
      content: z.string().optional().describe("update 时的新内容"),
      subject: z
        .string()
        .optional()
        .describe("update 时重新归属课程（对得上课表课程就归类，对不上落回未分类）"),
    }),
    execute: async ({ action, items, category, keyword, id, title, content, subject }) => {
      if (action === "add") {
        if (!items?.length) return { error: "add 需要 items（至少一条知识）" };
        if (items.length > 10) return { error: "一次最多记录 10 条知识" };
        const saved: Array<{ id: string; title: string; category: string | null }> = [];
        let updatedExisting = 0;
        for (const item of items) {
          if (!item.title.trim() || !item.content.trim())
            return { error: `「${item.title || "未命名"}」需要标题与内容` };
          try {
            const result = addKnowledge({ ...item, source: "对话" });
            if (result.updatedExisting) updatedExisting++;
            saved.push({
              id: result.entry.id,
              title: result.entry.title,
              category: result.entry.category,
            });
          } catch (error) {
            return { error: error instanceof Error ? error.message : `「${item.title}」记录失败` };
          }
        }
        const added = saved.length - updatedExisting;
        return {
          ok: true,
          summary:
            `已${added ? `记录 ${added} 条知识` : ""}` +
            (updatedExisting ? `${added ? "、" : ""}更新 ${updatedExisting} 条同名知识` : "") +
            categorySummary(saved),
          saved,
        };
      }
      if (action === "list") {
        let entries = listKnowledge();
        if (category !== undefined) {
          const want = category.trim();
          entries = want
            ? entries.filter((e) => e.category === want)
            : entries.filter((e) => !e.category);
        }
        if (keyword?.trim()) {
          const kw = keyword.trim().toLowerCase();
          entries = entries.filter(
            (e) => e.title.toLowerCase().includes(kw) || e.content.toLowerCase().includes(kw),
          );
        }
        const shown = entries.slice(0, 30);
        const counts = new Map<string, number>();
        for (const e of listKnowledge()) {
          const key = e.category ?? "未分类";
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return {
          summary:
            `共 ${entries.length} 条知识` +
            (entries.length > shown.length ? `（仅示前 ${shown.length} 条，可加 keyword 筛）` : ""),
          knowledge: shown,
          categories: [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name, n]) => ({ category: name, count: n })),
          note: entries.length ? undefined : "知识库还是空的",
        };
      }
      if (action === "update") {
        if (!id) return { error: "update 需要 id（先 list 拿到）" };
        try {
          const updated = updateKnowledge(id, {
            ...(title !== undefined ? { title } : {}),
            ...(content !== undefined ? { content } : {}),
            ...(subject !== undefined ? { subject } : {}),
          });
          return updated
            ? {
                ok: true,
                summary: updated.category
                  ? `知识已更新（归入「${updated.category}」）`
                  : "知识已更新（未分类）",
                updated,
              }
            : { error: `未找到知识 ${id}` };
        } catch (error) {
          return { error: error instanceof Error ? error.message : "更新失败" };
        }
      }
      // delete
      if (!id) return { error: "delete 需要 id（先 list 拿到）" };
      return deleteKnowledge(id)
        ? { ok: true, summary: "知识已删除", deletedId: id }
        : { error: `未找到知识 ${id}` };
    },
  }),
};
