/**
 * 空产出检测（src/core/empty-turn.ts）+ 网页端接线
 *
 * 这个特性的失败模式是「误报」：用户明明看到了思考卡或工具卡，却又收到
 * 一句「模型没有返回内容」——那比原来的沉默更让人困惑。所以边界用例
 * （有思考 / 有工具 / 有失败 / 已中止）比正例更需要钉死。
 *
 * 另含端到端断言：翻译层真的会在空流上标 empty，且只在空流上标。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { EMPTY_TURN_HINT, isEmptyTurn } = await import("../src/core/empty-turn");

/** 正例：一轮跑完什么都没有 */
const SILENT = {
  hasText: false,
  hasThink: false,
  hadToolCall: false,
  failure: null,
  aborted: false,
};

// ── 正例 ─────────────────────────────────────────────────

test("空产出：什么都没发生就是空产出", () => {
  assert.equal(isEmptyTurn(SILENT), true);
});

// ── 边界：以下四种都「不算空」 ───────────────────────────

test("有正文就不算空产出", () => {
  assert.equal(isEmptyTurn({ ...SILENT, hasText: true }), false);
});

test("有思考就不算空产出（思考卡已经渲染在界面上了）", () => {
  assert.equal(isEmptyTurn({ ...SILENT, hasThink: true }), false);
});

test("有工具调用就不算空产出（工具卡已经渲染）", () => {
  assert.equal(isEmptyTurn({ ...SILENT, hadToolCall: true }), false);
  // 工具失败了也算：有 tool-error 事件在界面上，不必再补一条空产出
  assert.equal(isEmptyTurn({ ...SILENT, hadToolCall: true, failure: "参数非法" }), false);
});

test("已有失败文案时不叠加空产出（避免两条红字解释同一件事）", () => {
  assert.equal(isEmptyTurn({ ...SILENT, failure: "模型调用失败：503" }), false);
});

test("用户主动中止不算空产出（ESC 是用户自己的选择，不是异常）", () => {
  assert.equal(isEmptyTurn({ ...SILENT, aborted: true }), false);
  // 中止 + 有思考：仍不算空
  assert.equal(isEmptyTurn({ ...SILENT, aborted: true, hasThink: true }), false);
});

// ── 文案本身 ─────────────────────────────────────────────

test("EMPTY_TURN_HINT 说清「怎么试」，而不是只报错", () => {
  assert.match(EMPTY_TURN_HINT, /重发/, "应告诉用户可以重发");
  assert.match(EMPTY_TURN_HINT, /没有返回内容/, "应说清现象");
  // 不要写成甩锅用户的措辞
  assert.ok(!/你的(网络|电脑|操作).*(问题|有误)/.test(EMPTY_TURN_HINT), "不该把锅甩给用户");
  // 单行足够长，别太啰嗦（TUI 会截到 200 字）
  assert.ok(EMPTY_TURN_HINT.length < 200, `提示应控制在 200 字内，实际 ${EMPTY_TURN_HINT.length}`);
});

// ── 翻译层端到端：empty 标记 ─────────────────────────────

/** 造一个只回放指定 part 序列的桩 agent */
function stubAgent(parts: unknown[]) {
  return {
    stream: async () => ({
      fullStream: (async function* () {
        for (const p of parts) yield p;
      })(),
    }),
  };
}

async function runTurn(parts: unknown[]) {
  const { translateStream } = await import("../src/channels/web/web-stream-translate");
  return translateStream(stubAgent(parts), {
    messages: [{ role: "user", content: "hi" }],
    signal: new AbortController().signal,
    send: () => {},
  });
}

test("翻译层：空流标 empty=true", async () => {
  const out = await runTurn([{ type: "start" }, { type: "finish" }]);
  assert.equal(out.empty, true, "空流应被标为 empty");
  assert.equal(out.failure, null, "空产出不是 failure——它没有自己的错误文案");
  assert.equal(out.text, "");
});

test("翻译层：有正文不标 empty", async () => {
  const out = await runTurn([
    { type: "start" },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "在的" },
    { type: "finish" },
  ]);
  assert.equal(out.empty, false);
  assert.equal(out.text, "在的");
});

test("翻译层：只有工具调用、没有正文也不标 empty（工具卡已在界面上）", async () => {
  const out = await runTurn([
    { type: "start" },
    { type: "tool-call", toolCallId: "c1", toolName: "get_time", input: {} },
    { type: "tool-result", toolCallId: "c1", toolName: "get_time", output: { ok: true } },
    { type: "finish" },
  ]);
  assert.equal(out.empty, false, "调了工具就不是空产出");
});

test("翻译层：只有思考没有正文也不标 empty（深思模型先想后答）", async () => {
  const out = await runTurn([
    { type: "start" },
    { type: "reasoning-delta", id: "r0", delta: "先想一下" },
    { type: "reasoning-end", id: "r0" },
    { type: "finish" },
  ]);
  assert.equal(out.empty, false, "有思考痕迹就不是「什么都没发生」");
  assert.equal(out.think, "先想一下");
});

test("翻译层：abort part（看门狗超时）不标 empty——它有 failure 口径", async () => {
  const out = await runTurn([
    { type: "start" },
    { type: "abort", reason: new Error("TimeoutError: First chunk timeout of 60000ms exceeded") },
  ]);
  assert.equal(out.empty, false);
  assert.match(out.failure ?? "", /本轮已中止/, "应保留看门狗自己的失败文案");
});
