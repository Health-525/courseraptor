/**
 * NYTDC 学业概览：纯计算，不请求教务接口，不推断培养方案或毕业资格。
 *
 * 与 NJTECH 版的差异：通识选修**没有固定的六类清单**（那是南工大的校规）。
 * 通达的模块来自成绩单上的「课程归属」字段（实机见：语言文学 / 美学艺术 /
 * 科学技术…），选课通知只规定「每个模块课程需选满 1 学分（24 级专转本
 * 美学艺术模块需 2 学分）」，具体模块与最低学分以本人培养方案为准。
 * 所以这里按实际出现的模块统计，不臆造清单、不断言是否修满。
 */

import type { GradeCourse } from "../../core/model";
import { isPassFailGrade, toGP } from "./grades";

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
      "已获学分仅汇总已通过课程（含及格及以上的五级制成绩），按课程号与性质去重；不是毕业审核。未知成绩需到教务系统核实。" +
      (failedTerms.length
        ? "部分学期查询失败，当前统计不完整，不能据此断言没有挂科或学分已修满。"
        : ""),
  };
}

/**
 * 通识选修按「课程归属」模块统计（通达特有字段 kcgsmc）。
 * 只做检查清单：模块是否覆盖由本人培养方案决定，工具不代为判定达标。
 */
export function summarizeGeneralElectives(courses: GradeCourse[]) {
  const byCategory = new Map<string, { credits: number; courses: string[] }>();
  for (const g of courses) {
    if (
      !g.category ||
      g.type !== "任选" ||
      !String(g.courseClass ?? "").includes("选修") ||
      gradeStatus(g.score) !== "passed" ||
      creditOf(g) === 0
    )
      continue;
    const entry = byCategory.get(g.category) ?? { credits: 0, courses: [] };
    entry.credits = rounded(entry.credits + creditOf(g));
    entry.courses.push(`${g.course}(${g.credit}分)`);
    byCategory.set(g.category, entry);
  }
  return {
    byCategory: [...byCategory].map(([category, entry]) => ({ category, ...entry })),
    coveredModules: [...byCategory.keys()],
    note:
      "按成绩单上的「课程归属」模块统计已通过的全校性任选课。选课通知要求每个模块课程选满 1 学分（24 级专转本学生美学艺术模块需 2 学分），" +
      "但具体模块清单与最低学分以本人年级/专业培养方案为准；本统计不等于达到毕业要求。",
  };
}
