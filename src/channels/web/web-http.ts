/** 本机 HTTP 防线与响应基建：Host/Origin/CSRF 三道门、Obsidian CORS、CSRF 注入、
 *  json 输出与实际监听端口的存取器（listen() 写、/api/localapi 读）。 */

import crypto from "node:crypto";
import type http from "node:http";
import { localApiToken, OBSIDIAN_ORIGIN } from "../../core/local-api";

// ── 本机请求防线：Host / Origin / CSRF token 三道门 ───────────

/** 每次进程启动随机生成，只嵌进本实例渲染的页面 meta——外站跨域读不到 */
const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");

/** 实际监听端口（Host 校验要知道本服务到底跑在哪个口上） */
let listenPort = 0;

/** listen() 绑定成功后回写实际端口（跨模块写入口；读侧见 getListenPort） */
export function setListenPort(port: number): void {
  listenPort = port;
}

/** GET /api/localapi 读取实际端口（设置页「Obsidian 插件」连接检测用） */
export function getListenPort(): number {
  return listenPort;
}

/**
 * 恶意网页借浏览器发请求的几条路逐一堵死：
 * 1) Host 不是本机地址 → 403（DNS rebinding：外站域名解析到 127.0.0.1 冒充同源）；
 * 2) 带 Origin 且不是本服务/Obsidian → 403（跨站 fetch：text/plain 免预检直达，
 *    浏览器只拦读不拦发）；
 * 3) 写请求必须携带本服务页面签发的 CSRF token 或本地 API 令牌 → 403。
 * 返回 true 表示已写完拒绝响应，调用方直接 return。
 *
 * app://obsidian.md 是 Obsidian 渲染进程的私有 origin，浏览器里的网页发不出
 * 这个值，放进白名单不会给恶意网页开门；它携带的写请求仍须过第 3 道门
 * （插件持本地 API 令牌）。
 */
export function requestForbidden(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  const host = String(req.headers.host ?? "").toLowerCase();
  const localHosts = new Set([`127.0.0.1:${listenPort}`, `localhost:${listenPort}`]);
  if (!localHosts.has(host)) {
    json(res, { error: "拒绝访问：请求目标不是本机服务" }, 403);
    return true;
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const localOrigins = new Set([
      `http://127.0.0.1:${listenPort}`,
      `http://localhost:${listenPort}`,
      OBSIDIAN_ORIGIN,
    ]);
    if (!localOrigins.has(origin)) {
      json(res, { error: "拒绝访问：请求不是来自本服务页面" }, 403);
      return true;
    }
  }
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const apiToken = req.headers["x-raptor-token"];
    const hasApiToken = typeof apiToken === "string" && apiToken === localApiToken();
    if (req.headers["x-csrf-token"] !== CSRF_TOKEN && !hasApiToken) {
      json(res, { error: "拒绝访问：缺少有效令牌，请从本服务页面操作" }, 403);
      return true;
    }
  }
  return false;
}

/**
 * Obsidian 插件在渲染进程里走浏览器 fetch（Obsidian 的 requestUrl 不支持
 * 流式读响应，聊天 SSE 用不了），跨源请求要 CORS 头才读得到响应。这里只对
 * app://obsidian.md 开：恶意网页的 Origin 不同，依然读不到任何响应（发得
 * 出、读不进，与现状一致）。返回 true 表示这是预检请求、已代答 204。
 */
export function applyObsidianCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.headers.origin !== OBSIDIAN_ORIGIN) return false;
  res.setHeader("Access-Control-Allow-Origin", OBSIDIAN_ORIGIN);
  res.setHeader("Vary", "Origin");
  if ((req.method ?? "").toUpperCase() === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, x-csrf-token, x-raptor-token",
      "access-control-max-age": "600",
    });
    res.end();
    return true;
  }
  return false;
}

/**
 * 给页面注入 CSRF 引导：meta 携带 token + 包一层 window.fetch，
 * 页面自身的写请求自动带上 x-csrf-token（三个页面共用，页面代码零改动）。
 * 演示服务不注入：那边没有敏感状态，页面拿不到 meta 就不带头。
 */
export function withCsrf(html: string): string {
  const bootstrap = [
    `<meta name="csrf-token" content="${CSRF_TOKEN}">`,
    "<script>",
    "(function () {",
    "  'use strict';",
    "  var meta = document.querySelector('meta[name=\"csrf-token\"]');",
    "  var token = meta && meta.content;",
    "  if (!token) return;",
    "  var raw = window.fetch.bind(window);",
    "  window.fetch = function (input, init) {",
    "    init = init ? Object.assign({}, init) : {};",
    "    var method = String(init.method || (input && input.method) || 'GET').toUpperCase();",
    "    if (method === 'GET' || method === 'HEAD') return raw(input, init);",
    "    var headers = new Headers(init.headers || (input && input.headers) || {});",
    "    if (!headers.has('x-csrf-token')) headers.set('x-csrf-token', token);",
    "    init.headers = headers;",
    "    return raw(input, init);",
    "  };",
    "})();",
    "</script>",
  ].join("\n");
  // 函数替换避免 token/脚本内容里出现 $ 序列被误当替换模式
  return html.replace("</head>", () => `${bootstrap}\n</head>`);
}

export function json(res: http.ServerResponse, obj: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
