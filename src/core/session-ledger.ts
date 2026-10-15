/**
 * 会话状态台账（state ledger）——治长会话里的「我还没记过」式自相矛盾
 *
 * 问题：网页端每轮只把最后 CONTEXT_WINDOW（40）条历史喂给模型。一条会话
 * 聊到后面，最早那些轮次里的**状态改动**（记过的待办、落盘的知识、
 * set_holidays 登记的放假安排）就滑出了上下文——但它们**确实
 * 生效在磁盘上**。于是模型会说出「我还没帮你记过这条待办」，而用户
 * 明明刚让它记过。这是自相矛盾，不是幻觉。
 *
 * 做法（对应上游 OpenMAIC 的 whiteboard-ledger 思路）：把每轮**成功执行
 * 的状态改动**压成一行中文事实，追加进会话档案；下一轮开始前把最近若干
 * 行拼进用户消息尾部，让模型始终知道「这些事已经做过了」。查询类工具
 * （list/query/status）不记——只记改变了什么的动作。
 *
 * 分层：这里是**纯逻辑**（工具+入参 → 一行事实、渲染提示词块、去重与截断），
 * 落盘由 chat-sessions.ts 负责（它拥有 data/chat-sessions.json）。这样规则
 * 可以脱离文件系统单测，I/O 也只有一处。
 *
 * 三条自我约束：
 * 1. **闭集**：只有明确列出的工具+动作才进台账。新增写操作工具时要有意识地
 *    决定要不要登记——漏登记等于这个改动会随上下文滑出而「失忆」。
 * 2. **只记成功的**：工具以 `{error}` 形态返回失败（不抛异常）时跳过；
 *    set_holidays 的部分成功（部分日期非法但其余已落盘）按 recorded>0 记。
 * 3. **一行一事实、限长限量**：台账是补充不是账本，渲染时截断条目、限制条数，
 *    绝不允许它膨胀成第二份 history。
 */

/** 台账落盘上限（条）：超出的从最旧开始丢。取 12 是给「渲染 8 条」留余量，
 *  这样用户连续问「刚才那条」时窗口还在 */
export const LEDGER_MAX = 12;

/** 每次渲染进提示词的条数上限：8 条 × 约 40 字 ≈ 320 字，对上下文是可忽略的
 *  开销，却足以覆盖绝大多数「我刚才让你做了什么」的追问 */
export const LEDGER_RENDER = 8;

/** 单行截断长度（字）：一行说清「改了什么」，不搬参数细节 */
const LINE_MAX = 42;

export interface LedgerEntry {
  /** 记下的时刻（毫秒） */
  at: number;
  /** 一行中文事实，如「待办 已添加「交高数作业」（截止 2026-09-20）」 */
  line: string;
}

/** 宽松读取：工具入参形状是 zod 推断出来的，但台账不能因形状意外而崩 */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function clip(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1)}…` : flat;
}

/** 截掉日期里的时间部分：台账要的是「9-20 截止」不是「2026-09-20T23:59:00」 */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[2])}-${Number(m[3])}` : iso.slice(0, 16);
}

/** 目录前缀：让台账一眼能分类，也提醒模型这是「本地存储里的东西」 */
const PREFIX = {
  todos: "待办",
  knowledge: "知识库",
  memory: "长期记忆",
  calendar: "校历",
  pomodoro: "番茄钟",
  artifact: "文件",
} as const;

/**
 * 哪些工具+动作算「状态改动」的**闭集**。
 *
 * 判定按 (工具, action) 二元组：同一个工具的查询动作（list/query/status）
 * 不登记——台账只记改变了什么。返回值是要写进台账的分类前缀；返回 undefined
 * 表示不进台账。新增写操作工具时在这里有意识地登记。
 */
function ledgerCategory(
  toolName: string,
  action: string,
): (typeof PREFIX)[keyof typeof PREFIX] | undefined {
  switch (toolName) {
    case "manage_todos":
      return action === "list" ? undefined : PREFIX.todos;
    case "manage_knowledge":
      return action === "list" ? undefined : PREFIX.knowledge;
    case "save_memory":
      return action === "list" ? undefined : PREFIX.memory;
    case "set_holidays":
      return PREFIX.calendar;
    case "manage_pomodoro":
      // status/list 是查询；start/cancel 改变了当前计时状态
      return action === "status" || action === "list" ? undefined : PREFIX.pomodoro;
    case "generate_document":
    case "convert_document":
    case "ppt_save":
      return PREFIX.artifact;
    default:
      return undefined;
  }
}

/**
 * 从工具返回里挖「到底改了什么」的一行中文。
 *
 * 优先复用工具自己的 summary——那是各工具作者写给用户看的人话，措辞比自己
 * 拼参数可靠得多；只在没有 summary 时才按入参兜底拼一行。
 */
function describe(toolName: string, action: string, input: unknown, output: unknown): string {
  const i = rec(input);
  const o = rec(output);
  const summary = str(o.summary);
  if (summary) return summary;
  // 文档类工具的 note 形如「已生成 DOCX，保存于本机 …」——路径太长，进台账
  // 只留格式与文件名
  if (
    toolName === "generate_document" ||
    toolName === "convert_document" ||
    toolName === "ppt_save"
  ) {
    const fmt = str(o.format) || str(i.format) || str(i.target);
    const file = str(o.filename) || str(i.filename) || "未命名";
    return `已产出 ${fmt.toUpperCase() || "文件"}：${file}`;
  }
  // pomodoro 的 start 没有 summary 也会带 pomodoro 视图，兜底拼一行
  if (toolName === "manage_pomodoro") {
    const mins = num(i.minutes);
    return `番茄钟${action === "cancel" ? "已取消" : `已开始${mins ? ` ${mins} 分钟` : ""}`}`;
  }
  if (toolName === "set_holidays") {
    const recorded = num(o.recorded) ?? arr(i.days).length;
    const removed = arr(o.removed).length;
    const parts = [`已登记 ${recorded} 天放假/调休安排`];
    if (removed) parts.push(`移除 ${removed} 天`);
    return parts.join("，");
  }
  // 待办：add 带 items 数组（一次可能记多条），其余动作只有 id
  if (toolName === "manage_todos") {
    if (action === "add") {
      const titles = arr(i.items)
        .map((it) => str(rec(it).title))
        .filter(Boolean);
      if (titles.length === 1) return `已添加待办「${titles[0]}」`;
      if (titles.length > 1) return `已添加 ${titles.length} 条待办`;
      return "已添加待办";
    }
    const title = str(i.title);
    if (action === "delete") return title ? `已删除待办「${title}」` : "已删除一条待办";
    if (action === "update") {
      if (i.done === true) return title ? `待办「${title}」已标记完成` : "一条待办已标记完成";
      const due = str(i.dueAt);
      return title
        ? `待办「${title}」已更新${due ? `（截止 ${shortDate(due)}）` : ""}`
        : "一条待办已更新";
    }
    return "待办已更新";
  }
  if (toolName === "manage_knowledge") {
    if (action === "add") {
      const titles = arr(i.items)
        .map((it) => str(rec(it).title))
        .filter(Boolean);
      if (titles.length === 1) return `已入库知识「${titles[0]}」`;
      if (titles.length > 1) return `已入库 ${titles.length} 条知识`;
      return "已入库知识";
    }
    if (action === "delete") return "已删除一条知识";
    if (action === "update") {
      const title = str(i.title);
      return title ? `知识「${title}」已更新` : "一条知识已更新";
    }
    return "知识库已更新";
  }
  return "已完成一次写入";
}

/**
 * 工具执行 → 台账行；不进台账返回 null。
 *
 * 这是台账的唯一入口判定：先看动作在不在闭集，再看这次执行是否真的改动了
 * 什么（工具失败常以 `{error}` 返回而非抛异常，见 didMutate）。
 */
export function ledgerLine(toolName: string, input: unknown, output: unknown): string | null {
  const action = str(rec(input).action);
  const category = ledgerCategory(toolName, action);
  if (!category) return null;
  if (!didMutate(toolName, output)) return null;
  const body = describe(toolName, action, input, output);
  if (!body) return null;
  return clip(`【${category}】${body}`);
}

/**
 * 一次工具执行是否**真的改变了状态**。
 *
 * 我们的工具失败时多数不抛异常，而是返回 `{error: "..."}`（于是前端把它当
 * tool-result 事件渲染），所以只看「有没有抛错」会把失败当成功记进台账。
 * set_holidays 是部分成功形态（部分日期非法、其余已落盘，error 与 recorded
 * 并存），所以给它开一个口子：recorded>0 就算改过。
 */
export function didMutate(toolName: string, output: unknown): boolean {
  const o = rec(output);
  const hasError = typeof o.error === "string" && o.error.trim().length > 0;
  if (!hasError) return true;
  if (toolName === "set_holidays") {
    const recorded = num(o.recorded) ?? 0;
    return recorded > 0 || (arr(o.removed).length ?? 0) > 0;
  }
  return false;
}

/** 会话里已生效但可能滑出上下文的改动，追加到台账尾部并去重 */
export function pushLedger(
  existing: LedgerEntry[] | undefined,
  line: string,
  at: number,
): LedgerEntry[] {
  const clean = clip(line);
  if (!clean) return existing ?? [];
  // 同一条事实重复出现（例如连续两轮都添加了同一条待办）只保留最新位置：
  // 台账要表达「当前已生效」，不是流水账
  const kept = (existing ?? []).filter((e) => e.line !== clean);
  return [...kept, { at, line: clean }].slice(-LEDGER_MAX);
}

/**
 * 台账 → 提示词块。没有条目返回 ""（调用方直接拼空串，不留多余空行）。
 *
 * 措辞上明确两件事：这些改动**已生效**，以及**不要因为上下文里没有就否认**
 * ——后者正是本模块存在的理由。
 */
export function ledgerBlock(entries: LedgerEntry[] | undefined): string {
  const recent = (entries ?? []).slice(-LEDGER_RENDER);
  if (!recent.length) return "";
  const lines = recent.map((e) => `- ${e.line}`).join("\n");
  return `\n\n[本会话已生效的状态改动]\n${lines}\n（以上都已写入本地存储，不要重复执行；用户问起时直接承认已做，不要说「还没记过」「没有找到」——不确定就用对应的查询工具现查，别凭印象断言。）`;
}
