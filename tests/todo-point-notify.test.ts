/**
 * 定点通知测试：notifyAt 校验、到点触发与去重、补发窗口边界、
 * 完成/清理、改时刻重新武装；manage_todos 对 notifyAt 的透传与清除。
 * 全部注入时钟与通知出口，绝不真弹桌面通知或发 QQ。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-point-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { dueWithinWindow, runPointNotifyCheck } = await import("../src/core/todo-reminders");
const { addReminder, deleteReminder, listReminders, normalizeNotifyAt, updateReminder } =
  await import("../src/core/workspace-data");
const { coreTools } = await import("../src/core/tools");

const manage = coreTools.manage_todos as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

/** 注入的通知出口：只记录通知到的标题 */
function recorder() {
  const sent: string[] = [];
  return {
    sent,
    notify: (items: Array<{ title: string }>) => {
      sent.push(...items.map((i) => i.title));
    },
  };
}

/** 每个用例自清场：删掉本用例建的待办，不流进后面的用例 */
function cleanup(...ids: string[]): void {
  for (const id of ids) deleteReminder(id);
}

test("normalizeNotifyAt：纯日期拒绝、无效串拒绝、空格写法可解析", () => {
  assert.equal(normalizeNotifyAt("2026-11-06"), null, "纯日期没有钟点，不该当通知时刻");
  assert.equal(normalizeNotifyAt("not-a-time"), null);
  assert.equal(normalizeNotifyAt(""), null);
  assert.equal(
    normalizeNotifyAt("2026-11-06 09:05"),
    new Date("2026-11-06T09:05:00").toISOString(),
  );
});

test("addReminder：notifyAt 必须带钟点；合法值规范化存 ISO", () => {
  assert.throws(() =>
    addReminder({ title: "无钟点", dueAt: "2026-12-20", notifyAt: "2026-12-18" }),
  );
  const r = addReminder({
    title: "带钟点",
    dueAt: "2026-12-20T23:00",
    notifyAt: "2026-12-18T09:00",
  });
  assert.equal(r.notifyAt, new Date("2026-12-18T09:00:00").toISOString());
  cleanup(r.id);
});

test("定点通知：到点触发一次，复查不重弹", () => {
  const rec = recorder();
  const r = addReminder({
    title: "交材料",
    dueAt: "2026-12-20T15:00",
    notifyAt: "2026-12-18T09:00",
  });
  // 未到点不触发
  assert.deepEqual(
    runPointNotifyCheck({ now: new Date("2026-12-18T08:00"), notify: rec.notify }),
    [],
  );
  // 到点（计划点后 2 分钟，补发窗口内）触发
  assert.deepEqual(
    runPointNotifyCheck({ now: new Date("2026-12-18T09:02"), notify: rec.notify }).map(
      (x) => x.title,
    ),
    ["交材料"],
  );
  // 同时刻复查：已通知过，不重弹
  assert.deepEqual(
    runPointNotifyCheck({ now: new Date("2026-12-18T09:05"), notify: rec.notify }),
    [],
  );
  assert.deepEqual(rec.sent, ["交材料"]);
  cleanup(r.id);
});

test("补发窗口：15 分钟内补发，超过的静默跳过不轰炸", () => {
  const rec = recorder();
  const inWindow = addReminder({
    title: "窗口内",
    dueAt: "2026-12-20T15:00",
    notifyAt: "2026-12-18T10:00",
  });
  const tooLate = addReminder({
    title: "错过太久",
    dueAt: "2026-12-20T15:00",
    notifyAt: "2026-12-18T09:50",
  });
  // now 10:12：窗口内过了 12 分钟 ✓ 补发；错过太久过了 22 分钟 ✗ 静默标记
  assert.deepEqual(
    runPointNotifyCheck({ now: new Date("2026-12-18T10:12"), notify: rec.notify }).map(
      (x) => x.title,
    ),
    ["窗口内"],
  );
  // 再查（10:30）：错过太久的已标记，不再触发
  assert.deepEqual(
    runPointNotifyCheck({ now: new Date("2026-12-18T10:30"), notify: rec.notify }),
    [],
  );
  assert.deepEqual(rec.sent, ["窗口内"]);
  cleanup(inWindow.id, tooLate.id);
});

test("完成不触发；改通知时刻重新武装；删除清理记录", () => {
  const rec = recorder();
  const r = addReminder({
    title: "晨跑",
    dueAt: "2026-12-20T15:00",
    notifyAt: "2026-12-18T07:00",
  });
  updateReminder(r.id, { done: true });
  assert.deepEqual(
    runPointNotifyCheck({ now: new Date("2026-12-18T07:02"), notify: rec.notify }),
    [],
    "已完成的待办不该触发",
  );
  // 取消完成：原时刻已过且超窗，静默标记不补
  updateReminder(r.id, { done: false });
  assert.deepEqual(
    runPointNotifyCheck({ now: new Date("2026-12-18T07:30"), notify: rec.notify }),
    [],
  );
  // 改到新时刻：重新武装，新时刻到点触发
  updateReminder(r.id, { notifyAt: "2026-12-18T08:00" });
  assert.deepEqual(
    runPointNotifyCheck({ now: new Date("2026-12-18T08:01"), notify: rec.notify }).map(
      (x) => x.title,
    ),
    ["晨跑"],
  );
  cleanup(r.id);
  assert.deepEqual(
    runPointNotifyCheck({ now: new Date("2026-12-18T08:02"), notify: rec.notify }),
    [],
    "删除后不该再触发",
  );
});

test("弥散提醒不受影响：设了 notifyAt 的待办仍进 7 天窗口", () => {
  const r = addReminder({
    title: "共存验证",
    dueAt: "2026-12-20T15:00",
    notifyAt: "2026-12-19T09:00",
  });
  assert.deepEqual(
    dueWithinWindow(new Date("2026-12-18T10:00")).map((x) => x.title),
    ["共存验证"],
  );
  cleanup(r.id);
});

test("manage_todos 工具：add 带 notifyAt 落库、update 改/清通知时刻", async () => {
  const r = await manage.execute({
    action: "add",
    items: [{ title: "取快递", dueAt: "2026-12-20", notifyAt: "2026-12-20T14:00" }],
  });
  assert.equal(r.ok, true);
  const added = r.added as Array<{ id: string; notifyAt?: string }>;
  assert.equal(added[0]!.notifyAt, new Date("2026-12-20T14:00:00").toISOString());

  // 纯日期当 notifyAt：报错且不落库
  const bad = await manage.execute({
    action: "add",
    items: [{ title: "坏通知", dueAt: "2026-12-20", notifyAt: "2026-12-20" }],
  });
  assert.match(String(bad.error), /钟点/);
  assert.equal(listReminders().length, 1);

  const up = await manage.execute({
    action: "update",
    id: added[0]!.id,
    notifyAt: "2026-12-20T10:00",
  });
  assert.equal(up.ok, true);
  const cleared = await manage.execute({ action: "update", id: added[0]!.id, notifyAt: "" });
  assert.equal(cleared.ok, true);
  assert.equal(listReminders().find((x) => x.id === added[0]!.id)?.notifyAt, undefined);

  cleanup(added[0]!.id);
});
