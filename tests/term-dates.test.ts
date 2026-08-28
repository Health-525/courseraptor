/**
 * 学期日期真值源测试
 *
 * 背景：2026 秋的开学日期曾在代码里写死 2026-09-07（估算），而对话里依据
 * 南工教〔2026〕91号通知修正为 2026-08-31 后没有同步回代码，两份真相漂移，
 * 整个学期周次系统性偏差一周。这组测试钉住单一真值源的规则。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-terms-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const {
  parseTermStartDate,
  parseTermRef,
  mondayOf,
  resolveWeek1Monday,
  recordWeek1Monday,
  termKey,
  loadStore,
} = await import("../src/jwgl/term-dates");

test("2026 秋季第 1 周周一 = 2026-08-31（不是估算的 09-07）", () => {
  // 南工教〔2026〕91号：报到 8-29~8-30、注册 8-31~9-30，第一周从 8-31（周一）开始。
  // 此前按「9 月第一个周一」估成 9-07，currentWeekOf 整学期少报一周。
  const r = resolveWeek1Monday(2026, 3);
  assert.equal(r.week1Monday, "2026-08-31");
  assert.ok(r.source === "known" || r.source === "recorded");
});

test("存量学期播种：2025 秋/春有确定值，来源非估算", () => {
  assert.equal(resolveWeek1Monday(2025, 3).week1Monday, "2025-09-01");
  assert.equal(resolveWeek1Monday(2025, 12).week1Monday, "2026-03-02");
});

test("查不到的学期按「春季 3 月第一个周一」估算且必须标 estimated", () => {
  const r = resolveWeek1Monday(2026, 12);
  assert.equal(r.week1Monday, mondayOf(2027, 3, 1));
  assert.equal(r.source, "estimated");
});

test("mondayOf: 任意日期归到所在周的周一", () => {
  assert.equal(mondayOf(2026, 8, 28), "2026-08-24"); // 周五 → 周一
  assert.equal(mondayOf(2026, 8, 31), "2026-08-31"); // 周一 → 自身
  assert.equal(mondayOf(2026, 8, 30), "2026-08-24"); // 周日 → 前一周一
});

test("recordWeek1Monday: recorded 可覆盖 known，estimated 不能覆盖实测", () => {
  const key = termKey(2999, 3);

  // 先给一个 known
  recordWeek1Monday(2999, 3, "2999-09-01", "known", "测试");
  assert.equal(resolveWeek1Monday(2999, 3).week1Monday, "2999-09-01");

  // estimated 不允许冲掉 known（估算值不得污染真值）
  const blocked = recordWeek1Monday(2999, 3, "2999-09-99" as string, "estimated", "估算");
  assert.equal(blocked.week1Monday, "2999-09-01");

  // recorded（通知实测）可以覆盖 known
  recordWeek1Monday(2999, 3, "2999-08-31", "recorded", "校历通知");
  const r = resolveWeek1Monday(2999, 3);
  assert.equal(r.week1Monday, "2999-08-31");
  assert.equal(r.source, "recorded");
});

test("落盘持久化：写进 RAPTOR_DATA_DIR 而非真实 data/", () => {
  const store = loadStore();
  assert.ok(fs.existsSync(path.join(tmpData, "term-dates.json")));
  assert.ok(store[termKey(2026, 3)].week1Monday === "2026-08-31");
  // 确认没写进项目目录
  const projectStore = path.resolve(import.meta.dirname, "../data/term-dates.json");
  assert.equal(fs.existsSync(projectStore), false);
});

// ── 从通知正文解析开学日期 ────────────────────────────────────

test("parseTermStartDate: 「第一周从 2026-08-31（周一）开始」强信号", () => {
  const r = parseTermStartDate(
    "各学院：2026-2027学年第一学期第一周从 2026-08-31（周一）开始，请做好教学安排。"
  );
  assert.equal(r?.week1Monday, "2026-08-31");
});

test("parseTermStartDate: 中文日期「8月31日（星期一）正式上课」", () => {
  const r = parseTermStartDate("学生 8 月 31 日（星期一）正式上课。");
  assert.equal(r?.week1Monday, "2026-08-31");
});

test("parseTermStartDate: 报到注册表述不可用时不硬猜开学日", () => {
  // 只有报到/注册日期，没有「上课/开学」锚定——不应返回结果
  const r = parseTermStartDate("报到时间：8-29～8-30，注册时间：8-31～9-30。");
  assert.equal(r, null);
});

test("parseTermRef: 「2026-2027学年第一学期」", () => {
  assert.deepEqual(parseTermRef("2026-2027学年第一学期报到注册通知"), {
    year: 2026,
    semester: 3,
  });
  assert.deepEqual(parseTermRef("2025-2026-2学期"), { year: 2025, semester: 12 });
  assert.equal(parseTermRef("没有学期信息"), null);
});
