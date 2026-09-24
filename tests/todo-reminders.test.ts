/**
 * 待办到期提醒测试：窗口判定、每天一次去重、8 点前不弹、
 * 完成后清理去重记录、单轮上限；QQ 主动推送通道的注册语义。
 * 全部注入时钟与通知出口，绝不真弹桌面通知或发 QQ。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-todoremind-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { dueWithinWindow, runReminderCheck } = await import("../src/core/todo-reminders");
const { addReminder, updateReminder } = await import("../src/core/workspace-data");
const { pushQQText, registerQQPush } = await import("../src/channels/qq/push");

/** 注入的通知出口：只记录提醒到的标题 */
function recorder() {
  const sent: string[] = [];
  return {
    sent,
    notify: (items: Array<{ title: string }>) => {
      sent.push(...items.map((i) => i.title));
    },
  };
}

const stateFile = () => path.join(tmpData, "todo-reminder-state.json");

test("窗口判定：7 天内未完成才进窗口，恰好 7 天含，逾期/太远/已完成不含", () => {
  const now = new Date("2026-09-15T10:00:00");
  const created = [
    addReminder({ title: "三天后交作业", dueAt: "2026-09-18T22:00:00" }),
    addReminder({ title: "恰好七天", dueAt: "2026-09-22T10:00:00" }),
    addReminder({ title: "太远的十天后", dueAt: "2026-09-25T10:00:00" }),
    addReminder({ title: "昨天已逾期", dueAt: "2026-09-14T23:59:00" }),
    addReminder({ title: "已完成的两天内", dueAt: "2026-09-16T10:00:00" }),
  ];
  updateReminder(created[4].id, { done: true });

  assert.deepEqual(
    dueWithinWindow(now).map((r) => r.title),
    ["三天后交作业", "恰好七天"],
  );
  // 清场：这些待办不能流进后面的用例
  for (const r of created) updateReminder(r.id, { done: true });
});

test("每天一次：同日复查不重弹，次日再查重新提醒", () => {
  const rec = recorder();
  const t = addReminder({ title: "周五交实验报告", dueAt: "2026-09-18T22:00:00" });

  assert.deepEqual(
    runReminderCheck({ now: new Date("2026-09-15T10:00:00"), notify: rec.notify }).map(
      (r) => r.title,
    ),
    ["周五交实验报告"],
  );
  assert.deepEqual(
    runReminderCheck({ now: new Date("2026-09-15T22:00:00"), notify: rec.notify }),
    [],
    "同一天第二次检查不该再弹",
  );
  assert.deepEqual(
    runReminderCheck({ now: new Date("2026-09-16T09:00:00"), notify: rec.notify }).map(
      (r) => r.title,
    ),
    ["周五交实验报告"],
    "第二天应重新提醒",
  );
  assert.deepEqual(rec.sent, ["周五交实验报告", "周五交实验报告"]);

  updateReminder(t.id, { done: true });
});

test("早 8 点前不提醒，8 点后照常", () => {
  const rec = recorder();
  const t = addReminder({ title: "周日英语考试", dueAt: "2026-09-20T14:00:00" });

  assert.deepEqual(
    runReminderCheck({ now: new Date("2026-09-17T07:59:00"), notify: rec.notify }),
    [],
  );
  assert.deepEqual(
    runReminderCheck({ now: new Date("2026-09-17T08:00:00"), notify: rec.notify }).map(
      (r) => r.title,
    ),
    ["周日英语考试"],
  );

  updateReminder(t.id, { done: true });
});

test("完成后不再提醒，去重记录随之清理", () => {
  const rec = recorder();
  const t = addReminder({ title: "下周一交材料", dueAt: "2026-09-21T18:00:00" });
  const now = new Date("2026-09-18T10:00:00");

  runReminderCheck({ now, notify: rec.notify });
  const state = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  assert.equal(state.reminded[t.id], "2026-09-18");

  updateReminder(t.id, { done: true });
  assert.deepEqual(runReminderCheck({ now, notify: rec.notify }), []);
  const after = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  assert.equal(after.reminded[t.id], undefined, "完成后的去重记录应被清掉");
});

test("单轮最多提醒 5 条，剩余的下一轮再补", () => {
  const rec = recorder();
  const created = Array.from({ length: 7 }, (_, i) =>
    addReminder({ title: `批量${i + 1}`, dueAt: `2026-09-19T1${i}:00:00` }),
  );

  const reminded = runReminderCheck({ now: new Date("2026-09-18T11:00:00"), notify: rec.notify });
  assert.equal(reminded.length, 5);
  assert.equal(rec.sent.length, 5);

  for (const r of created) updateReminder(r.id, { done: true });
});

test("QQ 推送通道：桥未注册返回 false，注册后送达", async () => {
  assert.equal(await pushQQText("桥不在时只能静默降级"), false);
  const pushed: string[] = [];
  registerQQPush(async (text) => {
    pushed.push(text);
  });
  assert.equal(await pushQQText("待办提醒测试"), true);
  assert.deepEqual(pushed, ["待办提醒测试"]);
});
