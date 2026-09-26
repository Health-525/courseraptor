/**
 * 共享会话管理：教务登录 cookie 与选课会话的缓存 + 失效重建
 * 教务线路间歇抖动，全部带指数退避重试
 */

import { config } from "../../core/config";
import { RaptorError } from "../../core/errors";
import { withRetry } from "../../core/http";
import { loginJwgl } from "./auth";
import { openXkSession, type XkSession } from "./xk";

const RETRY_MAX = 5;

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

/** 获取登录 cookie（缓存复用，失效/被强制时重建） */
export async function getCookie(force = false): Promise<string> {
  requireJwglCredentials();
  if (!force && authCache && Date.now() - authCache.createdAt < AUTH_TTL_MS) {
    return authCache.cookie;
  }
  const { cookie } = await loginWithRetry();
  authCache = { cookie, createdAt: Date.now() };
  return cookie;
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

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询间隔 + 随机抖动（±20%），避免请求间隔被精确识别 */
export function pollDelay(baseMs: number): Promise<void> {
  const jitter = baseMs * (0.8 + Math.random() * 0.4);
  return sleep(Math.round(jitter));
}
