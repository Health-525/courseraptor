/**
 * 通用 HTTP 原语 — 超时 / 类型化网络错误 / 重试
 *
 * 超时/断网抛 RaptorError("NETWORK")，HTTP 状态由调用方按业务判断。
 * 2026-10 起仓库不再内置学校教务适配器，原先的 cookie 客户端与全局限速桶
 * 已随适配器一并移除（程序不再请求教务系统）；这里只留下与具体学校无关
 * 的 fetch / retry 原语，供天气等通用联网能力使用。
 */

import { isRaptorError, RaptorError } from "./errors";

// ── 重试 ──────────────────────────────────────────────────────

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  attempts?: number;
  /** 退避基数（毫秒），默认 1000 */
  baseDelayMs?: number;
  /** 退避上限（毫秒），默认 8000 */
  maxDelayMs?: number;
  /** linear: base*n；exponential: base*2^(n-1)（默认） */
  backoff?: "linear" | "exponential";
  /** 耗尽后的包装文案前缀；不传则原样抛出最后一次的错误 */
  label?: string;
}

/** 计算第 attempt 次失败后的等待毫秒（attempt 从 1 起）
 *  @internal 仅为测试钉住退避曲线使用 */
export function backoffDelay(
  opts: Required<Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "backoff">>,
  attempt: number,
): number {
  const raw =
    opts.backoff === "linear" ? opts.baseDelayMs * attempt : opts.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(raw, opts.maxDelayMs);
}

/**
 * 带类型化分诊的重试：RaptorError 按 retryable 决定是否再试
 * （凭证错误/结构变化立即上抛），裸 Error（http 层网络异常）视为瞬时故障重试。
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const backoff = {
    baseDelayMs: options.baseDelayMs ?? 1000,
    maxDelayMs: options.maxDelayMs ?? 8000,
    backoff: options.backoff ?? "exponential",
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (isRaptorError(e) && !e.retryable) throw e;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, backoffDelay(backoff, attempt)));
      }
    }
  }
  if (options.label) {
    throw new Error(
      `${options.label}（已重试 ${attempts} 次）：${(lastError as Error)?.message ?? "未知错误"}`,
    );
  }
  throw lastError;
}

// ── 统一 fetch 原语 ────────────────────────────────────────────

/** 注入点：真实 fetch 或测试替身。init 只承诺这两个字段，返回最小 Response 形状即可 */
export type TextFetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface FetchUrlTextOptions {
  /** 超时毫秒数，默认 15000 */
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: TextFetch;
}

/** global fetch + 超时 + 类型化网络错误；HTTP 状态不在此判定 */
export async function fetchUrlText(
  url: string,
  opts: FetchUrlTextOptions = {},
): Promise<{ status: number; text: string }> {
  const doFetch: TextFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    // undici 内部重定向跟随有 20 跳上限，A↔B 互跳不会无限循环
    const res = await doFetch(url, {
      headers: opts.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    const err = e as Error;
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new RaptorError("NETWORK", `请求超时（${Math.round(timeoutMs / 1000)}s）：${url}`);
    }
    throw new RaptorError("NETWORK", `网络错误：${err?.message ?? String(e)}`);
  }
}

/** 注入点：真实 fetch 或测试替身（二进制形态）。返回最小 Response 形状即可 */
export type BufferFetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface FetchUrlBufferOptions {
  /** 超时毫秒数，默认 30000 */
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: BufferFetch;
}

/** global fetch + 超时 + 类型化网络错误（二进制）；HTTP 状态不在此判定 */
export async function fetchUrlBuffer(
  url: string,
  opts: FetchUrlBufferOptions = {},
): Promise<{ status: number; buf: Buffer }> {
  const doFetch: BufferFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  try {
    const res = await doFetch(url, {
      headers: opts.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  } catch (e) {
    const err = e as Error;
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new RaptorError("NETWORK", `请求超时（${Math.round(timeoutMs / 1000)}s）：${url}`);
    }
    throw new RaptorError("NETWORK", `网络错误：${err?.message ?? String(e)}`);
  }
}
