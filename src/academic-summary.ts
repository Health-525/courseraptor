/** 学业概览：纯计算，不请求教务接口，不推断培养方案或毕业资格。 */
import { isPassFailGrade, toGP } from "./jwgl/grades";
import type { GradeCourse } from "./jwgl/types";

export type GradeStatus = "passed" | "failed" | "pending";

export function gradeStatus(score: string): GradeStatus {
  const gp = toGP(score);
  if (gp !== null) return gp > 0 ? "passed" : "failed";
  return isPassFailGrade(score) ? "passed" : "pending";
}

const creditOf = (g: GradeCourse): number => {
  const value = Number(g.credit);
  return Number.isFinite(value) && value > 0 ? value : 0;
};
const rounded = (value: number): number => Math.round(value * 100) / 100;

/** 入参必须是重修去重后的成绩；未知、缓考等不计入已获学分。 */
export function summarizeAcademics(courses: GradeCourse[], failedTerms: string[] = []) {
  const passed = courses.filter((g) => gradeStatus(g.score) === "passed");
  const details = (status: GradeStatus) =>
    courses
      .filter((g) => gradeStatus(g.score) === status)
      .map((g) => ({
        course: g.course,
        courseCode: g.courseCode,
        semester: g.semester,
        score: g.score,
        credit: creditOf(g),
      }));
  return {
    dataComplete: failedTerms.length === 0,
    passedCourseCount: passed.length,
    earnedCredits: rounded(passed.reduce((sum, g) => sum + creditOf(g), 0)),
    failedCourses: details("failed"),
    pendingCourses: details("pending"),
    note:
      "已获学分仅汇总已通过课程（含合格/通过/免修/免考），按课程号与性质去重；不是毕业审核。未知成绩需到教务系统核实。" +
      (failedTerms.length
        ? "部分学期查询失败，当前统计不完整，不能据此断言没有挂科或学分已修满。"
        : ""),
  };
}

const GENERAL_CATEGORIES = [
  "创新创业类",
  "公共艺术类",
  "人文类",
  "社会类",
  "自然类",
  "AI前沿技术类",
];

/** 六类仅作检查清单；不同年级/专业的最低要求必须核对培养方案。 */
export function summarizeGeneralElectives(courses: GradeCourse[]) {
  const byCategory = new Map<string, { credits: number; courses: string[] }>();
  for (const g of courses) {
    if (
      g.type !== "选修" ||
      !g.courseClass?.includes("通识") ||
      !g.category ||
      gradeStatus(g.score) !== "passed" ||
      creditOf(g) === 0
    )
      continue;
    const entry = byCategory.get(g.category) ?? { credits: 0, courses: [] };
    entry.credits = rounded(entry.credits + creditOf(g));
    entry.courses.push(`${g.course}(${g.credit}分)`);
    byCategory.set(g.category, entry);
  }
  const covered = (category: string) =>
    [...byCategory.keys()].some(
      (key) => key === category || key.includes(category) || category.includes(key),
    );
  return {
    byCategory: [...byCategory].map(([category, entry]) => ({ category, ...entry })),
    missingCategories: GENERAL_CATEGORIES.filter((category) => !covered(category)),
    note: "只统计已通过且有正学分的通识选修。未覆盖类别不等于必须补修，已覆盖不等于达到最低学分；请按本人年级/专业培养方案核对六类要求。大学英语拓展课程归属以培养方案为准。",
  };
}
