/**
 * 时间模块测试
 *
 * 全程离线、时钟注入：getTimeReport 不碰真实 Date.now()，时区换算靠
 * Node 自带 Intl；教学周用临时数据目录里的种子真值（2026 秋 8-31 开学）。
 * 钉住的行为有四条——
 * 1. 读数来自注入时刻，字段齐全且互相一致（datetime = date + weekday + time）；
 * 2. 时区换算正确，跨日边界时两地的日期/星期各自正确，不共用；
 * 3. 北京时间与教学周永远按学校口径给出，不随查询时区漂移；
 * 4. 非法时区返回失败，绝不静默降级成默认时区的时间。
 *
 * 时刻全部用 UTC 字面量构造（带 Z）：北京取正午前后，保证任何合理本机
 * 时区下 candidateXnxqList 读到的年/月（local 字段）都是同一值。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-time-"));

const { getTimeReport, SCHOOL_TIMEZONE } = await import("../src/time");

type Ok = Extract<ReturnType<typeof getTimeReport>, { ok: true }>["data"];

function mustOk(r: ReturnType<typeof getTimeReport>): Ok {
  assert.equal(r.ok, true);
  return (r as { data: Ok }).data;
}

test("默认北京时间：字段齐全且互相一致（2026-09-05 周六 14:30:45）", () => {
  const t = mustOk(getTimeReport(undefined, new Date("2026-09-05T06:30:45Z")));
  assert.equal(t.timezone, SCHOOL_TIMEZONE);
  assert.equal(t.date, "2026-09-05");
  assert.equal(t.time, "14:30:45");
  assert.equal(t.weekday, "周六");
  assert.equal(t.datetime, "2026-09-05（周六）14:30:45");
  assert.equal(t.iso, "2026-09-05T14:30:45+08:00");
  assert.equal(t.utcOffset, "+08:00");
  assert.equal(t.epochMs, new Date("2026-09-05T06:30:45Z").getTime());
  assert.equal(t.beijingNow, t.datetime);
});

test("时区换算：同一时刻纽约是凌晨，教学周仍按北京口径", () => {
  const t = mustOk(getTimeReport("America/New_York", new Date("2026-09-05T06:30:45Z")));
  assert.equal(t.timezone, "America/New_York");
  assert.equal(t.date, "2026-09-05");
  assert.equal(t.time, "02:30:45");
  assert.equal(t.utcOffset, "-04:00"); // 9 月仍是夏令时 EDT
  assert.equal(t.beijingNow, "2026-09-05（周六）14:30:45"); // 北京读数不随查询时区漂移
  assert.equal(t.term.week, 1);
});

test("跨日边界：北京已过午夜是周日，纽约还在周六", () => {
  const instant = new Date("2026-09-05T16:30:00Z");
  const ny = mustOk(getTimeReport("America/New_York", instant));
  assert.equal(ny.date, "2026-09-05");
  assert.equal(ny.time, "12:30:00");
  assert.equal(ny.weekday, "周六");

  const bj = mustOk(getTimeReport(SCHOOL_TIMEZONE, instant));
  assert.equal(bj.date, "2026-09-06");
  assert.equal(bj.time, "00:30:00");
  assert.equal(bj.weekday, "周日");
});

test("教学周：开学第 1 周，周次真值来自种子（week1Monday=2026-08-31）", () => {
  const t = mustOk(getTimeReport(undefined, new Date("2026-09-05T06:30:45Z")));
  assert.equal(t.term.label, "2026-2027学年第一学期");
  assert.equal(t.term.week, 1);
  assert.equal(t.term.week1Monday, "2026-08-31");
  assert.equal(t.term.weekRange, "2026-08-31 ~ 2026-09-06");
  assert.ok(t.term.source === "known" || t.term.source === "recorded");
});

test("教学周：第 2 周周一，weekRange 对齐到本周一~周日", () => {
  const t = mustOk(getTimeReport(undefined, new Date("2026-09-07T02:00:00Z"))); // 北京 9-07 10:00
  assert.equal(t.term.week, 2);
  assert.equal(t.term.weekRange, "2026-09-07 ~ 2026-09-13");
  assert.equal(t.weekday, "周一");
});

test("非法时区返回失败，不静默降级成默认时区", () => {
  const r = getTimeReport("Mars/Olympus");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /无法识别的时区/);
});
