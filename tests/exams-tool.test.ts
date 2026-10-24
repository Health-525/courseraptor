/**
 * edit_exams 工具测试：改考场/补录/批量删直写考试缓存，base 快照与
 * revert 还原，手动课表模式从零补录（学期跟课表缓存走），以及官方
 * 刷新覆盖式写入后 base 清空的语义边界。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-exams-edit-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const seedExams = {
  year: 2026,
  semester: 3,
  label: "2026-2027学年第一学期",
  exams: [
    {
      subject: "高等数学",
      date: "2026-11-14",
      time: "14:00-16:00",
      location: "教A-101",
      seatNumber: "12",
    },
    { subject: "大学英语", date: "2026-11-21", time: "09:00-11:00", location: "教B-201" },
  ],
};

fs.writeFileSync(
  path.join(tmpData, "exam-cache.json"),
  JSON.stringify({ savedAt: 1, exams: seedExams }),
  "utf8",
);

const { coreTools } = await import("../src/core/tools");
const { loadExamCache, saveExamCache } = await import("../src/core/exam-cache");
const { registerSchool } = await import("../src/core/school");
const { customSchool } = await import("../src/adapters/custom");

const edit = coreTools.edit_exams as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

test("list：带 id 的考试清单，无修改时不提示 revert", async () => {
  const r = await edit.execute({ action: "list" });
  const entries = r.entries as Array<Record<string, unknown>>;
  assert.equal(entries.length, 2);
  const first = entries[0];
  assert.ok(first);
  assert.equal(first.id, "0");
  assert.equal(first.subject, "高等数学");
  assert.equal(first.seatNumber, "12");
  assert.equal(r.note, undefined);
});

test("update 改考场：落盘并建立 base 快照", async () => {
  const r = await edit.execute({ action: "update", id: "0", location: "教C-302" });
  assert.equal(r.ok, true);
  const cached = loadExamCache();
  assert.equal(cached?.exams.exams[0]?.location, "教C-302");
  assert.ok(cached?.base, "首次修改应落下 base 快照");
  assert.equal(cached?.base?.exams[0]?.location, "教A-101");
});

test("update 日期收整为补零格式，非法日期拒绝", async () => {
  const ok = await edit.execute({ action: "update", id: "0", date: "2026-12-1" });
  assert.equal(ok.ok, true);
  assert.equal(loadExamCache()?.exams.exams[0]?.date, "2026-12-01");

  const bad = await edit.execute({ action: "update", id: "0", date: "2026-02-30" });
  assert.ok(String(bad.error).includes("日期无效"));
  assert.equal(loadExamCache()?.exams.exams[0]?.date, "2026-12-01");
});

test("add 批量补录 + delete 按 ids 批量删", async () => {
  const r = await edit.execute({
    action: "add",
    items: [
      { subject: "数据结构", date: "2026-12-05", time: "19:00-21:00", location: "教D-105" },
      { subject: "体育", date: "2026-12-12" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(loadExamCache()?.exams.exams.length, 4);

  const d = await edit.execute({ action: "delete", ids: ["2", "3"] });
  assert.equal(d.ok, true);
  assert.equal(loadExamCache()?.exams.exams.length, 2);
  assert.equal(d.remaining, 2);
});

test("revert：整体还原最后官方查到的安排并清掉 base", async () => {
  const r = await edit.execute({ action: "revert" });
  assert.equal(r.ok, true);
  const cached = loadExamCache();
  assert.equal(cached?.exams.exams[0]?.location, "教A-101");
  assert.equal(cached?.base, undefined);

  const again = await edit.execute({ action: "revert" });
  assert.ok(String(again.error).includes("没有本地修改"));
});

test("官方刷新覆盖式写入：saveExamCache 不保留 base", () => {
  const fresh = structuredClone(seedExams);
  const first = fresh.exams[0];
  assert.ok(first);
  first.location = "教X-999";
  saveExamCache(fresh);
  const cached = loadExamCache();
  assert.equal(cached?.exams.exams[0]?.location, "教X-999");
  assert.equal(cached?.base, undefined);
});

test("手动课表模式无缓存可从零补录，学期跟课表缓存走", async () => {
  fs.rmSync(path.join(tmpData, "exam-cache.json"), { force: true });
  fs.writeFileSync(
    path.join(tmpData, "schedule-cache.json"),
    JSON.stringify({
      savedAt: 1,
      schedule: { year: 2026, semester: 12, label: "2026-2027学年第二学期", courses: [] },
    }),
    "utf8",
  );
  registerSchool(customSchool);

  const r = await edit.execute({
    action: "add",
    items: [{ subject: "操作系统", date: "2027-1-9", location: "教E-201" }],
  });
  assert.equal(r.ok, true);
  const cached = loadExamCache();
  assert.equal(cached?.exams.label, "2026-2027学年第二学期");
  assert.equal(cached?.exams.exams[0]?.date, "2027-01-09");
  assert.equal(cached?.schoolId, "custom");
});
