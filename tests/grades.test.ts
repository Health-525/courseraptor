/**
 * GPA 计算与入学年份推断测试
 *
 * 对应四类真实翻车：
 * - 入学年份硬编码 2023，别人克隆就漏数据
 * - 去重只按课程名，多学期同名课被合并、学分吞掉
 * - 通过型成绩记 0 绩点计入分母，军训/毕业实习拉低 GPA
 * - 「不及格」包含「及格」，includes 误判成 1.0 绩点
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { toGP, isPassFailGrade, enrollYearFromStudentId } = await import("../src/jwgl/grades");

// ── 数字制 ────────────────────────────────────────────────────

test("数字制绩点分档", () => {
  assert.equal(toGP("95"), 4.0);
  assert.equal(toGP("88"), 3.7);
  assert.equal(toGP("80"), 3.0);
  assert.equal(toGP("76"), 2.7);
  assert.equal(toGP("61"), 1.3);
  assert.equal(toGP("58"), 0); // 不及格：0 分且计入分母
});

// ── 等级制与通过型 ────────────────────────────────────────────

test("等级制绩点", () => {
  assert.equal(toGP("优秀"), 4.0);
  assert.equal(toGP("良好"), 3.0);
  assert.equal(toGP("中等"), 2.0);
  assert.equal(toGP("及格"), 1.0);
});

test("「不及格」不得被 includes(及格) 误判成 1.0 绩点", () => {
  // 回归：旧实现对等级制用 includes 逐个匹配，「不及格」命中「及格」分支
  assert.equal(toGP("不及格"), 0);
  assert.equal(toGP("不合格"), 0);
});

test("通过型成绩返回 null（移出 GPA 分母），而不是 0", () => {
  // 军训、毕业实习这类「必修 + 有学分 + 记合格」的课，
  // 记 0 绩点会拉低 GPA；正确语义是整体排除。
  assert.equal(toGP("合格"), null);
  assert.equal(toGP("通过"), null);
  assert.equal(toGP("免修"), null);
  assert.equal(isPassFailGrade("合格"), true);
  assert.equal(isPassFailGrade("92"), false);
  assert.equal(isPassFailGrade("良好"), false);
  assert.equal(isPassFailGrade("不及格"), false);
});

test("空/未知标记返回 null，不猜", () => {
  assert.equal(toGP(""), null);
  assert.equal(toGP("缓考"), null);
  assert.equal(toGP("缺考"), null);
});

// ── 入学年份推断 ──────────────────────────────────────────────

test("入学年份从学号前四位推", () => {
  assert.equal(enrollYearFromStudentId("202321144057"), 2023);
  assert.equal(enrollYearFromStudentId("202511100001"), 2025);
});

test("学号不规范时往前放宽范围，宁可多查不漏数据", () => {
  const y = enrollYearFromStudentId("abc");
  const now = new Date().getFullYear();
  assert.equal(y, now - 5);
  // 未来年份视为异常
  assert.equal(enrollYearFromStudentId("299900000001"), new Date().getFullYear() - 5);
});
