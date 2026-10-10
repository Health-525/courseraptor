/**
 * 成绩与考试工具：get_grades / get_exams
 *
 * 缓存优先策略（与 get_schedule 同约定）：
 * - 默认从本地缓存返回，不登录教务
 * - 用户明确说「刷新/最新/重新查」时由模型传 refresh=true 走联网
 * - 联网成功后与旧缓存做结构化 diff，不同才落盘
 * - 指定 semester 时永远联网（缓存只保最新学期）
 */

import { isDeepStrictEqual } from "node:util";
import { tool } from "ai";
import { z } from "zod";
import { config } from "../../../core/config";
import { loadExamCache, saveExamCache } from "../../../core/exam-cache";
import { type CachedGrades, loadGradesCache, saveGradesCache } from "../../../core/grades-cache";
import type { ExamResult, GradeResult } from "../../../core/model";
import { summarizeAcademics, summarizeGeneralElectives } from "../academic-summary";
import { fetchExamsSmart, parseSemesterString } from "../academics";
import { fetchAllGrades } from "../grades";
import { withAuthRetry } from "../session";

/** 由 GradeResult 组装 CachedGrades 的可写载荷（savedAt/schoolId 由 save 层填） */
function buildGradesPayload(result: GradeResult): Omit<CachedGrades, "savedAt" | "schoolId"> {
  const semesters = [...new Set(result.allCourses.map((g) => g.semester))].sort();
  const recentSemester = semesters[semesters.length - 1];
  return {
    gpa: result.gpa,
    gpaBasis: result.gpaBasis || undefined,
    requiredCredits: result.requiredCredits,
    courseCount: result.allCourses.length,
    recentSemester,
    recentCourses: result.allCourses
      .filter((g) => g.semester === recentSemester)
      .map((g) => ({
        course: g.course,
        score: g.score,
        credit: g.credit,
        type: g.type || undefined,
        semester: g.semester,
      })),
    // 全量落盘：让缓存模式也能派生 academicSummary/generalElectives，
    // 不必为了完整回答再登录一次
    allCourses: result.allCourses,
    requiredCourses: result.requiredCourses,
    passFailCredits: result.passFailCredits,
    failedTerms: result.failedTerms,
  };
}

/** 缓存 diff：新旧 allCourses + 关键汇总字段都相等才算「同」，避免无意义写盘 */
function gradesPayloadEqual(a: CachedGrades, b: Omit<CachedGrades, "savedAt" | "schoolId">) {
  return (
    a.gpa === b.gpa &&
    a.gpaBasis === b.gpaBasis &&
    a.requiredCredits === b.requiredCredits &&
    a.courseCount === b.courseCount &&
    a.recentSemester === b.recentSemester &&
    a.requiredCourses === b.requiredCourses &&
    a.passFailCredits === b.passFailCredits &&
    isDeepStrictEqual(a.failedTerms ?? [], b.failedTerms ?? []) &&
    isDeepStrictEqual(a.allCourses ?? [], b.allCourses ?? []) &&
    isDeepStrictEqual(a.recentCourses, b.recentCourses)
  );
}

export const gradesTools = {
  /** 成绩查询 */
  get_grades: tool({
    description:
      "查询全部学期的成绩与 GPA、已获学分、未通过/待确认课程及通识分类概览。重复课程取最高有效成绩；只统计已通过课程的学分，不代替培养方案或毕业审核。**默认走本地缓存不登录教务**；仅当用户明确说「刷新成绩 / 最新的 / 刚出的 / 重新查一下」时才传 refresh=true 强刷。缓存模式下若返回 fromCache=true 且缺少 courses 明细（老缓存未存全量），提醒用户可要求刷新以获取完整数据。",
    inputSchema: z.object({
      refresh: z
        .boolean()
        .optional()
        .describe(
          "true=忽略本地缓存强制登录教务拉最新（仅在用户明确说「刷新/最新/重新查」时传）；不传或 false=优先用本地缓存，缓存不存在才联网",
        ),
    }),
    execute: async ({ refresh }) => {
      // ── 缓存优先分支：refresh !== true 时先读盘 ──
      if (!refresh) {
        const cached = loadGradesCache();
        if (cached) {
          const savedAtStr = new Date(cached.savedAt).toLocaleString("zh-CN");
          // 老缓存（无 allCourses）只能返回摘要子集；提示模型可要求刷新
          if (!cached.allCourses) {
            return {
              gpa: cached.gpa,
              gpaBasis: cached.gpaBasis,
              requiredCredits: cached.requiredCredits,
              courseCount: cached.courseCount,
              recentSemester: cached.recentSemester,
              recentCourses: cached.recentCourses,
              fromCache: true,
              savedAt: cached.savedAt,
              staleNote: `ℹ️ 本次未联网，返回本地缓存成绩摘要（保存于 ${savedAtStr}）。老缓存未存全部学期明细，如需完整课程列表与学业概览，请让用户明确说「刷新成绩」后重新调用并传 refresh=true。`,
            };
          }
          // 新缓存：全量派生，输出结构与联网模式对齐
          return {
            gpa: cached.gpa,
            gpaBasis: cached.gpaBasis,
            requiredCredits: cached.requiredCredits,
            passFailCredits: cached.passFailCredits ?? 0,
            requiredCourses: cached.requiredCourses ?? 0,
            courseCount: cached.courseCount,
            failedTerms: cached.failedTerms?.length ? cached.failedTerms : undefined,
            generalElectives: summarizeGeneralElectives(cached.allCourses),
            academicSummary: summarizeAcademics(cached.allCourses, cached.failedTerms ?? []),
            courses: cached.allCourses.map((g) => ({
              course: g.course,
              courseCode: g.courseCode || undefined,
              score: g.score,
              credit: g.credit,
              type: g.type,
              semester: g.semester,
            })),
            fromCache: true,
            savedAt: cached.savedAt,
            staleNote: `ℹ️ 本次未联网，返回本地缓存成绩（保存于 ${savedAtStr}）。用户若明确说「刷新/最新/刚出的」成绩，重新调用并传 refresh=true。`,
          };
        }
      }

      // ── 联网分支：refresh=true 或缓存不存在 ──
      // 会话失效自动重登一次；全部学期失败时 fetchAllGrades 会抛错，坏数据不会落进缓存
      const result = await withAuthRetry((c) => fetchAllGrades(c, config.jwglUsername));

      const generalElectives = summarizeGeneralElectives(result.allCourses);

      // 落盘：与旧缓存 diff，不同才写（避免每次都写盘）
      const payload = buildGradesPayload(result);
      const old = loadGradesCache();
      if (!old || !gradesPayloadEqual(old, payload)) {
        saveGradesCache(payload);
      }

      return {
        gpa: result.gpa,
        gpaBasis: result.gpaBasis,
        // 语义：这是计入 GPA 的必修课学分和，不是总修学分。转述时别说成「总学分」。
        requiredCredits: result.requiredCredits,
        passFailCredits: result.passFailCredits || 0,
        requiredCourses: result.requiredCourses,
        courseCount: result.allCourses.length,
        failedTerms: result.failedTerms?.length ? result.failedTerms : undefined,
        generalElectives,
        academicSummary: summarizeAcademics(result.allCourses, result.failedTerms),
        courses: result.allCourses.map((g) => ({
          course: g.course,
          courseCode: g.courseCode || undefined,
          score: g.score,
          credit: g.credit,
          type: g.type,
          semester: g.semester,
        })),
      };
    },
  }),

  /** 考试安排 */
  get_exams: tool({
    description:
      "查询考试安排：科目、日期、时间、考场、座位号。**默认走本地缓存不登录教务**；仅当用户明确说「刷新考试 / 最新的 / 重新查」时才传 refresh=true 强刷。指定 semester 时永远联网（缓存只保最新学期）。",
    inputSchema: z.object({
      semester: z
        .string()
        .optional()
        .describe("指定学期，格式如「2026-2027-1」；不填则自动探测最新学期"),
      refresh: z
        .boolean()
        .optional()
        .describe(
          "true=忽略本地缓存强制登录教务拉最新（仅在用户明确说「刷新/最新/重新查」时传）；不传或 false=优先用本地缓存，缓存不存在才联网",
        ),
    }),
    execute: async ({ semester, refresh }) => {
      const parsed = semester ? parseSemesterString(semester) : null;
      if (semester && !parsed) {
        return { error: `学期格式无法解析：「${semester}」，应为「2026-2027-1」这类格式` };
      }
      let data: ExamResult | null = null;
      let staleAt: number | undefined; // 在线失败降级到缓存
      let fromCacheAt: number | undefined; // 主动走缓存（refresh !== true）

      // ── 缓存优先分支：不 refresh 且未指定学期时，先读盘 ──
      if (!refresh && !semester) {
        const cached = loadExamCache();
        if (cached) {
          data = cached.exams;
          fromCacheAt = cached.savedAt;
        }
      }

      // ── 联网分支：refresh=true / 无缓存 / 指定学期 ──
      if (!data) {
        try {
          const r = await withAuthRetry((c) => fetchExamsSmart(c, parsed?.year, parsed?.semester));
          if (r.ok) {
            data = r.data;
            // 未指定学期时才写回；且与旧缓存 diff 不同才落盘
            if (!semester) {
              const old = loadExamCache();
              if (!old || !isDeepStrictEqual(old.exams, data)) {
                saveExamCache(data);
              }
            }
          } else {
            // 拿不到 ≠ 没有：优先回退最后已知考试安排，没有缓存才报错
            const cached = loadExamCache();
            if (!cached) {
              return { error: `考试查询失败：${r.error}（不是「暂无考试」，是没查到）` };
            }
            data = cached.exams;
            staleAt = cached.savedAt;
          }
        } catch (e) {
          const cached = loadExamCache();
          if (!cached) throw e;
          data = cached.exams;
          staleAt = cached.savedAt;
        }
      }

      const exams0: ExamResult = data;
      const { label, exams } = exams0;
      return {
        term: label,
        total: exams.length,
        exams: exams.map((e) => ({
          subject: e.subject,
          date: e.date,
          time: e.time,
          location: e.location,
          seatNumber: e.seatNumber || undefined,
        })),
        /** true = 本次未联网，数据来自本地缓存（主动策略或失败降级） */
        fromCache: fromCacheAt !== undefined || staleAt !== undefined ? true : undefined,
        savedAt: fromCacheAt ?? staleAt,
        staleNote:
          staleAt !== undefined
            ? `⚠️ 教务在线查询失败，这是本地缓存的最后已知考试安排（保存于 ${new Date(staleAt).toLocaleString("zh-CN")}），可能已过期；网络恢复后再问一次即可刷新。`
            : fromCacheAt !== undefined
              ? `ℹ️ 本次未联网，返回本地缓存考试安排（保存于 ${new Date(fromCacheAt).toLocaleString("zh-CN")}）。用户若明确要「最新/刷新」考试安排，重新调用并传 refresh=true。`
              : undefined,
        note: exams.length === 0 ? "该学期暂无考试安排" : undefined,
      };
    },
  }),
};
