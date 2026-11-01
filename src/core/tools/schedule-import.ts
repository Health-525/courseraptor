/**
 * 课表导入（对话入口）：import_schedule / import_schedule_commit
 *
 * 设置页「导入课表」的姊妹通道：同学在对话里直接贴课表文字、或把课表
 * 文件当附件发来说「帮我导入课表」，agent 走同一套解析管线（core/
 * schedule-import 的 AI 结构化 + 追问）完成导入，不必再去设置页找入口。
 *
 * 服务端不存会话状态——解析草稿存进程内小台账（draftId + 30 分钟 TTL），
 * commit 按 draftId 取回，避免让模型逐条转述几十门课（转写必错、还费 token）。
 * 追问循环天然由对话承担：parse 返回 questions → 模型原样问用户 → 用户
 * 在下一轮回答 → 模型带 answers 重新 parse。与网页端点（/api/schedule/
 * import，前端持状态重放）共用 core/schedule-import 的全部纯逻辑。
 */

import { randomUUID } from "node:crypto";

import { tool } from "ai";
import { z } from "zod";

import { expandWeeks, WEEKDAY_NAMES } from "../academic-utils";
import { importTextOf, openLocalFile } from "../attachments";
import { config } from "../config";
import { recordManualTermStart } from "../manual-terms";
import type { CourseData } from "../model";
import { loadScheduleCache, saveScheduleCache } from "../schedule-cache";
import {
  findConflicts,
  hasScheduleParser,
  type ImportQA,
  installDefaultScheduleParser,
  parseScheduleImport,
  sanitizeCourses,
} from "../schedule-import";
import { school } from "../school";

// ── 草稿台账：draftId → 课程行，进程内、短时效、小容量 ─────────────

interface ImportDraft {
  courses: CourseData[];
  createdAt: number;
}

const drafts = new Map<string, ImportDraft>();
const DRAFT_TTL_MS = 30 * 60 * 1000;
const DRAFT_MAX = 8;

function saveDraft(courses: CourseData[]): string {
  const now = Date.now();
  for (const [id, d] of drafts) if (now - d.createdAt > DRAFT_TTL_MS) drafts.delete(id);
  while (drafts.size >= DRAFT_MAX) drafts.delete(drafts.keys().next().value as string);
  const id = randomUUID().slice(0, 8);
  drafts.set(id, { courses, createdAt: now });
  return id;
}

function loadDraft(id: string): CourseData[] | null {
  const d = drafts.get(id);
  if (!d) return null;
  if (Date.now() - d.createdAt > DRAFT_TTL_MS) {
    drafts.delete(id);
    return null;
  }
  return d.courses;
}

// ── 视图：给模型看的紧凑行（对齐 schedule-edit 的 viewOf 风格）──────

const periodLabel = (periods: number[]) =>
  periods.length ? `${Math.min(...periods)}-${Math.max(...periods)}节` : "";

const rowView = (c: CourseData, index: number) => ({
  index,
  title: c.title,
  weekday: c.weekday,
  weekdayLabel: WEEKDAY_NAMES[c.weekday] ?? `周${c.weekday}`,
  periods: c.periods,
  periodsLabel: periodLabel(c.periods),
  weeks: c.weeks,
  ...(c.location ? { location: c.location } : {}),
  ...(c.teacher ? { teacher: c.teacher } : {}),
});

/** 保证解析器已装配：没配 Key 时给可操作的指引（与网页端点同一道门槛） */
async function ensureParser(): Promise<string | null> {
  if (hasScheduleParser()) return null;
  if (!config.deepseekApiKey)
    return "AI 解析需要先配置模型：让用户到 设置 → AI 模型 保存 API Key 后再试（网页端说「打开设置」即可直达）";
  await installDefaultScheduleParser();
  return null;
}

const answersSchema = z.array(
  z.object({
    question: z.string(),
    answer: z.string(),
  }),
);

export const scheduleImportTools = {
  /** 第一步：课表内容 → 结构化草稿 + 追问 */
  import_schedule: tool({
    description:
      "把用户的课表内容解析成结构化课程草稿（AI 解析，支持教务网页复制的表格、Excel/CSV 文本、WakeUp/小爱等 App 导出、自由文字描述）。用户说「导入课表 / 这是我的课表 / 帮我录入课表」或发来课表附件时调用：text 传课表文本（用户直接贴在对话里的，或附件预解析内容），path 传用户上传文件的本机路径（上下文附件块里「本机路径：」后面的值）。返回课程草稿与最多 3 条 questions：**把 questions 原样转述给用户、等回答**；下一轮把问答放进 answers 重新调用，直到 questions 为空。草稿只是解析结果，没有写入课表——用户确认无误后调 import_schedule_commit 落盘。",
    inputSchema: z.object({
      text: z.string().optional().describe("课表文本（对话里贴的或附件解析出的内容）"),
      path: z
        .string()
        .optional()
        .describe("课表文件的本机路径（用户上传附件时用，来自上下文「本机路径：」）"),
      answers: answersSchema
        .optional()
        .describe("上一轮 questions 的用户回答（原样带回重新解析，不要自己编答案）"),
    }),
    execute: async ({ text, path, answers }) => {
      let content = text?.trim() ?? "";
      let fileName = "";
      if (!content && path?.trim()) {
        try {
          // previewRows 拉满：课表导入要「全部课程行」，默认 15 行装不下真实课表
          const result = await openLocalFile(path.trim(), { previewRows: 1000 });
          content = importTextOf(result).trim();
          fileName = path.trim().split(/[\\/]/).pop() ?? "";
        } catch (e) {
          return { error: `读取文件失败：${(e as Error).message.slice(0, 160)}` };
        }
        if (!content)
          return {
            error: `「${fileName}」是图片或其他暂不支持解析的格式：请让用户改贴文字，或导出 Excel/PDF/Word/TXT 后再传`,
          };
      }
      if (!content)
        return { error: "缺少课表内容：text 传用户贴的课表文本，或 path 传附件的本机路径" };

      const gate = await ensureParser();
      if (gate) return { error: gate };

      try {
        const parsed = await parseScheduleImport(content, (answers ?? []) as ImportQA[]);
        if (!parsed.courses.length)
          return {
            error:
              "一段内容里没有解析出任何课程：请让用户确认贴的是课表本体（含课程名、星期、节次），而不是说明文字",
            questions: parsed.questions,
          };
        const draftId = saveDraft(parsed.courses);
        return {
          draftId,
          summary: `解析出 ${parsed.courses.length} 个课表时段${fileName ? `（来自 ${fileName}）` : ""}${
            parsed.questions.length
              ? `，有 ${parsed.questions.length} 个问题待确认`
              : "，待用户确认后导入"
          }`,
          courses: parsed.courses.map(rowView),
          ...(parsed.rejected.length ? { rejected: parsed.rejected } : {}),
          ...(parsed.conflicts.length ? { conflicts: parsed.conflicts } : {}),
          ...(parsed.questions.length ? { questions: parsed.questions } : {}),
          ...(parsed.termHint ? { termHint: parsed.termHint } : {}),
          ...(parsed.termStartHint ? { termStartHint: parsed.termStartHint } : {}),
          next: parsed.questions.length
            ? "把 questions 逐条转述给用户（带选项），拿到回答后带 answers 重新调用本工具；不要自行替用户回答。"
            : "把课程清单念给用户核对（几门课、各在什么时候），用户确认后调 import_schedule_commit。commit 前必须得到用户明确同意。",
        };
      } catch (e) {
        return { error: (e as Error).message.slice(0, 200) };
      }
    },
  }),

  /** 第二步：草稿落盘（覆盖旧课表缓存） */
  import_schedule_commit: tool({
    description:
      "把 import_schedule 解析出的课表草稿写入本地课表缓存（整体覆盖旧课表，对查询、今日页、课表页立即生效）。必须先得到用户对课程清单的明确确认才能调用。draftId 用最近一次 import_schedule 返回的；用户口头修正（「第 3 行周次改成 1-17」「高数那门不要了」）用 edits/skip 传行号改动，不必重新解析。",
    inputSchema: z.object({
      draftId: z.string().describe("最近一次 import_schedule 返回的 draftId"),
      skip: z
        .array(z.number().int().min(0))
        .optional()
        .describe("要丢弃的课程行 index 列表（来自解析结果里的 index）"),
      edits: z
        .array(
          z.object({
            index: z.number().int().min(0).describe("目标行 index（来自解析结果）"),
            title: z.string().optional(),
            weekday: z.number().int().min(1).max(7).optional(),
            periods: z.array(z.number().int().min(1).max(20)).min(1).optional(),
            weeks: z.string().optional().describe('周次表达式，如 "1-16"、"1-8,11-16(单)"'),
            location: z.string().optional(),
            teacher: z.string().optional(),
          }),
        )
        .optional()
        .describe("按行号的修正（用户口述的改动，传哪个字段改哪个）"),
      termStart: z
        .string()
        .optional()
        .describe(
          "开学日期 YYYY-MM-DD（第 1 教学周的周一；解析给的 termStartHint 经用户确认后传入）",
        ),
    }),
    execute: async ({ draftId, skip, edits, termStart }) => {
      const draft = loadDraft(draftId);
      if (!draft)
        return {
          error: `草稿 ${draftId} 不存在或已过期（30 分钟）：请重新调 import_schedule 解析一次`,
        };

      // 应用用户修正：skip 剔行、edits 改字段（改完走同一道 sanitize 收口）
      const dropped = new Set(skip ?? []);
      const patched = draft
        .map((c, i) => ({ ...c, index: i }))
        .filter((c) => !dropped.has(c.index));
      for (const e of edits ?? []) {
        const row = patched.find((c) => c.index === e.index);
        if (!row)
          return { error: `edits 里的 index=${e.index} 不在解析结果中（请对照 courses 的 index）` };
        if (e.title !== undefined) row.title = e.title;
        if (e.weekday !== undefined) row.weekday = e.weekday;
        if (e.periods !== undefined) row.periods = [...new Set(e.periods)].sort((a, b) => a - b);
        if (e.weeks !== undefined) row.weeks = e.weeks;
        if (e.location !== undefined) row.location = e.location;
        if (e.teacher !== undefined) row.teacher = e.teacher;
      }
      const { courses, rejected } = sanitizeCourses(patched);
      if (!courses.length)
        return {
          error: `修正后没有可导入的课程${rejected.length ? `（${rejected.length} 行无效）` : ""}，请重新解析`,
        };

      const candidates = school().terms.candidates();
      const fallbackTerm = candidates[0];
      if (!fallbackTerm) return { error: "没有可用学期，无法确定默认学年学期" };
      // 学期取现有缓存的学年学期（重导同学期最常见），没有缓存才用学校默认
      const cached = loadScheduleCache();
      const year = cached?.schedule.year ?? fallbackTerm.year;
      const semester = cached?.schedule.semester ?? fallbackTerm.semester;
      const label = school().terms.label(year, semester);

      const start = termStart?.trim() ?? "";
      if (start) {
        const d = new Date(`${start}T00:00:00`);
        if (Number.isNaN(d.getTime()) || d.getDay() !== 1)
          return { error: "开学日期无效：应为「第 1 教学周的周一」日期（YYYY-MM-DD）" };
        recordManualTermStart(year, semester, start);
      }

      // 周次表达式整体过一遍可用性（sanitize 只查了非空）
      for (const c of courses)
        if (!expandWeeks(c.weeks).length)
          return { error: `周次表达式「${c.weeks}」解析不出任何周` };

      saveScheduleCache({ year, semester, label, courses });
      drafts.delete(draftId);
      return {
        ok: true,
        summary: `已导入课表：${label} · ${courses.length} 个时段${start ? ` · 开学日期 ${start}` : ""}`,
        term: label,
        year,
        semester,
        count: courses.length,
        ...(rejected.length ? { rejected } : {}),
        conflicts: findConflicts(courses),
        note: "已覆盖旧课表缓存，课表/今日页立即生效；个别时段冲突（conflicts 非空）时提醒用户确认。",
      };
    },
  }),
};
