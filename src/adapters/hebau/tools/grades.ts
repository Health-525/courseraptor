/**
 * 成绩与考试工具：get_grades / get_exams
 * （学籍等能力河北农大教务没有对应接口，不提供）
 */

import { tool } from "ai";
import { z } from "zod";
import { config } from "../../../core/config";
import { loadExamCache, saveExamCache } from "../../../core/exam-cache";
import { saveGradesCache } from "../../../core/grades-cache";
import type { ExamResult } from "../../../core/model";
import { fetchExamsSmart, parseSemesterString } from "../academics";
import { fetchHebauGrades } from "../grades";
import { withAuthRetry } from "../session";

export const gradesTools = {
  /** 成绩查询 */
  get_grades: tool({
    description:
      "查询全部学期的成绩与 GPA（河北农大 5.0 满绩制，仅必修课计入；合格/免修/缓考不计 GPA）。重复课程取最高有效成绩；只统计已通过课程的学分，不代替培养方案或毕业审核。",
    inputSchema: z.object({}),
    execute: async () => {
      // 会话失效自动重登一次；全部学期失败时 failedTerms 会如实上报，坏数据不会静默
      const result = await withAuthRetry((c) => fetchHebauGrades(c, config.jwglUsername));

      // 落盘成绩缓存：成绩面板（/api/grades）纯读缓存零登录，对话里问一次即刷新
      const semesters = [...new Set(result.allCourses.map((g) => g.semester))].sort();
      const recentSemester = semesters[semesters.length - 1];
      saveGradesCache({
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
      });

      return {
        gpa: result.gpa,
        gpaBasis: result.gpaBasis,
        // 语义：这是计入 GPA 的必修课学分和，不是总修学分。转述时别说成「总学分」。
        requiredCredits: result.requiredCredits,
        passFailCredits: result.passFailCredits || 0,
        requiredCourses: result.requiredCourses,
        courseCount: result.allCourses.length,
        failedTerms: result.failedTerms?.length ? result.failedTerms : undefined,
        failedTermsNote: result.failedTerms?.length
          ? "以上学期彻底查询失败（不是没有成绩），相关结论（如「无挂科」）对这些学期不成立，建议稍后重试。"
          : undefined,
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
      "查询考试安排：科目、日期、时间、考场、座位号。已排考场与未排考场都会返回（未排的 location/time 为空，要向用户说明「还没排考场」而不是漏掉）。默认自动探测最新学期（也可指定，如「2026-2027-1」）。",
    inputSchema: z.object({
      semester: z
        .string()
        .optional()
        .describe("指定学期，格式如「2026-2027-1」；不填则自动探测最新学期"),
    }),
    execute: async ({ semester }) => {
      const parsed = semester ? parseSemesterString(semester) : null;
      if (semester && !parsed) {
        return { error: `学期格式无法解析：「${semester}」，应为「2026-2027-1」这类格式` };
      }
      let data: ExamResult;
      let staleAt: number | undefined;
      try {
        const r = await withAuthRetry((c) => fetchExamsSmart(c, parsed?.year, parsed?.semester));
        if (r.ok) {
          data = r.data;
          // 未指定学期（自动探测的最新学期）时顺带刷新本地缓存，
          // 「今日档案」日程页读缓存就能展示临近考试，不必登录教务系统
          if (!semester) saveExamCache(data);
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
      const { label, exams } = data;
      return {
        term: label,
        total: exams.length,
        exams: exams.map((e) => ({
          subject: e.subject,
          date: e.date || undefined,
          time: e.time || undefined,
          location: e.location || undefined,
          seatNumber: e.seatNumber || undefined,
          notArranged: !e.location || undefined,
        })),
        staleNote:
          staleAt !== undefined
            ? `⚠️ 教务在线查询失败，这是本地缓存的最后已知考试安排（保存于 ${new Date(staleAt).toLocaleString("zh-CN")}），可能已过期；网络恢复后再问一次即可刷新。`
            : undefined,
        note: exams.length === 0 ? "该学期暂无考试安排" : undefined,
      };
    },
  }),
};
