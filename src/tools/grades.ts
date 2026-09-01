/**
 * 成绩与考试工具：get_grades / get_exams / get_lab_grades
 */

import { tool } from "ai";
import { z } from "zod";

import { config } from "../config";
import { fetchExamsSmart, parseSemesterString } from "../jwgl/academics";
import { fetchAllGrades } from "../jwgl/grades";
import { fetchLabGradesSmart } from "../jwgl/portal";
import { getCookie } from "./session";

export const gradesTools = {
  /** 成绩查询 */
  get_grades: tool({
    description: "查询全部学期的成绩与 GPA（按 NJTECH 绩点规则计算，重复课程取最高分）。",
    inputSchema: z.object({}),
    execute: async () => {
      const cookie = await getCookie();
      const result = await fetchAllGrades(cookie, config.jwglUsername);

      // 通识选修六类统计（选修性质 + 通识教育课，成绩接口自带课程归属 kcgsmc）
      const geByCat = new Map<string, { credits: number; courses: string[] }>();
      for (const g of result.allCourses) {
        if (g.type !== "选修" || !g.courseClass?.includes("通识") || !g.category) continue;
        const e = geByCat.get(g.category) ?? { credits: 0, courses: [] };
        e.credits += parseFloat(g.credit) || 0;
        e.courses.push(`${g.course}(${g.credit}分)`);
        geByCat.set(g.category, e);
      }
      const GE_REQUIRED = [
        "创新创业类",
        "公共艺术类",
        "人文类",
        "社会类",
        "自然类",
        "AI前沿技术类",
      ];
      const covered = (c: string) =>
        [...geByCat.keys()].some((k) => k === c || k.includes(c) || c.includes(k));
      const generalElectives = {
        byCategory: [...geByCat.entries()].map(([category, e]) => ({
          category,
          credits: e.credits,
          courses: e.courses,
        })),
        missingCategories: GE_REQUIRED.filter((c) => !covered(c)),
        note: "六类要求：创新创业/公共艺术(美育)/人文/社会/自然/AI前沿；「大学英语拓展课程」是否计入人文以培养方案为准",
      };

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
