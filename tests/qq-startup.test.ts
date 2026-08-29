import assert from "node:assert/strict";
import { test } from "node:test";
import { startStandaloneQQ } from "../src/qq/bridge";

test("独立 QQ 启动先完成授权校验，再加载凭证和桥接", async () => {
  const order: string[] = [];
  await startStandaloneQQ({
    ensureLicense: async () => {
      order.push("license");
    },
    ensureCredentials: async () => {
      order.push("credentials");
    },
    startBridge: async () => {
      order.push("bridge");
    },
  });
  assert.deepEqual(order, ["license", "credentials", "bridge"]);
});

test("独立 QQ 授权失败时不得启动桥接", async () => {
  const order: string[] = [];
  await assert.rejects(
    () => startStandaloneQQ({
      ensureLicense: async () => {
        order.push("license");
        throw new Error("未激活");
      },
      ensureCredentials: async () => {
        order.push("credentials");
      },
      startBridge: async () => {
        order.push("bridge");
      },
    }),
    /未激活/,
  );
  assert.deepEqual(order, ["license"]);
});
