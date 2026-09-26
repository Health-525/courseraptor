/**
 * 数值型环境变量校验契约（config.rateLimit）：
 * 坏值（非数字 / 越界）必须在启动期报错，而不是 NaN 悄悄进限速桶——
 * NaN 会让令牌桶的等待时间算出 NaN，限速静默失效。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { config, rateLimitSchema } from "../src/core/config";

test("默认值：未配置时 3 rps / burst 8", () => {
  const parsed = rateLimitSchema.parse({});
  assert.deepEqual(parsed, { rps: 3, burst: 8 });
});

test("合法下调：字符串数字被接受（.env 里一切都是字符串）", () => {
  assert.equal(rateLimitSchema.parse({ rps: "1" }).rps, 1);
  assert.equal(rateLimitSchema.parse({ burst: "16" }).burst, 16);
});

test("非法值被拒：非数字、0、负数、越上限", () => {
  for (const bad of ["abc", "", "0", "-1", "3.5", "10"]) {
    assert.equal(rateLimitSchema.safeParse({ rps: bad }).success, false, `rps=${bad} 必须被拒`);
  }
  for (const bad of ["abc", "0", "100"]) {
    assert.equal(rateLimitSchema.safeParse({ burst: bad }).success, false, `burst=${bad} 必须被拒`);
  }
});

test("单例配置携带校验后的限速值（http.ts 令牌桶从这里取初值）", () => {
  assert.equal(typeof config.rateLimit.rps, "number");
  assert.ok(config.rateLimit.rps >= 1 && config.rateLimit.rps <= 3);
  assert.ok(config.rateLimit.burst >= 1 && config.rateLimit.burst <= 64);
});
