/**
 * manage_todos 工具测试：对话里说的待办落进 web-workspace.json，
 * 与课表页 /today、对话页「设置 → 截止日期待办」共用同一份存储。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-todos-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { raptorTools } = await import("../src/tools");
const { listReminders } = await import("../src/web/workspace-data");

const manage = raptorTools.manage_todos as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

test("批量 add：一次记多条、纯日期按当天 23:59 本地截止", async () => {
  const r = await manage.execute({
    action: "add",
    items: [
      { title: "交高数作业", dueAt: "2026-09-15" },
      { title: "实验报告", dueAt: "2026-09-18T14:00:00", notes: "带数据处理" },
    ],
  });
  assert.equal(r.ok, true);
  assert.match(String(r.summary), /已记录 2 条待办/);
  const added = r.added as Array<{ title: string; dueAt: string; source?: string }>;
  assert.equal(added.length, 2);
  // 纯日期 2026-09-15 按本地 23:59 截止，而不是被当成 UTC 零点偏移到早 8 点
  assert.equal(new Date(added[0].dueAt).getHours(), 23);
  assert.equal(new Date(added[0].dueAt).getMinutes(), 59);
  assert.equal(added[0].source, "对话");
  assert.equal(listReminders().length, 2);
});

test("add 的参数校验：缺条目、坏时间、超上限都拒绝且不落盘", async () => {
  assert.match(String((await manage.execute({ action: "add" })).error), /items/);
  const bad = await manage.execute({ action: "add", items: [{ title: "坏时间", dueAt: "明天" }] });
  assert.match(String(bad.error), /截止时间无效/);
  const many = await manage.execute({
    action: "add",
    items: Array.from({ length: 21 }, (_, i) => ({ title: `凑数${i}`, dueAt: "2026-10-01" })),
  });
  assert.match(String(many.error), /最多记录 20 条/);
  assert.equal(listReminders().length, 2, "被拒绝的调用不能留下半成品");
});

test("list 默认只回未完成，includeDone 才带已完成", async () => {
  const listed = await manage.execute({ action: "list" });
  const todos = listed.todos as Array<{ id: string; done: boolean }>;
  assert.equal(todos.length, 2);
  assert.ok(todos.every((t) => !t.done));

  const first = await manage.execute({ action: "list", includeDone: true });
  assert.equal((first.todos as unknown[]).length, 2);

  const updated = await manage.execute({ action: "update", id: todos[0].id, done: true });
  assert.equal(updated.ok, true);
  const after = await manage.execute({ action: "list" });
  assert.equal((after.todos as unknown[]).length, 1);
  const all = await manage.execute({ action: "list", includeDone: true });
  assert.equal((all.todos as unknown[]).length, 2);
});

test("update 改标题与截止、delete 按 id 删除", async () => {
  const listed = await manage.execute({ action: "list" });
  const [target] = listed.todos as Array<{ id: string }>;
  const updated = await manage.execute({
    action: "update",
    id: target.id,
    title: "改名后的待办",
    dueAt: "2026-09-20",
  });
  assert.equal(updated.ok, true);
  const changed = (updated as { updated: { title: string; dueAt: string } }).updated;
  assert.equal(changed.title, "改名后的待办");
  assert.equal(new Date(changed.dueAt).getHours(), 23, "纯日期更新同样按 23:59");

  const del = await manage.execute({ action: "delete", id: target.id });
  assert.equal(del.ok, true);
  const again = await manage.execute({ action: "delete", id: target.id });
  assert.match(String(again.error), /未找到/);
  assert.equal(listReminders().length, 1, "只剩已完成那条");
});

test("update/delete 缺 id 与未知 id 的错误路径", async () => {
  assert.match(String((await manage.execute({ action: "update", done: true })).error), /id/);
  assert.match(String((await manage.execute({ action: "delete" })).error), /id/);
  assert.match(
    String((await manage.execute({ action: "update", id: "ghost", done: true })).error),
    /未找到/,
  );
});
