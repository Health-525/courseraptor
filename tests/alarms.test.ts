/**
 * 定时提醒测试：三种触发形态的到点判定、补发窗口、去重与停用语义、
 * 错过不追发；manage_alarms 工具契约。
 * 全部注入时钟与通知出口，绝不真弹桌面通知或发 QQ。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-alarms-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { addAlarm, deleteAlarm, lastDueMoment, nextDueMoment, runAlarmCheck, updateAlarm } =
  await import("../src/core/alarms");

/** 注入的通知出口：只记录触发到的标题 */
function recorder() {
  const sent: string[] = [];
  return {
    sent,
    notify: (fired: Array<{ alarm: { title: string } }>) => {
      sent.push(...fired.map((f) => f.alarm.title));
    },
  };
}

/** 每个用例自清场：删掉本用例建的提醒，不流进后面的用例 */
function cleanup(...ids: string[]): void {
  for (const id of ids) deleteAlarm(id);
}

test("校验：过去的时刻 / 非法 HH:MM / 越界 weekday / 空标题都拒绝", () => {
  assert.throws(() =>
    addAlarm({ title: "过去的事", trigger: { type: "once", at: "2020-01-01T08:00:00" } }),
  );
  assert.throws(() => addAlarm({ title: "坏时刻", trigger: { type: "daily", time: "25:00" } }));
  assert.throws(() =>
    addAlarm({ title: "坏星期", trigger: { type: "weekly", weekday: 7, time: "08:00" } }),
  );
  assert.throws(() => addAlarm({ title: "  ", trigger: { type: "daily", time: "08:00" } }));
});

test("一次性：到点触发一次即自动停用，复查不重弹", () => {
  const rec = recorder();
  const a = addAlarm({ title: "交材料", trigger: { type: "once", at: "2027-06-01T09:00:00" } });

  // 未到点不触发
  assert.deepEqual(runAlarmCheck({ now: new Date("2027-06-01T08:00:00"), notify: rec.notify }), []);
  // 到点（计划点后 2 分钟，补发窗口内）触发
  const fired = runAlarmCheck({ now: new Date("2027-06-01T09:02:00"), notify: rec.notify });
  assert.deepEqual(
    fired.map((f) => f.alarm.title),
    ["交材料"],
  );
  assert.equal(fired[0]?.dueAt, new Date("2027-06-01T09:00:00").toISOString());
  // 同一计划点复查不重弹
  assert.deepEqual(runAlarmCheck({ now: new Date("2027-06-01T09:05:00"), notify: rec.notify }), []);

  cleanup(a.id);
});

test("一次性：错过在补发窗口内补发，超过窗口自动停用且不弹", () => {
  const rec = recorder();
  const catchUp = addAlarm({
    title: "窗口内补发",
    trigger: { type: "once", at: "2027-06-02T10:00:00" },
  });
  const missed = addAlarm({
    title: "错过太久",
    trigger: { type: "once", at: "2027-06-01T10:00:00" },
  });

  // 计划点 10:00，now 10:12（≤15 分钟）：补发
  assert.deepEqual(
    runAlarmCheck({ now: new Date("2027-06-02T10:12:00"), notify: rec.notify }).map(
      (f) => f.alarm.title,
    ),
    ["窗口内补发"],
  );
  // 6月1日的错过整晚（>15 分钟）：不弹，且自动停用
  assert.deepEqual(runAlarmCheck({ now: new Date("2027-06-02T10:12:00"), notify: rec.notify }), []);
  const after = runAlarmCheck({ now: new Date("2027-06-02T18:00:00"), notify: rec.notify });
  assert.equal(after.length, 0);
  const stored = JSON.parse(fs.readFileSync(path.join(tmpData, "alarms.json"), "utf8"));
  const missedStored = stored.alarms.find((a: { id: string }) => a.id === missed.id);
  assert.equal(missedStored.enabled, false, "错过超过窗口的一次性提醒应自动停用");

  cleanup(catchUp.id, missed.id);
});

test("每天：当天到点触发，同日不重弹，次日再触发，错过整段跳过等次日", () => {
  const rec = recorder();
  const a = addAlarm({ title: "背单词", trigger: { type: "daily", time: "22:30" } });

  // 当天 22:31 触发
  assert.deepEqual(
    runAlarmCheck({ now: new Date("2026-11-02T22:31:00"), notify: rec.notify }).map(
      (f) => f.alarm.title,
    ),
    ["背单词"],
  );
  // 同日 22:40 复查：还是同一计划点，不重弹
  assert.deepEqual(runAlarmCheck({ now: new Date("2026-11-02T22:40:00"), notify: rec.notify }), []);
  // 次日 22:31：新计划点，再触发
  assert.deepEqual(
    runAlarmCheck({ now: new Date("2026-11-03T22:31:00"), notify: rec.notify }).map(
      (f) => f.alarm.title,
    ),
    ["背单词"],
  );
  cleanup(a.id);

  // 程序停了一整天：now 是次日 10:00，最近计划点是昨晚 22:30（>15 分钟）
  const skipped = addAlarm({ title: "停机一天", trigger: { type: "daily", time: "22:30" } });
  assert.deepEqual(runAlarmCheck({ now: new Date("2026-11-05T10:00:00"), notify: rec.notify }), []);
  assert.equal(skipped.enabled, true, "周期提醒错过不等于停用");
  // 当晚 22:30 恢复触发
  assert.deepEqual(
    runAlarmCheck({ now: new Date("2026-11-05T22:31:00"), notify: rec.notify }).map(
      (f) => f.alarm.title,
    ),
    ["停机一天"],
  );

  cleanup(skipped.id);
});

test("每周：目标星期到点触发，非目标日不触发；nextDue 预告正确", () => {
  const rec = recorder();
  // 2026-11-07 是周六（weekday 6）
  const a = addAlarm({ title: "还书", trigger: { type: "weekly", weekday: 6, time: "17:00" } });

  // 周五（2026-11-06）17:02：最近计划点是上周六，早超补发窗口，不弹
  assert.deepEqual(runAlarmCheck({ now: new Date("2026-11-06T17:02:00"), notify: rec.notify }), []);
  // 周六（2026-11-07）17:02 触发
  assert.deepEqual(
    runAlarmCheck({ now: new Date("2026-11-07T17:02:00"), notify: rec.notify }).map(
      (f) => f.alarm.title,
    ),
    ["还书"],
  );
  // 周四（2026-11-05）10:00 看预告：下次是 2026-11-07 17:00
  const next = nextDueMoment(a.trigger, new Date("2026-11-05T10:00:00"));
  assert.equal(next?.getTime(), new Date("2026-11-07T17:00:00").getTime());

  cleanup(a.id);
});

test("启停与改期：停用不触发，恢复后按新计划点走，删除即消失", () => {
  const rec = recorder();
  const a = addAlarm({ title: "晨读", trigger: { type: "daily", time: "07:30" } });
  updateAlarm(a.id, { enabled: false });
  assert.deepEqual(runAlarmCheck({ now: new Date("2026-11-02T07:31:00"), notify: rec.notify }), []);

  // 恢复并改到 08:30：旧计划点 07:30 不追，新计划点 08:30 触发
  updateAlarm(a.id, { enabled: true, trigger: { type: "daily", time: "08:30" } });
  assert.deepEqual(runAlarmCheck({ now: new Date("2026-11-02T08:00:00"), notify: rec.notify }), []);
  assert.deepEqual(
    runAlarmCheck({ now: new Date("2026-11-02T08:31:00"), notify: rec.notify }).map(
      (f) => f.alarm.title,
    ),
    ["晨读"],
  );

  deleteAlarm(a.id);
  assert.deepEqual(runAlarmCheck({ now: new Date("2026-11-03T08:31:00"), notify: rec.notify }), []);
  assert.equal(updateAlarm("不存在的id", { enabled: true }), null);
});

test("lastDueMoment：三种形态取「≤ now 的最近计划点」", () => {
  const now = new Date("2026-11-05T10:00:00"); // 周四
  // 一次性未到点
  assert.equal(lastDueMoment({ type: "once", at: "2027-01-01T00:00:00.000Z" }, now), null);
  // 一次性已到点
  assert.equal(
    lastDueMoment({ type: "once", at: "2026-11-04T00:00:00.000Z" }, now)?.toISOString(),
    "2026-11-04T00:00:00.000Z",
  );
  // 每天 08:00：今天已过，取今天
  assert.equal(
    lastDueMoment({ type: "daily", time: "08:00" }, now)?.getTime(),
    new Date("2026-11-05T08:00:00").getTime(),
  );
  // 每天 22:00：今天未到，取昨天
  assert.equal(
    lastDueMoment({ type: "daily", time: "22:00" }, now)?.getTime(),
    new Date("2026-11-04T22:00:00").getTime(),
  );
  // 每周六 09:00：最近的是上周六 2026-10-31
  assert.equal(
    lastDueMoment({ type: "weekly", weekday: 6, time: "09:00" }, now)?.getTime(),
    new Date("2026-10-31T09:00:00").getTime(),
  );
  // 每周四 09:00：今天就是目标日且已过点，取今天
  assert.equal(
    lastDueMoment({ type: "weekly", weekday: 4, time: "09:00" }, now)?.getTime(),
    new Date("2026-11-05T09:00:00").getTime(),
  );
});

const { coreTools } = await import("../src/core/tools");
const manage = coreTools.manage_alarms as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

test("manage_alarms 工具契约：批量 add / list 带下次时间 / update 启停 / delete", async () => {
  const r = await manage.execute({
    action: "add",
    items: [
      { title: "取快递", when: { type: "once", at: "2027-06-05T15:30:00" } },
      { title: "背单词", when: { type: "daily", time: "22:30" }, notes: "50 个" },
    ],
  });
  assert.equal(r.ok, true);
  assert.match(String(r.summary), /已设定 2 条提醒/);
  const added = r.added as Array<{ id: string; title: string; nextDue: string | null }>;
  assert.equal(added.length, 2);
  assert.ok(added[0]!.nextDue, "一次性未到点应给出下次触发时间");

  // 过去的一次性时刻：报错且不落库（半批回滚语义）
  const bad = await manage.execute({
    action: "add",
    items: [
      { title: "有效的", when: { type: "daily", time: "07:00" } },
      { title: "过去的事", when: { type: "once", at: "2020-01-01T08:00:00" } },
    ],
  });
  assert.match(String(bad.error), /过去的事.*必须在未来/);
  const afterBad = await manage.execute({ action: "list" });
  assert.match(String(afterBad.summary), /2 条启用中的提醒/, "失败批次不应留下半批提醒");

  const list = await manage.execute({ action: "list" });
  assert.match(String(list.summary), /2 条启用中的提醒/);

  const up = await manage.execute({ action: "update", id: added[1]!.id, enabled: false });
  assert.equal(up.ok, true);
  const list2 = await manage.execute({ action: "list" });
  assert.match(String(list2.summary), /1 条启用中的提醒/);
  const listAll = await manage.execute({ action: "list", includeDisabled: true });
  assert.match(String(listAll.summary), /共 2 条提醒/);

  for (const a of added) {
    const del = await manage.execute({ action: "delete", id: a.id });
    assert.equal(del.ok, true);
  }
  const list3 = await manage.execute({ action: "list", includeDisabled: true });
  assert.match(String(list3.summary), /共 0 条提醒/);
});
