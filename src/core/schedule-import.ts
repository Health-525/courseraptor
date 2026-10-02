/**
 * 手动课表导入 — AI 解析多格式课表文本为结构化课程
 *
 * 「其他学校」用户没有教务系统可抓，课表从设置页导入：粘贴任意格式文本
 * （教务网页复制的表格、Excel/CSV 导出、WakeUp/小爱等 App 的导出内容、
 * 自由文字描述）或上传文件（先经附件预解析流水线转文本）。本地解析全部
 * 离线完成；只有这一步把内容交给模型结构化——数据面收窄到课表文本本身。
 *
 * 交互协议（网页端三个接口配合，服务端不存会话状态）：
 * 1. POST /api/schedule/import { text | uploadId, answers? } → 返回课程草稿
 *    + questions（模型拿不准、需要用户补充的关键问题，最多 3 条）；
 * 2. 用户在界面里回答，带着 answers 重新请求，直到 questions 为空；
 * 3. 预览可逐行编辑/删除，POST /api/schedule/import/commit 落盘课表缓存。
 *
 * 结构参考：next_class（AI 解析文本课表 + 冲突检测 + 手动修正），
 * 追问环节是本项目的补充——拿不准的先问，不猜。
 */

import { z } from "zod";
import { expandWeeks, segmentsOverlap, WEEKDAY_NAMES } from "./academic-utils";
import type { CourseData, SkwjSegment } from "./model";

/** 模型单条课程的输出形状（宽进：未知字段忽略，weeks 缺省按整学期） */
const courseRowSchema = z.object({
  title: z.string(),
  weekday: z.number(),
  periods: z.array(z.number()),
  weeks: z.string().optional(),
  location: z.string().optional(),
  teacher: z.string().optional(),
});

const importResultSchema = z.object({
  courses: z.array(courseRowSchema).default([]),
  questions: z
    .array(
      z.object({
        question: z.string(),
        options: z.string().optional(),
      }),
    )
    .default([]),
  termHint: z.string().optional(),
  termStartHint: z.string().optional(),
});

export type ImportQuestion = { question: string; options?: string };
export type ImportQA = { question: string; answer: string };
export type ImportIssue = { row: number; reason: string };

export interface ParsedSchedule {
  courses: CourseData[];
  rejected: ImportIssue[];
  conflicts: string[];
  questions: ImportQuestion[];
  termHint?: string;
  termStartHint?: string;
}

/** 模型没提周次时的缺省（整学期）；导入预览会显式标出来让用户确认 */
export const DEFAULT_WEEKS = "1-18";

/** 送给模型的课表文本上限：再大基本是整本导出，截断并告知 */
const MAX_CONTENT_CHARS = 50_000;

const IMPORT_PROMPT = `你是课表解析助手。把用户给的课表内容解析成结构化 JSON。

输入可能是以下任意一种，不要假设固定格式：
- 教务系统网页里复制出来的表格文本（列可能乱序、表头可能缺失或重复）
- Excel / CSV 导出的文本（制表符或逗号分隔）
- 其他课表 App（WakeUp 课程表、小爱课程表等）导出的 JSON 或文本
- 用户手打的自由描述（如「周一 3-4 节高数，1-16 周，教一 101，张老师」）

只输出一个 JSON 对象，不要任何解释或代码块标记，形状如下：
{
  "courses": [
    { "title": "课程名", "weekday": 1, "periods": [3, 4], "weeks": "1-16", "location": "教室", "teacher": "教师" }
  ],
  "termHint": "内容里能看出学期（如 2026-2027-1）就写，否则省略",
  "termStartHint": "内容里提到开学日期/第一周周一就写 YYYY-MM-DD，否则省略",
  "questions": [
    { "question": "一句口语化的疑问", "options": "可选答案用 / 分隔，没有就省略" }
  ]
}

字段规则：
- weekday：1=周一 … 7=周日（「星期天」「周日」都是 7）
- periods：节次号数组。「第3-4节」= [3,4]；「第3节」= [3]；一大节等于两小节时展开
- weeks：周次表达式，如 "1-16"、"1-8,11-16"、"1-15(单)"。内容完全没提周次时按 "1-18" 填，并在 questions 里确认一共有几周
- 同一门课多个上课时段（周一一堂、周三一堂）拆成多条，title 保持一致
- location / teacher 内容里没有就填空字符串，绝不编造
- questions 最多 3 条：只问影响排课的关键信息（节次不明、周次两可、学期起始），每条一句话、给出用户能直接回答的选项；关键信息都明确时给空数组
- 用户已经回答过的问题（见「已问答」）不要再问

宁缺毋滥：某一行拿不准就不要硬猜进 courses，在 questions 里说明是哪一行、缺什么。`;

export function buildImportPrompt(content: string, answers: ImportQA[] = []): string {
  const trimmed = content.trim();
  const sliced = trimmed.slice(0, MAX_CONTENT_CHARS);
  const cutNote =
    sliced.length < trimmed.length
      ? `\n（内容过长，已截取前 ${MAX_CONTENT_CHARS} 字符；如课表不全请只解析截取部分，并在 questions 里说明）`
      : "";
  const qa = answers.length
    ? `\n\n## 已问答（用户的回答已是最准信息，据此修正解析，不要重复问）\n${answers
        .filter((a) => a.question && a.answer)
        .map((a) => `问：${a.question}\n答：${a.answer}`)
        .join("\n")}`
    : "";
  return `${IMPORT_PROMPT}\n\n## 课表内容\n${sliced}${cutNote}${qa}`;
}

// ── 模型输出收口：抽出 JSON、schema 校验 ────────────────────────

/** 从模型回复里抽 JSON 主体：容忍 ```json 围栏与前后废话 */
function extractJson(raw: string): unknown {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("模型没有返回 JSON（可能网络异常或内容过长），请重试一次");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("模型返回的 JSON 无法解析，请重试一次；反复失败可把课表内容精简后再贴");
  }
}

/**
 * 模型输出的原始行 → 规范课程（宽进严出）：字段裁剪、节次去重排序、
 * 周次缺省补整学期。不合格的行进 rejected 并给原因，不静默丢弃。
 */
export function sanitizeCourses(rows: unknown[]): {
  courses: CourseData[];
  rejected: ImportIssue[];
} {
  const courses: CourseData[] = [];
  const rejected: ImportIssue[] = [];
  rows.forEach((row, i) => {
    const label = i + 1;
    if (typeof row !== "object" || row === null) {
      rejected.push({ row: label, reason: "不是有效的课程条目" });
      return;
    }
    const r = row as Record<string, unknown>;
    const title = String(r.title ?? "").trim();
    if (!title) {
      rejected.push({ row: label, reason: "缺少课程名" });
      return;
    }
    const weekday = Number(r.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      rejected.push({ row: label, reason: `星期无效（${r.weekday}），应为 1-7` });
      return;
    }
    const rawPeriods = Array.isArray(r.periods) ? r.periods : [];
    const periods = [...new Set(rawPeriods.map((p) => Number(p)))]
      .filter((p) => Number.isInteger(p) && p >= 1 && p <= 20)
      .sort((a, b) => a - b);
    if (!periods.length) {
      rejected.push({ row: label, reason: "节次为空或无效" });
      return;
    }
    const weeks = String(r.weeks ?? "").trim() || DEFAULT_WEEKS;
    if (!expandWeeks(weeks).length) {
      rejected.push({ row: label, reason: `周次表达式「${weeks}」解析不出任何周` });
      return;
    }
    courses.push({
      title: title.slice(0, 60),
      weekday,
      periods,
      weeks,
      location: String(r.location ?? "")
        .trim()
        .slice(0, 60),
      teacher: String(r.teacher ?? "")
        .trim()
        .slice(0, 30),
    });
  });
  return { courses, rejected };
}

/** 同星期 + 节次 + 周次有交集的行两两找出来（导入预览里提示用户处理） */
export function findConflicts(courses: CourseData[]): string[] {
  const segments: SkwjSegment[] = courses.map((c) => ({
    weekday: c.weekday,
    periods: c.periods,
    weeks: c.weeks,
    expandedWeeks: expandWeeks(c.weeks),
  }));
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (segmentsOverlap(segments[i], segments[j])) {
        const a = courses[i];
        const b = courses[j];
        const overlapWeeks = segments[i].expandedWeeks.filter((w) =>
          segments[j].expandedWeeks.includes(w),
        );
        out.push(
          `「${a.title}」与「${b.title}」在${WEEKDAY_NAMES[a.weekday]}第 ${a.periods.join(",")} 节 ` +
            `与第 ${b.periods.join(",")} 节重叠（${overlapWeeks.slice(0, 5).join(",")}…周）；` +
            `若是同一门课的两个写法请删掉一条，真冲突请修正节次或周次`,
        );
      }
    }
  }
  return out;
}

// ── 解析器注册表：主程序装真实模型实现，测试注入替身不联网 ────────

export type ScheduleTextParser = (prompt: string) => Promise<string>;

let parser: ScheduleTextParser | null = null;
let defaultInstalled = false;

export function setScheduleParser(p: ScheduleTextParser | null): void {
  parser = p;
}

export function hasScheduleParser(): boolean {
  return parser !== null;
}

/**
 * 解析入口：拼提示词 → 调模型 → 收口输出。questions 原样透传给前端
 * （追问循环由前端持状态重放，服务端不存会话）。
 */
export async function parseScheduleImport(
  content: string,
  answers: ImportQA[] = [],
): Promise<ParsedSchedule> {
  if (!parser) throw new Error("课表解析器未装配");
  const raw = await parser(buildImportPrompt(content, answers));
  const parsed = importResultSchema.parse(extractJson(raw));
  const { courses, rejected } = sanitizeCourses(parsed.courses);
  return {
    courses,
    rejected,
    conflicts: findConflicts(courses),
    questions: parsed.questions
      .filter((q) => q.question?.trim())
      .slice(0, 3)
      .map((q) => ({ question: q.question.trim(), options: q.options?.trim() || undefined })),
    ...(parsed.termHint?.trim() ? { termHint: parsed.termHint.trim() } : {}),
    ...(parsed.termStartHint?.trim() ? { termStartHint: parsed.termStartHint.trim() } : {}),
  };
}

/**
 * 装配真实模型实现（直调模型 API，不带工具）。幂等：测试先注入替身后，
 * 这里不再覆盖。失败静默由调用方按「解析器未装配」处理。
 */
export async function installDefaultScheduleParser(): Promise<void> {
  if (defaultInstalled) return;
  const { generateText } = await import("ai");
  const { buildLanguageModel } = await import("./llm");
  defaultInstalled = true;
  setScheduleParser(async (prompt) => {
    const result = await generateText({
      model: buildLanguageModel(),
      prompt,
      maxOutputTokens: 6000,
      abortSignal: AbortSignal.timeout(90_000),
    });
    return result.text;
  });
}
