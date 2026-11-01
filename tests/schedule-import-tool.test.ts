/**
 * 对话内课表导入工具测试：import_schedule 出草稿（文本/文件路径/追问透传）、
 * import_schedule_commit 落盘（edits/skip 修正、termStart 校验、过期草稿拒绝）、
 * 台账只登记 commit。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-schedule-import-tool-"));
process.env.RAPTOR_DATA_DIR = tmpData;

await import("../src/adapters");
const { setScheduleParser } = await import("../src/core/schedule-import");
const { coreTools } = await import("../src/core/tools");
const { loadScheduleCache } = await import("../src/core/schedule-cache");
const { ledgerLine } = await import("../src/core/session-ledger");

const parse = coreTools.import_schedule as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
const commit = coreTools.import_schedule_commit as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const FAKE_OUTPUT = JSON.stringify({
  courses: [
    {
      title: "高等数学",
      weekday: 1,
      periods: [3, 4],
      weeks: "1-16",
      location: "教A-101",
      teacher: "张三",
    },
    {
      title: "大学英语",
      weekday: 3,
      periods: [1, 2],
      weeks: "1-16",
      location: "教B-201",
      teacher: "李四",
    },
    { title: "体育", weekday: 5, periods: [5, 6], weeks: "1-16", location: "体育馆", teacher: "" },
  ],
  questions: [{ question: "这学期一共上多少周？", options: "16 / 18" }],
  termHint: "2026-2027-1",
});

test.beforeEach(() => {
  setScheduleParser(async () => FAKE_OUTPUT);
});

test("文本解析出草稿：行视图 + 追问透传 + draftId", async () => {
  const r = await parse.execute({ text: "周一3-4节高数…（任意课表文本）" });
  assert.ok(typeof r.draftId === "string" && r.draftId.length > 0, "必须返回 draftId");
  assert.equal((r.courses as unknown[]).length, 3);
  const row = (r.courses as Array<Record<string, unknown>>)[0];
  assert.ok(row);
  assert.equal(row.title, "高等数学");
  assert.equal(row.weekdayLabel, "周一");
  assert.equal(row.periodsLabel, "3-4节");
  assert.equal(row.index, 0);
  const questions = r.questions as Array<{ question: string }>;
  assert.equal(questions.length, 1);
  assert.match(questions[0]!.question, /多少周/);
  assert.match(String(r.next), /转述/);
});

test("缺少课表内容时给出可操作错误", async () => {
  const r = await parse.execute({});
  assert.match(String(r.error), /text|path/);
});

test("path 入口：读取本机课表文件解析", async () => {
  const file = path.join(tmpData, "课表.txt");
  fs.writeFileSync(file, "周一 3-4节 高等数学 1-16周", "utf8");
  const r = await parse.execute({ path: file });
  assert.equal((r.courses as unknown[]).length, 3);
  assert.match(String(r.summary), /课表.txt/);
});

test("commit：落盘 + skip/edits 修正 + 台账登记", async () => {
  const p = await parse.execute({ text: "课表文本" });
  const draftId = p.draftId as string;
  // 用户口述修正：第 3 行（体育）不要了；第 1 行周次改 1-17
  const r = await commit.execute({
    draftId,
    skip: [2],
    edits: [{ index: 0, weeks: "1-17" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  const cached = loadScheduleCache();
  assert.ok(cached, "课表缓存必须已写入");
  const titles = cached.schedule.courses.map((c) => c.title);
  assert.deepEqual(titles, ["高等数学", "大学英语"]);
  assert.equal(cached.schedule.courses[0]?.weeks, "1-17");
  const line = ledgerLine("import_schedule_commit", { draftId }, r);
  assert.match(line ?? "", /【课表】已导入课表/);
  // 草稿用后即焚：同 id 二次 commit 拒绝
  const again = await commit.execute({ draftId });
  assert.match(String(again.error), /不存在或已过期/);
});

test("commit 校验 termStart：非周一拒绝且不落盘", async () => {
  const before = loadScheduleCache();
  const p = await parse.execute({ text: "课表文本" });
  const r = await commit.execute({ draftId: p.draftId as string, termStart: "2026-11-04" });
  assert.match(String(r.error), /周一/);
  assert.equal(loadScheduleCache()?.savedAt, before?.savedAt, "失败时不得写缓存");
});

test("commit：周一 termStart 通过并记录", async () => {
  const p = await parse.execute({ text: "课表文本" });
  const r = await commit.execute({ draftId: p.draftId as string, termStart: "2026-11-02" });
  assert.equal(r.ok, true);
  assert.match(String(r.summary), /开学日期 2026-11-02/);
});

test("未知 draftId 拒绝；parse 不进台账", async () => {
  const r = await commit.execute({ draftId: "nope" });
  assert.match(String(r.error), /不存在或已过期/);
  const p = await parse.execute({ text: "课表文本" });
  assert.equal(ledgerLine("import_schedule", { text: "…" }, p), null);
});

test("解析出零课程时如实报错并保留追问", async () => {
  setScheduleParser(async () => JSON.stringify({ courses: [], questions: [] }));
  const r = await parse.execute({ text: "不是课表的内容" });
  assert.match(String(r.error), /没有解析出任何课程/);
});
