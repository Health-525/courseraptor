/**
 * 短期记忆的跨会话隔离
 *
 * 背景：短期记忆由 data/session.json 承载——模型中间件每轮把当前完整对话
 * 覆写进去（**全局单文件**，不按会话区分），agent 组装时把尾部转写注入系统
 * 提示词。对 TUI（重启后续上）与 QQ（每条消息新建 agent、靠它连续）是必要
 * 的；对网页是污染——网页每轮本来就带该会话自己的完整历史
 * （chat-stream 用 contextMessages(sessionId)），注入进来的却是**别的会话**
 * 的尾巴，多标签并发时还会互相覆盖。
 *
 * 本测试钉住：carryOver=false 时提示词不含上次会话记录；网页装配点显式关掉；
 * 长期记忆不受影响（它本来就是跨会话的）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-carryover-"));
process.env.RAPTOR_DATA_DIR = dataDir;

await import("../src/adapters");
const { createRaptorAgent } = await import("../src/core/agent");
const { writeFileAtomicSync } = await import("../src/core/atomic-write");

const HEAD = "## 上次会话记录";

/** 造一份可被 loadLastSessionTranscript 读到的上次会话 */
function seedLastSession(): void {
  writeFileAtomicSync(
    path.join(dataDir, "session.json"),
    JSON.stringify({
      savedAt: new Date().toISOString(),
      messages: [
        { role: "user", content: "上一轮我说过选课的事" },
        { role: "assistant", content: [{ type: "text", text: "选课已经结束了" }] },
      ],
    }),
  );
}

/** ToolLoopAgent 把系统提示词放在 settings.instructions，直接读比钩模型层可靠 */
function instructionsOf(agent: unknown): string {
  const s = (agent as { settings?: { instructions?: unknown } }).settings;
  return typeof s?.instructions === "string" ? s.instructions : "";
}

test("carryOver 默认开：TUI/QQ 仍能恢复上次会话", async () => {
  seedLastSession();
  const seen = instructionsOf(await createRaptorAgent());
  assert.notEqual(seen, "", "应能读到 agent 的系统提示词，否则本测试是空跑");
  assert.match(seen, new RegExp(HEAD), "默认应注入上次会话记录");
  assert.match(seen, /选课已经结束了/, "应带上次的实际内容");
  const { loadLastSessionTranscript } = await import("../src/core/memory/shortterm");
  assert.match(await loadLastSessionTranscript(), new RegExp(HEAD), "转写本身应可读");
});

test("TUI 实例（channel 留空）不套 QQ 或网页的渠道专属排版规则", async () => {
  const seen = instructionsOf(await createRaptorAgent());
  assert.doesNotMatch(seen, /输出格式（QQ 渠道/, "TUI 不是 QQ，不该套 QQ 固定模板");
  assert.doesNotMatch(
    seen,
    /输出格式（网页渠道/,
    "TUI 是纯文本终端，不该套网页的 Markdown 表格规则",
  );
});

test("网页实例显式传 web：套用网页渠道的 Markdown 表格排版规则", async () => {
  const seen = instructionsOf(await createRaptorAgent("web", { carryOver: false }));
  assert.match(seen, /输出格式（网页渠道/, "网页实例应带 Markdown 表格排版规则");
});

test("carryOver=false：网页实例的提示词不含上次会话记录", async () => {
  seedLastSession();
  const seen = instructionsOf(await createRaptorAgent("web", { carryOver: false }));
  assert.notEqual(seen, "", "应能读到 agent 的系统提示词，否则本测试是空跑");
  assert.doesNotMatch(seen, new RegExp(HEAD), "网页不应注入上次会话记录");
  assert.doesNotMatch(seen, /选课已经结束了/, "别的会话内容不得出现在提示词里");
  // 说明是「不注入」而不是「没数据」：同一份转写仍可读
  const { loadLastSessionTranscript } = await import("../src/core/memory/shortterm");
  assert.match(await loadLastSessionTranscript(), /选课已经结束了/);
});

test("长期记忆不受影响：关掉注入后角色设定仍在", async () => {
  seedLastSession();
  const seen = instructionsOf(await createRaptorAgent("web", { carryOver: false }));
  assert.match(seen, /你是/, "网页实例仍要有角色设定，只摘掉短期记忆尾巴");
});

test("装配点：网页注册的是 carryOver=false 实例，TUI 保持默认注入", async () => {
  // 装配点已从 local/cli/index.ts 抽到共享引导 local/host/boot.ts（TUI 与桌面后端复用）
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "local", "host", "boot.ts"),
    "utf8",
  );
  assert.match(
    src,
    /setChatAgent\(await createRaptorAgent\("web", \{ carryOver: false \}\)\)/,
    "网页注册的实例应关掉注入",
  );
  assert.match(
    src,
    /setChatAgentRefresher\(async \(\) => \{\s*setChatAgent\(await createRaptorAgent\("web", \{ carryOver: false \}\)\)/,
    "换模型后重建的网页实例同样要关掉注入",
  );
  assert.match(src, /const agent = await createRaptorAgent\(\);/, "TUI 仍用默认（注入）实例");
  // 网页每轮自带该会话历史——这是网页不需要注入的前提
  const stream = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "channels", "web", "chat-stream.ts"),
    "utf8",
  );
  assert.match(stream, /contextMessages\(sessionId\)/, "网页每轮应带该会话历史");
});

test("会话消息本身按会话隔离：contextMessages 只给本会话的窗口", async () => {
  const { appendRound, contextMessages } = await import("../src/core/chat-sessions");
  appendRound("sess-a", "A 的问题", "A 的回答");
  appendRound("sess-b", "B 的问题", "B 的回答");
  const a = contextMessages("sess-a");
  const b = contextMessages("sess-b");
  const textA = JSON.stringify(a);
  const textB = JSON.stringify(b);
  assert.match(textA, /A 的问题/);
  assert.doesNotMatch(textA, /B 的问题/, "A 会话不得看到 B 的内容");
  assert.match(textB, /B 的问题/);
  assert.doesNotMatch(textB, /A 的问题/, "B 会话不得看到 A 的内容");
});
