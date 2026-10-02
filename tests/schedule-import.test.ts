/**
 * 手动课表导入的纯逻辑层：提示词拼装、模型输出收口（sanitize/冲突/追问）
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  buildImportPrompt,
  sanitizeCourses,
  findConflicts,
  parseScheduleImport,
  setScheduleParser,
  DEFAULT_WEEKS,
} = await import("../src/core/schedule-import");

test("buildImportPrompt：正文与追问答案都进提示词，超长截断有说明", () => {
  const p1 = buildImportPrompt("周一 3-4节 高数");
  assert.match(p1, /课表内容/);
  assert.match(p1, /周一 3-4节 高数/);
  // 没有答案时不带「已问答」段（提示词规则里提到这四个字，按 问：/答： 判段）
  assert.doesNotMatch(p1, /\n问：/);
  const p2 = buildImportPrompt("周一 3-4节 高数", [{ question: "共几周？", answer: "18 周" }]);
  assert.match(p2, /已问答/);
  assert.match(p2, /问：共几周/);
  assert.match(p2, /答：18 周/);
  const long = "高数\n".repeat(40000);
  const p3 = buildImportPrompt(long);
  assert.match(p3, /已截取/);
});

test("sanitizeCourses：宽进严出——缺字段拒收并给原因，周次缺省补整学期", () => {
  const r = sanitizeCourses([
    { title: "高数", weekday: 1, periods: [3, 4], weeks: "1-16", location: "A101", teacher: "张" },
    { title: "  英语  ", weekday: "3", periods: [5, "6", 5], location: "", teacher: "" },
    { weekday: 2, periods: [1] },
    { title: "体育", weekday: 9, periods: [1] },
    { title: "无人课", weekday: 5, periods: [] },
    { title: "坏周次", weekday: 5, periods: [1], weeks: "abc" },
    "不是对象",
  ]);
  assert.equal(r.courses.length, 2);
  const [a, b] = r.courses;
  assert.equal(a.title, "高数");
  assert.deepEqual(a.periods, [3, 4]);
  assert.equal(b.title, "英语");
  assert.equal(b.weekday, 3);
  assert.deepEqual(b.periods, [5, 6]);
  assert.equal(b.weeks, DEFAULT_WEEKS);
  // 拒收行逐条有原因
  const reasons = r.rejected.map((x) => x.reason).join("|");
  assert.match(reasons, /缺少课程名/);
  assert.match(reasons, /星期无效/);
  assert.match(reasons, /节次为空/);
  assert.match(reasons, /解析不出任何周/);
});

test("findConflicts：同星期+节次+周次交集才算冲突，单双周不算", () => {
  const mk = (title: string, weekday: number, weeks: string) => ({
    title,
    weekday,
    periods: [3, 4],
    weeks,
    location: "",
    teacher: "",
  });
  const conflicts = findConflicts([
    mk("高数", 1, "1-16"),
    mk("线代", 1, "8-16"),
    mk("单周课", 2, "1-15(单)"),
    mk("双周课", 2, "2-16(双)"),
    mk("周五课", 5, "1-16"),
  ]);
  // 高数×线代 周一 3-4 节 8-16 周重叠；单双周错开不算；周五不撞
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /高数.*线代|线代.*高数/);
});

test("parseScheduleImport：替身解析器 → JSON 收口（容忍围栏），追问透传", async () => {
  setScheduleParser(async () =>
    JSON.stringify({
      courses: [
        { title: "高数", weekday: 1, periods: [3, 4], weeks: "1-16" },
        { title: "坏行", weekday: 0, periods: [] },
      ],
      questions: [{ question: "本学期一共几周？", options: "16/18/20" }, { question: "" }],
      termHint: "2026-2027-1",
      termStartHint: "2026-09-07",
    }),
  );
  const parsed = await parseScheduleImport("任意内容");
  assert.equal(parsed.courses.length, 1);
  assert.equal(parsed.rejected.length, 1);
  assert.deepEqual(parsed.questions, [{ question: "本学期一共几周？", options: "16/18/20" }]);
  assert.equal(parsed.termHint, "2026-2027-1");
  assert.equal(parsed.termStartHint, "2026-09-07");
  assert.deepEqual(parsed.conflicts, []);
});

test("parseScheduleImport：模型输出不是 JSON 时给可操作报错", async () => {
  setScheduleParser(async () => "抱歉，我无法解析这段内容。");
  await assert.rejects(
    () => parseScheduleImport("内容"),
    (e: Error) => /没有返回 JSON/.test(e.message),
  );
  setScheduleParser(async () => '```json\n{"courses":[]}\n```');
  const ok = await parseScheduleImport("围栏包裹的 JSON");
  assert.equal(ok.courses.length, 0);
  setScheduleParser(null);
});
