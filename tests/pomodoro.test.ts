/**
 * 番茄钟测试：计时落盘 data/pomodoro.json、到期自动结算、
 * 取消语义，以及 manage_pomodoro 工具的参数校验与各动作。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-pomo-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { activePomodoro, cancelPomodoro, getPomodoro, listPomodoros, startPomodoro, toView } =
  await import("../src/core/pomodoro");
const { coreTools } = await import("../src/core/tools");

const manage = coreTools.manage_pomodoro as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
assert.ok(manage, "manage_pomodoro 应已注册进 coreTools");

test("start：时长落盘、默认 label 为专注、剩余约等于全长", () => {
  const item = startPomodoro(25);
  assert.equal(item.focusMinutes, 25);
  assert.equal(item.totalSec, 1500);
  assert.equal(item.label, "专注");
  assert.equal(item.status, "running");
  assert.equal(item.endsAt - item.startsAt, 25 * 60_000);
  const view = toView(item);
  assert.ok(view.remainingSec > 0 && view.remainingSec <= 1500);
  // 真落盘了：换个读法能找回
  assert.equal(getPomodoro(item.id)?.label, "专注");
});

test("start 参数校验：非整数、越界被拒绝且不落盘", () => {
  const before = listPomodoros().length;
  for (const bad of [0, 181, 2.5, Number.NaN]) {
    assert.throws(() => startPomodoro(bad as number), /整数|1-180/);
  }
  assert.equal(listPomodoros().length, before, "被拒绝的调用不能留下半成品");
});

test("到期自动结算：endsAt 已过则 active 为空、记录置 done", () => {
  const item = startPomodoro(1, "过期实验");
  const file = path.join(tmpData, "pomodoro.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  const row = raw.find((r) => r.id === item.id);
  assert.ok(row, "记录应已落盘");
  row.endsAt = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(raw));
  // 前面的用例可能还留着在走的计时：只断言过期这条被结算，且 active 不再是它
  assert.equal(getPomodoro(item.id)?.status, "done");
  assert.notEqual(activePomodoro()?.id, item.id);
  assert.equal(toView(getPomodoro(item.id)!).remainingSec, 0);
});

test("cancelPomodoro：未知 id 返回 null，只取消在走的", () => {
  assert.equal(cancelPomodoro("ghost"), null);
  const item = startPomodoro(10, "待取消");
  assert.equal(cancelPomodoro(item.id)?.status, "cancelled");
  assert.equal(getPomodoro(item.id)?.status, "cancelled");
});

test("工具 start：默认 25 分钟并带 fresh 标记，非法时长拒绝", async () => {
  const r = await manage.execute({ action: "start", label: "写论文" });
  assert.equal(r.ok, true);
  assert.equal(r.fresh, true);
  const p = r.pomodoro as { focusMinutes: number; label: string; totalSec: number; id: string };
  assert.equal(p.focusMinutes, 25);
  assert.equal(p.label, "写论文");
  assert.equal(p.totalSec, 1500);
  assert.match(String(r.summary), /25 分钟/);

  assert.match(String((await manage.execute({ action: "start", minutes: 0 })).error), /1-180/);
  assert.match(String((await manage.execute({ action: "start", minutes: 2.5 })).error), /整数/);
});

test("工具 status/cancel 按 id 精确操作，未知 id 给明确错误", async () => {
  const started = await manage.execute({ action: "start", minutes: 15, label: "按id操作" });
  const id = (started.pomodoro as { id: string }).id;
  assert.match(String((await manage.execute({ action: "status", id })).summary), /还剩/);
  const cancelled = await manage.execute({ action: "cancel", id });
  assert.equal(cancelled.ok, true);
  assert.match(String(cancelled.summary), /已取消/);
  assert.match(String((await manage.execute({ action: "cancel", id: "ghost" })).error), /没有在走/);
  assert.match(
    String((await manage.execute({ action: "status", id: "ghost" })).summary),
    /没有在走/,
  );
});

test("工具 list 返回最近记录", async () => {
  const l = await manage.execute({ action: "list", limit: 5 });
  assert.ok(Array.isArray(l.pomodoros));
  assert.ok((l.pomodoros as unknown[]).length > 0);
});

test("SSE 透出新建番茄钟的 pomodoro 事件，前端才画得出倒计时卡片", async () => {
  const { setChatAgent, startChatWeb } = await import("../src/channels/web/chat-web");
  const item = startPomodoro(25, "端到端");
  const view = toView(item);
  setChatAgent({
    stream() {
      async function* gen() {
        yield { type: "tool-call", toolCallId: "p1", toolName: "manage_pomodoro" };
        yield {
          type: "tool-result",
          toolCallId: "p1",
          toolName: "manage_pomodoro",
          output: { ok: true, summary: "已开始", pomodoro: { ...view }, fresh: true },
        };
        yield { type: "text-delta", text: "好" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;
  const token = (await (await fetch(url)).text()).match(
    /<meta name="csrf-token" content="([0-9a-f]{64})">/,
  )?.[1];
  assert.ok(token, "页面必须注入 csrf-token meta");
  const events = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const req = http.request(
      `${url}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": token },
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () =>
          resolve(
            raw
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ message: "开始番茄钟" }));
  });
  const toolEnd = events.find((e) => e.t === "tool" && e.phase === "end");
  assert.ok(toolEnd, "应有工具结束事件");
  const pomo = toolEnd.pomodoro as { id: string; endsAt: number } | undefined;
  assert.ok(pomo, "新建番茄钟必须随工具事件透出 pomodoro，前端才画得出卡片");
  assert.equal(pomo.id, item.id);

  // 查询与取消接口（卡片取消按钮走这里，不经过 agent）
  const listed = (await (await fetch(`${url}/api/pomodoro`)).json()) as {
    active: { id: string } | null;
  };
  assert.ok(listed.active, "应有在走的计时");
  const cancelled = await fetch(`${url}/api/pomodoro/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": token },
    body: JSON.stringify({ id: item.id }),
  });
  assert.equal(cancelled.status, 200);
  setChatAgent(null);
});
