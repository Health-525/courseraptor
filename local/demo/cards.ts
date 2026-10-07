/**
 * 演示模式的结构化结果卡：与 2026-09 前的正式「结果卡」同形（kind/title/
 * badge/summary/metrics/rows），红头档案设计令牌渲染。数据全部来自 ./data
 * 的虚构 fixtures——live 模式按工具调用推导，离线剧本按问题关键词推导。
 */
import { demoKnowledge, demoTodayBrief, demoTodos } from "./data";

export interface DemoCardRow {
  label: string;
  value?: string;
  meta?: string;
}

export interface DemoCard {
  kind: string;
  title: string;
  badge?: string;
  summary?: string;
  metrics?: Array<{ label: string; value: string }>;
  rows?: DemoCardRow[];
  source: string;
  updatedAt: number;
}

const BASE = { source: "演示模式（虚构数据）" } as const;

/* ── 各类卡片：直接从 fixtures 构建，与工具返回同源 ── */

export function scheduleCard(): DemoCard {
  const brief = demoTodayBrief();
  const days = brief.week?.days ?? [];
  const total = days.reduce((n, d) => n + d.courses.length, 0);
  return {
    ...BASE,
    kind: "schedule",
    title: "一周课表",
    badge: `${brief.term.weekLabel} · ${total} 门次 · 虚构示例`,
    summary: brief.next
      ? `下一节：${brief.next.dateLabel} ${brief.next.course.time} ${brief.next.course.title}${brief.next.makeup ? "（调休补课）" : ""}`
      : undefined,
    // 每天每门课一行（首行带星期标签），避免多课日挤一行导致断词换行
    rows: days.flatMap((d) =>
      d.courses.length
        ? d.courses.map((c, i) => ({
            label: i === 0 ? `${d.label} ${d.dateShort}${d.isToday ? " · 今天" : ""}` : "",
            value: `${c.title} ${c.time}`,
            meta:
              [c.location, d.makeup ? "调休补课" : null].filter(Boolean).join(" · ") || undefined,
          }))
        : [
            {
              label: `${d.label} ${d.dateShort}${d.isToday ? " · 今天" : ""}`,
              value: "—",
            },
          ],
    ),
    updatedAt: Date.now(),
  };
}

export function todosCard(output: unknown): DemoCard | null {
  // manage_todos list 的返回：{ summary, todos: [...] }
  const o = output as { todos?: Array<Record<string, unknown>> } | null;
  const list = o?.todos;
  if (!Array.isArray(list)) return null;
  const open = list.length;
  const overdue = list.filter((t) => t.overdue).length;
  return {
    ...BASE,
    kind: "todos",
    title: "待办清单",
    badge: `${open} 条未完成 · 虚构示例`,
    metrics: overdue ? [{ label: "已逾期", value: `${overdue} 条` }] : undefined,
    rows: list.map((t) => ({
      label: String(t.title ?? ""),
      value: String(t.dueLabel ?? ""),
      meta:
        [t.overdue ? "已逾期" : null, typeof t.notes === "string" ? t.notes : null]
          .filter(Boolean)
          .join(" · ") || undefined,
    })),
    updatedAt: Date.now(),
  };
}

export function knowledgeCard(): DemoCard {
  const entries = demoKnowledge(new Date());
  return {
    ...BASE,
    kind: "knowledge",
    title: "知识库",
    badge: `${entries.length} 条 · 虚构示例`,
    rows: entries.slice(0, 5).map((e) => ({
      label: e.title,
      value: e.category ?? "未分类",
    })),
    updatedAt: Date.now(),
  };
}

/* ── 推导入口 ── */

/** live 模式：由工具名 + 返回值推导卡片（仅读态查询出卡，写操作不出） */
export function demoCardFromTool(name: unknown, output: unknown): DemoCard | null {
  switch (name) {
    case "get_schedule":
      return scheduleCard();
    case "manage_todos":
      return todosCard(output);
    case "manage_knowledge": {
      const o = output as { entries?: unknown[] } | null;
      return Array.isArray(o?.entries) ? knowledgeCard() : null;
    }
    default:
      return null;
  }
}

/** 离线剧本：按问题关键词推导卡片（口径与 demoScript 一致） */
export function demoCardsForMessage(message: string): DemoCard[] {
  const cards: DemoCard[] = [];
  const seen = new Set<string>();
  const push = (card: DemoCard | null) => {
    if (card && !seen.has(card.kind)) {
      seen.add(card.kind);
      cards.push(card);
    }
  };
  if (/今天.*(安排|怎么样)|今日日程|今天有什么/.test(message)) {
    push(scheduleCard());
    push(todosCard({ todos: demoTodos(new Date()).items }));
  }
  if (/日历|导出|ics/i.test(message)) push(scheduleCard());
  if (/待办/.test(message)) push(todosCard({ todos: demoTodos(new Date()).items }));
  if (/知识|记住|笔记/.test(message)) push(knowledgeCard());
  if (/课表|上课|这周|今天|明天/.test(message)) push(scheduleCard());
  return cards;
}
