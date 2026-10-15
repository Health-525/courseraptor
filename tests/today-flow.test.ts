/**
 * 「今日」全链路 e2e：导入清洗 -> 当天课表换算 -> .ics 导出
 *
 * 覆盖用户主路径：把模型解析结果收口成课程 → 按日期换算当天实际要上的课
 * （假期清空/调休换课/周次过滤）→ 导出整学期日历。任一段漂移都会让
 * 「今日页显示的课」和「日历里的事件」对不上，这里一次性钉住。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前重定向数据目录并装配默认学校适配器
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-today-"));
await import("../src/adapters");

const { sanitizeCourses } = await import("../src/core/schedule-import");
const { planForDate } = await import("../src/core/calendar/week-plan");
const { buildTermICS } = await import("../src/core/calendar/export");

test("today全链路: 导入清洗 -> 当天课表 -> ICS导出", () => {
  const { courses, rejected } = sanitizeCourses([
    {
      title: "高等数学",
      weekday: 1,
      periods: [1, 2],
      weeks: "1-16",
      location: "教一101",
      teacher: "张老师",
    },
    { title: "英语", weekday: 2, periods: [3, 4], weeks: "1-16" },
    { title: "", weekday: 9, periods: [] },
  ]);
  assert.equal(rejected.length, 1, "缺课程名的行进 rejected");
  assert.equal(courses.length, 2);

  const week1Monday = "2026-08-31";
  const monday = planForDate(courses, week1Monday, week1Monday);
  assert.equal(monday.courses.length, 1);
  assert.equal(monday.courses[0]!.title, "高等数学");

  const tuesday = planForDate(courses, "2026-09-01", week1Monday);
  assert.equal(tuesday.courses.length, 1);
  assert.equal(tuesday.courses[0]!.title, "英语");

  const out = buildTermICS({
    courses,
    exams: [],
    week1Monday,
    termLabel: "2026秋",
    now: new Date("2026-09-01T00:00:00Z"),
  });
  assert.ok(out.courseEvents > 0, "应导出课程事件");
  assert.ok(out.ics.includes("BEGIN:VCALENDAR"));
  assert.ok(out.ics.includes("END:VCALENDAR"));
  assert.ok(out.ics.includes("高等数学"), "ICS 应含课程标题");
  assert.ok(out.ics.includes("UID:"), "事件需带稳定 UID");
  assert.ok(out.ics.includes("BEGIN:VTIMEZONE"), "需带 Asia/Shanghai 时区块");
});
