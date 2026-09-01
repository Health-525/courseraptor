/**
 * 放假/调休日历测试
 *
 * 背景：课表查询原本只认周一~周日的固定排课，放假照常显示「今天有课」、
 * 调休补课的周六反而「无课」。这组测试钉住：特殊日按日期归周、
 * holiday 覆盖课表、makeup 按 follows 周几补出行。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-holidays-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const {
  recordSpecialDays,
  removeSpecialDays,
  listSpecialDays,
  specialOnDate,
  specialDaysOfWeek,
  annotateWeekGroups,
  loadHolidayStore,
} = await import("../src/jwgl/term-holidays");
const { buildWeekIndex } = await import("../src/jwgl/academics");

// 2026 秋：第 1 周 2026-08-31（周一）～ 9-06
const WEEK1_MONDAY = "2026-08-31";

test("recordSpecialDays: 合法记录落盘并可读回", () => {
  const r = recordSpecialDays(
    [
      { date: "2026-11-01", type: "holiday", name: "校庆假" },
      { date: "2026-11-02", type: "holiday", name: "校庆假" },
      { date: "2026-11-03", type: "holiday", name: "校庆假" },
    ],
    "测试通知",
  );
  assert.equal(r.recorded, 3);
  assert.deepEqual(r.rejected, []);
  assert.ok(fs.existsSync(path.join(tmpData, "term-holidays.json")));
  assert.equal(listSpecialDays().filter((d) => d.date.startsWith("2026-11")).length, 3);
  assert.equal(loadHolidayStore().source, "测试通知");
});

test("recordSpecialDays: 非法日期与缺 follows 的 makeup 被拒绝", () => {
  const r = recordSpecialDays([
    { date: "2026-13-01", type: "holiday" }, // 月份不存在
    { date: "2026-12-99", type: "holiday" }, // 日不存在
    { date: "2026-12-10", type: "makeup" }, // makeup 缺 follows
  ]);
  assert.equal(r.recorded, 0);
  assert.equal(r.rejected.length, 3);
  // 同日 upsert 以新记录为准
  const up = recordSpecialDays([
    { date: "2026-12-05", type: "holiday", name: "哀悼日" },
    { date: "2026-12-05", type: "holiday", name: "更名后的假" },
  ]);
  assert.equal(up.recorded, 2);
  assert.equal(specialOnDate("2026-12-05")?.name, "更名后的假");
});

test("removeSpecialDays: 更正/撤回时删除记录", () => {
  recordSpecialDays([{ date: "2026-12-20", type: "holiday", name: "临时假" }]);
  const n = removeSpecialDays(["2026-12-20"]);
  assert.equal(n, 1);
  assert.equal(specialOnDate("2026-12-20"), null);
});

test("specialDaysOfWeek: 日期按教学周归位（10-01 是第 5 周周四）", () => {
  recordSpecialDays([{ date: "2026-10-01", type: "holiday", name: "国庆节" }]);
  const week5 = specialDaysOfWeek(WEEK1_MONDAY, 5);
  assert.equal(week5.length, 1);
  assert.equal(week5[0].date, "2026-10-01");
  assert.equal(week5[0].weekday, 4);
  // 第 4 周没有特殊日
  assert.equal(specialDaysOfWeek(WEEK1_MONDAY, 4).length, 0);
});

test("annotateWeekGroups: holiday 周带合并后的放假说明", () => {
  recordSpecialDays([
    { date: "2026-10-01", type: "holiday", name: "国庆节" },
    { date: "2026-10-02", type: "holiday", name: "国庆节" },
    { date: "2026-10-03", type: "holiday", name: "国庆节" },
  ]);
  const courses = [
    {
      title: "高等数学",
      weekday: 4,
      periods: [3, 4],
      weeks: "1-16",
      location: "明德楼",
      teacher: "张",
    },
  ];
  const groups = annotateWeekGroups(courses, WEEK1_MONDAY, buildWeekIndex(courses));
  const week5 = groups.find((g) => g.week === 5)!;
  // 周四的课仍按周次表达式正常出现在 lines（覆盖由模型按 holiday 字段语义执行）
  assert.ok(week5.lines.some((l) => l.includes("高等数学")));
  // 连续三天合并成一段
  assert.equal(week5.holiday?.length, 1);
  assert.match(week5.holiday![0], /10-01（周四）～10-03（周六）放假：国庆节/);
  // 没有特殊日的周不带 holiday/makeup 字段
  const week1 = groups.find((g) => g.week === 1)!;
  assert.equal(week1.holiday, undefined);
  assert.equal(week1.makeup, undefined);
});

test("annotateWeekGroups: makeup 日按 follows 周几补出课行", () => {
  // 9-05（第 1 周周六）补周三的课
  recordSpecialDays([{ date: "2026-09-05", type: "makeup", follows: 3, name: "军训调休" }]);
  const courses = [
    {
      title: "大学英语",
      weekday: 3,
      periods: [1, 2],
      weeks: "1-16",
      location: "仁智楼",
      teacher: "李",
    },
  ];
  const groups = annotateWeekGroups(courses, WEEK1_MONDAY, buildWeekIndex(courses));
  const week1 = groups.find((g) => g.week === 1)!;
  assert.equal(week1.makeup?.length, 1);
  const line = week1.makeup![0];
  assert.match(line, /09-05（周六）调休·按周三课表/);
  assert.match(line, /大学英语/);
  assert.match(line, /仁智楼/);
  // 补的是周三的课，不是周六自己的
  assert.doesNotMatch(line, /周六课表 · 09-05/);
});

test("annotateWeekGroups: makeup 不在该周周次范围内的课不会补", () => {
  recordSpecialDays([{ date: "2026-09-05", type: "makeup", follows: 3 }]);
  const courses = [
    { title: "只开单周", weekday: 3, periods: [1, 2], weeks: "3,5,7", location: "", teacher: "" },
  ];
  const groups = annotateWeekGroups(courses, WEEK1_MONDAY, buildWeekIndex(courses));
  // 该课只排在 3/5/7 周：第 1 周（含 9-05 调休日）根本无分组，周三的课也补不进任何周
  assert.equal(
    groups.find((g) => g.week === 1),
    undefined,
  );
  for (const g of groups) {
    assert.equal(g.makeup, undefined, `第 ${g.week} 周不应有调休补课行`);
  }
});
