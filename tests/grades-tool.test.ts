/**
 * edit_grades 工具测试：手动课表模式报分落盘、按学分加权平均分与
 * 最近学期派生量、update/delete 重算，删空回到面板空态；教务适配
 * 学校一律拒绝（成绩以官方查询为准，本地不可改）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-grades-edit-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { coreTools } = await import("../src/core/tools");
const { loadGradesCache } = await import("../src/core/grades-cache");
const { registerSchool } = await import("../src/core/school");
const { customSchool } = await import("../src/adapters/custom");

const edit = coreTools.edit_grades as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

test("add：逐门记录并按学分加权平均分重算（未装配学校视同手动模式）", async () => {
  const r = await edit.execute({
    action: "add",
    items: [
      { course: "高等数学", score: "92", credit: "4", type: "必修", semester: "2025-2026-2" },
      { course: "大学英语", score: "88", credit: "3", type: "必修", semester: "2025-2026-2" },
      { course: "线性代数", score: "80", credit: "2", semester: "2024-2025-1" },
    ],
  });
  assert.equal(r.ok, true);
  const cached = loadGradesCache();
  assert.ok(cached);
  assert.equal(cached?.courseCount, 3);
  // (92*4 + 88*3 + 80*2) / (4+3+2) = 792/9 = 88
  assert.equal(cached?.gpa, "88.00");
  assert.ok(String(cached?.gpaBasis).includes("手动记录"));
  assert.equal(cached?.recentSemester, "2025-2026-2");
  assert.equal(cached?.recentCourses.length, 2);
  assert.equal(cached?.allCourses?.length, 3);
});

test("update 改分后重算平均分", async () => {
  const r = await edit.execute({ action: "list" });
  const id = (r.entries as Array<Record<string, unknown>>)[0]?.id;
  assert.equal(id, "0");
  const u = await edit.execute({ action: "update", id: String(id), score: "95" });
  assert.equal(u.ok, true);
  // (95*4 + 88*3 + 80*2) / 9 = 804/9 = 89.33
  assert.equal(loadGradesCache()?.gpa, "89.33");
});

test("等级制分数照记但不计入平均分", async () => {
  const r = await edit.execute({
    action: "add",
    items: [{ course: "体育", score: "良", credit: "1", semester: "2025-2026-2" }],
  });
  assert.equal(r.ok, true);
  const cached = loadGradesCache();
  assert.equal(cached?.courseCount, 4);
  // 数值分不变：(95*4 + 88*3 + 80*2) / 9 = 89.33
  assert.equal(cached?.gpa, "89.33");
});

test("delete 删到空：缓存移除，面板回到空态，可重新记录", async () => {
  const r = await edit.execute({ action: "list" });
  const entries = r.entries as Array<Record<string, unknown>>;
  const ids = entries.map((e) => String(e.id));
  const d = await edit.execute({ action: "delete", ids });
  assert.equal(d.ok, true);
  assert.equal(d.remaining, 0);
  assert.equal(loadGradesCache(), null);

  const again = await edit.execute({
    action: "add",
    items: [{ course: "操作系统", score: "90", credit: "3" }],
  });
  assert.equal(again.ok, true);
  assert.equal(loadGradesCache()?.courseCount, 1);
  assert.equal(loadGradesCache()?.gpa, "90.00");
});

test("教务适配学校：一律拒绝并说明成绩以官方查询为准", async () => {
  registerSchool({
    ...customSchool,
    info: { ...customSchool.info, id: "fake", manual: undefined },
  });
  const r = await edit.execute({ action: "list" });
  assert.ok(String(r.error).includes("教务"));
  const add = await edit.execute({
    action: "add",
    items: [{ course: "高等数学", score: "92" }],
  });
  assert.ok(String(add.error).includes("不可修改"));
});
