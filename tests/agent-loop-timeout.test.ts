/**
 * agent 循环超时看门狗（src/core/loop-timeout.ts + AI SDK v7 timeout）
 *
 * 两层验证：
 * 1. 配置层：默认值 / 环境变量覆盖 / per-tool 覆盖键形状（对齐真实工具名，
 *    防漂移）/ 流式子集刻意不含 firstChunkMs·chunkMs（generateText 遇流式
 *    字段会刷 unsupported 警告——QQ 桥每轮一条）
 * 2. 语义层（mock model 全链路，SDK 行为均为实测钉住）：
 *    - 工具挂起被 toolMs 叫停，错误 tool-result 喂回模型，轮次继续出正文
 *    - 模型流停滞被 firstChunkMs 叫停，fullStream 以 abort part 收尾
 *    - 翻译层把 abort part 变成可见失败（此前落进 default 被丢掉，
 *      用户侧表现为「闪一下什么也没发生」）
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const ENV_KEYS = [
  "RAPTOR_TOOL_TIMEOUT_MS",
  "RAPTOR_STREAM_FIRST_CHUNK_MS",
  "RAPTOR_STREAM_CHUNK_MS",
] as const;

/** 存/还原三个超时环境变量，避免测试间互相污染 */
function stashEnv(t: { after: (fn: () => void) => void }): void {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/**
 * 给裸测试进程挂一个 ref 句柄，测完清掉。
 *
 * 为什么需要：SDK 看门狗底层是 AbortSignal.timeout，而它是 **unref** 的
 * （实测：只建一个 timeout 的脚本会立刻退出、abort 根本不触发）——看门狗
 * 不该拖住进程退出，这是对的。生产里事件循环始终有 ref 句柄（HTTP 服务
 * socket / readline / QQ 客户端），看门狗照常触发；但裸测试进程里，
 * 等待中的 Promise + unref 定时器 = 循环里什么都没有，node:test 会判
 * 「事件循环已耗尽」把测试取消掉。这里模拟一个活着的进程。
 */
function keepLoopAlive(t: { after: (fn: () => void) => void }): void {
  const timer = setInterval(() => {}, 1000);
  t.after(() => clearInterval(timer));
}

// ── 配置层 ──────────────────────────────────────────────

test("默认配置：无环境变量时工具 5 分钟、首 chunk 2 分钟、chunk 间隔 1 分钟", async (t) => {
  stashEnv(t);
  for (const k of ENV_KEYS) delete process.env[k];
  const { toolTimeoutConfig, streamTimeoutConfig } = await import("../src/core/loop-timeout");

  assert.deepEqual(toolTimeoutConfig(), {
    toolMs: 5 * 60_000,
    tools: {
      generate_documentMs: 10 * 60_000,
      convert_documentMs: 10 * 60_000,
      ppt_saveMs: 10 * 60_000,
    },
  });
  const stream = streamTimeoutConfig();
  assert.equal(stream.firstChunkMs, 2 * 60_000);
  assert.equal(stream.chunkMs, 60_000);
  // 流式配置必须包含工具级看门狗（调用点是整份替换，不是合并）
  assert.equal(stream.toolMs, 5 * 60_000);
});

test("环境变量覆盖：合法值生效，非法值（非数字/零/负）回落默认", async (t) => {
  stashEnv(t);
  const mod = await import("../src/core/loop-timeout");

  process.env.RAPTOR_TOOL_TIMEOUT_MS = "1234";
  process.env.RAPTOR_STREAM_FIRST_CHUNK_MS = "5678";
  process.env.RAPTOR_STREAM_CHUNK_MS = "910";
  assert.equal(mod.toolTimeoutConfig().toolMs, 1234);
  assert.equal(mod.streamTimeoutConfig().firstChunkMs, 5678);
  assert.equal(mod.streamTimeoutConfig().chunkMs, 910);

  process.env.RAPTOR_TOOL_TIMEOUT_MS = "abc";
  assert.equal(mod.toolTimeoutConfig().toolMs, mod.DEFAULT_TOOL_TIMEOUT_MS);
  process.env.RAPTOR_TOOL_TIMEOUT_MS = "0";
  assert.equal(mod.toolTimeoutConfig().toolMs, mod.DEFAULT_TOOL_TIMEOUT_MS);
  process.env.RAPTOR_TOOL_TIMEOUT_MS = "-5";
  assert.equal(mod.toolTimeoutConfig().toolMs, mod.DEFAULT_TOOL_TIMEOUT_MS);
});

test("per-tool 覆盖键形状：工具名+Ms 且工具名是真实的 core 工具", async (t) => {
  stashEnv(t);
  const { toolTimeoutConfig } = await import("../src/core/loop-timeout");
  const { coreTools } = await import("../src/core/tools");

  for (const key of Object.keys(toolTimeoutConfig().tools)) {
    assert.ok(key.endsWith("Ms"), `覆盖键 ${key} 必须以 Ms 结尾（SDK 的 per-tool 形状）`);
    const name = key.slice(0, -2);
    assert.ok(name in coreTools, `覆盖键 ${key} 去掉 Ms 后不是真实工具名：${name}`);
  }
  // 三件套长任务必须榜上有名（漏一个 = 那个工具的预算悄悄回落到默认）
  for (const name of ["generate_document", "convert_document", "ppt_save"]) {
    assert.ok(`${name}Ms` in toolTimeoutConfig().tools, `${name} 缺少长任务覆盖`);
  }
});

test("流式子集钉子：toolTimeoutConfig 不含 firstChunkMs/chunkMs（generate 路不告警）", async (t) => {
  stashEnv(t);
  const { toolTimeoutConfig } = await import("../src/core/loop-timeout");
  const cfg = toolTimeoutConfig();
  assert.equal("firstChunkMs" in cfg, false);
  assert.equal("chunkMs" in cfg, false);
});

// ── 用户可见文案 ────────────────────────────────────────

test("watchdogHint：各类看门狗 reason 翻中文，认不出的原文返回", async () => {
  const { watchdogHint, abortFailure } = await import("../src/core/loop-timeout");

  assert.match(
    watchdogHint("TimeoutError: First chunk timeout of 120000ms exceeded"),
    /等待模型响应超时/,
  );
  assert.match(watchdogHint("TimeoutError: Chunk timeout of 60000ms exceeded"), /中途停滞超时/);
  assert.match(watchdogHint("TimeoutError: Tool call timeout exceeded"), /工具执行超时/);
  assert.match(watchdogHint("TimeoutError: Total timeout exceeded"), /整轮对话超时/);
  assert.equal(watchdogHint("some unknown reason"), "some unknown reason");
  assert.equal(watchdogHint(""), "未知原因");

  // abortFailure 包一层「本轮已中止 + 调预算口子」
  const failure = abortFailure(new Error("TimeoutError: First chunk timeout of 60ms exceeded"));
  assert.match(failure, /^本轮已中止：等待模型响应超时/);
  assert.match(failure, /RAPTOR_STREAM_FIRST_CHUNK_MS/);
  assert.match(abortFailure("TimeoutError: Chunk timeout exceeded"), /模型响应中途停滞超时/);
});

// ── 语义层：mock model 全链路 ─────────────────────────────

/** LanguageModelV4 mock：按调用次序回放给定的 stream part 序列。
 *  两个 v7 实测形状钉子：流式 tool-call 的 input 是 JSON 字符串（SDK 对它
 *  .trim() 后解析）；finishReason 是 {raw, unified} 对象（传字符串会令
 *  unified 缺位、工具根本不被执行——finishReason 必须是对象） */
function scriptedMock(steps: unknown[][]) {
  let call = 0;
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const p of steps[Math.min(call++, steps.length - 1)] ?? []) controller.enqueue(p);
          controller.close();
        },
      }),
    }),
  } as never;
}

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const FINISH_TOOLS = { raw: "tool_calls", unified: "tool-calls" as const };
const FINISH_STOP = { raw: "stop", unified: "stop" as const };

function toolCallStep(toolName: string) {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "c1", toolName },
    { type: "tool-input-delta", id: "c1", delta: "{}" },
    { type: "tool-input-end", id: "c1" },
    { type: "tool-call", toolCallId: "c1", toolName, input: "{}" },
    { type: "finish", finishReason: FINISH_TOOLS, usage: USAGE },
  ];
}

function textStep(text: string) {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: text },
    { type: "text-end", id: "t0" },
    { type: "finish", finishReason: FINISH_STOP, usage: USAGE },
  ];
}

test("工具挂起：toolMs 到点即停，轮次不死——错误 tool-result 喂回模型后继续出正文", async (t) => {
  stashEnv(t);
  keepLoopAlive(t);
  // 60ms 工具预算：挂起的工具必死，但不拖慢后续步骤
  process.env.RAPTOR_TOOL_TIMEOUT_MS = "60";
  const { streamTimeoutConfig } = await import("../src/core/loop-timeout");
  const { streamText, stepCountIs, tool } = await import("ai");
  const { z } = await import("zod");

  let aborted = false;
  const hang = tool({
    description: "永远不返回的挂起工具（只看门狗管不管）",
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }) =>
      await new Promise<string>((_resolve, reject) => {
        abortSignal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("tool aborted by watchdog"));
          },
          { once: true },
        );
        // 故意不 resolve：没有看门狗这个 Promise 会挂到天荒地老
      }),
  });

  const startedAt = Date.now();
  const result = streamText({
    model: scriptedMock([toolCallStep("hang"), textStep("done")]),
    prompt: "ping",
    tools: { hang },
    stopWhen: stepCountIs(3),
    timeout: streamTimeoutConfig(),
  });

  const parts: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const p of result.fullStream) parts.push(p as never);

  const elapsed = Date.now() - startedAt;
  assert.ok(aborted, "挂起工具必须收到 abort——toolMs 没下发到工具就是没配生效");
  assert.ok(elapsed < 5000, `轮次应在看门狗到点后迅速收尾，实际 ${elapsed}ms`);
  // 轮次不死：挂起工具之后模型仍产出正文（错误 tool-result 被喂回模型）
  const text = parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.text)
    .join("");
  assert.equal(text, "done");
  // 失败以 tool-error 事件形态透出（前端工具卡能渲染成红色错误行）
  assert.ok(
    parts.some((p) => p.type === "tool-error"),
    "应透出 tool-error 事件",
  );
});

test("模型流停滞：firstChunkMs 到点即停，fullStream 以 abort part 收尾", async (t) => {
  stashEnv(t);
  keepLoopAlive(t);
  process.env.RAPTOR_STREAM_FIRST_CHUNK_MS = "60";
  const { streamTimeoutConfig } = await import("../src/core/loop-timeout");
  const { streamText } = await import("ai");

  // 永不 enqueue、永不 close 的流：没有看门狗时 for-await 会挂到天荒地老
  const stalled = {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock-model",
    doStream: async () => ({
      stream: new ReadableStream({
        start() {
          /* 什么都不发 */
        },
      }),
    }),
  } as never;

  const startedAt = Date.now();
  const result = streamText({
    model: stalled,
    prompt: "ping",
    timeout: streamTimeoutConfig(),
  });

  const parts: Array<{ type: string; reason?: unknown }> = [];
  for await (const p of result.fullStream) parts.push(p as never);

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 5000, `停滞流应被 firstChunkMs 迅速中止，实际 ${elapsed}ms`);
  // v7 实测：不抛错，发 {type:"abort", reason:"TimeoutError: First chunk
  // timeout..."} 后正常结束——翻译层必须接住这个 part（见下一个测试）
  const abortPart = parts.find((p) => p.type === "abort");
  assert.ok(abortPart, "停滞流必须以 abort part 收尾");
  assert.match(String(abortPart.reason), /First chunk timeout/);
});

test("翻译层接线：abort part 变成可见失败（不再「闪一下什么也没发生」）", async (t) => {
  stashEnv(t);
  const { translateStream } = await import("../src/channels/web/web-stream-translate");

  // 桩 agent：流里只发一个看门狗 abort part，随后结束
  const stubAgent = {
    stream: async () => ({
      fullStream: (async function* () {
        yield {
          type: "abort",
          reason: new Error("TimeoutError: First chunk timeout of 120000ms exceeded"),
        };
      })(),
    }),
  };

  const sent: Array<Record<string, unknown>> = [];
  const out = await translateStream(stubAgent, {
    messages: [{ role: "user", content: "ping" }],
    signal: new AbortController().signal,
    send: (obj) => sent.push(obj),
  });

  assert.match(out.failure ?? "", /^本轮已中止：等待模型响应超时/);
  assert.equal(out.text, "");
  // 无正文无失败才是旧行为的坑；现在 failure 必须被调用方看见
  assert.ok(
    sent.every((s) => s.t !== "err"),
    "翻译层自己不发 SSE，err 由调用方发",
  );
});
