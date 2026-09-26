/**
 * 类型化错误契约：code / retryable 默认映射与谓词函数。
 * 这是重试与重登逻辑的判断依据（session.ts / course-selection 等），
 * 映射一旦变化必须是有意识的决定，用测试钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCredentialError,
  isRaptorError,
  isSessionExpiredError,
  RaptorError,
  SESSION_EXPIRED_MESSAGE,
} from "../src/core/errors";

test("默认 retryable 映射：会话失效/网络/上游可重试，凭证/解析/业务拒绝不可重试", () => {
  assert.equal(new RaptorError("SESSION_EXPIRED", "x").retryable, true);
  assert.equal(new RaptorError("NETWORK", "x").retryable, true);
  assert.equal(new RaptorError("UPSTREAM", "x").retryable, true);
  assert.equal(new RaptorError("AUTH_MISSING", "x").retryable, false);
  assert.equal(new RaptorError("AUTH_INVALID", "x").retryable, false);
  assert.equal(new RaptorError("AUTH_LOCKED", "x").retryable, false);
  assert.equal(new RaptorError("PARSE", "x").retryable, false);
  assert.equal(new RaptorError("CAMPUS_ONLY", "x").retryable, false);
  assert.equal(new RaptorError("BUSINESS_REJECT", "x").retryable, false);
});

test("retryable 可按场景显式覆盖（如线路抖动导致的临时解析失败）", () => {
  assert.equal(new RaptorError("PARSE", "x", { retryable: true }).retryable, true);
  assert.equal(new RaptorError("NETWORK", "x", { retryable: false }).retryable, false);
});

test("isRaptorError 可选按 code 过滤，普通 Error 一律不匹配", () => {
  const e = new RaptorError("AUTH_INVALID", "学号或密码不正确");
  assert.equal(isRaptorError(e), true);
  assert.equal(isRaptorError(e, "AUTH_INVALID"), true);
  assert.equal(isRaptorError(e, "NETWORK"), false);
  assert.equal(isRaptorError(new Error("学号或密码不正确")), false);
  assert.equal(isRaptorError("SESSION_EXPIRED"), false);
  assert.equal(isRaptorError(null), false);
});

test("isSessionExpiredError 只认 code，文案里出现「失效」字样不算数", () => {
  assert.equal(isSessionExpiredError(new RaptorError("SESSION_EXPIRED", "会话已失效")), true);
  assert.equal(isSessionExpiredError(new RaptorError("UPSTREAM", "WebVPN 会话已失效")), false);
  assert.equal(isSessionExpiredError(new Error("SESSION_EXPIRED")), false);
});

test("isCredentialError 覆盖未配置/密码错/被锁三种，其他错误不算", () => {
  assert.equal(isCredentialError(new RaptorError("AUTH_MISSING", "x")), true);
  assert.equal(isCredentialError(new RaptorError("AUTH_INVALID", "x")), true);
  assert.equal(isCredentialError(new RaptorError("AUTH_LOCKED", "x")), true);
  assert.equal(isCredentialError(new RaptorError("SESSION_EXPIRED", "x")), false);
  assert.equal(isCredentialError(new Error("学号或密码不正确")), false);
});

test("cause 透传，包装错误不丢原始异常", () => {
  const cause = new Error("socket hang up");
  const e = new RaptorError("NETWORK", "上游不可达", { cause });
  assert.equal(e.cause, cause);
});

test("SESSION_EXPIRED_MESSAGE 哨兵值与同名 code 保持一致", () => {
  assert.equal(SESSION_EXPIRED_MESSAGE, "SESSION_EXPIRED");
  assert.equal(SESSION_EXPIRED_MESSAGE, "SESSION_EXPIRED" satisfies RaptorError["code"]);
});
