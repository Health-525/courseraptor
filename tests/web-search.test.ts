/**
 * 联网搜索模块测试（DeepSeek Search / Fetch API 客户端）
 *
 * 全程离线：fetch 注入替身，Key 解析是纯函数，坏网/坏 Key/坏响应这些分支
 * 不靠真联网验证。钉住的行为——
 * 1. 任何失败都是 { ok:false, error }：HTTP 错误按官方错误表翻成人话，
 *    绝不降级成空结果（否则模型会把「查询失败」说成「网上没有」）；
 * 2. Key 解析：供应商是 DeepSeek 时用当前 Key；切到别家时绝不拿别家 Key
 *    去请求 DeepSeek 端点（必然 401 还泄露 Key 归属），改用保存过的
 *    DeepSeek Key；
 * 3. 抓取正文超长截断，且 truncated 标记如实返回；
 * 4. 工具注册进 coreTools（模型按需调用）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块前设好数据目录（credentials/config 首次 load 即缓存；
// 每个测试文件是独立进程，不会污染其他用例）
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-websearch-"));
process.env.RAPTOR_DATA_DIR = dataDir;
process.env.RAPTOR_CREDENTIALS_FILE = path.join(dataDir, "credentials.enc");

const {
  resolveSearchKey,
  parseSearchResponse,
  parseFetchResponse,
  searchFailureMessage,
  searchWeb,
  fetchWebPage,
  FETCH_CONTENT_MAX_CHARS,
} = await import("../src/core/web-search");

// ── Key 解析（纯函数） ────────────────────────────────────────

test("Key 解析：供应商是 DeepSeek 时 env 最新值优先，其次 config 快照", () => {
  const r = resolveSearchKey({
    providerId: "deepseek",
    currentProviderKey: "sk-current",
    deepseekEnvKey: "sk-env",
    storedDeepSeekKey: "sk-stored",
  });
  assert.equal(r.key, "sk-env");
  assert.equal(r.source, "env");

  const r2 = resolveSearchKey({ providerId: "deepseek", currentProviderKey: "sk-current" });
  assert.deepEqual(r2, { key: "sk-current", source: "current" });
});

test("Key 解析：切到其他供应商时绝不拿别家 Key 请求 DeepSeek，改用保存过的 DeepSeek Key", () => {
  const r = resolveSearchKey({
    providerId: "zhenze",
    currentProviderKey: "sk-zhenze-key",
    storedDeepSeekKey: "sk-deepseek-saved",
  });
  assert.equal(r.key, "sk-deepseek-saved");
  assert.equal(r.source, "stored");

  // 没存过 DeepSeek Key 时兜底 shell 里的 DEEPSEEK_API_KEY
  const r2 = resolveSearchKey({
    providerId: "zhenze",
    currentProviderKey: "sk-zhenze-key",
    deepseekEnvKey: "sk-env-deepseek",
  });
  assert.deepEqual(r2, { key: "sk-env-deepseek", source: "env" });
});

test("Key 解析：全都没有时 source=unset，调用方据此给配置引导", () => {
  const r = resolveSearchKey({ providerId: "zhenze", currentProviderKey: "sk-zhenze-key" });
  assert.equal(r.key, "");
  assert.equal(r.source, "unset");
});

// ── 响应解析（纯函数） ────────────────────────────────────────

const SEARCH_FIXTURE = JSON.stringify({
  results: [
    {
      rerank_score: 1.8,
      title: "DeepSeek 发布 V4.1-Flash",
      url: "https://example.com/news/v41",
      snippet: "短摘要：新模型发布",
      summary: "长摘要：DeepSeek 于本周发布 V4.1-Flash，按 Flash 计费……",
      content: "",
      site_name: "Example News",
      site_icon: "https://example.com/icon.png",
      date: "2026-10-20T08:00:00Z",
      authority: 3,
    },
    { title: "缺 url 的坏条目应被跳过", snippet: "x" },
    { title: "极简条目", url: "https://example.com/bare" },
  ],
});

test("Search 响应解析：字段映射齐全，坏条目跳过不炸", () => {
  const hits = parseSearchResponse(SEARCH_FIXTURE);
  assert.equal(hits.length, 2);
  const first = hits[0];
  assert.equal(first?.title, "DeepSeek 发布 V4.1-Flash");
  assert.equal(first?.url, "https://example.com/news/v41");
  assert.equal(first?.summary?.startsWith("长摘要"), true);
  assert.equal(first?.siteName, "Example News");
  assert.equal(first?.date, "2026-10-20T08:00:00Z");
  assert.equal(first?.authority, 3);
  assert.equal(first?.rerankScore, 1.8);
  const bare = hits[1];
  assert.equal(bare?.snippet, undefined);
});

test("Search 响应解析：空 results 是合法的「没搜到」，缺字段/坏 JSON 抛错", () => {
  assert.deepEqual(parseSearchResponse('{"results": []}'), []);
  assert.throws(() => parseSearchResponse('{"foo": 1}'), /缺少 results/);
  assert.throws(() => parseSearchResponse("not json"), /JSON/);
});

test("Fetch 响应解析：content 必须是字符串，title 可空", () => {
  const page = parseFetchResponse(JSON.stringify({ title: "标题", content: "# 正文" }));
  assert.deepEqual(page, { title: "标题", content: "# 正文" });
  const noTitle = parseFetchResponse(JSON.stringify({ title: "", content: "x" }));
  assert.equal(noTitle.title, "");
  assert.throws(() => parseFetchResponse('{"title": "t"}'), /缺少 content/);
});

// ── 错误翻译（纯函数，对照官方错误表） ────────────────────────

test("HTTP 错误按官方错误表翻成人话，OpenAI 错误体的 message 附在后面", () => {
  assert.match(searchFailureMessage(401, ""), /Key 无效/);
  assert.match(searchFailureMessage(402, ""), /余额不足/);
  assert.match(searchFailureMessage(429, ""), /频繁/);
  assert.match(searchFailureMessage(503, ""), /服务端错误/);
  assert.match(
    searchFailureMessage(400, JSON.stringify({ error: { message: "query too long" } })),
    /query too long/,
  );
});

// ── 网络（注入 fetch） ────────────────────────────────────────

/** 假 fetch：记下请求参数，按预置路由回响应 */
function stubFetch(routes: Array<{ status?: number; body?: string; throw?: Error }>) {
  const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
  const impl = async (url: string, init?: Record<string, unknown>) => {
    calls.push({ url, init });
    const route = routes[Math.min(calls.length - 1, routes.length - 1)];
    if (!route) throw new Error(`未预置第 ${calls.length} 次请求`);
    if (route.throw) throw route.throw;
    return {
      status: route.status ?? 200,
      text: async () => route.body ?? "",
    };
  };
  return { impl, calls };
}

test("searchWeb：成功路径带 Bearer 认证、count 压到上限内，结果如实映射", async () => {
  const stub = stubFetch([{ body: SEARCH_FIXTURE }]);
  const r = await searchWeb("DeepSeek 最新模型", {
    count: 50,
    key: "sk-test",
    fetchImpl: stub.impl,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.hits.length, 2);

  const call = stub.calls[0];
  assert.equal(call?.url, "https://api.deepseek.com/v1/tools/search");
  const headers = call?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(String(call?.init?.body)) as { query: string; count: number };
  assert.equal(body.query, "DeepSeek 最新模型");
  assert.equal(body.count, 20, "count=50 应压到上限 20");
});

test("searchWeb：HTTP 401 / 网络错误 / 坏 JSON 都是 ok:false 的人话错误，不降级成空结果", async () => {
  const key = { key: "sk-test" };
  const r401 = await searchWeb("q", {
    ...key,
    fetchImpl: stubFetch([{ status: 401, body: "{}" }]).impl,
  });
  assert.equal(r401.ok, false);
  if (!r401.ok) assert.match(r401.error, /Key 无效/);

  const rNet = await searchWeb("q", {
    ...key,
    fetchImpl: stubFetch([{ throw: new Error("ECONNRESET") }]).impl,
  });
  assert.equal(rNet.ok, false);
  if (!rNet.ok) assert.match(rNet.error, /网络错误/);

  const rBad = await searchWeb("q", { ...key, fetchImpl: stubFetch([{ body: "not json" }]).impl });
  assert.equal(rBad.ok, false);
  if (!rBad.ok) assert.match(rBad.error, /解析失败/);
});

test("searchWeb：没配 Key 与超长查询在发请求前就拦下", async () => {
  const noKey = await searchWeb("q", { key: "" });
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.match(noKey.error, /未配置 DeepSeek API Key/, "要给配置引导而不是静默失败");

  const tooLong = await searchWeb("x".repeat(129), { key: "sk-test" });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.error, /128/);
});

test("fetchWebPage：成功读取、超长截断并如实标记 truncated", async () => {
  const okStub = stubFetch([
    { body: JSON.stringify({ title: "文档页", content: "# Hello\n正文".repeat(3000) }) },
  ]);
  const r = await fetchWebPage("https://example.com/doc", {
    key: "sk-test",
    fetchImpl: okStub.impl,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.title, "文档页");
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.content.length, FETCH_CONTENT_MAX_CHARS);
  assert.equal(okStub.calls[0]?.url, "https://api.deepseek.com/v1/tools/fetch");
});

test("fetchWebPage：非法 URL / 非 http 协议 / 内嵌凭据 / HTTP 404 都被拦", async () => {
  const key = { key: "sk-test" };
  const bad = await fetchWebPage("not-a-url", key);
  assert.equal(bad.ok, false);

  const ftp = await fetchWebPage("ftp://example.com/f", key);
  assert.equal(ftp.ok, false);
  if (!ftp.ok) assert.match(ftp.error, /http/);

  const cred = await fetchWebPage("https://user:pass@example.com/f", key);
  assert.equal(cred.ok, false);
  if (!cred.ok) assert.match(cred.error, /用户名密码/);

  const notFound = await fetchWebPage("https://example.com/none", {
    ...key,
    fetchImpl: stubFetch([{ status: 404, body: "{}" }]).impl,
  });
  assert.equal(notFound.ok, false);
  if (!notFound.ok) assert.match(notFound.error, /404/);
});

// ── 工具层接线 ────────────────────────────────────────────────

test("工具层接线：web_search / web_fetch 注册进 coreTools", async () => {
  const { coreTools } = await import("../src/core/tools");
  assert.ok(coreTools.web_search, "web_search 应注册");
  assert.ok(coreTools.web_fetch, "web_fetch 应注册");
});
