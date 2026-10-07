import assert from "node:assert/strict";
import { test } from "node:test";
import { startStandaloneQQ } from "../local/qq/bridge";

test("独立 QQ 入口按序拉起桥", async () => {
  const order: string[] = [];
  await startStandaloneQQ(async () => {
    order.push("bridge");
  });
  assert.deepEqual(order, ["bridge"]);
});

test("桥启动失败原样上抛（不吞错）", async () => {
  await assert.rejects(
    () =>
      startStandaloneQQ(async () => {
        throw new Error("桥启动失败");
      }),
    /桥启动失败/,
  );
});
