/**
 * 共享会话管理：教务登录会话的缓存 + 失效重建
 * 教务线路间歇抖动，全部带指数退避重试
 *
 * 学校维度：登录一律走 activeSchool() 的适配器，本文件不认识具体学校。
 * 缓存单位是 SchoolSession（cookie + 学号）而不是裸 cookie——河北农大的抓取接口
 * 要用学号推入学年份，且 CAS 会话由多个 Cookie 项拼成，拆开存迟早漏一个。
 */

import { config } from "../config";
import { openXkSession, type XkSession } from "../jwgl/xk";
import { SecondFactorRequiredError } from "../schools/mfa";
import { activeSchool } from "../schools/registry";
import {
  type SchoolAdapter,
  type SchoolCapability,
  type SchoolSession,
  supportsCapability,
  unsupportedCapabilityMessage,
} from "../schools/types";

const RETRY_MAX = 5;

// ── 普通登录会话（课表/成绩/考试用）───────────────────────────

interface AuthCache {
  session: SchoolSession;
  createdAt: number;
}

let authCache: AuthCache | null = null;
const AUTH_TTL_MS = 25 * 60 * 1000; // 25 分钟（保守于 30 分钟会话）

/** 获取登录会话（缓存复用，失效/被强制时重建） */
export async function getSession(force = false): Promise<SchoolSession> {
  if (!force && authCache && Date.now() - authCache.createdAt < AUTH_TTL_MS) {
    return authCache.session;
  }
  const session = await loginWithRetry();
  authCache = { session, createdAt: Date.now() };
  return session;
}

/** 获取登录 cookie（缓存复用，失效/被强制时重建） */
export async function getCookie(force = false): Promise<string> {
  return (await getSession(force)).cookie;
}

/** 会话被判失效时清缓存，下一轮重新登录 */
export function invalidateSession(): void {
  authCache = null;
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

async function loginWithRetry(): Promise<SchoolSession> {
  const school = activeSchool();
  requireCredentials(school.name);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      return await school.login({ username: config.jwglUsername, password: config.jwglPassword });
    } catch (e) {
      lastError = e as Error;
      const msg = lastError.message;
      // 二次认证要的是用户手里的验证码，不是第 2 次登录：重试等于反复给用户手机发码
      if (lastError instanceof SecondFactorRequiredError) throw lastError;
      // 密码错误不需要重试
      if (msg.includes("密码") || msg.includes("学号")) throw lastError;
      if (attempt < RETRY_MAX) {
        await sleep(attempt * 2000);
      }
    }
  }
  throw new Error(`教务登录失败（已重试 ${RETRY_MAX} 次）：${lastError?.message ?? "未知错误"}`);
}

/** 凭证缺失的前置拦截。空账号去打登录接口只会换来一句「密码错误」，误导人 */
function requireCredentials(schoolName: string): void {
  if (config.jwglUsername && config.jwglPassword) return;
  throw new Error(
    `尚未配置${schoolName}的教务系统账号。运行 raptor 按引导录入，或在 .env 设置 JWGL_USERNAME / JWGL_PASSWORD（换学校时记得换成本校账号）。`,
  );
}

/**
 * 把「需要二次认证」翻译成工具返回值。
 * 抛给 SDK 只剩一句模糊的工具失败，模型会当成网络问题转述；
 * 结构化字段（needs_auth_code / challenge_id）才能让它明确去要验证码。
 */
export function secondFactorGate(
  error: unknown,
): { error: string; needs_auth_code: true; challenge_id: string } | null {
  if (!(error instanceof SecondFactorRequiredError)) return null;
  return {
    error: error.message,
    needs_auth_code: true,
    challenge_id: error.challengeId,
  };
}

/**
 * 教务工具的统一入口：能力门禁 → 取会话 → 拦住二次认证。
 *
 * 顺序很重要：先判能力再登录。河北农大没开放选课接口，若先登录再拒绝，
 * 用户会平白收到一条 CAS 验证码。
 */
export async function schoolSessionFor(
  capability: SchoolCapability,
): Promise<
  | { school: SchoolAdapter; session: SchoolSession }
  | { error: string; unsupported?: boolean; needs_auth_code?: boolean; challenge_id?: string }
> {
  const school = activeSchool();
  if (!supportsCapability(school, capability)) {
    return { error: unsupportedCapabilityMessage(school, capability), unsupported: true };
  }
  try {
    return { school, session: await getSession() };
  } catch (e) {
    const gate = secondFactorGate(e);
    if (gate) return gate;
    throw e;
  }
}

/**
 * 用用户提供的验证码完成二次认证。
 * 成功即写入会话缓存，之后同一轮里的查询不必再登录一次。
 */
export async function submitAuthCode(challengeId: string, code: string): Promise<SchoolSession> {
  const school = activeSchool();
  requireCredentials(school.name);
  const session = await school.login({
    username: config.jwglUsername,
    password: config.jwglPassword,
    challengeId,
    dynamicCode: code,
  });
  authCache = { session, createdAt: Date.now() };
  return session;
}

async function openXkSessionWithRetry(): Promise<XkSession> {
  // 选课模块（src/jwgl/xk.ts）只对接了南工大教务系统。不设这道卡，
  // 河北农大的用户一触发选课工具，就会拿着河农大的学号密码去登录南工大——
  // 那是凭证外泄，不是功能缺失。
  const school = activeSchool();
  if (!supportsCapability(school, "courseSelection")) {
    throw new Error(unsupportedCapabilityMessage(school, "courseSelection"));
  }
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
  throw new Error(
    `选课会话建立失败（已重试 ${RETRY_MAX} 次）：${lastError?.message ?? "未知错误"}`,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询间隔 + 随机抖动（±20%），避免请求间隔被精确识别 */
export function pollDelay(baseMs: number): Promise<void> {
  const jitter = baseMs * (0.8 + Math.random() * 0.4);
  return sleep(Math.round(jitter));
}
