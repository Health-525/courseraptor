/**
 * 共享会话管理：教务登录 cookie 与选课会话的缓存 + 失效重建
 * 教务线路间歇抖动，全部带指数退避重试
 */

import { config } from "../config";
import { loginJwgl } from "../jwgl/auth";
import {
  openXkSession,
  type XkSession,
} from "../jwgl/xk";

const RETRY_MAX = 5;

// ── 普通登录 cookie（课表/成绩/考试用）────────────────────────

interface AuthCache {
  cookie: string;
  createdAt: number;
}

let authCache: AuthCache | null = null;
const AUTH_TTL_MS = 25 * 60 * 1000; // 25 分钟（保守于 30 分钟会话）

/** 获取登录 cookie（缓存复用，失效/被强制时重建） */
export async function getCookie(force = false): Promise<string> {
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
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      return await loginJwgl(config.jwglUsername, config.jwglPassword);
    } catch (e) {
      lastError = e as Error;
      const msg = lastError.message;
      // 密码错误不需要重试
      if (msg.includes("密码") || msg.includes("学号")) throw lastError;
      if (attempt < RETRY_MAX) {
        await sleep(attempt * 2000);
      }
    }
  }
  throw new Error(`教务登录失败（已重试 ${RETRY_MAX} 次）：${lastError?.message ?? "未知错误"}`);
}

async function openXkSessionWithRetry(): Promise<XkSession> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      return await openXkSession(config.jwglUsername, config.jwglPassword);
    } catch (e) {
      lastError = e as Error;
      const msg = lastError.message;
      if (msg.includes("密码") || msg.includes("学号")) throw lastError;
      if (attempt < RETRY_MAX) {
        await sleep(attempt * 2000);
      }
    }
  }
  throw new Error(`选课会话建立失败（已重试 ${RETRY_MAX} 次）：${lastError?.message ?? "未知错误"}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询间隔 + 随机抖动（±20%），避免请求间隔被精确识别 */
export function pollDelay(baseMs: number): Promise<void> {
  const jitter = baseMs * (0.8 + Math.random() * 0.4);
  return sleep(Math.round(jitter));
}
