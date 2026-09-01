import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runInlineTUI, type TUIStreamableAgent } from "../src/tui/inline";

const nullAgent: TUIStreamableAgent = {
  stream: async () => ({ fullStream: (async function* () {})() }),
};

function makeTTYStream(): PassThrough & {
  isTTY?: boolean;
  setRawMode?: (value: boolean) => void;
  columns?: number;
} {
  const stream = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (value: boolean) => void;
    columns?: number;
  };
  stream.isTTY = true;
  stream.columns = 80;
  stream.setRawMode = () => {};
  return stream;
}

test("行内模式无参 /key 请求外层安全设置流程，不进入 Agent", async () => {
  const input = makeTTYStream();
  const output = makeTTYStream();
  let agentCalls = 0;
  const agent: TUIStreamableAgent = {
    stream: async () => {
      agentCalls++;
      return { fullStream: (async function* () {})() };
    },
  };

  const done = runInlineTUI({
    title: "test",
    agent,
    input: input as never,
    output: output as never,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  input.write("/Key\r");
  const cleanupTimer = setTimeout(() => {
    input.write("\x7f".repeat(64));
    input.write("\x04");
  }, 30);
  cleanupTimer.unref?.();

  try {
    assert.equal(await done, "setup-key");
    assert.equal(agentCalls, 0);
  } finally {
    clearTimeout(cleanupTimer);
  }
});

test("行内旧式 /Key 参数不会回显、进入历史或提交给 Agent", async () => {
  const input = makeTTYStream();
  const output = makeTTYStream();
  const frames: string[] = [];
  output.on("data", (chunk: Buffer) => frames.push(chunk.toString("utf8")));
  let agentCalls = 0;
  const agent: TUIStreamableAgent = {
    stream: async () => {
      agentCalls++;
      return { fullStream: (async function* () {})() };
    },
  };

  const done = runInlineTUI({
    title: "test",
    agent,
    input: input as never,
    output: output as never,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const secret = "sk-ShouldNeverAppear123456789";
  input.write(`/Key ${secret}\r`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write("/exit\r");

  assert.equal(await done, "exit");
  assert.equal(agentCalls, 0, "旧式参数不得进入 Agent");
  assert.ok(!frames.join("").includes(secret), "旧式参数不得回显到行内终端");
});
