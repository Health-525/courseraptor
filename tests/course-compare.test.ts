/**
 * 选课冲突对比工具测试
 *
 * 钉住 parseSksjSegments / segmentsOverlap 的核心行为：
 * - 标准格式解析正确
 * - 多段、跨周、节次区间
 * - 冲突检测：同周同节同周次才冲突，不同条件不误判
 * - 容错：空串、缺字段、无法解析的段跳过不崩
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { parseSksjSegments, segmentsOverlap, expandWeeks } = await import(
  "../src/adapters/njtech/academics"
);

test("parseSksjSegments：标准单段解析", () => {
  const segs = parseSksjSegments("星期一第5-6节{2-17周}");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].weekday, 1);
  assert.deepEqual(segs[0].periods, [5, 6]);
  assert.equal(segs[0].weeks, "2-17");
  assert.deepEqual(segs[0].expandedWeeks, expandWeeks("2-17"));
});

test("parseSksjSegments：多段以分号分隔", () => {
  const segs = parseSksjSegments("星期一第5-6节{2-17周};星期四第5-6节{2-17周}");
  assert.equal(segs.length, 2);
  assert.equal(segs[0].weekday, 1);
  assert.equal(segs[1].weekday, 4);
});

test("parseSksjSegments：单节次格式（第3节而非第3-4节）", () => {
  const segs = parseSksjSegments("星期三第3节{1-16周}");
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0].periods, [3]);
});

test("parseSksjSegments：周日/星期天均映射为7", () => {
  assert.equal(parseSksjSegments("星期日第1-2节{1-10周}")[0].weekday, 7);
  assert.equal(parseSksjSegments("星期天第1-2节{1-10周}")[0].weekday, 7);
});

test("parseSksjSegments：空串返回空数组", () => {
  assert.deepEqual(parseSksjSegments(""), []);
});

test("parseSksjSegments：无法解析的段跳过不崩", () => {
  const segs = parseSksjSegments("乱七八糟;星期二第7-8节{3-15周}");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].weekday, 2);
});

test("parseSksjSegments：复杂周次表达式", () => {
  const segs = parseSksjSegments("星期五第9-10节{2-6,8-12周}");
  assert.equal(segs[0].weeks, "2-6,8-12");
  // 2-6 + 8-12 = 10 周
  assert.equal(segs[0].expandedWeeks.length, 10);
  assert.ok(segs[0].expandedWeeks.includes(2));
  assert.ok(segs[0].expandedWeeks.includes(6));
  assert.ok(segs[0].expandedWeeks.includes(8));
  assert.ok(segs[0].expandedWeeks.includes(12));
  assert.ok(!segs[0].expandedWeeks.includes(7));
});

test("segmentsOverlap：同周同节同周次=冲突", () => {
  const a = parseSksjSegments("星期一第5-6节{2-17周}")[0];
  const b = parseSksjSegments("星期一第6-7节{10-15周}")[0];
  // 节次 6 交集，周次 10-15 在 2-17 内
  assert.equal(segmentsOverlap(a, b), true);
});

test("segmentsOverlap：同周不同节=不冲突", () => {
  const a = parseSksjSegments("星期一第5-6节{2-17周}")[0];
  const b = parseSksjSegments("星期一第7-8节{2-17周}")[0];
  assert.equal(segmentsOverlap(a, b), false);
});

test("segmentsOverlap：不同星期=不冲突", () => {
  const a = parseSksjSegments("星期一第5-6节{2-17周}")[0];
  const b = parseSksjSegments("星期二第5-6节{2-17周}")[0];
  assert.equal(segmentsOverlap(a, b), false);
});

test("segmentsOverlap：周次无交集=不冲突", () => {
  const a = parseSksjSegments("星期一第5-6节{2-8周}")[0];
  const b = parseSksjSegments("星期一第5-6节{9-17周}")[0];
  assert.equal(segmentsOverlap(a, b), false);
});

test("segmentsOverlap：单双周不冲突", () => {
  const a = parseSksjSegments("星期一第5-6节{2-17(单)周}")[0];
  const b = parseSksjSegments("星期一第5-6节{2-17(双)周}")[0];
  assert.equal(segmentsOverlap(a, b), false);
});

test("segmentsOverlap：无周次字段时 expandedWeeks 为空，不冲突", () => {
  // 无 {..周} 的段，expandedWeeks 为空数组
  const a = parseSksjSegments("星期一第5-6节")[0];
  const b = parseSksjSegments("星期一第5-6节")[0];
  assert.equal(segmentsOverlap(a, b), false);
});
