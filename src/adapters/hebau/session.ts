/**
 * 共享会话管理：CAS/URP 登录 cookie 的缓存 + 失效重建
 * 登录链跨两个主机（CAS → URP），线路抖动时带退避重试。
 *
 * 与 njtech/session.ts 的关键差异在二次认证：loginHebau 可能抛
 * SecondFactorRequiredError（BUSINESS_REJECT，不可重试）——withRetry 按
 * RaptorError.retryable 判定，不会盲目重试，用户不会连收多条验证码短信。
 */

import { config } from "../../core/config";
import { isSessionExpiredError, RaptorError } from "../../core/errors";
import { withRetry } from "../../core/http";
import { loginHebau } from "./cas";

const RETRY_MAX = 5;

/** 教务功能前置检查：没配账号时直接给可操作的提示，而不是拿 undefined 去撞登录接口。
    文案命中 chat-web 的 NEED_SETUP_RE：网页端会据此自动弹出设置面板 */
function requireJwglCredentials(): void {
  if (!config.jwglUsername || !config.jwglPassword) {
    throw new RaptorError(
      "AUTH_MISSING",
      "尚未配置教务账号：请在设置面板里填写统一身份认证的学号和密码（网页端我已自动为你打开）后重试",
    );
  }
}

interface AuthCache {
  cookie: string;
  createdAt: number;
}

let authCache: AuthCache | null = null;
const AUTH_TTL_MS = 25 * 60 * 1000; // 25 分钟（保守于常见 30 分钟会话）

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

/** 登录 cookie 失效（被服务端提前踢下线等）时清除缓存，下一次 getCookie 重新登录 */
export function invalidateAuthCache(): void {
  authCache = null;
}

/** 带「会话失效自动重登一次」的查询执行器：urp 层识别出登录页后抛
    SESSION_EXPIRED，这里换新 cookie 重试一次，仍失败才把错误交给上层。
    避免死 cookie 熬满 25 分钟 TTL 期间所有教务查询持续报错。 */
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

// ── 带重试的登录 ─────────────────────────────────────────────

async function loginWithRetry(): Promise<{ cookie: string }> {
  // 线性退避（2/4/6/8s）；凭证错误/二次认证/结构变化这类不可重试错误由
  // withRetry 按 RaptorError.retryable 立即上抛
  const { cookie } = await withRetry(() => loginHebau(config.jwglUsername, config.jwglPassword), {
    attempts: RETRY_MAX,
    baseDelayMs: 2000,
    backoff: "linear",
    label: "河北农大统一认证登录失败",
  });
  return { cookie };
}
