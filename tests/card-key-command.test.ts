import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runAgentTUI } from "@ai-sdk/tui";
import { createKeyProxy } from "../src/tui/keys";

const waitForIO = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

test("卡片模式无参 /key 请求外层安全设置流程，不提交给 Agent", async () => {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, "isTTY", { value: true });
  Object.defineProperty(stdin, "setRawMode", { value: () => {} });

  const screen = new PassThrough() as PassThrough & {
    columns?: number;
    rows?: number;
    isTTY?: boolean;
  };
  screen.columns = 80;
  screen.rows = 24;
  screen.isTTY = true;

  let agentCalls = 0;
  const keys = createKeyProxy(stdin, {
    commands: {
      "/key": { desc: "管理 API Key", switchTo: "setup-key" },
    },
  });
  const done = runAgentTUI({
    agent: {
      stream: async () => {
        agentCalls++;
        return { fullStream: (async function* () {})() };
      },
    },
    userInput: keys.stream,
    screen,
  } as unknown as Parameters<typeof runAgentTUI>[0]);

  try {
    await waitForIO();
    stdin.write("/key\r");
    await waitForIO();

    assert.equal(keys.switchRequest, "setup-key");
    assert.equal(agentCalls, 0, "/key 不得提交给 Agent");
  } finally {
    stdin.write("\x03");
    await done;
    keys.restore();
    screen.destroy();
  }
});
