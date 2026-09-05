/**
 * 日历导出测试
 *
 * 钉住的行为（对照 ScholarFlow 单周版刻意补齐的语义）：
 * 1. 周次表达式展开成具体日期，时刻来自节次表；
 * 2. 放假日：当天的课被吞掉，换成「放假」全天事件；没排课的放假日也要可见；
 * 3. 调休补课日：按被换周几的课表补出事件，自然落在该天的课不上；
 * 4. 考试事件带提前 30 分钟提醒与座位信息；
 * 5. RFC 5545 基本面：CRLF、转义、UID 跨次稳定（重复导入不重复建事件）、
 *    行按 UTF-8 字节数折叠（中文标题不超宽）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录（term-holidays 真值源落在这里）
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-ics-"));

const { buildTermICS } = await import("../src/calendar-export");
const { recordSpecialDays } = await import("../src/jwgl/term-holidays");

const NOW = new Date("2026-09-01T00:00:00Z");

/** week1Monday=2026-08-31（周一）的学期底稿 */
function fixture() {
  return {
    week1Monday: "2026-08-31",
    termLabel: "2026-2027学年第一学期",
    now: NOW,
    courses: [
      {
        title: "最优化方法",
        weekday: 3, // 周三
        periods: [1, 2], // 08:10-09:50
        weeks: "1-2",
        location: "仁智楼518",
        teacher: "张三",
      },
      {
        title: "周六课,含逗号",
        weekday: 6, // 周六
        periods: [3, 4], // 10:20-12:00
        weeks: "1-2", // 第 1 周周六（09-05）是调休补课日：不照常上；第 2 周正常
        location: "",
        teacher: "",
      },
      {
        title: "无节次课",
        weekday: 2,
        periods: [],
        weeks: "1-16",
        location: "",
        teacher: "",
      },
    ],
    exams: [
      {
        subject: "最优化方法",
        date: "2026-09-10",
        time: "14:00-16:00",
        location: "仁智楼201",
        seatNumber: "15",
      },
    ],
  };
}

/** 第 1 周周三=09-02（放假日）、周六=09-05（调休补课）；第 2 周周三=09-09 正常 */
test("假期吞课、全天事件补齐、调休按被换周几补课", () => {
  recordSpecialDays([
    { date: "2026-09-02", type: "holiday", name: "测试节" },
    { date: "2026-09-04", type: "holiday", name: "没课日的中秋" }, // 当天无课，靠全量补齐
    { date: "2026-09-05", type: "makeup", follows: 3 }, // 周六补周三的课
  ]);

  const r = buildTermICS(fixture());
  assert.equal(r.courseEvents, 2); // 09-09 的最优化方法 + 09-12 的周六课
  assert.equal(r.holidaySkipped, 1); // 09-02 的课被吞
  assert.equal(r.holidayEvents, 2); // 09-02 + 09-04（后者当天无课也要可见）
  assert.equal(r.makeupEvents, 1); // 09-05 按周三课表补出
  assert.equal(r.noTimeSkipped, 1); // 无节次课定时不了，如实跳过

  // 正常周次展开：第 2 周周三 = 2026-09-09 08:10、第 2 周周六 = 09-12 10:20
  assert.ok(r.ics.includes("DTSTART;TZID=Asia/Shanghai:20260909T081000"));
  assert.ok(r.ics.includes("DTSTART;TZID=Asia/Shanghai:20260912T102000"));
  // 放假日：全天事件而不是定时事件
  assert.ok(r.ics.includes("DTSTART;VALUE=DATE:20260902"));
  assert.ok(r.ics.includes("DTSTART;VALUE=DATE:20260904"));
  assert.ok(r.ics.includes("SUMMARY:放假：测试节"));
  // 当天的课确实被吞掉
  assert.ok(!r.ics.includes("20260902T081000"));
  // 调休补课：09-05（周六）出现周三的第 1-2 节课
  assert.ok(r.ics.includes("DTSTART;TZID=Asia/Shanghai:20260905T081000"));
  assert.ok(r.ics.includes("调休补课（按周三课表）"));
  // 自然落在 09-05 的周六课不照常上（该天执行周三课表）
  assert.ok(!r.ics.includes("20260905T1020"));
});

test("考试事件带时刻、考场座位与提前 30 分钟提醒", () => {
  const r = buildTermICS(fixture());
  assert.ok(r.ics.includes("DTSTART;TZID=Asia/Shanghai:20260910T140000"));
  assert.ok(r.ics.includes("DTEND;TZID=Asia/Shanghai:20260910T160000"));
  assert.ok(r.ics.includes("TRIGGER:-PT30M"));
  assert.ok(r.ics.includes("座位：15"));
  assert.ok(r.ics.includes("LOCATION:仁智楼201"));
  assert.equal(r.examEvents, 1);
});

test("RFC 5545 基本面：CRLF、转义、日历名、UID 稳定", () => {
  const a = buildTermICS(fixture());
  const b = buildTermICS(fixture());
  assert.equal(a.ics, b.ics, "同输入同 now 必须逐字节一致（UID/DTSTAMP 稳定）");

  assert.ok(a.ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(a.ics.endsWith("END:VCALENDAR\r\n") || a.ics.endsWith("END:VCALENDAR"));
  assert.ok(a.ics.includes("VERSION:2.0"));
  assert.ok(a.ics.includes("X-WR-CALNAME:2026-2027学年第一学期"));
  assert.ok(a.ics.includes("BEGIN:VTIMEZONE"));
  // 逗号必须转义（否则字段会被截断）
  assert.ok(a.ics.includes("周六课\\,含逗号"));

  // 每行按 UTF-8 字节数不超过 75（含续行前导空格）
  for (const line of a.ics.split("\r\n")) {
    assert.ok(
      Buffer.byteLength(line, "utf8") <= 75,
      `超宽行（${Buffer.byteLength(line, "utf8")} 字节）：${line.slice(0, 40)}…`,
    );
  }
});

test("长中文标题正确折叠后仍能还原完整 SUMMARY", () => {
  const fx = fixture();
  const longTitle = "习近平新时代中国特色社会主义思想概论（含形势与政策实践环节）";
  fx.courses = [
    { title: longTitle, weekday: 1, periods: [1, 2], weeks: "1", location: "", teacher: "" },
  ];
  const r = buildTermICS(fx);
  // 展开折叠：续行去掉前导空格拼回
  const unfolded = r.ics.split("\r\n ").join("");
  assert.ok(unfolded.includes(`SUMMARY:${longTitle}`));
  // 该标题远超 75 字节，必须真的产生了续行（而非侥幸没折）
  assert.ok(r.ics.includes("\r\n "), "超宽中文行应产生以空格开头的续行");
});
