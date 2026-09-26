/**
 * 统一 HTTP 原语契约（core/http）：
 * - withRetry：RaptorError 按 retryable 分诊（凭证错误立即上抛、网络错误重试）、
 *   线性/指数退避、label 包装文案
 * - httpError：失败响应 → 类型化错误（code/retryable 由失败点打标）
 * - fetchUrlText：超时抛 NETWORK、HTTP 状态留给调用方判定
 * 全程替身注入，不联网、不真实等待（baseDelayMs=1）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RaptorError } from "../src/core/errors";
import {
  backoffDelay,
  fetchUrlText,
  type HttpResponse,
  httpError,
  withRetry,
} from "../src/core/http";

test("withRetry：瞬时故障重试到成功，调用次数如实记录", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new RaptorError("NETWORK", "抖动");
      return "ok";
    },
    { attempts: 5, baseDelayMs: 1 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry：不可重试的 RaptorError（凭证错误）立即上抛，不空转", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new RaptorError("AUTH_INVALID", "学号或密码不正确");
      },
      { attempts: 5, baseDelayMs: 1 },
    ),
    (e: unknown) => e instanceof RaptorError && e.code === "AUTH_INVALID",
  );
  assert.equal(calls, 1, "凭证错误第一次就该停");
});

test("withRetry：裸 Error（http 层网络异常）视为瞬时故障照常重试", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("socket hang up");
      },
      { attempts: 3, baseDelayMs: 1 },
    ),
    /socket hang up/,
  );
  assert.equal(calls, 3);
});

test("withRetry：耗尽后带 label 时包装重试次数文案，无 label 原样抛出", async () => {
  await assert.rejects(
    withRetry(
      async () => {
        throw new Error("上游 502");
      },
      { attempts: 2, baseDelayMs: 1, label: "教务登录失败" },
    ),
    /教务登录失败（已重试 2 次）：上游 502/,
  );
  await assert.rejects(
    withRetry(
      async () => {
        throw new RaptorError("NETWORK", "原样");
      },
      { attempts: 2, baseDelayMs: 1 },
    ),
    (e: unknown) => e instanceof RaptorError && e.message === "原样",
  );
});

test("withRetry：线性退避 1x/2x/3x 与旧手写循环一致（指数为 1x/2x/4x，均有上限）", async () => {
  const linear = { baseDelayMs: 1000, maxDelayMs: 8000, backoff: "linear" } as const;
  const exponential = { baseDelayMs: 1000, maxDelayMs: 8000, backoff: "exponential" } as const;
  // 登录链的 2/4/6/8s（session.ts 旧行为）由 linear 严格保持
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => backoffDelay(linear, n)),
    [1000, 2000, 3000, 4000],
  );
  assert.deepEqual(
    [1, 2, 3].map((n) => backoffDelay(exponential, n)),
    [1000, 2000, 4000],
  );
  // 指数增长触顶后不再增长
  assert.equal(backoffDelay(exponential, 10), 8000);
});

test("httpError：网络失败映射 NETWORK 可重试，5xx 映射 UPSTREAM 可重试，重定向异常不可重试", () => {
  const network: HttpResponse = {
    status: 0,
    body: "",
    headers: {},
    error: "网络错误：ECONNRESET",
    errorCode: "NETWORK",
    errorRetryable: true,
  };
  const e1 = httpError(network);
  assert.ok(e1 && e1.code === "NETWORK" && e1.retryable);

  const upstream: HttpResponse = {
    status: 502,
    body: "",
    headers: {},
    error: "服务端错误 HTTP 502",
    errorCode: "UPSTREAM",
    errorRetryable: true,
  };
  const e2 = httpError(upstream);
  assert.ok(e2 && e2.code === "UPSTREAM" && e2.retryable);

  const redirectLoop: HttpResponse = {
    status: 302,
    body: "",
    headers: {},
    error: "重定向次数超过上限（5）",
    errorCode: "UPSTREAM",
    errorRetryable: false,
  };
  const e3 = httpError(redirectLoop);
  assert.ok(e3 && e3.code === "UPSTREAM" && !e3.retryable, "重定向环路是确定性失败，重试无意义");

  const fine: HttpResponse = { status: 200, body: "ok", headers: {} };
  assert.equal(httpError(fine), null);
});

test("fetchUrlText：超时抛 NETWORK RaptorError，正常时返回状态与文本", async () => {
  const timeoutErr = new Error("The operation was aborted due to timeout");
  timeoutErr.name = "TimeoutError";
  await assert.rejects(
    fetchUrlText("https://example.com/x", {
      timeoutMs: 10,
      fetchImpl: async () => {
        throw timeoutErr;
      },
    }),
    (e: unknown) => e instanceof RaptorError && e.code === "NETWORK" && e.message.includes("超时"),
  );

  const { status, text } = await fetchUrlText("https://example.com/x", {
    fetchImpl: async () => ({ status: 483, text: async () => "拦截页" }),
  });
  // HTTP 状态不在此判定（jwc 的 483 要由调用方读签名识别）
  assert.equal(status, 483);
  assert.equal(text, "拦截页");
});
