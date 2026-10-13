/**
 * 中文短句规则引擎 — 无模型也能建图
 *
 * 模型没配好、或用户只是随手丢一句「张三是李四的父亲」时，模型链路
 * 又慢又贵还可能失败。这里用纯正则把这类短句直接解析成操作，秒级
 * 完成、零成本。解析不出来就老实返回空，由模型接管，绝不硬猜。
 *
 * 纯函数无依赖，可直接测。
 */

import { GRAPH_CATEGORIES, type GraphCategory } from "./graph-categories";
import {
  addAlias,
  addRelation,
  clearGraph,
  deletePerson,
  deleteRelationByNames,
  findPerson,
  resolveName,
  updatePerson,
} from "./graph-store";

/* ── 关系词表 ─────────────────────────────────────────────── */

const FAMILY = [
  "父亲",
  "母亲",
  "爸",
  "妈",
  "儿子",
  "女儿",
  "哥哥",
  "姐姐",
  "弟弟",
  "妹妹",
  "兄长",
  "祖父",
  "祖母",
  "爷爷",
  "奶奶",
  "外公",
  "外婆",
  "孙子",
  "孙女",
  "叔叔",
  "伯伯",
  "舅舅",
  "姑姑",
  "姨",
  "婶婶",
  "侄子",
  "侄女",
  "表哥",
  "表姐",
  "表弟",
  "表妹",
  "堂兄",
  "堂弟",
  "堂姐",
  "堂妹",
  "表兄妹",
  "姐弟",
  "兄妹",
  "妯娌",
  "婆媳",
  "翁婿",
  "连襟",
];
const ROMANCE = [
  "妻子",
  "丈夫",
  "老婆",
  "老公",
  "恋人",
  "爱人",
  "未婚妻",
  "未婚夫",
  "未婚夫妻",
  "情人",
  "续弦",
  "妾",
];
const FRIENDSHIP = ["朋友", "挚友", "好友", "结拜兄弟", "结拜", "同窗", "盟友", "伙伴", "兄弟"];
const CONFLICT = ["仇人", "敌人", "对手", "情敌", "死敌", "债主"];
const HIERARCHY = [
  "师父",
  "师傅",
  "徒弟",
  "学生",
  "弟子",
  "上司",
  "下属",
  "主子",
  "仆人",
  "管家",
  "上级",
  "下级",
  "领导",
  "秘书",
];
const OTHER = ["同学", "同事", "邻居", "室友", "医生"];

/** 情感动词 → 类别 + 关系词。动词本身即关系词，不再二次归类 */
const FEELINGS: Record<string, { category: GraphCategory; label: string }> = {
  喜欢: { category: "romance", label: "喜欢" },
  暗恋: { category: "romance", label: "暗恋" },
  仰慕: { category: "romance", label: "仰慕" },
  追求: { category: "romance", label: "追求" },
  讨厌: { category: "conflict", label: "讨厌" },
  嫉妒: { category: "conflict", label: "嫉妒" },
  敬佩: { category: "friendship", label: "敬佩" },
  信任: { category: "friendship", label: "信任" },
  欣赏: { category: "friendship", label: "欣赏" },
  追随: { category: "hierarchy", label: "追随" },
  投靠: { category: "hierarchy", label: "投靠" },
  庇护: { category: "hierarchy", label: "庇护" },
  追杀: { category: "conflict", label: "追杀" },
};

/** 按关系词判类别；判不出返回 null（不进闭集，绝不硬塞进「其他」） */
function classify(relWord: string): GraphCategory | null {
  if (ROMANCE.includes(relWord)) return "romance";
  if (FAMILY.includes(relWord)) return "family";
  if (FRIENDSHIP.includes(relWord)) return "friendship";
  if (CONFLICT.includes(relWord)) return "conflict";
  if (HIERARCHY.includes(relWord)) return "hierarchy";
  if (OTHER.includes(relWord)) return "other";
  return null;
}

/** 无向关系：友情与「其他」类天然对称，画箭头反而误导 */
const BIDIRECTIONAL_LABELS = [
  "朋友",
  "挚友",
  "同窗",
  "同学",
  "结拜",
  "盟友",
  "伙伴",
  "兄弟",
  "邻居",
  "室友",
  "同事",
];

/**
 * 解析出来的人名不能是这些词——否则「他和她是同学」会把「他」当人名建进去。
 * 含代词（他/她/它/我/你/您/咱/谁）、指示词与常见虚词。
 */
const NAME_STOP = new Set([
  "的",
  "是",
  "和",
  "与",
  "就",
  "又",
  "也",
  "叫",
  "做",
  "了",
  "把",
  "被",
  "在",
  "很",
  "都",
  "还",
  "。",
  "，",
  "！",
  "？",
  " ",
  "",
  "他",
  "她",
  "它",
  "我",
  "你",
  "您",
  "咱",
  "谁",
  "其",
  "某",
  "这",
  "那",
  "此",
  "各",
  "有",
  "为",
  "跟",
  "同",
  "和",
  "及",
  "以及",
  "而且",
  "但是",
  "但是",
  "不过",
  "然后",
  "所以",
  "因为",
  "如果",
  "已经",
  "还是",
  "就是",
  "不是",
  "没有",
  "可以",
  "应该",
  "可能",
]);

function cleanName(s: string): string {
  return (s ?? "").replace(/[，。！？、；""''「」『』（）()]/g, "").trim();
}

/**
 * 人名出口闸：非空、不含停用词、且长度合理（三字名以上才算正常人物名，
 * 两字名在小说里够用但一个字必然是切碎的产物）。任一不满足就返回空串，
 * 调用方据此放弃这一条而不是把垃圾名字写进图谱。
 *
 * 另加句尾语气词剔除：「重新开始吧」去掉「吧」是「重新开始」，仍是短语不是
 * 人名。人名不会带「吧/呀/啊/呢/嘛/哦」这类语气词——它们属于说话的那一端。
 */
const TONE_SUFFIX = /[吧呀啊呢嘛哦噢喔嘞呗啦]+$/;

/**
 * 动作短语黑名单：这些是「用户在下指令」而不是「一个人」。
 * 「删掉重新开始吧」里的「重新开始」若被当人名，删的��是空气但会误报；
 * 更危险的是用户真想删一个叫「重来」的人时也会被拦——所以这份名单只收
 * 明确的动补结构，不收可能出现在人名里的字。
 */
const ACTION_PHRASES = [
  "重新开始",
  "重新来",
  "重来",
  "再来",
  "算了",
  "完事",
  "结束",
  "暂停",
  "继续",
  "开始",
  "重来一次",
  "从头",
  "换个",
  "试试",
  "看看",
  "等等",
  "先删",
];

function personName(raw: string): string {
  let name = cleanName(raw);
  if (!name) return "";
  const trimmed = name.replace(TONE_SUFFIX, "");
  // 剥完语气词若为空或过长过短，都说明这不是个人名
  if (!trimmed || trimmed.length > 12) return "";
  name = trimmed;
  if (NAME_STOP.has(name)) return "";
  if (ACTION_PHRASES.includes(name)) return "";
  // 含句内虚词的多字短语（「重新开始」「没有了」之类）不是人名
  for (const stop of NAME_STOP) {
    if (stop.length >= 2 && name.includes(stop)) return "";
  }
  return name;
}

/** 两端都必须是像样的人名，这条关系才成立 */
function pairOk(a: string, b: string): boolean {
  return Boolean(a && b);
}

/* ── 操作类型 ─────────────────────────────────────────────── */

export type GraphOp =
  | {
      op: "relation";
      from: string;
      to: string;
      category: GraphCategory;
      label: string;
      evidence: string;
      directed: boolean;
    }
  | { op: "alias"; name: string; alias: string; evidence: string }
  | { op: "person"; name: string; note?: string }
  | { op: "rename_person"; name: string; newName: string }
  | { op: "delete_person"; name: string }
  | { op: "delete_relation"; from: string; to: string; label: string }
  | { op: "clear_graph" };

/**
 * 解析一段中文短句，返回操作数组。逐句独立解析，一段里有多句就产出多个 op。
 * 认不出的句子不产出任何 op——宁可漏给模型，不可瞎猜。
 */
export function parseGraphRules(text: string): GraphOp[] {
  const ops: GraphOp[] = [];
  const lines = text
    .split(/[。；;！!？?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of lines) ops.push(...parseLine(line));
  return ops;
}

function parseLine(line: string): GraphOp[] {
  let m: RegExpMatchArray | null;

  // 清空图谱：不可恢复的危险操作，只认整句就是明确指令的说法。
  // 整句锚定（^…$)是关键——「删掉重新开始吧」不是清空指令，放它进来
  // 会把整本图谱误删，而用户只是想重新读一遍。
  if (/^(清空(图谱|人物|人物关系|关系图|所有人物)|全部删掉重来?|删掉重来|重新来)$/.test(line)) {
    return [{ op: "clear_graph" }];
  }

  // 删关系：「删除张三和李四的仇人」
  m = line.match(/^(?:删除|删掉|去掉|移除)(.{1,12}?)[和与跟](.{1,12}?)的(.{1,8}?)(?:关系)?$/);
  if (m) {
    const a = personName(m[1] ?? "");
    const b = personName(m[2] ?? "");
    const rel = cleanName(m[3] ?? "");
    if (pairOk(a, b) && rel) return [{ op: "delete_relation", from: a, to: b, label: rel }];
  }

  // 删人物：「删除张三」/「把张三删了」。名字要像人名，否则一律不删——
  // 删除同样不可撤销，宁可漏掉让人重说一句，也不能拿「重新开始吧」当人名。
  m = line.match(/^(?:删除|删掉|去掉|移除)(?:人物|角色)?(.{1,12})$/);
  if (m && !/[和与跟的]/.test(m[1] ?? "")) {
    const a = personName(m[1] ?? "");
    if (a) return [{ op: "delete_person", name: a }];
  }
  m = line.match(/^把(.{1,12}?)(?:删掉?|去掉|移除)了?$/);
  if (m) {
    const a = personName(m[1] ?? "");
    if (a) return [{ op: "delete_person", name: a }];
  }

  // 改名：「把张三改叫张小明」/「张三改名为张三丰」
  m = line.match(
    /^(?:把|将)?(.{1,12}?)(?:改名为|改名成|更名为|改名叫做|改名叫|改叫|改名|现在叫)(.{1,12})$/,
  );
  if (m) {
    const a = personName(m[1] ?? "");
    const b = personName(m[2] ?? "");
    if (pairOk(a, b)) return [{ op: "rename_person", name: a, newName: b }];
  }

  // 别名：「宝玉又叫宝二爷」
  m = line.match(/^(.{1,12}?)(?:就是|又叫|也叫|又称|便叫)(.{1,12})$/);
  if (m) {
    const a = personName(m[1] ?? "");
    const b = personName(m[2] ?? "");
    if (pairOk(a, b)) return [{ op: "alias", name: a, alias: b, evidence: line }];
  }

  // 「A 是 B 的 X」
  m = line.match(/^(.{1,12}?)是(.{1,12}?)的(.{1,8})$/);
  if (m) {
    const a = personName(m[1] ?? "");
    const b = personName(m[2] ?? "");
    const rel = cleanName(m[3] ?? "");
    const category = classify(rel);
    if (pairOk(a, b) && category)
      return [
        { op: "relation", from: a, to: b, category, label: rel, evidence: line, directed: true },
      ];
  }

  // 「A 的 X 是 B」→ 反向（B 是 A 的 X）
  m = line.match(/^(.{1,12}?)的(.{1,8})是(.{1,12})$/);
  if (m) {
    const a = personName(m[1] ?? "");
    const rel = cleanName(m[2] ?? "");
    const b = personName(m[3] ?? "");
    const category = classify(rel);
    if (pairOk(a, b) && category)
      return [
        { op: "relation", from: b, to: a, category, label: rel, evidence: line, directed: true },
      ];
  }

  // 「A 和 B 是 X」→ 无向
  m = line.match(/^(.{1,12}?)[和与跟](.{1,12}?)是(.{1,8})$/);
  if (m) {
    const a = personName(m[1] ?? "");
    const b = personName(m[2] ?? "");
    const rel = cleanName(m[3] ?? "");
    const category = classify(rel);
    if (pairOk(a, b) && category) {
      const bidir =
        category === "friendship" || category === "other" || BIDIRECTIONAL_LABELS.includes(rel);
      return [
        { op: "relation", from: a, to: b, category, label: rel, evidence: line, directed: !bidir },
      ];
    }
  }

  // 情感动词：「A 暗恋 B」
  for (const [verb, conf] of Object.entries(FEELINGS)) {
    const idx = line.indexOf(verb);
    if (idx > 0 && idx < 14) {
      const a = personName(line.slice(0, idx));
      const b = personName(line.slice(idx + verb.length));
      if (pairOk(a, b))
        return [
          {
            op: "relation",
            from: a,
            to: b,
            category: conf.category,
            label: conf.label,
            evidence: line,
            directed: true,
          },
        ];
    }
  }

  return [];
}

/**
 * 把操作应用到图谱，返回人类可读事件列表（每条对应一次工具事件气泡）。
 * 人名先过 resolveName 把简称归到主名，避免「宝玉」和「贾宝玉」裂成两人。
 */
export function applyGraphOps(bookId: string, ops: GraphOp[]): string[] {
  const events: string[] = [];
  for (const op of ops) {
    try {
      if (op.op === "relation") {
        const from = resolveName(bookId, op.from) ?? op.from;
        const to = resolveName(bookId, op.to) ?? op.to;
        const { relation, duplicate } = addRelation(bookId, from, to, op.category, op.label, {
          evidence: op.evidence,
          directed: op.directed,
        });
        events.push(
          duplicate
            ? `↺ 关系已存在：${from} —${op.label}→ ${to}`
            : `✚ 新增关系：${from} —${op.label}→ ${to}（${GRAPH_CATEGORIES[op.category].name}）`,
        );
        void relation;
      } else if (op.op === "alias") {
        let { name, alias } = op;
        const rn = resolveName(bookId, name);
        const ra = resolveName(bookId, alias);
        name = rn ?? name;
        alias = ra ?? alias;
        // 主名不在库而别名在库时对调：优先并入已有人物，别造出重复人
        if (!findPerson(bookId, name) && findPerson(bookId, alias)) {
          const tmp = name;
          name = alias;
          alias = tmp;
        }
        addAlias(bookId, name, alias);
        events.push(`↔ 别名合并：「${alias}」并入「${name}」`);
      } else if (op.op === "person") {
        events.push(`✚ 新增人物：${op.name}`);
      } else if (op.op === "delete_person") {
        const name = resolveName(bookId, op.name) ?? op.name;
        const person = findPerson(bookId, name);
        if (!person) {
          events.push(`？ 图谱里没有「${op.name}」这个人物`);
        } else {
          const removed = deletePerson(bookId, person.id);
          events.push(`🗑 已删除人物：${person.name}（连带 ${removed} 条关系）`);
        }
      } else if (op.op === "delete_relation") {
        const result = deleteRelationByNames(bookId, op.from, op.to, op.label);
        events.push(
          "error" in result
            ? `？ ${result.error}`
            : `🗑 已删除关系：${op.from} —${result.label}→ ${op.to}`,
        );
      } else if (op.op === "rename_person") {
        const result = updatePerson(bookId, op.name, { newName: op.newName });
        events.push(
          "error" in result
            ? `？ ${result.error}`
            : `✎ 改名：「${result.oldName}」→「${result.person.name}」`,
        );
      } else if (op.op === "clear_graph") {
        const removed = clearGraph(bookId);
        events.push(`🗑 已清空当前图谱（${removed.persons} 个人物、${removed.relations} 条关系）`);
      }
    } catch (error) {
      events.push(`？ ${error instanceof Error ? error.message : "操作失败"}`);
    }
  }
  return events;
}

/** 事件前缀里的这几个符号表示「图谱真的变了」，用来判断该不该推重绘 */
export const MUTATING_EVENT_RE = /^[✚✎🗑↔]/u;
