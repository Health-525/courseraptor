/**
 * 河北农大会话管理：CAS 登录会话的缓存 + 失效重建 + 二次认证续登
 * （结构与 njtech/session.ts 同款：缓存复用、并发去重、会话失效自动重登一次）
 *
 * 与 njtech 的差别：登录可能抛 SecondFactorRequiredError（CAS 动态码）——
 * 它是 AUTH_CHALLENGE（不可重试），withRetry 会立刻放行给上层去要验证码，
 * 不会反复触发登录给用户手机灌码。
 */

import { config } from "../../core/config";
import { isSessionExpiredError, RaptorError } from "../../core/errors";
import { withRetry } from "../../core/http";
import {
  findSecondFactor,
  readSecondFactor,
  SecondFactorRequiredError,
} from "../../core/school-mfa";
import { completeSecondFactor, loginHebau } from "./cas";

const RETRY_MAX = 5;

// ── 登录会话（课表/成绩/考试用）───────────────────────────────

/** 教务功能前置检查：没配账号时直接给可操作的提示，而不是拿 undefined 去撞登录接口。
    文案命中 chat-web 的 NEED_SETUP_RE：网页端会据此自动弹出设置面板 */
function requireJwglCredentials(): void {
  if (!config.jwglUsername || !config.jwglPassword) {
    throw new RaptorError(
      "AUTH_MISSING",
      "尚未配置教务账号：请在设置面板里填写学号和密码（网页端我已自动为你打开）后重试",
    );
  }
}

interface AuthCache {
  cookie: string;
  createdAt: number;
}

let authCache: AuthCache | null = null;
const AUTH_TTL_MS = 25 * 60 * 1000; // 25 分钟（保守于 CAS 会话）

/** 登录去重：一轮对话里模型并行调多个教务工具时，并发 getCookie 只触发一次真实登录 */
let authInflight: Promise<string> | null = null;

/** 获取登录 cookie（缓存复用，失效/被强制时重建；并发调用共享同一次登录） */
export async function getCookie(force = false): Promise<string> {
  requireJwglCredentials();
  if (!force && authCache && Date.now() - authCache.createdAt < AUTH_TTL_MS) {
    return authCache.cookie;
  }
  if (!authInflight) {
    authInflight = loginWithRetry()
      .then(({ cookie }) => {
        authCache = { cookie, createdAt: Date.now() };
        return cookie;
      })
      .finally(() => {
        authInflight = null;
      });
  }
  return authInflight;
}

/** 会话被判失效时清缓存，下一轮 getCookie 重新登录 */
export function invalidateAuthCache(): void {
  authCache = null;
}

/** 带「会话失效自动重登一次」的查询执行器：fetch 层识别出登录页后抛
    SESSION_EXPIRED，这里换新 cookie 重试一次，仍失败才把错误交给上层 */
export async function withAuthRetry<T>(fn: (cookie: string) => Promise<T>): Promise<T> {
  let cookie = await getCookie();
  try {
    return await fn(cookie);
  } catch (e) {
    if (!isSessionExpiredError(e)) throw e;
    invalidateAuthCache();
    cookie = await getCookie(true);
    return await fn(cookie);
  }
}

/**
 * 用用户提供的验证码完成二次认证并写入会话缓存。
 * challengeId 省略时按「本校 + 当前学号」找唯一待验证会话（用户通常只回验证码原文）。
 */
export async function submitSecondFactor(input: {
  code: string;
  challengeId?: string;
}): Promise<void> {
  requireJwglCredentials();
  const username = config.jwglUsername;
  let challengeId = input.challengeId?.trim();
  if (!challengeId) {
    const pending = findSecondFactor("hebau", username);
    if (!pending) {
      throw new RaptorError(
        "AUTH_CHALLENGE",
        "当前没有待验证的登录（可能已超过 10 分钟或已用完）。请重新查询一次课表/成绩触发新验证码，再把它发给我。",
        { retryable: false },
      );
    }
    challengeId = pending.challengeId;
  } else {
    const pending = readSecondFactor(challengeId, "hebau", username);
    if (typeof pending === "string") {
      throw new RaptorError("AUTH_CHALLENGE", pending, { retryable: false });
    }
  }
  const session = await completeSecondFactor(challengeId, input.code.trim(), username);
  authCache = { cookie: session.cookie, createdAt: Date.now() };
}

// ── 带重试的登录 ─────────────────────────────────────────────

async function loginWithRetry(): Promise<{ cookie: string }> {
  // 线性退避（2/4/6/8s）。凭证错误与二次认证由 withRetry 按 RaptorError.retryable
  // 立即上抛：前者重试无意义，后者重试等于反复给用户手机发验证码
  const { cookie } = await withRetry(
    () => loginHebau({ username: config.jwglUsername, password: config.jwglPassword }),
    {
      attempts: RETRY_MAX,
      baseDelayMs: 2000,
      backoff: "linear",
      label: "河北农大教务登录失败",
    },
  );
  return { cookie };
}

export { SecondFactorRequiredError };
