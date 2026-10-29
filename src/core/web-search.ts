/**
 * DeepSeek 联网搜索 —— 官方 Search / Fetch API 客户端
 *
 * 为什么是独立端点而不是 chat completions 的内置 web_search 工具：
 * DeepSeek 官方已把联网能力拆成独立的 Search / Fetch API（自研搜索引擎，
 * POST /v1/tools/search 与 /v1/tools/fetch），查询词、条数、是否读全文都
 * 由调用方控制——做成 agent 工具后模型按需调用，与项目「模型驱动工具」的
 * 架构一致，且不依赖 @ai-sdk/deepseek 对服务端工具的封装进度。
 *
 * 三条约束（对齐 weather.ts 的契约）：
 *
 * 1. 「拿不到」≠「没搜到」。超时、HTTP 错误、Key 缺失一律走
 *    { ok:false, error }，绝不返回空的 results——否则模型会把「查询失败」
 *    说成「网上没有相关信息」。
 * 2. 解析函数与网络函数分开：前者是纯函数可离线单测，后者的 fetch 可注入。
 * 3. Key 实时解析（每次调用现取）：与 llm.ts 的「保存 Key 即热生效」语义
 *    一致，设置面板里换 Key 不需要重建 agent。
 *
 * 计费口径（DeepSeek 侧）：按成功请求计费（$0.75/千次），HTTP 200 且结果
 * 非空才算成功；失败与空结果不计费。搜索 QPS 100 / 抓取 QPS 25（账户级）。
 * 提示词已约束模型一次一个聚焦查询、不为同一问题反复搜索。
 */

import { config, effectiveProviderKeys } from "./config";
import { loadCredentialsStore } from "./credentials";
import type { FetchResult } from "./fetch-result";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
/** 搜索请求超时：官方 QPS 100、常规秒级返回，20s 足够覆盖慢查询 */
const SEARCH_TIMEOUT_MS = 20_000;
/** 抓取请求超时：目标站点 body 读取可能慢（官方 408 也提示等待重试），放宽到 45s */
const FETCH_TIMEOUT_MS = 45_000;
/** 单条结果数上限：官方允许 50，压到 20 防止一次搜索把上下文塞满 */
const MAX_COUNT = 20;
/** 抓取正文截断上限（字符）：喂给模型的上下文预算 */
export const FETCH_CONTENT_MAX_CHARS = 20_000;

// ── Key 解析 ──────────────────────────────────────────────────

export interface DeepSeekSearchKeyInputs {
  /** 当前模型供应商 id（deepseek 时当前 Key 就是 DeepSeek Key） */
  providerId: string;
  /** 当前供应商的 Key（config.deepseekApiKey，历史名、实为「当前供应商 Key」） */
  currentProviderKey: string;
  /** 进程环境里的 DEEPSEEK_API_KEY（保存 Key 的路径会热写它） */
  deepseekEnvKey?: string;
  /** 凭证库里按厂商保存的 DeepSeek Key（providerKeys.deepseek） */
  storedDeepSeekKey?: string;
}

export type DeepSeekSearchKeySource = "env" | "current" | "stored" | "unset";

/**
 * 纯函数：选出调用 Search API 的 Key。
 *
 * 当前供应商是 DeepSeek 时，env 里的 DEEPSEEK_API_KEY 最新（设置面板保存
 * Key 即热写 env，config 单例可能滞后）优先于 config 快照；切到其他供应商
 * 时当前 Key 属于别家端点、绝不能拿去请求 DeepSeek，改用保存过的 DeepSeek
 * Key，最后兜底 shell 里配的 DEEPSEEK_API_KEY。
 */
export function resolveSearchKey(input: DeepSeekSearchKeyInputs): {
  key: string;
  source: DeepSeekSearchKeySource;
} {
  const env = input.deepseekEnvKey?.trim() ?? "";
  if (input.providerId === "deepseek") {
    if (env) return { key: env, source: "env" };
    const current = input.currentProviderKey.trim();
    if (current) return { key: current, source: "current" };
  }
  const stored = input.storedDeepSeekKey?.trim() ?? "";
  if (stored) return { key: stored, source: "stored" };
  if (env) return { key: env, source: "env" };
  return { key: "", source: "unset" };
}

/** 运行时解析：每次调用现取（保存 Key 后无需重启即生效） */
export function deepSeekSearchKey(): { key: string; source: DeepSeekSearchKeySource } {
  return resolveSearchKey({
    providerId: config.providerId,
    currentProviderKey: config.deepseekApiKey,
    deepseekEnvKey: process.env.DEEPSEEK_API_KEY,
    storedDeepSeekKey: effectiveProviderKeys(loadCredentialsStore()).keys.deepseek,
  });
}

/** 没配 Key 时给模型的话术：指路设置面板，别让它编「最新」信息 */
export const MISSING_KEY_ERROR =
  "未配置 DeepSeek API Key：联网搜索走 DeepSeek 官方 Search API，需要一把 DeepSeek Key（对话供应商就是 DeepSeek 时与对话共用同一把；切到其他供应商时用之前保存过的 DeepSeek Key）。请在网页「功能大厅 → 设置」里配置后重试。请如实告知用户暂时搜不了，不要凭训练数据里的印象充当最新信息。";

// ── 类型 ──────────────────────────────────────────────────────

export interface WebSearchHit {
  title: string;
  url: string;
  /** ~100-200 字的短摘要（面向展示） */
  snippet?: string;
  /** ~600-800 字的长摘要（面向模型，组织回答以它为准） */
  summary?: string;
  siteName?: string;
  /** 发布时间（RFC 3339 UTC），接口可能给 null */
  date?: string;
  /** 站点权威度 0-4（-1 未知）；≥3 高可信 */
  authority?: number;
  /** 相关度 rerank 分 0-3；≥1.5 高相关 */
  rerankScore?: number;
}

export interface WebFetchPage {
  title: string;
  content: string;
  truncated: boolean;
}

// ── 纯解析函数 ────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Search 响应 → 结果列表。坏 JSON / 缺 results 字段直接抛，由调用方转 { ok:false } */
export function parseSearchResponse(body: string): WebSearchHit[] {
  const json = JSON.parse(body) as Record<string, unknown>;
  const results = json.results;
  if (!Array.isArray(results)) throw new Error("响应缺少 results 字段");
  const hits: WebSearchHit[] = [];
  for (const item of results) {
    const o = (item ?? {}) as Record<string, unknown>;
    const title = asString(o.title);
    const url = asString(o.url);
    if (!title || !url) continue;
    const authority = Number(o.authority);
    const rerank = Number(o.rerank_score);
    hits.push({
      title,
      url,
      snippet: asString(o.snippet),
      summary: asString(o.summary),
      siteName: asString(o.site_name),
      date: asString(o.date),
      authority: Number.isFinite(authority) ? authority : undefined,
      rerankScore: Number.isFinite(rerank) ? rerank : undefined,
    });
  }
  return hits;
}

/** Fetch 响应 → 页面正文。坏 JSON / 缺 content 抛错（内容为空串是合法的） */
export function parseFetchResponse(body: string): { title: string; content: string } {
  const json = JSON.parse(body) as Record<string, unknown>;
  if (typeof json.content !== "string") throw new Error("响应缺少 content 字段");
  return { title: typeof json.title === "string" ? json.title : "", content: json.content };
}

// ── HTTP ──────────────────────────────────────────────────────

/** 注入点：真实 fetch 或测试替身。init 只承诺这四个字段，返回最小 Response 形状即可 */
export type SearchFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/** OpenAI 兼容错误体（{error:{message}}）里抠一句人话，抠不到给空串 */
function apiErrorMessage(body: string): string {
  try {
    const msg = (JSON.parse(body) as { error?: { message?: unknown } })?.error?.message;
    return typeof msg === "string" ? msg.slice(0, 120) : "";
  } catch {
    return "";
  }
}

/** HTTP 状态 → 面向用户的中文错误（对照官方 Search/Fetch API 错误表） */
export function searchFailureMessage(status: number, body: string): string {
  const detail = apiErrorMessage(body);
  const suffix = detail ? `：${detail}` : "";
  if (status === 400) return `请求被拒绝（400）${suffix}。检查查询词长度与格式（1-128 字）`;
  if (status === 401) return "DeepSeek API Key 无效（401），请到网页设置里核对 Key";
  if (status === 402) return "DeepSeek 账户余额不足（402），请到开放平台充值";
  if (status === 403) return `目标站点拒绝抓取（403）${suffix}`;
  if (status === 404) return `目标页面没有可读内容（404）${suffix}`;
  if (status === 408) return "读取目标页面超时（408），稍等可重试一次";
  if (status === 429) return "搜索请求太频繁（429），稍等再试";
  if (status >= 500) return `DeepSeek 服务端错误（${status}），稍等可重试一次`;
  return `HTTP ${status}${suffix}`;
}

/** POST JSON + 超时；传输失败与 HTTP 错误统一翻成 FetchResult 的 error 分支 */
async function postJson(
  url: string,
  payload: Record<string, unknown>,
  key: string,
  fetchImpl: SearchFetch,
  timeoutMs: number,
): Promise<FetchResult<string>> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.status === 200) return { ok: true, data: text };
    return { ok: false, error: searchFailureMessage(res.status, text) };
  } catch (e) {
    const err = e as Error;
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return { ok: false, error: `请求超时（${Math.round(timeoutMs / 1000)}s）：${url}` };
    }
    return { ok: false, error: `网络错误：${err?.message ?? String(e)}` };
  }
}

// ── 对外入口 ──────────────────────────────────────────────────

export interface SearchWebOptions {
  /** 结果条数 1-20（官方允许 50，这里压上限护上下文），默认 8 */
  count?: number;
  fetchImpl?: SearchFetch;
  /** 覆盖 Key 解析（测试用）；缺省走 deepSeekSearchKey() */
  key?: string;
}

/**
 * 联网搜索。失败一律 { ok:false, error }，不降级成空结果。
 */
export async function searchWeb(
  query: string,
  opts: SearchWebOptions = {},
): Promise<FetchResult<{ query: string; hits: WebSearchHit[] }>> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, error: "搜索词为空" };
  if (trimmed.length > 128) return { ok: false, error: "搜索词超过 128 字上限（官方限制）" };

  const key = opts.key ?? deepSeekSearchKey().key;
  if (!key) return { ok: false, error: MISSING_KEY_ERROR };

  const count = Math.max(1, Math.min(MAX_COUNT, Math.round(opts.count ?? 8)));
  const resp = await postJson(
    SEARCH_URL,
    { query: trimmed, count },
    key,
    opts.fetchImpl ?? fetch,
    SEARCH_TIMEOUT_MS,
  );
  if (!resp.ok) return resp;
  try {
    return { ok: true, data: { query: trimmed, hits: parseSearchResponse(resp.data) } };
  } catch (e) {
    return {
      ok: false,
      error: `搜索响应解析失败：${(e as Error).message.slice(0, 120)}（响应 ${resp.data.length} 字节）`,
    };
  }
}

export interface FetchWebPageOptions {
  fetchImpl?: SearchFetch;
  key?: string;
}

/**
 * 抓取单个网页正文（Markdown）。超长正文截断到 FETCH_CONTENT_MAX_CHARS。
 * URL 形状校验与官方约束对齐：http/https、带主机、不含内嵌用户名密码。
 */
export async function fetchWebPage(
  url: string,
  opts: FetchWebPageOptions = {},
): Promise<FetchResult<WebFetchPage>> {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `不是合法的 URL：${trimmed.slice(0, 100)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "只支持 http/https 链接" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "链接里内嵌了用户名密码，官方 API 拒绝此类地址" };
  }

  const key = opts.key ?? deepSeekSearchKey().key;
  if (!key) return { ok: false, error: MISSING_KEY_ERROR };

  const resp = await postJson(
    FETCH_URL,
    { url: trimmed },
    key,
    opts.fetchImpl ?? fetch,
    FETCH_TIMEOUT_MS,
  );
  if (!resp.ok) return resp;
  try {
    const page = parseFetchResponse(resp.data);
    const truncated = page.content.length > FETCH_CONTENT_MAX_CHARS;
    return {
      ok: true,
      data: {
        title: page.title,
        content: truncated ? page.content.slice(0, FETCH_CONTENT_MAX_CHARS) : page.content,
        truncated,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `网页响应解析失败：${(e as Error).message.slice(0, 120)}（响应 ${resp.data.length} 字节）`,
    };
  }
}
