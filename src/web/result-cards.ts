/** 把教务工具结果压成稳定、可落盘的网页结果卡，避免前端解析 Markdown。 */

import type { StoredArtifact } from "../chat-sessions";
import type { ChangeSummary } from "./workspace-data";

type Obj = Record<string, unknown>;

const obj = (value: unknown): Obj | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
const arr = (value: unknown): Obj[] =>
  Array.isArray(value) ? value.map(obj).filter((x): x is Obj => !!x) : [];
const str = (value: unknown): string => (value == null ? "" : String(value));
const take = (value: unknown, max = 42): string => {
  const text = str(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export function snapshotEntries(toolName: string, output: unknown): Record<string, string> | null {
  const o = obj(output);
  if (!o || typeof o.error === "string") return null;
  const entries: Record<string, string> = {};
  if (toolName === "get_grades") {
    for (const row of arr(o.courses)) {
      const id = `${take(row.courseCode || row.course, 60)}｜${take(row.semester, 30)}`;
      entries[id] = [row.score, row.credit, row.type].map(str).join("｜");
    }
  } else if (toolName === "get_exams") {
    for (const row of arr(o.exams)) {
      const id = take(row.subject, 80);
      entries[id] = [row.date, row.time, row.location, row.seatNumber].map(str).join("｜");
    }
  } else if (toolName === "get_news") {
    for (const row of arr(o.items)) {
      const id = take(row.title, 100);
      entries[id] = [row.date, row.relevance, row.url].map(str).join("｜");
    }
  } else return null;
  return entries;
}

function dateCandidate(text: string): string | undefined {
  const full = text.match(/(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  const short = text.match(/(?:^|\D)(\d{1,2})月(\d{1,2})日/);
  const now = new Date();
  const year = full ? Number(full[1]) : now.getFullYear();
  const month = full ? Number(full[2]) : short ? Number(short[1]) : 0;
  const day = full ? Number(full[3]) : short ? Number(short[2]) : 0;
  if (!month || !day) return undefined;
  const value = new Date(year, month - 1, day, 17, 0);
  if (Number.isNaN(value.getTime())) return undefined;
  return value.toISOString();
}

export function resultCard(
  toolName: string,
  output: unknown,
  change?: ChangeSummary,
): StoredArtifact | null {
  const o = obj(output);
  if (!o || typeof o.error === "string") return null;
  const now = Date.now();
  if (toolName === "get_grades") {
    const summary = obj(o.academicSummary);
    const failed = arr(summary?.failedCourses);
    return {
      kind: "grades",
      title: "成绩与学业概览",
      badge: `${Number(o.courseCount) || arr(o.courses).length} 门课程`,
      updatedAt: now,
      summary: take(summary?.note || o.note, 100),
      metrics: [
        { label: "GPA", value: str(o.gpa || "—") },
        { label: "已获学分", value: str(summary?.earnedCredits ?? o.requiredCredits ?? "—") },
        { label: "未通过", value: `${failed.length} 门` },
      ],
      rows: failed.slice(0, 5).map((r) => ({
        label: take(r.course || r.name),
        value: take(r.score, 12),
        meta: "未通过",
      })),
      change,
      actions: [
        {
          type: "prompt",
          label: "重新查询",
          prompt: "重新查询我的成绩，并重点说明新增或变化的成绩",
        },
      ],
    };
  }
  if (toolName === "get_exams") {
    const rows = arr(o.exams)
      .slice(0, 8)
      .map((r) => ({
        label: take(r.subject),
        value: [take(r.date, 16), take(r.time, 18)].filter(Boolean).join(" · "),
        meta: [take(r.location, 24), r.seatNumber ? `座位 ${take(r.seatNumber, 10)}` : ""]
          .filter(Boolean)
          .join(" · "),
      }));
    return {
      kind: "exams",
      title: "考试安排",
      badge: take(o.term, 22),
      updatedAt: now,
      summary: take(o.note, 100),
      metrics: [{ label: "考试", value: `${Number(o.total) || rows.length} 场` }],
      rows,
      change,
      actions: [
        {
          type: "prompt",
          label: "重新查询",
          prompt: "重新查询最近的考试安排，并告诉我是否有改期或换考场",
        },
        { type: "prompt", label: "导出日历", prompt: "把考试安排导出为手机可以导入的日历文件" },
      ],
    };
  }
  if (toolName === "get_news") {
    const rows = arr(o.items)
      .slice(0, 8)
      .map((r) => ({
        label: take(r.title, 56),
        value: take(r.date, 16),
        meta: r.relevance === "high" ? "需要关注" : take(r.category, 18),
        url: str(r.url) || undefined,
      }));
    return {
      kind: "news",
      title: "教务通知",
      badge: `${Number(o.mustSeeCount) || 0} 条需要关注`,
      updatedAt: now,
      source: "南京工业大学教务处",
      rows,
      change,
      actions: [
        {
          type: "prompt",
          label: "刷新通知",
          prompt: "刷新教务处通知，只告诉我与我相关且需要行动的内容",
        },
      ],
    };
  }
  if (toolName === "read_notice") {
    const body = str(o.text);
    return {
      kind: "notice",
      title: take(o.title, 70) || "通知正文",
      badge: "已读取原文",
      updatedAt: now,
      source: "学校通知原文",
      sourceUrl: typeof o.url === "string" ? o.url : undefined,
      summary: take(body, 160),
      actions: [{ type: "reminder", label: "设为提醒", dueAt: dateCandidate(body) }],
    };
  }
  if (toolName === "read_local_file" || toolName === "fetch_attachment") {
    return {
      kind: "file",
      title: take(o.filename, 70) || "附件已读取",
      badge: take(o.format || o.mode, 16),
      updatedAt: now,
      summary: take(o.hint || o.note || o.text, 140),
      metrics: [
        ...(o.totalDataRows != null ? [{ label: "数据行", value: str(o.totalDataRows) }] : []),
        ...(o.charCount != null ? [{ label: "字符", value: str(o.charCount) }] : []),
      ],
    };
  }
  return null;
}
