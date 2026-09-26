/**
 * 教务系统 HTTP 客户端 — Cookie 管理 / 全局节流 / 显式错误契约
 *
 * 三条设计约束（都是踩过坑之后加的）：
 *
 * 1. 失败必须可见。网络错误、超时、重定向环路一律写进 HttpResponse.error，
 *    绝不再返回 `{ status: 0, body: "" }`。之前上游的 `try { JSON.parse } catch { return [] }`
 *    会把断网翻译成「课表为空」，工具层再补一句「假期属正常」——一整类误报
 *    都源于此。调用方请看 httpFailure()。
 *
 * 2. 节流在传输层。抢课循环每加一个分组、教务每多开一个轮次 tab，请求量就
 *    线性放大；把 sleep 散在业务循环里，作者自己都察觉不到速率变了。
 *    令牌桶放在这里，任何调用点都绕不过去。
 *
 * 3. 重定向有上限。正方失效时会 302 回登录页，无跳数限制的递归迟早出事。
 */

import https from "node:https";

import { config } from "./config";
import { isRaptorError, RaptorError, type RaptorErrorCode } from "./errors";

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  /**
   * 传输层/协议层失败原因（网络错误、超时、重定向环路、5xx）。
   * 一旦非空，body 不可信——绝不能当「空数据」往上报。
   */
  error?: string;
  /** error 对应的错误码（httpError() 据此构建类型化错误） */
  errorCode?: RaptorErrorCode;
  /** 瞬时故障（网络抖动/5xx）时为 true：重试有意义；重定向异常等确定性失败为 false */
  errorRetryable?: boolean;
}

export interface HttpClient {
  req(urlPath: string, opts?: HttpOptions): Promise<HttpResponse>;
  getCookie(): string;
}

export interface HttpOptions {
  method?: string;
  body?: string;
}

/** 单次请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 30_000;
/** 单次 req() 内部最多跟随多少次重定向 */
const MAX_REDIRECTS = 5;

// ── 全局令牌桶 ────────────────────────────────────────────────
// 进程级共享：所有 client、所有模块加起来也不会超过这个速率。
// 选课峰值时段对学校系统的礼貌边界，也是不被 WAF 盯上的边界。

interface RateLimit {
  rps: number;
  burst: number;
}

const rateLimit: RateLimit = {
  // 经 config 的 zod 校验（只允许下调、防 NaN），不再裸读环境变量
  rps: config.rateLimit.rps,
  burst: config.rateLimit.burst,
};

let tokens = rateLimit.burst;
let lastRefill = Date.now();

/** 调整全局速率（测试与手动降速用） */
export function setRateLimit(rps: number, burst: number): void {
  rateLimit.rps = rps;
  rateLimit.burst = burst;
  tokens = Math.min(tokens, burst);
}

async function acquireToken(): Promise<void> {
  const now = Date.now();
  const elapsedSec = (now - lastRefill) / 1000;
  // 补充令牌（这一步与下面的扣减之间不能有 await，否则并发下会超发）
  tokens = Math.min(rateLimit.burst, tokens + elapsedSec * rateLimit.rps);
  lastRefill = now;

  if (tokens >= 1) {
    tokens -= 1;
    return;
  }

  const waitMs = Math.ceil(((1 - tokens) / rateLimit.rps) * 1000);
  await new Promise((r) => setTimeout(r, waitMs));
  return acquireToken();
}

// ── 客户端 ────────────────────────────────────────────────────

function parseCookieString(cookie: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0) map.set(trimmed.slice(0, eq).trim(), trimmed);
  }
  return map;
}

/**
 * 创建带 Cookie 管理的 HTTP 客户端
 * @param baseURL - 教务系统基础 URL (e.g. "https://jwgl.njtech.edu.cn")
 * @param initialCookie - 登录后的 cookie 字符串（登录流程传空串，由 Set-Cookie 填充）
 */
export function createClient(baseURL: string, initialCookie = ""): HttpClient {
  const cookieMap = parseCookieString(initialCookie);

  const buildCookie = (): string => [...cookieMap.values()].join("; ");

  function absorbCookies(sc: string[] | undefined, map: Map<string, string>): void {
    if (!sc) return;
    for (const c of sc) {
      const kv = c.split(";")[0];
      const eq = kv.indexOf("=");
      if (eq > 0) map.set(kv.slice(0, eq).trim(), kv.trim());
    }
  }

  /** 单次请求（不含重定向跟随） */
  function once(url: URL, opts: HttpOptions & { method: string }): Promise<HttpResponse> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: HttpResponse) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const q = https.request(
        {
          method: opts.method,
          hostname: url.hostname,
          path: url.pathname + url.search,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Cookie: buildCookie(),
            Referer: baseURL,
            ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          },
        },
        (r) => {
          absorbCookies(r.headers["set-cookie"] as string[] | undefined, cookieMap);

          // 逐块 toString 会把跨 chunk 边界的 UTF-8 中文切成两半、变成 U+FFFD
          //（课名/教师名/通知正文全是中文），必须先攒 Buffer 再一次性解码
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            finish({
              status: r.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              headers: r.headers as Record<string, string | string[] | undefined>,
            }),
          );
        },
      );

      q.on("error", (e: Error) =>
        finish({
          status: 0,
          body: "",
          headers: {},
          error: `网络错误：${e.message}`,
          errorCode: "NETWORK",
          errorRetryable: true,
        }),
      );
      q.setTimeout(REQUEST_TIMEOUT_MS, () =>
        q.destroy(new Error(`请求超时（${REQUEST_TIMEOUT_MS}ms）`)),
      );

      if (opts.body) q.write(opts.body);
      q.end();
    });
  }

  async function req(urlPath: string, opts: HttpOptions = {}, hops = 0): Promise<HttpResponse> {
    await acquireToken();

    const method = opts.method || "GET";
    const resp = await once(new URL(urlPath, baseURL), { ...opts, method });

    const status = resp.status;
    if (status >= 300 && status < 400) {
      const location = resp.headers.location;
      const target = Array.isArray(location) ? location[0] : location;
      if (!target) {
        // 302 却不给 Location：正方会话失效的典型表现
        return {
          ...resp,
          error: `重定向 ${status} 缺少 Location（会话可能已失效）`,
          errorCode: "UPSTREAM",
          errorRetryable: false,
        };
      }
      if (hops >= MAX_REDIRECTS) {
        return {
          ...resp,
          error: `重定向次数超过上限（${MAX_REDIRECTS}）`,
          errorCode: "UPSTREAM",
          errorRetryable: false,
        };
      }
      const next = target.startsWith("http") ? target : baseURL + target;
      // 重定向后按浏览器行为降为 GET
      return req(next, { method: "GET" }, hops + 1);
    }

    if (status >= 500) {
      return {
        ...resp,
        error: `服务端错误 HTTP ${status}`,
        errorCode: "UPSTREAM",
        errorRetryable: true,
      };
    }

    return resp;
  }

  return { req: (p, o) => req(p, o), getCookie: buildCookie };
}

/**
 * 判断一次响应是否失败。调用方在解析 body 之前必须先过这一关——
 * 「拿不到」和「确认为空」是两件事，混为一谈就是误报的源头。
 */
export function httpFailure(resp: HttpResponse): string | null {
  if (resp.error) return resp.error;
  if (resp.status === 0) return "无响应（连接中断）";
  if (resp.status >= 500) return `服务端错误 HTTP ${resp.status}`;
  return null;
}

/**
 * 把失败响应构建成类型化错误（供抛异常风格的调用方使用）。
 * errorCode / errorRetryable 由传输层在失败点打标，重试决策不再靠文案。
 */
export function httpError(resp: HttpResponse): RaptorError | null {
  const failure = httpFailure(resp);
  if (failure === null) return null;
  const code = resp.errorCode ?? (resp.status === 0 ? "NETWORK" : "UPSTREAM");
  const retryable = resp.errorRetryable ?? (code === "NETWORK" || code === "UPSTREAM");
  // status===0 且无 error 字段的旧形态（理论上已不存在）按网络错误处理
  return new RaptorError(code, failure, { retryable });
}

// ── 统一重试 ──────────────────────────────────────────────────
// 之前重试散在 session（5 次线性）/ grades（3 次线性）/ webvpn（4 次验证码
// 驱动）各写各的循环；退避曲线与「什么值得重试」无法统一调整。

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  attempts?: number;
  /** 退避基数（毫秒），默认 1000 */
  baseDelayMs?: number;
  /** 退避上限（毫秒），默认 8000 */
  maxDelayMs?: number;
  /** linear: base*n（登录链用，与旧行为一致）；exponential: base*2^(n-1)（默认） */
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

// ── 统一 fetch 原语（走 global fetch 的模块共用）───────────────
// weather / news / attachments 各自维护超时与错误翻译的状况在此收敛：
// 超时/断网抛 RaptorError("NETWORK")，HTTP 状态由调用方按业务判断
// （jwc 的 483 拦截页需要读 body 签名，不能在这里一刀切 ok/!ok）。

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

/** 统一的抓取结果：ok=false 时必须把 error 如实上报给模型，不许降级成空列表 */
import type { FetchResult } from "./fetch-result";

export type { FetchResult };

/**
 * 抓取 + 解析的通用包装：传输失败直接短路，解析失败也区分成因。
 * @param fetch - 发请求
 * @param parse - 解析 body（只在传输成功时执行）
 */
export async function fetchJson<T>(
  fetch: () => Promise<HttpResponse>,
  parse: (body: string) => T,
): Promise<FetchResult<T>> {
  const resp = await fetch();
  const failure = httpFailure(resp);
  if (failure) return { ok: false, error: failure };
  try {
    return { ok: true, data: parse(resp.body) };
  } catch (e) {
    return {
      ok: false,
      error: `响应解析失败：${(e as Error).message.slice(0, 120)}（HTTP ${resp.status}，响应 ${resp.body.length} 字节）`,
    };
  }
}
