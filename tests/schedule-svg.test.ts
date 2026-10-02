/**
 * 课表 SVG 导出测试
 *
 * 钉住的行为：
 * 1. term 整学期汇总：课格带课名/地点/周次（不带教师名），XML 正确转义；
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
const { scheduleSvgToPng } = await import("../src/core/schedule-png");
const { loadLogoDataUri } = await import("../src/core/brand");
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

test("term：课名/地点/周次入图（不带教师名），XML 转义正确", () => {
  const r = renderTermScheduleSVG({
    courses: fixtureCourses(),
    termLabel: TERM_LABEL,
    now: new Date("2026-10-01T12:00:00"),
  });
  assertWellFormed(r.svg);
  assert.ok(r.svg.includes(TERM_LABEL));
  assert.ok(r.svg.includes("最优化方法"));
  assert.ok(r.svg.includes("仁智楼518"), "地点是元信息主体");
  assert.ok(!r.svg.includes("张三"), "导出图不带教师名");
  assert.ok(r.svg.includes("1-16周"), "周次原文要标注周");
  assert.ok(r.svg.includes("&lt;提高班&gt;"), "课名中的尖括号必须转义");
  assert.ok(!r.svg.includes("<提高班>"), "不允许裸尖括号内容");
  assert.ok(r.svg.includes("生成于 2026-10-01 12:00"), "页头带生成时间戳");
});

test("term：同时段不同周次并排分栏，计数如实", () => {
  const r = renderTermScheduleSVG({ courses: fixtureCourses(), termLabel: TERM_LABEL });
  assert.equal(r.counts.cells, 3);
  assert.equal(r.counts.splitSlots, 1, "周三 1-2 节两门课算一个并排时段");
  // 窄卡里课名会折行，断言用去标签的纯文本（折行不破坏连续性）
  const plain = r.svg.replace(/<[^>]+>/g, "");
  assert.ok(plain.includes("大学英语"));
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

// ── color 彩色课格风格 + PNG ────────────────────────────────────────

test("color：每门课稳定配色，品牌小字落款与顶条在场", () => {
  const r = renderTermScheduleSVG({
    courses: fixtureCourses(),
    termLabel: TERM_LABEL,
    style: "color",
  });
  assertWellFormed(r.svg);
  // 课格用色盘底色（断言至少出现一个色盘值）
  assert.ok(
    /#F3E1DB|#F4E4CE|#F2ECC9|#EDF3D9|#E7F1E2|#E5F0EA|#E4EDF5|#E8E7F4|#EDE9F4|#F4E5EB|#F0E8DB|#ECEEF2/.test(
      r.svg,
    ),
    "彩色课格应使用色盘",
  );
  // 同一门课跨形态同色：两份渲染里「最优化方法」的卡片底色一致
  const w = renderWeekScheduleSVG({
    courses: fixtureCourses(),
    week: 3,
    week1Monday: WEEK1_MONDAY,
    termLabel: TERM_LABEL,
    style: "color",
  });
  const colorOf = (svg: string) =>
    svg
      .slice(svg.indexOf("最优化方法") - 300, svg.indexOf("最优化方法"))
      .match(/#F[A-F0-9]{5}/g)
      ?.pop();
  assert.ok(colorOf(r.svg), "term 图里应能找到课格底色");
  assert.equal(colorOf(r.svg), colorOf(w.svg), "同一门课跨形态颜色稳定");
  // 品牌元素：顶部朱砂条 + 右下落款小字
  assert.ok(r.svg.includes('height="2" fill="#AD392C"'), "顶部朱砂细条");
  assert.ok(r.svg.includes("COURSERAPTOR · 生成于"), "底部小字落款");
  assert.ok(r.svg.includes("Microsoft YaHei"), "color 风格用黑体系而非楷体");
  // 最佳实践版式：零网格线——不再有满格底盘（gridRule 底色外框）
  assert.ok(!r.svg.includes('fill="#F0EDE6" stroke='), "color 不画网格底盘");
});

test("color+logo：logo 以 data URI 嵌入（印章与落款）", () => {
  const logo = loadLogoDataUri();
  assert.ok(logo, "仓库里应能读到 logo");
  const color = renderTermScheduleSVG({
    courses: fixtureCourses(),
    termLabel: TERM_LABEL,
    style: "color",
    logoDataUri: logo,
  });
  assert.ok(color.svg.includes('href="data:image/png;base64,'), "color 落款嵌 logo");
  const classic = renderTermScheduleSVG({
    courses: fixtureCourses(),
    termLabel: TERM_LABEL,
    style: "classic",
    logoDataUri: logo,
  });
  assert.ok(classic.svg.includes('clip-path="url(#sealClip)"'), "classic 印章嵌 logo");
});

test("PNG：2 倍宽光栅化出合法位图", () => {
  const r = renderTermScheduleSVG({
    courses: fixtureCourses(),
    termLabel: TERM_LABEL,
    style: "color",
  });
  const png = scheduleSvgToPng(r.svg, r.width * 2);
  assert.ok(png.length > 1000, "PNG 应有实际内容");
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50); // \x89PNG 魔数
  assert.ok(png.toString("latin1").includes("IHDR"), "PNG 头块");
});

// ── 网页直链端点 ────────────────────────────────────────────────────

test("端点：无课表缓存时如实报错", async () => {
  const url = (await startChatWeb())!;
  const res = await fetch(`${url}/api/schedule/image?mode=term`);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "无缓存应返回 error 字段而不是空图");
});

test("端点：默认 PNG 红头档案且 inline 可预览，download=1 才强制下载", async () => {
  const url = (await startChatWeb())!;
  saveScheduleCache({
    year: 2026,
    semester: 3,
    label: TERM_LABEL,
    courses: fixtureCourses(),
  });

  const png = await fetch(`${url}/api/schedule/image?mode=term`);
  assert.match(png.headers.get("content-type") ?? "", /image\/png/);
  assert.match(
    png.headers.get("content-disposition") ?? "",
    /^inline; .*schedule-term-2026-1\.png/,
  );
  const pngBytes = Buffer.from(await png.arrayBuffer());
  assert.equal(pngBytes[0], 0x89, "PNG 魔数");
  assert.ok(pngBytes.length > 1000);

  const dl = await fetch(`${url}/api/schedule/image?mode=term&download=1`);
  assert.match(
    dl.headers.get("content-disposition") ?? "",
    /^attachment; .*schedule-term-2026-1\.png/,
  );

  const week = await fetch(`${url}/api/schedule/image?mode=week&week=2`);
  assert.match(week.headers.get("content-disposition") ?? "", /schedule-week2-2026-1\.png/);
  const weekSvgText = (await fetch(`${url}/api/schedule/image?mode=week&week=2&format=svg`).then(
    (r) => r.text(),
  )) as string;
  assert.ok(weekSvgText.includes("第 2 周课表"), "单周图副标题要标周次");
  assert.ok(!weekSvgText.includes("体育"), "第 2 周双周无体育");

  const classic = await fetch(`${url}/api/schedule/image?mode=term&format=svg&style=classic`);
  assert.match(classic.headers.get("content-type") ?? "", /image\/svg\+xml/);
  const classicSvg = await classic.text();
  assert.ok(classicSvg.includes("最优化方法"));
  assert.ok(classicSvg.includes("COURSERAPTOR · SCHEDULE"), "classic 页头品牌行保留");
  assert.ok(classicSvg.includes('fill="#E1DCCF" stroke='), "classic 保留满格网格底盘");
});
