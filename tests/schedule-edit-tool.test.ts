/**
 * edit_schedule 工具测试：调课/加课/退课直写课表缓存，冲突拦截、
 * base 快照与 revert 还原，以及在线刷新覆盖后 base 清空的语义边界。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-schedule-edit-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const seedSchedule = {
  year: 2026,
  semester: 3,
  label: "2026-2027学年第一学期",
  courses: [
    {
      title: "高等数学",
      weekday: 1,
      periods: [1, 2],
      weeks: "1-16",
      location: "教A-101",
      teacher: "张三",
    },
    {
      title: "大学英语",
      weekday: 2,
      periods: [1, 2],
      weeks: "1-16",
      location: "教B-201",
      teacher: "李四",
    },
    {
      title: "体育",
      weekday: 4,
      periods: [5, 6],
      weeks: "2-16(单)",
      location: "体育馆",
      teacher: "",
    },
  ],
};

fs.writeFileSync(
  path.join(tmpData, "schedule-cache.json"),
  JSON.stringify({ savedAt: 1, schedule: seedSchedule }),
  "utf8",
);

const { coreTools } = await import("../src/core/tools");
const { loadScheduleCache, saveScheduleCache } = await import("../src/core/schedule-cache");

const edit = coreTools.edit_schedule as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const firstTitle = () => loadScheduleCache()?.schedule.courses[0]?.title ?? "";

test("list：带 id 的时段清单，无修改时不提示 revert", async () => {
  const r = await edit.execute({ action: "list" });
  assert.equal((r.entries as unknown[]).length, 3);
  const first = (r.entries as Array<Record<string, unknown>>)[0];
  assert.ok(first);
  assert.equal(first.id, "0");
  assert.equal(first.title, "高等数学");
  assert.equal(first.periodsLabel, "1-2节");
  assert.equal(r.note, undefined);
});

test("update 调课：换星期节次+教室，落盘并建立 base 快照", async () => {
  const r = await edit.execute({
    action: "update",
    id: "0",
    weekday: 5,
    periods: [3, 4],
    location: "教C-302",
  });
  assert.equal(r.ok, true);
  const cached = loadScheduleCache();
  const moved = cached?.schedule.courses[0];
  assert.equal(moved?.title, "高等数学");
  assert.equal(moved?.weekday, 5);
  assert.deepEqual(moved?.periods, [3, 4]);
  assert.equal(moved?.location, "教C-302");
  // base 是修改前的原样：周一 1-2 节
  assert.equal(cached?.base?.courses[0]?.weekday, 1);
  assert.deepEqual(cached?.base?.courses[0]?.periods, [1, 2]);
});

test("update 与已有课冲突被拦，不落盘", async () => {
  // 高数现在周五 3-4 节；挪去周二 1-2 节撞大学英语
  const before = loadScheduleCache();
  const r = await edit.execute({ action: "update", id: "0", weekday: 2, periods: [1, 2] });
  assert.ok(typeof r.error === "string" && r.error.includes("大学英语"));
  const after = loadScheduleCache();
  assert.equal(after?.schedule.courses[0]?.weekday, before?.schedule.courses[0]?.weekday);
});

test("单双周不误报：高数改双周后挪到周四 5-6 节，与单周的体育不冲突", async () => {
  // 高数当前周五 3-4 节（全周）：先改成双周（只改周次，无位置冲突）
  const rebase = await edit.execute({ action: "update", id: "0", weeks: "1-16(双)" });
  assert.equal(rebase.ok, true);
  const r = await edit.execute({ action: "update", id: "0", weekday: 4, periods: [5, 6] });
  assert.equal(r.ok, true);
});

test("allowConflict：改回全周撞单周体育被拦，确认后可覆盖写入", async () => {
  const blocked = await edit.execute({ action: "update", id: "0", weeks: "1-16" });
  assert.ok(typeof blocked.error === "string" && blocked.error.includes("体育"));
  const r = await edit.execute({ action: "update", id: "0", weeks: "1-16", allowConflict: true });
  assert.equal(r.ok, true);
  assert.ok(typeof r.warning === "string" && r.warning.includes("体育"));
});

test("update 换教师/清空字段与坏 id 拦截", async () => {
  const r = await edit.execute({ action: "update", id: "1", teacher: "" });
  assert.equal(r.ok, true);
  assert.equal(loadScheduleCache()?.schedule.courses[1]?.teacher, "");
  const bad = await edit.execute({ action: "update", id: "99", teacher: "x" });
  assert.ok(typeof bad.error === "string");
  const badWeeks = await edit.execute({ action: "update", id: "1", weeks: "无" });
  assert.ok(typeof badWeeks.error === "string");
});

test("add 新增课：weeks 默认 1-16，冲突拦截同 update", async () => {
  const r = await edit.execute({
    action: "add",
    title: "线性代数",
    weekday: 3,
    periods: [7, 8],
    location: "教D-401",
  });
  assert.equal(r.ok, true);
  const added = loadScheduleCache()?.schedule.courses.at(-1);
  assert.equal(added?.title, "线性代数");
  assert.equal(added?.weeks, "1-16");
  const conflict = await edit.execute({
    action: "add",
    title: "影分身",
    weekday: 2,
    periods: [1, 2],
  });
  assert.ok(typeof conflict.error === "string" && typeof conflict.error === "string");
});

test("add 缺必填字段报错", async () => {
  const noTitle = await edit.execute({ action: "add", weekday: 3, periods: [7, 8] });
  assert.ok(typeof noTitle.error === "string");
  const noWeekday = await edit.execute({ action: "add", title: "X", periods: [7, 8] });
  assert.ok(typeof noWeekday.error === "string");
});

test("delete 批量删除 + 剩余计数；越界 id 拦截", async () => {
  const listed = await edit.execute({ action: "list" });
  const entries = listed.entries as Array<Record<string, unknown>>;
  const linalg = entries.find((e) => e.title === "线性代数")?.id;
  const pe = entries.find((e) => e.title === "体育")?.id;
  assert.ok(typeof linalg === "string" && typeof pe === "string");
  const r = await edit.execute({ action: "delete", ids: [linalg, pe] });
  assert.equal(r.ok, true);
  const titles = loadScheduleCache()?.schedule.courses.map((c) => c.title);
  assert.ok(!titles?.includes("线性代数"));
  assert.ok(!titles?.includes("体育"));
  const bad = await edit.execute({ action: "delete", ids: ["99"] });
  assert.ok(typeof bad.error === "string");
});

test("revert：整体还原最初导入课表，base 清空；再 revert 报错", async () => {
  const r = await edit.execute({ action: "revert" });
  assert.equal(r.ok, true);
  const cached = loadScheduleCache();
  assert.equal(cached?.base, undefined);
  assert.deepEqual(
    cached?.schedule.courses.map((c) => `${c.title}@${c.weekday}`),
    seedSchedule.courses.map((c) => `${c.title}@${c.weekday}`),
  );
  const again = await edit.execute({ action: "revert" });
  assert.ok(typeof again.error === "string");
});

test("在线刷新（saveScheduleCache 覆盖）后 base 清空、list 无 revert 提示", async () => {
  await edit.execute({ action: "update", id: "0", location: "临时教室" }); // 建立 base
  assert.ok(loadScheduleCache()?.base);
  saveScheduleCache(seedSchedule); // 模拟在线拉取/重新导入
  assert.equal(loadScheduleCache()?.base, undefined);
  const r = await edit.execute({ action: "list" });
  assert.equal(r.note, undefined);
});

test("无缓存时明确报错，不编造课表", async () => {
  fs.rmSync(path.join(tmpData, "schedule-cache.json"), { force: true });
  const r = await edit.execute({ action: "list" });
  assert.ok(typeof r.error === "string" && r.error.includes("还没有课表缓存"));
  assert.equal(firstTitle(), "");
});
