/**
 * 共享会话管理：教务登录 cookie 与选课会话的缓存 + 失效重建
 * 教务线路间歇抖动，全部带指数退避重试
 *
 * 2026-10 收紧：RETRY_MAX 从 5 降到 2（首次 + 一次重试），与 core/http
 * 的默认 attempts=2 对齐。用户明确表态「获取信息 2 次失败直接报错」——
 * 正方登录抖动时宁可让用户手动重试，也不要在客户端空转十几秒。
 */

import { config } from "../../core/config";
import { isSessionExpiredError, RaptorError } from "../../core/errors";
import { withRetry } from "../../core/http";
import { loginJwgl } from "./auth";
import { openXkSession, type XkSession } from "./xk";

const RETRY_MAX = 2;

// ── 普通登录 cookie（课表/成绩/考试用）────────────────────────

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

/** 普通登录 cookie 失效（被服务端提前踢下线等）时清除缓存，下一次 getCookie 重新登录 */
export function invalidateAuthCache(): void {
  authCache = null;
}

/** 带「会话失效自动重登一次」的查询执行器：fetch 层识别出登录页后抛
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

// ── 选课会话（含 xkkzId/csrftoken 与预热上下文）─────────────────

interface XkCache {
  session: XkSession;
  createdAt: number;
}

let xkCache: XkCache | null = null;
const XK_TTL_MS = 25 * 60 * 1000;

/** 获取选课会话（缓存复用） */
export async function getXkSession(force = false): Promise<XkSession> {
  requireJwglCredentials();
  if (!force && xkCache && Date.now() - xkCache.createdAt < XK_TTL_MS) {
    return xkCache.session;
  }
  const session = await openXkSessionWithRetry();
  xkCache = { session, createdAt: Date.now() };
  return session;
}

/** 选课会话失效时清除缓存（下一轮 getXkSession 重建） */
export function invalidateXkSession(): void {
  xkCache = null;
}

// ── 带重试的登录 ─────────────────────────────────────────────

async function loginWithRetry(): Promise<{ cookie: string }> {
  // 线性退避与旧手写循环一致（2/4/6/8s）；凭证错误/结构变化由
  // withRetry 按 RaptorError.retryable 立即上抛，不再重试
  const { cookie } = await withRetry(() => loginJwgl(config.jwglUsername, config.jwglPassword), {
    attempts: RETRY_MAX,
    baseDelayMs: 2000,
    backoff: "linear",
    label: "教务登录失败",
  });
  return { cookie };
}

async function openXkSessionWithRetry(): Promise<XkSession> {
  return withRetry(() => openXkSession(config.jwglUsername, config.jwglPassword), {
    attempts: RETRY_MAX,
    baseDelayMs: 2000,
    backoff: "linear",
    label: "选课会话建立失败",
  });
}
