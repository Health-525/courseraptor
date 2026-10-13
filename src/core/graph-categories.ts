/**
 * 关系类别闭集 — 全局唯一真相源
 *
 * label 用具体词（父亲、暗恋、师徒），category 只能从这 6 类里选。
 * 闭集是防「同义词泛滥」的关键：模型自由发挥类别名，图谱就会碎成
 * 「亲情/血亲/亲属关系」三条同义的线，筛选与配色全部失效。
 *
 * 工具层（graph.ts）、规则引擎（graph-rules.ts）、前端画板
 * （graph-page.ts）都从这里取，改一处即全链路生效。
 */

export const GRAPH_CATEGORIES = {
  family: {
    name: "血缘亲属",
    color: "#bf4d28",
    examples: "父亲 母亲 儿子 女儿 兄妹 祖孙 叔侄 表亲",
  },
  romance: { name: "婚姻爱情", color: "#c4566e", examples: "夫妻 恋人 暗恋 未婚妻 情人 追求" },
  friendship: { name: "友情同盟", color: "#47714f", examples: "朋友 挚友 结拜 同窗 盟友" },
  conflict: { name: "敌对冲突", color: "#3f5a73", examples: "仇人 对手 情敌 背叛 追捕 嫉恨" },
  hierarchy: { name: "尊卑从属", color: "#9c6d1e", examples: "师徒 上下级 主仆 君臣 雇佣" },
  other: { name: "其他", color: "#857f74", examples: "邻居 同事 医患 债主" },
} as const;

export type GraphCategory = keyof typeof GRAPH_CATEGORIES;

export const GRAPH_CATEGORY_IDS = Object.keys(GRAPH_CATEGORIES) as GraphCategory[];

export function isGraphCategory(value: unknown): value is GraphCategory {
  return typeof value === "string" && value in GRAPH_CATEGORIES;
}

/** 提示词/图例用的闭集说明列表 */
export function graphCategoryList(): string[] {
  return GRAPH_CATEGORY_IDS.map(
    (k) => `- ${k}（${GRAPH_CATEGORIES[k].name}）：${GRAPH_CATEGORIES[k].examples}`,
  );
}

/** 未知类别（历史数据/模型跑偏）不抛错，退回「其他」的展示色 */
export function categoryColor(id: string): string {
  return isGraphCategory(id) ? GRAPH_CATEGORIES[id].color : GRAPH_CATEGORIES.other.color;
}

export function categoryName(id: string): string {
  return isGraphCategory(id) ? GRAPH_CATEGORIES[id].name : GRAPH_CATEGORIES.other.name;
}
