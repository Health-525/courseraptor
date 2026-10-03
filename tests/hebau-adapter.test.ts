/**
 * HEBAU 适配器纯函数单测：周次位串归一、5.0 制绩点、学期编码/标签、开学日期真值层
 * 全部离线：term-dates 用临时 RAPTOR_DATA_DIR 隔离，不打真实教务系统
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 隔离：term-dates-hebau.json 落临时目录，不碰真机 data/
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-hebau-"));

const { normalizeWeekSpec, parsePeriodRange, toCourseRow } = await import(
  "../src/adapters/hebau/schedule"
);
const { hebauGradeToGP, isHebauRequired, enrollYearFromStudentId } = await import(
  "../src/adapters/hebau/grades"
);
const { xnxqdm } = await import("../src/adapters/hebau/urp");
const { termLabel } = await import("../src/adapters/hebau/academics");
const { loadStore, resolveWeek1Monday, currentWeekOf, termKey } = await import(
  "../src/adapters/hebau/term-dates"
);

test("normalizeWeekSpec：URP 位串转范围式（真实数据形态）", () => {
  // 真实样本：0000000001111110000 = 第 10-15 周有课
  assert.equal(normalizeWeekSpec("0000000001111110000"), "10-15");
  // 隔位 1 = 单周课（位串第 1 位 = 第 1 周）
  assert.equal(normalizeWeekSpec("10101010101010101010"), "1,3,5,7,9,11,13,15,17,19");
  // 首位 0：从第 2 周起的隔周课
  assert.equal(normalizeWeekSpec("01010101010101010101"), "2,4,6,8,10,12,14,16,18,20");
  // 全 0 串 = 无课
  assert.equal(normalizeWeekSpec("00000000000000000000"), "");
  // 单周
  assert.equal(normalizeWeekSpec("00000000010000000000"), "10");
});

test("normalizeWeekSpec：范围式透传与清洗", () => {
  assert.equal(normalizeWeekSpec("2-6,8-12"), "2-6,8-12");
  assert.equal(normalizeWeekSpec("1-20周"), "1-20");
  assert.equal(normalizeWeekSpec("1-16(单)"), "1-16(单)");
  assert.equal(normalizeWeekSpec("1-8 全周"), "1-8");
  assert.equal(normalizeWeekSpec(""), "");
});

test("parsePeriodRange：SKJC/JSJC 展开，只有开始节时按 1 节算（宁少不多）", () => {
  assert.deepEqual(parsePeriodRange({ SKJC: "3", JSJC: "4" }), [3, 4]);
  assert.deepEqual(parsePeriodRange({ SKJC: "5" }), [5]);
  // SKCD 连堂节数兜底
  assert.deepEqual(parsePeriodRange({ SKJC: "1", SKCD: "2" }), [1, 2]);
  assert.deepEqual(parsePeriodRange({}), []);
});

test("toCourseRow：课程名为空的行丢弃，字段别名混杂可解析", () => {
  assert.equal(toCourseRow({ JASMC: "教一-101" }), null);
  const row = toCourseRow({
    kcmc: "高等数学",
    xqj: "2",
    skjc: "3",
    jsjc: "4",
    skzc: "0000000001111110000",
    cdmc: "西教-201",
    skjs: "张三",
  });
  assert.ok(row);
  assert.equal(row.title, "高等数学");
  assert.equal(row.weekday, 2);
  assert.deepEqual(row.periods, [3, 4]);
  assert.equal(row.weeks, "10-15");
  assert.equal(row.location, "西教-201");
  assert.equal(row.teacher, "张三");
});

test("hebauGradeToGP：5.0 满绩制（分数/10-5），通过型/缓考移出计算", () => {
  assert.equal(hebauGradeToGP("100"), 5);
  assert.equal(hebauGradeToGP("90"), 4);
  assert.equal(hebauGradeToGP("60"), 1);
  // 不及格：参与计算，绩点 0（与「不参与」是两回事）
  assert.equal(hebauGradeToGP("59"), 0);
  assert.equal(hebauGradeToGP("85"), 3.5);
  // 半分四舍五入到一位小数（与旧实现一致）
  assert.equal(hebauGradeToGP("85.5"), 3.6);
  // 等级制
  assert.equal(hebauGradeToGP("优秀"), 4.5);
  assert.equal(hebauGradeToGP("良好"), 3.5);
  assert.equal(hebauGradeToGP("不及格"), 0);
  // 通过型与异常态：null（不参与 GPA），不是 0
  assert.equal(hebauGradeToGP("合格"), null);
  assert.equal(hebauGradeToGP("免修"), null);
  assert.equal(hebauGradeToGP("缓考"), null);
  assert.equal(hebauGradeToGP(""), null);
  assert.equal(hebauGradeToGP("105"), null);
});

test("isHebauRequired / enrollYearFromStudentId", () => {
  assert.equal(isHebauRequired("001"), true);
  assert.equal(isHebauRequired("必修"), true);
  assert.equal(isHebauRequired("专业选修课"), false);
  assert.equal(isHebauRequired("002"), false);
  assert.equal(enrollYearFromStudentId("202312345678"), 2023); // 合成学号，非真实
  // 不规范学号：回退到 5 年前（宁多查不漏学期）
  assert.ok(enrollYearFromStudentId("ab") <= 2021);
});

test("xnxqdm / termLabel：学期编码换算与本校叫法", () => {
  assert.equal(xnxqdm(2026, 3), "2026-2027-1");
  assert.equal(xnxqdm(2026, 12), "2026-2027-2");
  assert.equal(termLabel(2026, 3), "2026-2027学年秋冬学期");
  assert.equal(termLabel(2026, 12), "2026-2027学年春夏学期");
});

test("termKey 与种子真值：2026-1 = 2026-09-01（known）", () => {
  assert.equal(termKey(2026, 3), "2026-1");
  assert.equal(termKey(2026, 12), "2026-2");
  const store = loadStore();
  // 首次运行：种子播种落盘
  assert.equal(store["2026-1"].week1Monday, "2026-09-01");
  assert.equal(store["2026-1"].source, "known");
  assert.ok(fs.existsSync(path.join(process.env.RAPTOR_DATA_DIR!, "term-dates-hebau.json")));
});

test("resolveWeek1Monday：未登记学期按 9 月/3 月第一个周一估算并如实标注", () => {
  const autumn = resolveWeek1Monday(2030, 3);
  assert.equal(autumn.source, "estimated");
  assert.equal(autumn.week1Monday, "2030-09-02"); // 2030-09-01 是周日 → 第一个周一是 09-02
  const spring = resolveWeek1Monday(2029, 12);
  assert.equal(spring.source, "estimated");
  assert.equal(spring.week1Monday, "2030-03-04"); // 2030-03-01 是周五 → 第一个周一是 03-04
});

test("currentWeekOf：周次推算与学期边界", () => {
  // 2026-09-01 开学：开学当天是第 1 周
  const w1 = currentWeekOf(2026, 3, new Date("2026-09-01T12:00:00"));
  assert.equal(w1?.week, 1);
  assert.equal(w1?.source, "known");
  // 第 5 周周一
  const w5 = currentWeekOf(2026, 3, new Date("2026-09-29T12:00:00"));
  assert.equal(w5?.week, 5);
  // 开学前与 30 周外返回 null
  assert.equal(currentWeekOf(2026, 3, new Date("2026-08-20T12:00:00")), null);
  assert.equal(currentWeekOf(2026, 3, new Date("2027-06-01T12:00:00")), null);
});
