import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gradeStatus,
  summarizeAcademics,
  summarizeGeneralElectives,
} from "../src/academic-summary";
import { deduplicateGrades, isPassFailGrade, toGP } from "../src/jwgl/grades";
import type { GradeCourse } from "../src/jwgl/types";

const course = (patch: Partial<GradeCourse> = {}): GradeCourse => ({
  course: "示例课程",
  courseCode: "demo-1",
  score: "85",
  credit: "2",
  type: "选修",
  semester: "2025-2026第一学期",
  category: "人文类",
  courseClass: "通识教育课",
  ...patch,
});

test("未知、缓考、缺考和非标准数字不授予学分，也不算通过型", () => {
  for (const score of ["", "缓考", "缺考", "待录入", "免修申请中", "101", "-1", "60待审核"]) {
    assert.equal(gradeStatus(score), "pending", score);
    assert.equal(isPassFailGrade(score), false, score);
    assert.equal(toGP(score), null, score);
  }
  assert.equal(summarizeAcademics([course({ score: "缓考" })]).earnedCredits, 0);
});

test("明确未通过与通过型成绩区分，未通过不能被子串匹配为通过", () => {
  for (const score of ["59", "0", "不合格", "未通过", "不通过", "不及格"]) {
    assert.equal(gradeStatus(score), "failed", score);
  }
  for (const score of ["60", "100", "优秀", "及格", "合格", "通过", "免修", "免考"]) {
    assert.equal(gradeStatus(score), "passed", score);
  }
});

test("重修保留通过成绩；不同课程号的同名课不合并", () => {
  for (const scores of [
    ["58", "合格"],
    ["合格", "58"],
    ["良好", "缓考"],
    ["缓考", "良好"],
  ]) {
    const result = deduplicateGrades(scores.map((score) => course({ score })));
    assert.equal(result.length, 1);
    assert.equal(gradeStatus(result[0].score), "passed");
  }
  assert.equal(deduplicateGrades([course(), course({ courseCode: "demo-2" })]).length, 2);
  assert.equal(
    deduplicateGrades([course({ score: "90" }), course({ score: "95" })])[0].score,
    "95",
  );
});

test("学业概览区分已获学分、未通过与待确认，并保留数据不完整提示", () => {
  const result = summarizeAcademics(
    [
      course(),
      course({ score: "合格", credit: "0.5" }),
      course({ score: "58" }),
      course({ score: "缓考" }),
      course({ credit: "-2" }),
      course({ credit: "Infinity" }),
    ],
    ["2025-1 查询失败"],
  );
  assert.equal(result.earnedCredits, 2.5);
  assert.equal(result.failedCourses.length, 1);
  assert.equal(result.pendingCourses.length, 1);
  assert.equal(result.dataComplete, false);
  assert.match(result.note, /不完整/);
  assert.equal(summarizeAcademics([]).dataComplete, true);
});

test("通识类别仅统计已通过正学分，未通过类别仍标记未覆盖", () => {
  const result = summarizeGeneralElectives([
    course(),
    course({ score: "58", category: "公共艺术类" }),
    course({ score: "缓考", category: "自然类" }),
    course({ score: "合格", category: "社会类" }),
    course({ credit: "0", category: "创新创业类" }),
    course({ type: "必修", category: "AI前沿技术类" }),
  ]);
  assert.deepEqual(
    result.byCategory.map((entry) => entry.category),
    ["人文类", "社会类"],
  );
  assert.ok(result.missingCategories.includes("公共艺术类"));
  assert.ok(result.missingCategories.includes("自然类"));
  assert.match(result.note, /已覆盖不等于达到最低学分/);
});
