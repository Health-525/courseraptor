import assert from "node:assert/strict";
import { test } from "node:test";
import { startStandaloneQQ } from "../src/qq/bridge";

test("独立 QQ 启动加载凭证后启动桥接", async () => {
  const order: string[] = [];
  await startStandaloneQQ({
    ensureCredentials: async () => {
      order.push("credentials");
    },
    startBridge: async () => {
      order.push("bridge");
    },
  });
  assert.deepEqual(order, ["credentials", "bridge"]);
});

test("独立 QQ 凭证加载失败时不得启动桥接", async () => {
  const order: string[] = [];
  await assert.rejects(
    () =>
      startStandaloneQQ({
        ensureCredentials: async () => {
          order.push("credentials");
          throw new Error("凭证加载失败");
        },
        startBridge: async () => {
          order.push("bridge");
        },
      }),
    /凭证加载失败/,
  );
  assert.deepEqual(order, ["credentials"]);
});
