/**
 * 成绩与考试工具：get_grades / get_exams / get_lab_grades
 */

import { tool } from "ai";
import { z } from "zod";

import { summarizeAcademics, summarizeGeneralElectives } from "../academic-summary";
import { config } from "../config";
import { fetchExamsSmart, parseSemesterString } from "../jwgl/academics";
import { fetchAllGrades } from "../jwgl/grades";
import { fetchLabGradesSmart } from "../jwgl/portal";
import { getCookie } from "./session";

export const gradesTools = {
  /** 成绩查询 */
  get_grades: tool({
    description:
      "查询全部学期的成绩与 GPA、已获学分、未通过/待确认课程及通识分类概览。重复课程取最高有效成绩；只统计已通过课程的学分，不代替培养方案或毕业审核。",
    inputSchema: z.object({}),
    execute: async () => {
      const cookie = await getCookie();
      const result = await fetchAllGrades(cookie, config.jwglUsername);

      const generalElectives = summarizeGeneralElectives(result.allCourses);

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
      "查询考试安排：科目、日期、时间、考场、座位号。默认自动探测最新学期（也可指定，如「2026-2027-1」）。",
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
      const cookie = await getCookie();
      const r = await fetchExamsSmart(cookie, parsed?.year, parsed?.semester);
      if (!r.ok) {
        return { error: `考试查询失败：${r.error}（不是「暂无考试」，是没查到）` };
      }
      const { label, exams } = r.data;
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
        note: exams.length === 0 ? "该学期暂无考试安排" : undefined,
      };
    },
  }),

  /** 实验成绩 */
  get_lab_grades: tool({
    description:
      "查询实验课程成绩（按学期，默认自动探测最新学期，也可指定如「2026-2027-1」）。没有实验课的学期返回空属正常。",
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
      const cookie = await getCookie();
      const { label, items } = await fetchLabGradesSmart(cookie, parsed?.year, parsed?.semester);
      return {
        term: label,
        total: items.length,
        items: items.slice(0, 30),
        note: items.length === 0 ? "该学期暂无实验成绩（无实验课属正常）" : undefined,
      };
    },
  }),
};
