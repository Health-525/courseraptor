/**
 * NYTDC 共享会话管理：教务登录 cookie 的缓存 + 失效重建
 *
 * 与 NJTECH 的 session.ts 同构，去掉选课（xk）会话部分——通达适配第一版
 * 不声明 courseSelection 能力，选课链路的会话预热代码随之下沉。
 */

import { config } from "../../core/config";
import { isSessionExpiredError, RaptorError } from "../../core/errors";
import { withRetry } from "../../core/http";
import { loginJwgl } from "./auth";

const RETRY_MAX = 5;

/** 判断响应体是不是「被踢回登录页」（正方统一用登录页模板兜底） */
export function isSessionExpired(body: string): boolean {
  if (!body) return false;
  return (
    body.includes("login_slogin") || body.includes('id="csrftoken"') || body.includes("用户登录")
  );
}

/**
 * 教务功能前置检查：没配账号时直接给可操作的提示，而不是拿 undefined 去撞登录接口。
 * 文案命中 chat-web 的 NEED_SETUP_RE：网页端会据此自动弹出设置面板。
 */
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
const AUTH_TTL_MS = 25 * 60 * 1000; // 25 分钟（保守于 30 分钟会话）

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

/** cookie 失效（被服务端提前踢下线等）时清除缓存，下一次 getCookie 重新登录 */
export function invalidateAuthCache(): void {
  authCache = null;
}

/**
 * 带「会话失效自动重登一次」的查询执行器：fetch 层识别出登录页后抛
 * SESSION_EXPIRED，这里换新 cookie 重试一次。
 */
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

/** 带重试的登录（线性退避 2/4/6/8s，与 NJTECH 同款；凭证错误不重试） */
async function loginWithRetry(): Promise<{ cookie: string }> {
  const { cookie } = await withRetry(() => loginJwgl(config.jwglUsername, config.jwglPassword), {
    attempts: RETRY_MAX,
    baseDelayMs: 2000,
    backoff: "linear",
    label: "教务登录失败",
  });
  return { cookie };
}
