/**
 * 课表 SVG 导出测试
 *
 * 钉住的行为：
 * 1. term 整学期汇总：课格带课名/地点/教师/周次，XML 正确转义；
 * 2. 同一时段不同周次的课（冲突）并排分栏，计数值如实；
 * 3. 无节次课程落脚注不入格；周末没课的尾列自动收掉；
 * 4. week 单周：放假日清空并画竖排放假块、调休按被补周几换课表、
 *    单双周过滤、今天列带「·今」标记；
 * 5. 网页直链 /api/schedule/svg：无缓存如实报错，有缓存按
 *    attachment 下发 image/svg+xml（term 与指定周两种形态）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-svg-"));

await import("../src/adapters");
const { renderTermScheduleSVG, renderWeekScheduleSVG } = await import("../src/core/schedule-svg");
const { recordSpecialDays } = await import("../src/core/calendar/holidays");
const { saveScheduleCache } = await import("../src/core/schedule-cache");
const { startChatWeb } = await import("../src/channels/web/chat-web");

/** week1Monday=2026-08-31（周一）的学期底稿 */
const WEEK1_MONDAY = "2026-08-31";
const TERM_LABEL = "2026-2027学年第一学期";

function fixtureCourses() {
  return [
    {
      title: "最优化方法",
      weekday: 3, // 周三
      periods: [1, 2],
      weeks: "1-16",
      location: "仁智楼518",
      teacher: "张三",
    },
    {
      title: "大学英语",
      weekday: 3, // 周三，与最优化同时段、不同周次 → 冲突并排
      periods: [1, 2],
      weeks: "9-16",
      location: "同和楼210",
      teacher: "李四",
    },
    {
      title: "体育(二)<提高班>", // 课名带 XML 敏感字符
      weekday: 5, // 周五
      periods: [6, 7],
      weeks: "3-13(单)", // 单周
      location: "操场",
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
  ];
}

function assertWellFormed(svg: string): void {
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), "必须是 svg 根元素开头");
  assert.ok(svg.endsWith("</svg>"), "必须以 </svg> 收尾");
  // 未转义的 & 不允许出现（实体引用除外）
  assert.doesNotMatch(svg, /&(?!amp;|lt;|gt;|quot;|apos;|#)/);
}

// ── term 整学期汇总 ─────────────────────────────────────────────────

test("term：课名/地点/教师/周次入图，XML 转义正确", () => {
  const r = renderTermScheduleSVG({
    courses: fixtureCourses(),
    termLabel: TERM_LABEL,
    now: new Date("2026-10-01T12:00:00"),
  });
  assertWellFormed(r.svg);
  assert.ok(r.svg.includes(TERM_LABEL));
  assert.ok(r.svg.includes("最优化方法"));
  assert.ok(r.svg.includes("仁智楼518 · 张三"), "地点与教师合并成一行元信息");
  assert.ok(r.svg.includes("1-16周"), "周次原文要标注周");
  assert.ok(r.svg.includes("&lt;提高班&gt;"), "课名中的尖括号必须转义");
  assert.ok(!r.svg.includes("<提高班>"), "不允许裸尖括号内容");
  assert.ok(r.svg.includes("生成于 2026-10-01 12:00"), "页头带生成时间戳");
});

test("term：同时段不同周次并排分栏，计数如实", () => {
  const r = renderTermScheduleSVG({ courses: fixtureCourses(), termLabel: TERM_LABEL });
  assert.equal(r.counts.cells, 3);
  assert.equal(r.counts.splitSlots, 1, "周三 1-2 节两门课算一个并排时段");
  assert.ok(r.svg.includes("大学英语"));
});

test("term：无节次课落脚注，空周末尾列收掉", () => {
  const r = renderTermScheduleSVG({ courses: fixtureCourses(), termLabel: TERM_LABEL });
  assert.equal(r.counts.unscheduled, 1);
  assert.ok(r.svg.includes("无节次课"), "脚注里要点名未排课");
  assert.ok(!r.svg.includes("周六"), "周六无课应收列");
  assert.ok(!r.svg.includes("周日"), "周日无课应收列");
  assert.ok(r.svg.includes("周五"), "周一~周五保底保留");
});

// ── week 单周（放假 / 调休 / 单双周） ───────────────────────────────

// 第 1 周周三=09-02（放假日）、周六=09-05（调休补周三的课）
recordSpecialDays([
  { date: "2026-09-02", type: "holiday", name: "测试节" },
  { date: "2026-09-05", type: "makeup", follows: 3 },
]);

test("week：放假日清空画竖排块，调休日按被补周几上课", () => {
  const r = renderWeekScheduleSVG({
    courses: fixtureCourses(),
    week: 1,
    week1Monday: WEEK1_MONDAY,
    termLabel: TERM_LABEL,
    now: new Date("2026-09-01T10:00:00"), // 第 1 周周二
  });
  assertWellFormed(r.svg);
  assert.ok(r.svg.includes("测试节 放假"), "放假日画竖排块");
  assert.ok(r.svg.includes("补课"), "调休日角标");
  assert.ok(r.svg.includes("最优化方法"), "周六补的是周三的课");
  assert.ok(r.svg.includes("·今"), "周二 09-01 是今天");
  // 第 1 周不该出现的：大学英语(9-16 周)、单周体育(3-13 单)
  assert.ok(!r.svg.includes("大学英语"));
  assert.ok(!r.svg.includes("体育"));
});

test("week：单双周过滤——单周课只出现在单周", () => {
  const even = renderWeekScheduleSVG({
    courses: fixtureCourses(),
    week: 2, // 双周
    week1Monday: WEEK1_MONDAY,
    termLabel: TERM_LABEL,
    now: new Date("2026-10-01T10:00:00"),
  });
  assert.ok(!even.svg.includes("体育"), "第 2 周是双周，单周体育不该出现");
  const odd = renderWeekScheduleSVG({
    courses: fixtureCourses(),
    week: 3, // 单周
    week1Monday: WEEK1_MONDAY,
    termLabel: TERM_LABEL,
    now: new Date("2026-10-01T10:00:00"),
  });
  assert.ok(odd.svg.includes("体育"), "第 3 周是单周，体育应该在");
});

// ── 网页直链端点 ────────────────────────────────────────────────────

test("端点：无课表缓存时如实报错", async () => {
  const url = (await startChatWeb())!;
  const res = await fetch(`${url}/api/schedule/svg?mode=term`);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "无缓存应返回 error 字段而不是空图");
});

test("端点：term 与指定周两种形态按 attachment 下发 SVG", async () => {
  const url = (await startChatWeb())!;
  saveScheduleCache({
    year: 2026,
    semester: 3,
    label: TERM_LABEL,
    courses: fixtureCourses(),
  });

  const term = await fetch(`${url}/api/schedule/svg?mode=term`);
  assert.match(term.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assert.match(term.headers.get("content-disposition") ?? "", /schedule-term-2026-1\.svg/);
  const termSvg = await term.text();
  assert.ok(termSvg.includes("最优化方法"));

  const week = await fetch(`${url}/api/schedule/svg?mode=week&week=2`);
  assert.match(week.headers.get("content-disposition") ?? "", /schedule-week2-2026-1\.svg/);
  const weekSvg = await week.text();
  assert.ok(weekSvg.includes("第 2 周课表"), "单周图副标题要标周次");
  assert.ok(!weekSvg.includes("体育"), "第 2 周双周无体育");
});
