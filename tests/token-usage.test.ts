/**
 * Token 用量记账（src/core/token-usage.ts）：按天/按模型聚合、防抖落盘、
 * 过期清理、快照口径（今日/近 7 天/近 30 天）与非法输入忽略。
 * 另含 agent.ts 模型中间件的全链路钉——AI SDK provider spec 升级改 usage
 * 字段形状时（v7 起 finish part 是 usage.inputTokens.total 的对象形态），
 * 用量统计是唯一受害者且失败完全静默，靠这个测试红出来。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { recordTokenUsage, resetTokenUsageForTest, tokenUsageSnapshot } = await import(
  "../src/core/token-usage"
);

function tempDataDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-token-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.RAPTOR_DATA_DIR = dir;
  return dir;
}

test("recordTokenUsage：同日多次累计、按模型分账，快照聚合今日/近 7 天", async (t) => {
  const dir = tempDataDir(t);
  resetTokenUsageForTest();

  recordTokenUsage({ model: "deepseek/deepseek-chat", inputTokens: 1000, outputTokens: 200 });
  recordTokenUsage({ model: "deepseek/deepseek-chat", inputTokens: 500, outputTokens: 100 });
  recordTokenUsage({ model: "zhenze/glm-5.3", inputTokens: 300, outputTokens: 60 });

  const snap = await tokenUsageSnapshot();
  const days = Object.values(snap.days);
  assert.equal(days.length, 1, "只有今天一个日期");
  assert.equal(days[0].total, 2160);
  assert.equal(days[0].in, 1800);
  assert.equal(days[0].out, 360);
  // 模型分布按总量降序
  assert.equal(snap.models[0].model, "deepseek/deepseek-chat");
  assert.equal(snap.models[0].total, 1800);
  assert.equal(snap.models[1].model, "zhenze/glm-5.3");
  assert.equal(snap.models[1].total, 360);
  assert.equal(snap.totals.today, 2160);
  assert.equal(snap.totals.week, 2160);
  assert.equal(snap.totals.month, 2160);
  assert.equal(snap.totals.year, 2160);

  // 落盘形状：天 → 模型 → {in,out}
  const file = JSON.parse(fs.readFileSync(path.join(dir, "token-usage.json"), "utf8")) as {
    days: Record<string, Record<string, { in: number; out: number }>>;
  };
  const day = Object.values(file.days)[0];
  assert.equal(day["deepseek/deepseek-chat"].in, 1500);
  assert.equal(day["zhenze/glm-5.3"].out, 60);
});

test("快照前强制冲刷 pending：记录后立刻可见（不等 2 秒防抖）", async (t) => {
  tempDataDir(t);
  resetTokenUsageForTest();
  recordTokenUsage({ model: "glm/glm-5.3", inputTokens: 42, outputTokens: 7 });
  const snap = await tokenUsageSnapshot();
  assert.equal(snap.totals.today, 49, "snapshot 应冲刷 pending 后聚合");
});

test("过期清理：写入时清掉 371 天外的旧日期", async (t) => {
  const dir = tempDataDir(t);
  resetTokenUsageForTest();
  // 手工塞一笔一年半前的旧账
  const staleDate = new Date(Date.now() - 500 * 86_400_000 + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
  const file = path.join(dir, "token-usage.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ days: { [staleDate]: { "old/model": { in: 9, out: 9 } } } }),
  );
  recordTokenUsage({ model: "deepseek/deepseek-chat", inputTokens: 10, outputTokens: 2 });
  await tokenUsageSnapshot();
  const after = JSON.parse(fs.readFileSync(file, "utf8")) as { days: Record<string, unknown> };
  assert.equal(after.days[staleDate], undefined, "一年半前的旧账应被清理");
  assert.equal(Object.keys(after.days).length, 1);
});

test("非法输入静默忽略：空模型 / 非正数 / NaN", async (t) => {
  tempDataDir(t);
  resetTokenUsageForTest();
  recordTokenUsage({ model: "", inputTokens: 100, outputTokens: 100 });
  recordTokenUsage({ model: "x/y", inputTokens: -5, outputTokens: 0 });
  recordTokenUsage({ model: "x/y", inputTokens: Number.NaN, outputTokens: Number("abc") });
  const snap = await tokenUsageSnapshot();
  assert.equal(snap.totals.year, 0);
  assert.equal(Object.keys(snap.days).length, 0);
});

// ── agent.ts 模型中间件全链路（防 provider spec 漂移的钉子）────────

/** LanguageModelV4 mock：doStream 发一条带 V4 usage 的 finish part */
function v4StreamMock(usage: unknown) {
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t0" });
          controller.enqueue({ type: "text-delta", id: "t0", delta: "hi" });
          controller.enqueue({ type: "text-end", id: "t0" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage });
          controller.close();
        },
      }),
    }),
  } as never;
}

test("模型中间件：流式 finish 的 V4 usage（inputTokens.total 对象形态）落进用量记账", async (t) => {
  tempDataDir(t);
  resetTokenUsageForTest();
  const { raptorModelMiddleware } = await import("../src/core/agent");
  const { streamText, wrapLanguageModel } = await import("ai");

  const wrapped = wrapLanguageModel({
    model: v4StreamMock({
      inputTokens: { total: 21, noCache: 21, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 7, text: 7, reasoning: 0 },
    }),
    middleware: raptorModelMiddleware(),
  });
  const result = streamText({ model: wrapped, prompt: "ping" });
  for await (const _ of result.fullStream) {
    // 消费完整流（含 finish part）——usage 记账发生在中间件旁路
  }

  const snap = await tokenUsageSnapshot();
  assert.equal(snap.models.length, 1, "应记录当前模型一条");
  assert.equal(snap.models[0].in, 21);
  assert.equal(snap.models[0].out, 7);
  assert.equal(snap.models[0].total, 28);
});

test("模型中间件：旧数字形态的 usage 也兼容（防降级场景静默丢数）", async (t) => {
  tempDataDir(t);
  resetTokenUsageForTest();
  const { raptorModelMiddleware } = await import("../src/core/agent");
  const { streamText, wrapLanguageModel } = await import("ai");

  const wrapped = wrapLanguageModel({
    model: v4StreamMock({ inputTokens: 100, outputTokens: 40 }),
    middleware: raptorModelMiddleware(),
  });
  const result = streamText({ model: wrapped, prompt: "ping" });
  for await (const _ of result.fullStream) {
  }

  const snap = await tokenUsageSnapshot();
  assert.equal(snap.models[0].total, 140);
});
