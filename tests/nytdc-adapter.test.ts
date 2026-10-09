/**
 * NYTDC（南京邮电大学通达学院）适配器纯函数单测
 *
 * 全部离线：term-dates 用临时 RAPTOR_DATA_DIR 隔离，不打真实教务系统。
 * 样本取自实机抓取的真实记录（2025-2026-2 / 2026-2027-1 两个学期），
 * 其中「单双周分段生效」的判定是用教务系统自己下发的周次位掩码（oldzc）
 * 作为真值反推出来的。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-nytdc-"));

const {
  compactWeeks,
  decodeWeekMask,
  expandWeeksPerSegment,
  weeksSpecOf,
  splitExamTime,
  periodTimeRange,
  NYTDC_PERIOD_TIMES,
} = await import("../src/adapters/nytdc/academics");
const { toGP, isPassFailGrade, isOptionalCourse, enrollYearFromStudentId, gpaPointOf } =
  await import("../src/adapters/nytdc/grades");
const { resolveWeek1Monday, currentWeekOf, termKey } = await import(
  "../src/adapters/nytdc/term-dates"
);
const { expandWeeks } = await import("../src/core/academic-utils");

// ── 周次位掩码（本适配器正确性的地基）────────────────────────

test("decodeWeekMask：真实课表的位掩码逐位还原周次", () => {
  // 体育Ⅲ「1-4周,7-18周」
  assert.deepEqual(
    decodeWeekMask("262095"),
    [1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  );
  // 数字电路与逻辑设计B「2-4周(双),10-18周(双)」
  assert.deepEqual(decodeWeekMask("174602"), [2, 4, 10, 12, 14, 16, 18]);
  // 电路分析基础B「1-3周,7周,11-17周(单)」——注意第 2 周有课
  assert.deepEqual(decodeWeekMask("87111"), [1, 2, 3, 7, 11, 13, 15, 17]);
  // 空/非法/零掩码一律当「没拿到」
  assert.deepEqual(decodeWeekMask(""), []);
  assert.deepEqual(decodeWeekMask("abc"), []);
  assert.deepEqual(decodeWeekMask("0"), []);
});

test("expandWeeksPerSegment：单双周按段生效（与位掩码语义一致）", () => {
  // 「1-3周,7周,11-17周(单)」= 1,2,3 全上 + 7 + 11-17 的奇数周
  assert.deepEqual(expandWeeksPerSegment("1-3,7,11-17(单)"), [1, 2, 3, 7, 11, 13, 15, 17]);
  // 「1-3周(单),6-7周,10-18周」= 1,3 + 6,7 + 10-18
  assert.deepEqual(
    expandWeeksPerSegment("1-3(单),6-7,10-18"),
    [1, 3, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  );
  // 整串都带同一标记时与逐段一致
  assert.deepEqual(expandWeeksPerSegment("2-4(双),10-18(双)"), [2, 4, 10, 12, 14, 16, 18]);
});

test("周次串是显式列出：core 的 expandWeeks 展开后与位掩码逐位一致", () => {
  for (const mask of ["262095", "174602", "87111", "87365", "261733"]) {
    const fromMask = decodeWeekMask(mask);
    const spec = compactWeeks(fromMask);
    assert.deepEqual(expandWeeks(spec), fromMask, `掩码 ${mask} -> ${spec}`);
  }
});

test("compactWeeks：连续段折成区间，其余列单周", () => {
  assert.equal(compactWeeks([1, 2, 3, 7]), "1-3,7");
  assert.equal(compactWeeks([1, 3, 5]), "1,3,5");
  assert.equal(compactWeeks([]), "");
});

test("weeksSpecOf：位掩码优先；缺失时回落到 zcd 分段展开", () => {
  assert.equal(weeksSpecOf({ oldzc: "87111", zcd: "1-3周,7周,11-17周(单)" }), "1-3,7,11,13,15,17");
  // 没有 oldzc：按 zcd 分段展开（仍然不让「(单)」串到整串上）
  assert.equal(weeksSpecOf({ zcd: "1-3周,7周,11-17周(单)" }), "1-3,7,11,13,15,17");
  assert.equal(weeksSpecOf({ oldzc: "", zcd: "" }), "");
});

// ── 绩点与学分 ──────────────────────────────────────────────

test("toGP：百分制按分数÷20（通达学籍管理办法）", () => {
  assert.equal(toGP("100"), 5);
  assert.equal(toGP("95"), 4.75);
  assert.equal(toGP("90"), 4.5);
  assert.equal(toGP("83"), 4.15);
  assert.equal(toGP("61"), 3.05);
  assert.equal(toGP("60"), 3);
  assert.equal(toGP("59"), 0);
  assert.equal(toGP("0"), 0);
});

test("toGP：五级制有绩点，及格也在内（不能当通过型移出）", () => {
  assert.equal(toGP("优秀"), 4.75);
  assert.equal(toGP("良好"), 4.25);
  assert.equal(toGP("中等"), 3.75);
  assert.equal(toGP("及格"), 3.25);
  assert.equal(toGP("不及格"), 0);
  // 通过型：有学分但不计绩点
  assert.equal(toGP("合格"), null);
  assert.equal(isPassFailGrade("合格"), true);
  assert.equal(isPassFailGrade("及格"), false);
  // 未知标记：不猜
  assert.equal(toGP("缓考"), null);
  assert.equal(toGP(""), null);
});

test("gpaPointOf：教务系统下发的 jd 优先，缺失才按分数推算", () => {
  assert.equal(gpaPointOf({ jd: "4.85", cj: "97" }), 4.85);
  assert.equal(gpaPointOf({ jd: "", cj: "97" }), 4.85);
  assert.equal(gpaPointOf({ cj: "及格" }), 3.25);
});

test("isOptionalCourse：任选课不计入平均学分绩点", () => {
  assert.equal(isOptionalCourse("任选"), true);
  assert.equal(isOptionalCourse("公选"), true);
  assert.equal(isOptionalCourse("必修"), false);
  assert.equal(isOptionalCourse("限选"), false);
});

test("enrollYearFromStudentId：通达学号前 2 位是入学年", () => {
  assert.equal(enrollYearFromStudentId("25120914"), 2025);
  assert.equal(enrollYearFromStudentId("23120914"), 2023);
  // 学号不规范时保守多查几年，不抛错
  assert.equal(enrollYearFromStudentId(""), new Date().getFullYear() - 5);
});

// ── 考试时间拆分 ────────────────────────────────────────────

test("splitExamTime：通达把日期与时间打包在 kssj 里", () => {
  assert.deepEqual(splitExamTime("2026-07-04(13:30-15:20)"), {
    date: "2026-07-04",
    time: "13:30-15:20",
  });
  // 中文括号与空格也认
  assert.deepEqual(splitExamTime("2026-07-03（15:40-17:30）"), {
    date: "2026-07-03",
    time: "15:40-17:30",
  });
  // 只有日期时不硬编时间
  assert.deepEqual(splitExamTime("2026-07-04"), { date: "2026-07-04", time: "" });
  assert.deepEqual(splitExamTime(""), { date: "", time: "" });
});

// ── 作息与校历 ──────────────────────────────────────────────

test("作息时间表：12 节五大节，按教务处官网《作息时间表》", () => {
  assert.equal(NYTDC_PERIOD_TIMES["1"], "07:50-08:35");
  assert.equal(NYTDC_PERIOD_TIMES["12"], "20:10-20:55");
  assert.equal(periodTimeRange([3, 4]), "09:40-11:15");
  assert.equal(periodTimeRange([6, 9]), "14:00-17:20");
  // 表外的节次不给时间（宁缺勿错）
  assert.equal(periodTimeRange([13]), undefined);
});

test("开学日期真值：三个学期来自校历/通知，来源是 known 不是 estimated", () => {
  assert.equal(termKey(2026, 3), "2026-1");
  assert.equal(termKey(2025, 12), "2025-2");

  const t2025a = resolveWeek1Monday(2025, 3);
  assert.equal(t2025a.week1Monday, "2025-09-08");
  assert.equal(t2025a.source, "known");

  const t2025b = resolveWeek1Monday(2025, 12);
  assert.equal(t2025b.week1Monday, "2026-03-02");
  assert.equal(t2025b.source, "known");

  const t2026a = resolveWeek1Monday(2026, 3);
  assert.equal(t2026a.week1Monday, "2026-08-31");
  assert.equal(t2026a.source, "known");

  // 查不到的学期必须如实标 estimated
  const unknown = resolveWeek1Monday(2030, 12);
  assert.equal(unknown.source, "estimated");
});

test("currentWeekOf：按开学周一算教学周", () => {
  // 2026-2027 学年第一学期第 1 周周一 = 2026-08-31
  assert.equal(currentWeekOf(2026, 3, new Date("2026-08-31T12:00:00"))?.week, 1);
  assert.equal(currentWeekOf(2026, 3, new Date("2026-09-07T12:00:00"))?.week, 2);
  assert.equal(currentWeekOf(2026, 3, new Date("2026-10-07T12:00:00"))?.week, 6);
  // 开学前返回 null，不硬报第 0 周
  assert.equal(currentWeekOf(2026, 3, new Date("2026-08-01T12:00:00")), null);
});
