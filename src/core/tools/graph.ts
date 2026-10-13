/**
 * 读书人物图谱工具：manage_graph
 *
 * 把用户边读书边口述的人物与关系写进 data/graph.json（见 core/graph-store），
 * 独立 /graph 页的画板能直接看。用户丢一句「宝玉是贾母的孙子」，这里就往图谱里
 * 长一条线。
 *
 * 三条铁律（来自防幻觉设计，写进 description 强制约束）：
 * 1. 只抽取不生成——只记用户明确说过的，绝不用预训练知识补人物与关系（那是剧透，也是污染）
 * 2. evidence 必须是用户输入里的原句，没有就留空，禁止编造
 * 3. category 只能取 graph-categories.ts 的 6 类闭集，防止同义词泛滥
 */

import { tool } from "ai";
import { z } from "zod";

import { GRAPH_CATEGORIES, type GraphCategory, isGraphCategory } from "../graph-categories";
import {
  addAlias,
  addRelation,
  clearGraph,
  createBook,
  deletePerson,
  deleteRelation,
  findRelation,
  getGraph,
  listBooks,
  relationsOfPerson,
  resolveBookId,
  updatePerson,
  updateRelation,
} from "../graph-store";

const CATEGORY_ENUM = Object.keys(GRAPH_CATEGORIES) as [GraphCategory, ...GraphCategory[]];

/** 摘要里的分类统计，如「血缘亲属 ×3、友情同盟 ×2」 */
function categorySummary(relations: Array<{ category: string }>): string {
  if (!relations.length) return "";
  const counts = new Map<string, number>();
  for (const r of relations) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, n]) => `${GRAPH_CATEGORIES[id as GraphCategory]?.name ?? id} ×${n}`);
  return parts.length ? `（${parts.join("、")}）` : "";
}

export const graphTools = {
  /** 读书人物关系图谱维护 */
  manage_graph: tool({
    description:
      "读书人物关系图谱（本地持久，/graph 页有画板可以直接看）。用户口述书中人物与关系时调用。三条铁律：一、只抽取不生成——只记用户明确说过的，绝不用你对该书的既有知识补充人物或关系（那是剧透，也是污染），用户没说的就等于不存在；二、evidence 只填用户输入里的原句，没有就留空，禁止编造；三、category 只能取血缘亲属/婚姻爱情/友情同盟/敌对冲突/尊卑从属/其他这 6 类之一（血缘亲属=父母子女兄妹祖孙叔侄表亲，婚姻爱情=夫妻恋人暗恋，友情同盟=朋友挚友同窗结拜盟友，敌对冲突=仇人对手情敌背叛，尊卑从属=师徒上下级主仆君臣雇佣，其他=邻居同事室友），label 则填具体关系词（如「父亲」「暗恋」「师徒」）。用法：用户说「张三是李四的父亲」用 action=add_relation；说「宝玉又叫宝二爷」用 action=merge_person；说「把张三改叫张小明」用 action=update_person；说「我记错了删掉张三」用 action=delete_person（连带删除其全部关系）；说「删掉张三和李四的仇人关系」用 action=delete_relation；说「清空图谱重来」用 action=clear_graph（危险，必须先口头跟用户确认）；用户问「贾宝玉和林黛玉什么关系」先用 action=query_person 查图再答，图里没有就直说不知道，绝不靠记忆编；action=list 看全图。闲聊提问、非小说场景不要往图谱里塞东西；拿不准人物关系时先问用户一句。",
    inputSchema: z.object({
      action: z
        .enum([
          "add_relation",
          "merge_person",
          "update_person",
          "update_relation",
          "delete_person",
          "delete_relation",
          "clear_graph",
          "query_person",
          "list",
          "new_book",
        ])
        .describe(
          "add_relation=新增关系，merge_person=别名合并（同一人不同称呼），update_person=改主名/备注/重要度，update_relation=修正已有关系，delete_person=删人物（连带关系），delete_relation=删单条关系，clear_graph=清空整本图谱（危险），query_person=查某人全部关系，list=看图谱全貌，new_book=新建一本书的图谱",
        ),
      book: z
        .string()
        .optional()
        .describe("书名（如「红楼梦」）。不传就用当前默认书；用户明确提到新书才传"),
      from: z.string().optional().describe("add_relation：关系发出方人物名（不存在会自动创建）"),
      to: z.string().optional().describe("add_relation：关系接收方人物名（不存在会自动创建）"),
      category: z
        .enum(CATEGORY_ENUM)
        .optional()
        .describe("add_relation 必填：关系类别，只能取这 6 类之一"),
      label: z
        .string()
        .optional()
        .describe("add_relation：具体关系词，如「父亲」「暗恋」「师徒」「同窗」"),
      evidence: z
        .string()
        .optional()
        .describe("add_relation：用户输入里的原句证据，用户没给原句就留空，禁止编造"),
      chapter: z.string().optional().describe("add_relation：出处章节，如「第 3 回」"),
      directed: z
        .boolean()
        .optional()
        .describe(
          "add_relation：关系是否有方向。暗恋/上司/师徒=true 有向；朋友/同学/同窗=false 无向。不确定就省略",
        ),
      relations: z
        .array(
          z.object({
            from: z.string().describe("关系发出方人物名"),
            to: z.string().describe("关系接收方人物名"),
            category: z.enum(CATEGORY_ENUM).describe("关系类别，6 类闭集之一"),
            label: z.string().describe("具体关系词，如「父亲」「暗恋」"),
            evidence: z.string().optional().describe("用户输入里的原句，没有就留空"),
            chapter: z.string().optional().describe("出处章节"),
            directed: z.boolean().optional().describe("是否有方向；不确定就省略"),
          }),
        )
        .optional()
        .describe("add_relation 批量用：用户一口气给了整段原文时逐条抽取（至多 20 条）"),
      name: z
        .string()
        .optional()
        .describe("update_person/delete_person/query_person：要操作的人物名（主名或别名均可）"),
      alias: z.string().optional().describe("merge_person：并入 canonical 的那个称呼"),
      canonical: z.string().optional().describe("merge_person：保留的主名"),
      newName: z.string().optional().describe("update_person：新的主名"),
      note: z.string().optional().describe("update_person：新的身份备注，如「荣国府二少爷」"),
      importance: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("update_person：重要度 1-3，主要人物 3、次要 2、路人 1，影响画板节点大小"),
      relFrom: z
        .string()
        .optional()
        .describe("update_relation/delete_relation：定位原关系用的人物名"),
      relTo: z
        .string()
        .optional()
        .describe("update_relation/delete_relation：定位原关系用的人物名"),
      relLabel: z
        .string()
        .optional()
        .describe("update_relation/delete_relation：原关系词（定位用）"),
      newLabel: z.string().optional().describe("update_relation：新的关系词"),
      newCategory: z.enum(CATEGORY_ENUM).optional().describe("update_relation：新的类别"),
    }),
    execute: async ({
      action,
      book,
      from,
      to,
      category,
      label,
      evidence,
      chapter,
      directed,
      relations,
      name,
      alias,
      canonical,
      newName,
      note,
      importance,
      relFrom,
      relTo,
      relLabel,
      newLabel,
      newCategory,
    }) => {
      // 显式白名单守卫：zod 的 enum 在真实链路会先拦一道，但 execute 也可能
      // 被直接调用（测试、未来的复用）。action 认不出来就报错，绝不静默落到
      // 末尾的 new_book 分支去建一本新书——那是最难察觉的一类误操作。
      const ACTIONS = new Set([
        "add_relation",
        "merge_person",
        "update_person",
        "update_relation",
        "delete_person",
        "delete_relation",
        "clear_graph",
        "query_person",
        "list",
        "new_book",
      ]);
      if (typeof action !== "string" || !ACTIONS.has(action)) {
        return {
          error: `未知 action：${String(action ?? "（空）")}。可用：${[...ACTIONS].join(" / ")}`,
        };
      }

      const bookId = resolveBookId(book, book);
      // graphDirty=true 让 web 层知道该推图谱事件；snapshot 一并带上，
      // 前端对话区当场就能重绘，不必再拉一次 /api/graph
      const dirty = (extra: Record<string, unknown>) => ({
        graphDirty: true,
        bookId,
        snapshot: getGraph(bookId),
        categories: GRAPH_CATEGORIES,
        ...extra,
      });

      if (action === "add_relation") {
        const batch = relations?.length
          ? relations
          : from && to && category && label
            ? [{ from, to, category, label, evidence, chapter, directed }]
            : null;
        if (!batch?.length)
          return {
            error: "add_relation 需要 from / to / category / label（或用 relations 批量传）",
          };
        if (batch.length > 20) return { error: "一次最多新增 20 条关系" };

        const saved: Array<{ from: string; to: string; label: string; category: GraphCategory }> =
          [];
        const duplicates: string[] = [];
        for (const r of batch) {
          if (!r.from.trim() || !r.to.trim()) return { error: "关系的两端人物名都不能为空" };
          if (!isGraphCategory(r.category)) return { error: `未知关系类别：${r.category}` };
          if (!r.label.trim()) return { error: `「${r.from} → ${r.to}」缺少具体关系词` };
          try {
            const { duplicate } = addRelation(bookId, r.from, r.to, r.category, r.label, {
              evidence: r.evidence,
              chapter: r.chapter,
              directed: r.directed,
            });
            if (duplicate) duplicates.push(`${r.from} —${r.label}→ ${r.to}`);
            else saved.push({ from: r.from, to: r.to, label: r.label, category: r.category });
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : `「${r.from} → ${r.to}」新增失败`,
            };
          }
        }
        const summary =
          (saved.length ? `已新增 ${saved.length} 条关系` : "") +
          (duplicates.length
            ? `${saved.length ? "，" : ""}${duplicates.length} 条已存在未重复添加`
            : "") +
          categorySummary(saved);
        if (!saved.length && !duplicates.length) return { error: "没有可新增的关系" };
        return { ok: true, summary: summary || "关系未变化", saved, duplicates, ...dirty({}) };
      }

      if (action === "merge_person") {
        if (!canonical?.trim() || !alias?.trim())
          return { error: "merge_person 需要 canonical 与 alias" };
        if (canonical.trim() === alias.trim()) return { error: "主名与别名相同，无需合并" };
        try {
          const person = addAlias(bookId, canonical, alias);
          return {
            ok: true,
            summary: `别名合并：「${alias.trim()}」并入「${person.name}」`,
            ...dirty({ person }),
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : "别名合并失败" };
        }
      }

      if (action === "update_person") {
        if (!name?.trim()) return { error: "update_person 需要 name（要改的人物）" };
        if (newName === undefined && note === undefined && importance === undefined)
          return { error: "update_person 需要至少一个待改字段（newName / note / importance）" };
        const result = updatePerson(bookId, name, {
          ...(newName !== undefined ? { newName } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(importance !== undefined ? { importance } : {}),
        });
        if ("error" in result) return { error: result.error };
        const parts: string[] = [];
        if (newName !== undefined && result.person.name !== result.oldName)
          parts.push(`主名改为「${result.person.name}」`);
        if (note !== undefined) parts.push(`备注改为「${note}」`);
        if (importance !== undefined) parts.push(`重要度 ${importance}`);
        return {
          ok: true,
          summary: `已修改人物：${result.oldName}（${parts.join("，")}）`,
          ...dirty({ person: result.person }),
        };
      }

      if (action === "update_relation") {
        if (!relFrom?.trim() || !relTo?.trim() || !relLabel?.trim())
          return { error: "update_relation 需要 relFrom / relTo / relLabel（定位原关系）" };
        if (
          newLabel === undefined &&
          newCategory === undefined &&
          directed === undefined &&
          evidence === undefined &&
          chapter === undefined
        )
          return {
            error:
              "update_relation 需要至少一个待改字段（newLabel / newCategory / directed / evidence / chapter）",
          };
        const result = updateRelation(bookId, relFrom, relTo, relLabel, {
          ...(newLabel !== undefined ? { newLabel } : {}),
          ...(newCategory !== undefined ? { newCategory } : {}),
          ...(directed !== undefined ? { directed } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
          ...(chapter !== undefined ? { chapter } : {}),
        });
        if ("error" in result) return { error: result.error };
        return {
          ok: true,
          summary: `已修正关系：${relFrom} —${result.relation.label}→ ${relTo}`,
          ...dirty({ relation: result.relation }),
        };
      }

      if (action === "delete_person") {
        if (!name?.trim()) return { error: "delete_person 需要 name" };
        const found = relationsOfPerson(bookId, name);
        if (!found) return { error: `图谱里没有「${name}」这个人物` };
        const removed = deletePerson(bookId, found.person.id);
        return {
          ok: true,
          summary: `已删除人物：${found.person.name}（连带 ${removed} 条关系）`,
          ...dirty({ deletedPerson: found.person.name, removedRelations: removed }),
        };
      }

      if (action === "delete_relation") {
        if (!relFrom?.trim() || !relTo?.trim() || !relLabel?.trim())
          return { error: "delete_relation 需要 relFrom / relTo / relLabel（定位那条关系）" };
        const found = findRelation(bookId, relFrom, relTo, relLabel);
        if (!found) return { error: `没找到「${relFrom} —${relLabel}→ ${relTo}」这条关系` };
        deleteRelation(bookId, found.id);
        return {
          ok: true,
          summary: `已删除关系：${found.fromName} —${found.label}→ ${found.toName}`,
          ...dirty({ deletedRelation: found.label }),
        };
      }

      if (action === "clear_graph") {
        const removed = clearGraph(bookId);
        return {
          ok: true,
          summary: `已清空当前图谱（${removed.persons} 个人物、${removed.relations} 条关系）`,
          ...dirty({ cleared: removed }),
        };
      }

      if (action === "query_person") {
        if (!name?.trim()) return { error: "query_person 需要 name" };
        const found = relationsOfPerson(bookId, name);
        if (!found)
          return {
            summary: `图谱里没有「${name.trim()}」这个人物`,
            note: "如实告诉用户图里没有这个人，不要靠对这本书的记忆回答",
          };
        return {
          summary:
            `${found.person.name}：${found.relations.length} 条关系` +
            categorySummary(found.relations) +
            (found.person.aliases.length ? `（又称 ${found.person.aliases.join("、")}）` : ""),
          person: found.person,
          relations: found.relations.map((r) => ({
            from: r.sourceName,
            to: r.targetName,
            label: r.label,
            category: r.category,
            directed: r.directed,
            evidence: r.evidence || undefined,
            chapter: r.chapter || undefined,
          })),
        };
      }

      if (action === "list") {
        const graph = getGraph(bookId);
        const books = listBooks();
        return {
          summary:
            `共 ${graph.persons.length} 个人物、${graph.relations.length} 条关系` +
            categorySummary(graph.relations) +
            (books.length > 1
              ? `（本机有 ${books.length} 本书：${books.map((b) => `《${b.title}》`).join("、")}）`
              : ""),
          bookId,
          persons: graph.persons.slice(0, 60).map((p) => ({
            name: p.name,
            aliases: p.aliases,
            note: p.note || undefined,
            importance: p.importance,
          })),
          relations: graph.relations.slice(0, 80).map((r) => ({
            from: r.sourceName,
            to: r.targetName,
            label: r.label,
            category: r.category,
          })),
          truncated: graph.persons.length > 60 || graph.relations.length > 80 || undefined,
          note: graph.persons.length ? undefined : "图谱还是空的，可以让用户开始口述人物关系",
        };
      }

      // new_book
      const created = createBook(book ?? "");
      return {
        ok: true,
        summary: `已新建《${created.title}》的人物图谱`,
        graphDirty: true,
        bookId: created.id,
        snapshot: getGraph(created.id),
        categories: GRAPH_CATEGORIES,
      };
    },
  }),
};
