/**
 * 图谱载荷的校验闸：从 manage_graph 的工具结果里挑出合法的图谱快照，
 * SSE 透传前过一道，让对话页能当场重绘画板。
 *
 * 为什么住在 channels：职责是「保护浏览器端渲染器不被模型伪造/畸形的
 * 图谱字段坑到」，唯一消费者是本层的 chat-stream。载荷构造（数据本身）
 * 在 core/graph-store——core 造数据、本层验数据，依赖方向不反向。
 *
 * 校验从严：人物名/关系词限长、端点必须存在、类别必须落在 6 类闭集内、
 * 数量封顶。任一条不过就整份返回 null，宁可前端不重绘，也不画出一张
 * 乱七八糟或直接崩页的图。
 */

import { GRAPH_CATEGORY_IDS } from "../../core/graph-categories";
import type { GraphSnapshot } from "../../core/graph-store";

/**
 * 单次事件透传的规模上限：对话区小画板画不下更多，超出就让用户开 /graph 页。
 * 人物不封顶（节点多不占版面），只对关系封顶。
 */
const RELATION_CAP = 260;
const NAME_CAP = 24;
const LABEL_CAP = 12;
const ALIAS_CAP = 6;
const EVIDENCE_CAP = 200;

const CATEGORY_SET = new Set<string>(GRAPH_CATEGORY_IDS);

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/**
 * 展示用文本：超长截断而非拒收。
 *
 * 人名/关系词超长只是显示不下（画板节点宽度固定），不是数据有问题——
 * 整份拒绝会让一条超长备注把整张图挡在对话区外。截到上限加省略号，
 * 前端照常画得出来。
 */
function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function aliasList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a): a is string => typeof a === "string" && a.length > 0)
    .slice(0, ALIAS_CAP)
    .map((a) => clip(a, NAME_CAP));
}

/**
 * 从工具结果提取可渲染的图谱快照。形状不对返回 null，绝不透传畸形载荷。
 * 只认「带完整 persons + relations 数组」的形态——manage_graph 的变更类
 * action 都经 graphDirty 带 bookId 回传快照，读不出来的忽略即可。
 */
export function graphPayloadOfToolOutput(output: unknown): GraphSnapshot | null {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  if (o.graphDirty !== true) return null;
  const snapshot = o.snapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const s = snapshot as Record<string, unknown>;
  if (typeof s.bookId !== "string" || !s.bookId) return null;
  if (!Array.isArray(s.persons) || !Array.isArray(s.relations)) return null;
  // 空图谱没有重绘价值，前端自己会显示空态
  if (!s.persons.length) return null;

  const ids = new Set<string>();
  const persons = [];
  // 先把人物全过一遍形状闸（不截顶），让下面的关系能拿到完整端点集合
  for (const raw of s.persons) {
    if (typeof raw !== "object" || raw === null) return null;
    const p = raw as Record<string, unknown>;
    const id = str(p.id, 64);
    // id 是画板认节点的唯一依据，缺任一整份拒绝；主名只需非空（过长截断）
    if (!id || typeof p.name !== "string" || !p.name.trim()) return null;
    ids.add(id);
  }
  // 人物可以多（节点多不占地方），但展示字段一律截断
  for (const raw of s.persons) {
    const p = raw as Record<string, unknown>;
    const importance =
      typeof p.importance === "number" && Number.isFinite(p.importance)
        ? Math.min(3, Math.max(1, Math.round(p.importance)))
        : 1;
    persons.push({
      id: str(p.id, 64) as string,
      name: clip(p.name, NAME_CAP),
      aliases: aliasList(p.aliases),
      note: clip(p.note, 60),
      importance,
    });
  }

  // 关系逐条校验：端点必须落在上面那个完整人物集合里，否则画板会画出悬空
  // 连线。端点缺失说明数据真有问题（不是截顶造成的），所以整份拒绝。
  const relations = [];
  for (const raw of s.relations) {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const id = str(r.id, 64);
    const sourceId = str(r.sourceId, 64);
    const targetId = str(r.targetId, 64);
    if (!id || !sourceId || !targetId) return null;
    if (!ids.has(sourceId) || !ids.has(targetId)) return null;
    if (typeof r.category !== "string" || !CATEGORY_SET.has(r.category)) return null;
    // 关系词空着就画不出线上标签，等于没这条线，丢掉即可
    const label = clip(r.label, LABEL_CAP);
    if (!label) continue;
    relations.push({
      id,
      sourceId,
      targetId,
      category: r.category,
      label,
      directed: r.directed !== false,
      evidence: clip(r.evidence, EVIDENCE_CAP),
      chapter: clip(r.chapter, 40),
      sourceName: clip(r.sourceName, NAME_CAP),
      targetName: clip(r.targetName, NAME_CAP),
    });
    // 关系封顶：对话区小画板画不下更多，前 N 条之外交给 /graph 完整页
    if (relations.length >= RELATION_CAP) break;
  }

  return {
    bookId: s.bookId,
    version: typeof s.version === "number" ? s.version : Date.now(),
    persons,
    relations,
  } as GraphSnapshot;
}
