/**
 * 网页对话窗口 — 浏览器里直接和 Agent 聊
 *
 * 终端 TUI 之外的第二对话入口：随主程序自动启动，地址显示在欢迎卡片
 * 下方，浏览器打开即聊。单页零依赖（Node 内置 http + 原生前端），
 * 只绑 127.0.0.1 不暴露局域网，端口默认 3210（RAPTOR_WEB_PORT 可改）。
 *
 * 界面是「红头档案」编辑部风：暖纸底 + 墨色字 + 单一朱砂红，楷体报头、
 * 等宽小字数据行、圆形印章徽章。设计令牌在 chat-page.ts 的 CSS :root。
 *
 * 协议：POST /api/chat 用 SSE 流式回传（text=文本增量 / think=思考过程增量
 * 与段末标记 / tool=工具卡片 / err=错误 / end=结束并携带 sid），与行内 TUI
 * 消费的是同一个 agent.fullStream。
 * 多会话历史由 chat-sessions.ts 落盘（data/chat-sessions.json），重启不丢；
 * 每轮把该会话最后 40 条转成 ModelMessage 传给 agent，多轮上下文完整。
 *
 * 本机防线（防「恶意网页借用户浏览器之手」的 CSRF/DNS rebinding）：
 * 1) Host 必须是本机地址——挡域名解析到 127.0.0.1 冒充同源；
 * 2) 带 Origin 的请求必须是本服务自己——挡跨站 fetch（text/plain 等
 *    「简单请求」不经预检直达，浏览器只拦读不拦发）；
 * 3) 写请求必须带 CSRF token——token 只嵌在本服务渲染的页面 meta 里，
 *    外站跨域读不到，伪造不出合法写请求（jsonBody 另拒非 JSON 类型）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelMessage } from "ai";
import { attachmentStats, clearAttachments } from "../attachment-store";
import { type AttachmentResult, openLocalFile } from "../attachments";
import {
  appendRound,
  contextMessages,
  DEFAULT_ID,
  deleteSession,
  getSession,
  listSessions,
  readSessions,
  resetAll,
  setAutoTitle,
  updateSession,
} from "../chat-sessions";
import { config } from "../config";
import { loadCredentialsStore, saveCredentialsStore } from "../credentials";
import { generatedDir } from "../document/save";
import { loadGradesCache } from "../grades-cache";
import { fetchJwcNews } from "../jwgl/news";
import { getCookie } from "../jwgl/session";
import { clearKnowledge, deleteKnowledge, knowledgeStats, listKnowledge } from "../knowledge";
import { loadUserGrade } from "../memory/longterm";
import {
  allowedModelIds,
  cachedModelOptions,
  invalidateModelCache,
  listModelOptions,
  validateModelChoice,
} from "../models";
import {
  getDeepSeekKeyStatus,
  getQQBotStatus,
  setDeepSeekApiKey,
  setQQBotCredentials,
} from "../onboarding";
import { isInsideDir } from "../paths";
import {
  activePomodoro,
  cancelPomodoro,
  listPomodoros,
  type PomodoroView,
  toView,
} from "../pomodoro";
import { relevanceOf } from "../tools/news";
import {
  addReminder,
  clearReminders,
  clearUploads,
  deleteReminder,
  deleteUpload,
  getUploads,
  listReminders,
  MAX_UPLOAD_BYTES,
  reminderIcs,
  saveUpload,
  updateReminder,
  type WebUpload,
  workspaceStats,
} from "../workspace-data";
import { chatPage } from "./chat-page";
import { knowledgePage } from "./knowledge-page";
import { effectiveQuickQuestions, normalizeQuickQuestions } from "./quick-questions";
import { cleanTitle, type TitleMaker } from "./session-titles";
import { buildTodayBrief } from "./today-brief";
import { todayPage } from "./today-page";

/** 前端 Markdown 渲染器（marked 的 UMD 构建，静态吐给浏览器） */
const MARKED_UMD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
  "marked",
  "lib",
  "marked.umd.js",
);

/** 项目 logo（随仓库放在 docs/）：浏览器标签页图标与首屏那枚印章共用同一张 */
const LOGO_PNG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "courseraptor-logo.png",
);

/** 静态资源进程启动后不会变，读一次常驻内存即可——请求路径上不再碰盘，
 * 同进程还挂着 SSE 流式对话，同步 IO 阻塞事件循环会放大流式延迟 */
const staticCache = new Map<string, Buffer | null>();

function loadStaticOnce(absolutePath: string): Buffer | null {
  if (!staticCache.has(absolutePath)) {
    try {
      staticCache.set(absolutePath, fs.readFileSync(absolutePath));
    } catch {
      // 读取失败也缓存住（null），避免后续请求反复重试丢盘
      staticCache.set(absolutePath, null);
    }
  }
  return staticCache.get(absolutePath) ?? null;
}

interface ScoredNewsItem {
  title: string;
  date: string;
  category: string | undefined;
  relevance: "high" | "medium" | "low";
  relevanceReason: string | undefined;
  url: string;
  /** 官网设置了访问权限的文章：原文页匿名打开是「您无权访问此页面」 */
  restricted: boolean | undefined;
}

interface ScoredNewsSnapshot {
  items: ScoredNewsItem[];
  gradeBasis: string | null;
  fetchedAt: number;
}

/**
 * 教务处通知的服务端缓存：官网三页现场抓取要数秒，功能大厅每次
 * 开面板都会打一次 /api/news，5 分钟内复用同一份快照即可。
 * 空结果与异常一律不缓存——不把网络抖动固化成「近期没有通知」。
 * in-flight 复用挡住并发请求下的重复抓取。
 */
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;
let newsCache: ScoredNewsSnapshot | null = null;
let newsInflight: Promise<ScoredNewsSnapshot> | null = null;

async function scoredNewsSnapshot(): Promise<ScoredNewsSnapshot> {
  if (newsCache && Date.now() - newsCache.fetchedAt < NEWS_CACHE_TTL_MS) {
    return newsCache;
  }
  if (newsInflight) return newsInflight;
  newsInflight = (async () => {
    const items = await fetchJwcNews([], 30);
    const grade = await loadUserGrade();
    const scored = items.slice(0, 10).map((i) => {
      const { level, reason } = relevanceOf(i.title, grade);
      return {
        title: i.title,
        date: i.date,
        category: i.category,
        relevance: level,
        relevanceReason: reason,
        url: i.url,
        restricted: i.restricted ?? undefined,
      };
    });
    // 只有一页都没有才视为「本轮无数据」不缓存；部分成功的结果照常缓存
    const snapshot: ScoredNewsSnapshot = {
      items: scored,
      gradeBasis: grade,
      fetchedAt: Date.now(),
    };
    if (scored.length > 0) newsCache = snapshot;
    return snapshot;
  })();
  try {
    return await newsInflight;
  } finally {
    newsInflight = null;
  }
}

/** 与 agent.ts 的 ToolLoopAgent 对齐的最小接口：网页端每轮都带全量历史，
 * 所以只声明 messages 分支（ToolLoopAgent.stream 的 prompt/messages 是
 * 二选一的判别联合，两边都可选反而匹配不上） */
export interface ChatStreamableAgent {
  stream(options: {
    messages: ModelMessage[];
    abortSignal?: AbortSignal;
  }): PromiseLike<{ fullStream: AsyncIterable<unknown> }>;
}

let agentProvider: (() => ChatStreamableAgent | null) | null = null;

/** 主程序在 agent 就绪后注入；网页先于 agent 可用也无妨，来消息时才取 */
export function setChatAgent(agent: ChatStreamableAgent | null): void {
  agentProvider = agent ? () => agent : null;
}

/** 换模型后重建 agent 的钩子（模型在组装时绑定，不重建就只能重启） */
let agentRefresher: (() => Promise<void>) | null = null;

export function setChatAgentRefresher(refresh: () => Promise<void>): void {
  agentRefresher = refresh;
}

// ── 会话自动命名：落盘后让模型把「首问截断」换成像样的标题 ──────

/** 主程序注入的真实命名实现；null 时（测试/agent 未装配）自动命名静默关闭 */
let titleMaker: TitleMaker | null = null;

export function setTitleMaker(maker: TitleMaker | null): void {
  titleMaker = maker;
}

/**
 * 一轮完整落盘后调用：会话尚未定题（titleSet 未置）才交给模型命名。
 * 尽力而为——maker 缺席、联网失败、输出不合形状都直接放弃，标题保持
 * 首问兜底，绝不影响对话主流程，也不抛错打断落盘链。
 */
async function maybeAutoTitle(sessionId: string): Promise<void> {
  if (!titleMaker) return;
  try {
    const s = getSession(sessionId);
    if (!s || s.titleSet || !s.messages.length) return;
    const raw = await titleMaker({
      messages: s.messages.map(({ role, text }) => ({ role, text })),
    });
    const title = cleanTitle(raw);
    if (title) setAutoTitle(sessionId, title);
  } catch {
    // 命名失败无关紧要：兜底标题还在
  }
}

/** 重建串行链：连续保存两次模型也不会并发建两个 agent */
let refreshChain: Promise<string> = Promise.resolve("");

/** 重建对话引擎，返回给用户看的生效说明 */
async function refreshChatAgent(): Promise<string> {
  if (!agentRefresher) return "；本次未能即时切换，重启后生效";
  try {
    await agentRefresher();
    return "；下一条消息起生效（终端界面重启后生效）";
  } catch {
    // 重建失败时旧 agent 仍在位，对话不会中断
    return "；即时切换失败，旧模型继续可用，重启后生效";
  }
}

let runningUrl: string | null = null;
let starting: Promise<string | null> | null = null;

/** 已在跑就直接返回地址（TUI 卡片/行内模式来回切也不会重复起服务） */
export function getWebUrl(): string | null {
  return runningUrl;
}

/** 启动网页服务；失败返回 null 不抛错（网页挂了不影响终端对话） */
export function startChatWeb(): Promise<string | null> {
  // index.ts 与欢迎面板可能并发调用：必须共享同一个进行中的 Promise，
  // 否则两边各自 listen，首选端口冲突后会同时退到随机端口起两个服务
  if (runningUrl) return Promise.resolve(runningUrl);
  starting ??= doStart();
  return starting;
}

async function doStart(): Promise<string | null> {
  const preferred = Number(process.env.RAPTOR_WEB_PORT) || 3210;
  for (const port of [preferred, 0]) {
    // 第二轮 port=0：让系统挑一个空闲端口，首选端口被占也能起
    const url = await listen(port).catch(() => null);
    if (url) {
      runningUrl = url;
      return url;
    }
  }
  return null;
}

// ── QQ 凭证保存后的桥热启动 ─────────────────────────────────

/** 返回追加到保存结果里的说明文案；测试可注入替身避免真实连 QQ */
export type QQBridgeLauncher = () => Promise<string>;

let qqBridgeLauncher: QQBridgeLauncher | null = null;

/** 测试注入用：替换默认的桥热启动实现 */
export function setQQBridgeLauncher(fn: QQBridgeLauncher | null): void {
  qqBridgeLauncher = fn;
}

/** 未在跑则拉起；已在跑则沿用启动时的凭证（重启后切换），失败如实说明 */
async function defaultQQBridgeLauncher(): Promise<string> {
  const { isQQBridgeOnline, startQQBridge } = await import("../qq/bridge");
  if (isQQBridgeOnline()) {
    return "；QQ 桥已在线（沿用启动时的凭证），重启 raptor 后切换为新凭证";
  }
  try {
    const { createQQFileLogger } = await import("../qq/logger");
    // 20 秒没连上就先回话：桥后台继续尝试，凭证已加密保存
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("连接超时（20 秒）")), 20_000);
    });
    await Promise.race([startQQBridge({ logger: createQQFileLogger() }), timeout]);
    return "；QQ 桥已拉起，到 QQ 里给机器人发激活暗号即可开始使用";
  } catch (error) {
    return `；QQ 桥拉起失败：${oneLine(error instanceof Error ? error.message : String(error), 120)}。凭证已保存，可稍后重启 raptor 重试`;
  }
}

async function maybeStartQQBridge(): Promise<string> {
  return (qqBridgeLauncher ?? defaultQQBridgeLauncher)();
}

// ── 轮次串行化 ──────────────────────────────────────────────

/** 串行化：上一轮没跑完时新请求排队，避免并发把会话文件写花 */
let turnChain: Promise<void> = Promise.resolve();

// ── fullStream 事件（同 inline.ts 的宽松视图，字段按需取用）──────

interface StreamEvent {
  type: string;
  text?: string;
  delta?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

async function jsonBody(
  req: http.IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<Record<string, unknown>> {
  // 只认 application/json：text/plain 是 CORS「简单请求」的免预检类型，
  // 恶意网页能不经浏览器询问直接 POST 过来——统一在门口拒掉
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw new Error("CONTENT_TYPE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buf);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error("INVALID_JSON");
  }
}

const deltaOf = (p: StreamEvent): string => p.text ?? p.delta ?? "";

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 工具结果的一行摘要（同 inline.ts summarizeResult 的简化版） */
function summarizeResult(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return oneLine(output, 100);
  if (Array.isArray(output)) return `${output.length} 项`;
  if (typeof output !== "object") return oneLine(String(output), 60);
  const o = output as Record<string, unknown>;
  if (typeof o.error === "string") return `错误：${oneLine(o.error, 80)}`;
  const bits: string[] = [];
  for (const k of ["summary", "term", "gpa", "total"]) {
    if (o[k] !== undefined && o[k] !== null) bits.push(oneLine(String(o[k]), 48));
  }
  return bits.join(" · ");
}

/** 工具参数/结果的展开态预览：给独立工具卡片的 <pre> 用，封顶防刷屏 */
function previewJson(v: unknown, max = 1200): string {
  if (v == null) return "";
  let s: string;
  try {
    s = typeof v === "string" ? v : (JSON.stringify(v, null, 1) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}\n…（已截断）` : s;
}

function listen(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (requestForbidden(req, res)) return;
      void handle(req, res);
    });
    // unref：不让网页服务拖住进程退出——终端 UI 退出时主程序该走就走
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        listenPort = addr.port;
        resolve(`http://localhost:${addr.port}`);
      } else {
        reject(new Error("server address unavailable"));
      }
    });
  });
}

// ── 本机请求防线：Host / Origin / CSRF token 三道门 ───────────

/** 每次进程启动随机生成，只嵌进本实例渲染的页面 meta——外站跨域读不到 */
const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");

/** 实际监听端口（Host 校验要知道本服务到底跑在哪个口上） */
let listenPort = 0;

/**
 * 恶意网页借浏览器发请求的几条路逐一堵死：
 * 1) Host 不是本机地址 → 403（DNS rebinding：外站域名解析到 127.0.0.1 冒充同源）；
 * 2) 带 Origin 且不是本服务 → 403（跨站 fetch：text/plain 免预检直达，浏览器只拦读不拦发）；
 * 3) 写请求（POST/PATCH/PUT/DELETE）必须携带本服务页面签发的 CSRF token → 403。
 * 返回 true 表示已写完拒绝响应，调用方直接 return。
 */
function requestForbidden(req: http.IncomingMessage, res: http.ServerResponse): boolean {
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
    ]);
    if (!localOrigins.has(origin)) {
      json(res, { error: "拒绝访问：请求不是来自本服务页面" }, 403);
      return true;
    }
  }
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (req.headers["x-csrf-token"] !== CSRF_TOKEN) {
      json(res, { error: "拒绝访问：缺少有效令牌，请从本服务页面操作" }, 403);
      return true;
    }
  }
  return false;
}

/**
 * 给页面注入 CSRF 引导：meta 携带 token + 包一层 window.fetch，
 * 页面自身的写请求自动带上 x-csrf-token（三个页面共用，页面代码零改动）。
 * 演示服务不注入：那边没有敏感状态，页面拿不到 meta 就不带头。
 */
function withCsrf(html: string): string {
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

function json(res: http.ServerResponse, obj: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// ── 成品文件下载：只服务 data/generated，别处一律 404 ──────────

const FILE_MIME: Record<string, string> = {
  ".ics": "text/calendar; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** 工具产物路径是否确实落在 generated 目录内（与 QQ 桥 sendFile 同一道护栏） */
function insideGenerated(filePath: string): boolean {
  return isInsideDir(generatedDir(), filePath);
}

/** GET /files/ 的统一 404：明确 text/plain，绝不兜底吐 HTML 页面骗 200 */
function fileNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

/**
 * GET /files/<文件名>：下载本轮工具产出的成品（ics/文档）。
 * 文件名先 basename 再解析校验，路径穿越（../）到不了目录外。
 */
async function serveGeneratedFile(rawName: string, res: http.ServerResponse): Promise<void> {
  let name = "";
  try {
    name = path.basename(decodeURIComponent(rawName));
  } catch {
    // 半截百分号编码：当非法名处理
  }
  if (!name) {
    fileNotFound(res);
    return;
  }
  const root = path.resolve(generatedDir());
  const target = path.resolve(root, name);
  if (!isInsideDir(root, target)) {
    fileNotFound(res);
    return;
  }
  try {
    const buf = await fs.promises.readFile(target);
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) throw new Error("not a file");
    const mime = FILE_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
    // 文件名常含中文：ASCII 兜底 + RFC 5987 编码双写
    const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
    res.writeHead(200, {
      "content-type": mime,
      "content-length": buf.length,
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
    });
    res.end(buf);
  } catch {
    fileNotFound(res);
  }
}

/**
 * 从工具结果里提取可下载的成品（网页端下载按钮的数据源）。
 * 兼容两种返回形状：文档工具的顶层 {filename, path} 与
 * export_calendar 的 {file: {filename, filePath, bytes}}；
 * 路径不在 generated 目录内的一律不透出。
 */
/** 工具因凭证未配置而失败的口径：命中时 SSE 事件带 panel=settings，网页端自动推出设置面板 */
const NEED_SETUP_RE = /尚未配置|请先配置/;

function filesOfToolOutput(output: unknown): Array<{ name: string; size: number }> {
  if (typeof output !== "object" || output == null || Array.isArray(output)) return [];
  const o = output as Record<string, unknown>;
  const out: Array<{ name: string; size: number }> = [];
  const push = (name: unknown, p: unknown, size: unknown) => {
    if (typeof name !== "string" || !name) return;
    if (typeof p !== "string" || !insideGenerated(p)) return;
    out.push({ name, size: typeof size === "number" ? size : 0 });
  };
  push(o.filename, o.path, o.bytes);
  if (typeof o.file === "object" && o.file != null) {
    const f = o.file as Record<string, unknown>;
    push(f.filename, f.filePath, f.bytes);
  }
  return out;
}

/**
 * 从工具结果里提取新建的番茄钟（前端渲染实时倒计时卡片的数据源）。
 * 只有 start 带 fresh 标记的才透出——status/cancel 的同名 payload
 * 只给模型组话用，不画卡，避免查一次时间就多一张卡。
 */
function pomodoroOfToolOutput(output: unknown): PomodoroView | null {
  if (typeof output !== "object" || output == null || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  if (o.fresh !== true) return null;
  const p = o.pomodoro;
  if (typeof p !== "object" || p == null || Array.isArray(p)) return null;
  const v = p as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.endsAt !== "number" || typeof v.totalSec !== "number") {
    return null;
  }
  return v as unknown as PomodoroView;
}

const SESSIONS_PREFIX = "/api/sessions/";
/** 会话 id 白名单：uuid/十六进制/default。注意必须放行字母——无 sessionId
 * 的对话落 default 档，只收十六进制会让侧栏点击默认档被误判非法而 404 */
const SESSION_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const sidOf = (v: unknown): string =>
  typeof v === "string" && SESSION_ID_RE.test(v) ? v : DEFAULT_ID;

// ── 设置：教务账号 + DeepSeek Key（复用 /key 的「校验→热生效→加密落盘」）──

const SOURCE_LABEL: Record<string, string> = {
  env: "来自 .env",
  encrypted: "本机加密",
  unset: "未配置",
};

/** 给设置弹窗的状态：只有脱敏摘要，永远不回显密码与完整 Key */
function settingsPayload() {
  const ds = getDeepSeekKeyStatus();
  const qq = getQQBotStatus();
  return {
    jwgl: {
      configured: !!(config.jwglUsername && config.jwglPassword),
      username: config.jwglUsername || "",
      sourceLabel: SOURCE_LABEL[config.credentialsSource] ?? config.credentialsSource,
    },
    deepseek: { ...ds, sourceLabel: SOURCE_LABEL[ds.source] ?? ds.source },
    qq: { ...qq, sourceLabel: SOURCE_LABEL[qq.source] ?? qq.source },
    model: config.model,
    /** 下拉候选：只读同步缓存/兜底清单，联网刷新走 GET /api/models，别卡住弹窗 */
    models: cachedModelOptions(),
    /** 输入框上方「常用」快捷问题的当前生效清单（未自定义时为默认） */
    quickQuestions: effectiveQuickQuestions(loadCredentialsStore()?.webQuickQuestions),
  };
}

async function runDiagnostic(target: unknown): Promise<SettingResult> {
  if (target === "jwgl") {
    if (!config.jwglUsername || !config.jwglPassword) {
      return { field: "jwgl", ok: false, message: "请先保存完整的教务账号" };
    }
    try {
      await getCookie(true);
      return { field: "jwgl", ok: true, message: "教务系统连接正常，账号可以使用" };
    } catch (error) {
      return {
        field: "jwgl",
        ok: false,
        message: `教务连接失败：${oneLine(error instanceof Error ? error.message : String(error), 120)}`,
      };
    }
  }
  if (target === "deepseek") {
    if (!config.deepseekApiKey) {
      return { field: "deepseek", ok: false, message: "请先保存 API Key" };
    }
    const base = (config.deepseekBaseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
    try {
      const response = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${config.deepseekApiKey}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        return {
          field: "deepseek",
          ok: false,
          message:
            response.status === 401 || response.status === 403
              ? "模型连接失败：API Key 无效或没有权限"
              : `模型连接失败：服务返回 HTTP ${response.status}`,
        };
      }
      return { field: "deepseek", ok: true, message: `模型服务连接正常 · ${config.model}` };
    } catch (error) {
      return {
        field: "deepseek",
        ok: false,
        message: `模型连接失败：${oneLine(error instanceof Error ? error.message : String(error), 100)}`,
      };
    }
  }
  return { field: "unknown", ok: false, message: "未知的检测项目" };
}

function generatedStats(): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  try {
    for (const entry of fs.readdirSync(generatedDir(), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      count++;
      bytes += fs.statSync(path.join(generatedDir(), entry.name)).size;
    }
  } catch {
    // 目录尚未创建就是零占用
  }
  return { count, bytes };
}

function clearGenerated(): number {
  let removed = 0;
  const root = path.resolve(generatedDir());
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const target = path.resolve(root, entry.name);
      if (!isInsideDir(root, target)) continue;
      fs.rmSync(target, { force: true });
      removed++;
    }
  } catch {
    // 目录不存在或文件正被占用：保留未删项目
  }
  return removed;
}

function dataPayload() {
  const sessions = listSessions();
  const attachments = attachmentStats();
  const workspace = workspaceStats();
  return {
    sessions: { count: sessions.length, messages: sessions.reduce((n, s) => n + s.count, 0) },
    attachments: { count: attachments.count, bytes: attachments.totalBytes },
    uploads: workspace.uploads,
    generated: generatedStats(),
    reminders: workspace.reminders,
    knowledge: knowledgeStats(),
  };
}

interface SettingResult {
  field: string;
  ok: boolean;
  message: string;
}

function applySettings(body: Record<string, unknown>): {
  ok: boolean;
  results: SettingResult[];
  status: ReturnType<typeof settingsPayload>;
  modelChanged: boolean;
} {
  const results: SettingResult[] = [];
  const user = typeof body.jwglUsername === "string" ? body.jwglUsername.trim() : "";
  const pass = typeof body.jwglPassword === "string" ? body.jwglPassword : "";
  if (user || pass) {
    if (!user || !pass) {
      results.push({ field: "jwgl", ok: false, message: "学号与密码需要一起提交" });
    } else {
      saveCredentialsStore({ username: user, password: pass });
      config.jwglUsername = user;
      config.jwglPassword = pass;
      config.credentialsSource = "encrypted";
      results.push({ field: "jwgl", ok: true, message: "教务账号已加密保存，下次查询即生效" });
    }
  }
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (key) {
    const r = setDeepSeekApiKey(key);
    results.push({ field: "apiKey", ok: r.ok, message: r.message.replace(/^[✅❌]\s*/, "") });
    // 可用型号跟 Key 走：换 Key 后旧清单作废，下次打开弹窗重新拉
    if (r.ok) invalidateModelCache();
  }
  const qqPatch: { appId?: string; appSecret?: string; passcode?: string } = {};
  if (typeof body.qqAppId === "string" && body.qqAppId.trim()) qqPatch.appId = body.qqAppId.trim();
  if (typeof body.qqAppSecret === "string" && body.qqAppSecret.trim()) {
    qqPatch.appSecret = body.qqAppSecret.trim();
  }
  if (typeof body.qqPasscode === "string" && body.qqPasscode.trim()) {
    qqPatch.passcode = body.qqPasscode.trim();
  }
  if (qqPatch.appId || qqPatch.appSecret || qqPatch.passcode) {
    const r = setQQBotCredentials(qqPatch);
    results.push({ field: "qq", ok: r.ok, message: r.message.replace(/^[✅❌]\s*/, "") });
  }
  // 「常用」快捷问题：数组整体替换（设置面板按清单编辑后一次提交）；
  // 空/形状不对按空清单处理——空清单即恢复默认，不用单独的「重置」协议
  if (body.quickQuestions !== undefined) {
    const normalized = normalizeQuickQuestions(body.quickQuestions);
    saveCredentialsStore({ webQuickQuestions: normalized });
    results.push({
      field: "quickQuestions",
      ok: true,
      message: normalized.length
        ? `常用问题已保存（${normalized.length} 条），输入框上方已同步更新`
        : "常用问题已清空，恢复默认清单",
    });
  }
  let modelChanged = false;
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  if (requestedModel) {
    const allowed = allowedModelIds(
      cachedModelOptions().map((m) => m.id),
      [config.model],
    );
    const r = validateModelChoice({ requested: requestedModel, allowed, current: config.model });
    if (r.ok && r.model === config.model) {
      results.push({ field: "model", ok: true, message: "所选模型已是当前值，无需切换" });
    } else {
      results.push({ field: "model", ok: r.ok, message: r.message });
      if (r.ok) {
        config.model = r.model;
        saveCredentialsStore({ model: r.model, modelOverride: true });
        modelChanged = true;
      }
    }
  }
  if (!results.length) {
    results.push({ field: "none", ok: true, message: "没有需要保存的修改" });
  }
  return {
    ok: results.every((r) => r.ok),
    results,
    status: settingsPayload(),
    modelChanged,
  };
}

/**
 * 页面模板缓存：正式服务渲染的三个页面都是纯模板（动态数据全走 /api/*，
 * CSRF 由 withCsrf 每次后注入），首次拼接后缓存字符串。chatPage() 单次
 * 拼接即 16 万字节级，每请求重来一遍纯属浪费。要往页面注入动态真值时，
 * 改这里换成「以真值为键」的缓存。
 */
let chatPageHtml: string | null = null;
let todayPageHtml: string | null = null;
let knowledgePageHtml: string | null = null;

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "";
  if (req.method === "GET") {
    if (url.startsWith("/files/")) {
      await serveGeneratedFile(url.slice("/files/".length), res);
      return;
    }
    if (url === "/vendor/marked.min.js") {
      const buf = loadStaticOnce(MARKED_UMD);
      if (buf) {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(buf);
      } else {
        res.writeHead(404);
        res.end("// marked 不可用，页面会退回纯文本渲染");
      }
      return;
    }
    if (url === "/logo.png" || url === "/favicon.ico") {
      const buf = loadStaticOnce(LOGO_PNG);
      if (buf) {
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
        });
        res.end(buf);
      } else {
        // 图没了也只是没图标，不能连累页面
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (url === "/today" || url === "/today/") {
      // 独立日程页：下一节课/今日/本周/考试，纯本地缓存渲染
      todayPageHtml ??= todayPage();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(withCsrf(todayPageHtml));
      return;
    }
    if (url === "/knowledge" || url === "/knowledge/") {
      // 独立知识库页：对话中沉淀的知识条目，纯本地存储渲染
      knowledgePageHtml ??= knowledgePage();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(withCsrf(knowledgePageHtml));
      return;
    }
    if (url === "/api/knowledge") {
      json(res, { entries: listKnowledge() });
      return;
    }
    if (url === "/api/grades") {
      // 成绩面板走纯缓存（get_grades 查通一次即落盘），这里绝不登录教务
      json(res, loadGradesCache() ?? { savedAt: null });
      return;
    }
    if (url === "/api/news") {
      // 教务处官网公开页，无需登录；TTL 缓存见 scoredNewsSnapshot，失败如实降级
      try {
        const snapshot = await scoredNewsSnapshot();
        json(res, {
          items: snapshot.items,
          gradeBasis: snapshot.gradeBasis ?? undefined,
          fetchedAt: snapshot.fetchedAt,
        });
      } catch (e) {
        json(res, { items: [], error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (url === "/api/today" || url.startsWith("/api/today?")) {
      // 只读本地缓存（课表/考试/假期/学期日期），不登录教务、不调模型
      const week = Number(new URL(url, "http://127.0.0.1").searchParams.get("week"));
      json(res, buildTodayBrief(undefined, Number.isInteger(week) ? week : undefined));
      return;
    }
    if (url === "/api/sessions") {
      json(res, { sessions: listSessions() });
      return;
    }
    if (url === "/api/settings") {
      json(res, settingsPayload());
      return;
    }
    if (url === "/api/models" || url.startsWith("/api/models?")) {
      // 弹窗打开后异步刷新：清单以该 Key 实际可用的型号为准
      const force = new URL(url, "http://127.0.0.1").searchParams.get("refresh") === "1";
      const list = await listModelOptions({
        baseUrl: config.deepseekBaseUrl,
        apiKey: config.deepseekApiKey,
        force,
      });
      json(res, {
        ok: list.source === "live",
        current: config.model,
        source: list.source,
        options: list.options,
        message: list.message ?? "",
      });
      return;
    }
    if (url === "/api/reminders") {
      json(res, { reminders: listReminders() });
      return;
    }
    if (url === "/api/pomodoro") {
      // 番茄钟现状：卡片取消按钮与重开页面后的状态都走这里，不经过 agent
      const active = activePomodoro();
      json(res, {
        active: active ? toView(active) : null,
        recent: listPomodoros(10).map((p) => toView(p)),
      });
      return;
    }
    if (url.startsWith("/api/reminders/") && url.endsWith(".ics")) {
      const id = url.slice("/api/reminders/".length, -4);
      const reminder = listReminders().find((r) => r.id === id);
      if (!reminder) {
        fileNotFound(res);
        return;
      }
      const body = reminderIcs(reminder);
      res.writeHead(200, {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="courseraptor-${id}.ics"`,
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (url === "/api/data") {
      json(res, dataPayload());
      return;
    }
    if (url === "/api/data/export") {
      const body = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          sessions: readSessions().map((s) => ({
            ...s,
            messages: s.messages.map(({ attachments, ...m }) => ({
              ...m,
              ...(attachments?.length
                ? { attachments: attachments.map(({ id, name }) => ({ id, name })) }
                : {}),
            })),
          })),
          reminders: listReminders(),
          knowledge: listKnowledge(),
          summary: dataPayload(),
        },
        null,
        2,
      );
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="courseraptor-data-${new Date().toISOString().slice(0, 10)}.json"`,
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (url.startsWith(SESSIONS_PREFIX)) {
      const raw = decodeURIComponent(url.slice(SESSIONS_PREFIX.length));
      const s = SESSION_ID_RE.test(raw) ? getSession(raw) : null;
      if (!s) {
        json(res, { error: "会话不存在" }, 404);
        return;
      }
      json(res, {
        id: s.id,
        title: s.title || "新会话",
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messages: s.messages.map(({ attachments, ...message }) => ({
          ...message,
          ...(attachments?.length
            ? { attachments: attachments.map(({ id, name }) => ({ id, name })) }
            : {}),
        })),
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    chatPageHtml ??= chatPage();
    res.end(withCsrf(chatPageHtml));
    return;
  }
  if (req.method === "POST") {
    if (url === "/api/reset") {
      // 清空全部会话档案（UI 不再挂这个动作，留给测试与自救）
      resetAll();
      json(res, { ok: true });
      return;
    }
    if (url === "/api/settings") {
      let body: Record<string, unknown>;
      try {
        body = await jsonBody(req);
      } catch {
        json(res, { error: "请求体需要是 JSON" }, 400);
        return;
      }
      const r = applySettings(body ?? {});
      if (r.modelChanged) {
        // 串行重建：并发保存时不能让两个 agent 互相覆盖
        refreshChain = refreshChain
          .then(refreshChatAgent)
          .catch(() => "；即时切换失败，旧模型继续可用，重启后生效");
        const note = await refreshChain;
        const line = r.results.find((item) => item.field === "model");
        if (line) line.message += note;
      }
      // QQ 凭证保存成功且已凑齐：顺手把桥拉起来（未在跑时），不用等重启
      const qqLine = r.results.find((item) => item.field === "qq");
      if (r.ok && qqLine?.ok && config.qqBotAppId && config.qqBotAppSecret) {
        qqLine.message += await maybeStartQQBridge();
      }
      json(res, r, r.ok ? 200 : 400);
      return;
    }
    if (url === "/api/diagnostics") {
      try {
        const body = await jsonBody(req, 16_384);
        const result = await runDiagnostic(body.target);
        json(res, { ok: result.ok, result, checkedAt: Date.now() }, result.ok ? 200 : 400);
      } catch {
        json(res, { error: "请求体需要是 JSON" }, 400);
      }
      return;
    }
    if (url === "/api/uploads") {
      try {
        const body = await jsonBody(req, Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64_000);
        const data = typeof body.data === "string" ? body.data : "";
        const name = typeof body.name === "string" ? body.name : "";
        const type = typeof body.type === "string" ? body.type : "";
        const buf = Buffer.from(data, "base64");
        if (!data || !buf.length) throw new Error("文件内容无效");
        const upload = saveUpload(name, type, buf);
        json(res, {
          upload: { id: upload.id, name: upload.name, size: upload.size, type: upload.type },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "上传失败";
        json(
          res,
          {
            error:
              message === "PAYLOAD_TOO_LARGE"
                ? "单个文件不能超过 25 MB"
                : message === "CONTENT_TYPE"
                  ? "请求体需要是 JSON"
                  : message,
          },
          400,
        );
      }
      return;
    }
    if (url === "/api/reminders") {
      try {
        const reminder = addReminder(await jsonBody(req, 32_768));
        json(res, { reminder }, 201);
      } catch (error) {
        json(res, { error: error instanceof Error ? error.message : "创建提醒失败" }, 400);
      }
      return;
    }
    if (url === "/api/pomodoro/cancel") {
      // 倒计时卡片上的「取消」按钮直调这里：不打扰 agent 那轮对话
      try {
        const body = await jsonBody(req, 16_384);
        const target = cancelPomodoro(typeof body.id === "string" ? body.id : undefined);
        if (!target) {
          json(res, { error: "当前没有在走的番茄钟" }, 404);
          return;
        }
        json(res, { ok: true, pomodoro: toView(target) });
      } catch {
        json(res, { error: "请求体需要是 JSON" }, 400);
      }
      return;
    }
    if (url === "/api/data/clear") {
      try {
        const body = await jsonBody(req, 16_384);
        const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
        const result: Record<string, number> = {};
        if (scopes.includes("sessions")) {
          result.sessions = listSessions().length;
          resetAll();
        }
        if (scopes.includes("attachments")) result.attachments = await clearAttachments();
        if (scopes.includes("uploads")) result.uploads = clearUploads();
        if (scopes.includes("generated")) result.generated = clearGenerated();
        if (scopes.includes("reminders")) result.reminders = clearReminders();
        if (scopes.includes("knowledge")) result.knowledge = clearKnowledge();
        json(res, { ok: true, result, summary: dataPayload() });
      } catch {
        json(res, { error: "清理请求无效" }, 400);
      }
      return;
    }
    if (url === "/api/chat") {
      await handleChat(req, res);
      return;
    }
  }
  if (req.method === "PATCH" && url.startsWith(SESSIONS_PREFIX)) {
    const raw = decodeURIComponent(url.slice(SESSIONS_PREFIX.length));
    if (!SESSION_ID_RE.test(raw)) {
      json(res, { error: "会话不存在" }, 404);
      return;
    }
    try {
      const body = await jsonBody(req, 16_384);
      const updated = updateSession(raw, {
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
      });
      json(
        res,
        updated
          ? {
              ok: true,
              session: {
                id: updated.id,
                title: updated.title,
                pinned: !!updated.pinned,
                archived: !!updated.archived,
              },
            }
          : { error: "会话不存在或标题无效" },
        updated ? 200 : 404,
      );
    } catch {
      json(res, { error: "请求体需要是 JSON" }, 400);
    }
    return;
  }
  if (req.method === "PATCH" && url.startsWith("/api/reminders/")) {
    const id = url.slice("/api/reminders/".length);
    try {
      const reminder = updateReminder(id, await jsonBody(req, 32_768));
      json(res, reminder ? { reminder } : { error: "提醒不存在" }, reminder ? 200 : 404);
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : "更新提醒失败" }, 400);
    }
    return;
  }
  if (req.method === "DELETE" && url.startsWith(SESSIONS_PREFIX)) {
    const raw = decodeURIComponent(url.slice(SESSIONS_PREFIX.length));
    const ok = SESSION_ID_RE.test(raw) && deleteSession(raw);
    json(res, ok ? { ok: true } : { error: "会话不存在" }, ok ? 200 : 404);
    return;
  }
  if (req.method === "DELETE" && url.startsWith("/api/uploads/")) {
    const ok = deleteUpload(url.slice("/api/uploads/".length));
    json(res, ok ? { ok: true } : { error: "附件不存在" }, ok ? 200 : 404);
    return;
  }
  if (req.method === "DELETE" && url.startsWith("/api/reminders/")) {
    const ok = deleteReminder(url.slice("/api/reminders/".length));
    json(res, ok ? { ok: true } : { error: "提醒不存在" }, ok ? 200 : 404);
    return;
  }
  if (req.method === "DELETE" && url.startsWith("/api/knowledge/")) {
    const ok = deleteKnowledge(url.slice("/api/knowledge/".length));
    json(res, ok ? { ok: true } : { error: "知识条目不存在" }, ok ? 200 : 404);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  const agent = agentProvider?.();
  if (!agent) {
    json(res, { error: "Agent 尚未就绪，稍等几秒再发" }, 503);
    return;
  }

  let message = "";
  let sessionId = DEFAULT_ID;
  let uploads: WebUpload[] = [];
  try {
    const body = await jsonBody(req);
    message = typeof body.message === "string" ? body.message.trim() : "";
    sessionId = sidOf(body.sessionId);
    const ids = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String).slice(0, 8) : [];
    uploads = getUploads(ids);
  } catch {
    message = "";
  }
  if (!message) {
    json(res, { error: "消息为空" }, 400);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // SSE 走代理时需要立即冲刷缓冲；直连时无害
  res.write(":\n\n");

  const send = (obj: unknown): void => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // 客户端关页面 = 中断本轮（对齐终端里 ESC 打断的语义）。
  // 挂在 res 上：req 的 close 在请求体读完时也会触发，会误中断
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  // 排队执行：串行化对会话存档的读写。本轮全部事件发完后必须 res.end()
  // 关闭 SSE——不关的话浏览器/测试的 reader 永远等不到流结束
  const prev = turnChain;
  turnChain = prev
    .then(() => runTurn(agent, sessionId, message, uploads, send, abort.signal))
    .catch(() => {})
    .finally(() => {
      if (!res.writableEnded) res.end();
    });
  await prev;
}

/**
 * 把一个已解析的附件渲染成注入模型的文本块。
 * 小文件给全文（agent 无需再调工具即可回答），大文件给概览 + id
 * （agent 拿着 id 直接做精准的 query_table / 续读，省一轮试错）。
 */
function attachmentDigest(result: AttachmentResult, name: string, storedPath: string): string {
  const head = `[附件：${name}；本机路径：${storedPath}]`;
  if (result.mode === "text") {
    const lead = `解析成功（${result.format}，全文 ${result.charCount} 字符）`;
    if (!result.hasMore) return `${head}\n${lead}，全文如下：\n${result.text}`;
    return `${head}\n${lead}。以下是前 ${result.text.length} 字符，剩余用 read_local_file(path, offset=${result.nextOffset}) 续读，或用 keyword 参数定位：\n${result.text}`;
  }
  if (result.mode === "table") {
    const sheets = result.sheets
      .map(
        (s) =>
          `sheet「${s.name}」：${s.dataRows} 行 × ${s.cols} 列\n${s.preview.join("\n")}${s.moreRows ? `\n（还有 ${s.moreRows} 行未展示）` : ""}`,
      )
      .join("\n");
    return `${head}\n表格（${result.format}，共 ${result.totalDataRows} 数据行），缓存 id=${result.id}。概览：\n${sheets}\n后续用 query_table(id="${result.id}") 按条件筛选，不要试图通读全表。`;
  }
  if (result.mode === "search")
    return `${head}\n（关键词视图，命中 ${result.matchCount} 处）\n${result.matches.join("\n")}`;
  // file 模式（不支持解析的格式）：如实告知，路径仍给 agent 备用
  if (result.mode === "file")
    return `${head}\n该格式暂不支持自动解析，已存副本（${result.size} 字节）。`;
  return `${head}\n（内容已由云解析兜底，见 markdown）`;
}

/** 发消息前把本轮上传预解析成小型文本块，直接注入模型上下文 */
async function preparseUploads(uploads: WebUpload[]): Promise<string> {
  if (!uploads.length) return "";
  const blocks: string[] = [];
  for (const upload of uploads) {
    try {
      const result = await openLocalFile(upload.storedPath);
      blocks.push(attachmentDigest(result, upload.name, upload.storedPath));
    } catch (e) {
      blocks.push(
        `[附件：${upload.name}；本机路径：${upload.storedPath}]\n预解析失败（${(e as Error).message.slice(0, 120)}），请用 read_local_file 读取。`,
      );
    }
  }
  return `\n\n${blocks.join("\n\n")}\n以上附件内容已预先解析注入。小文件可直接基于内容回答；大表格/长文按各块内指引用工具按需取数。`;
}

async function runTurn(
  agent: ChatStreamableAgent,
  sessionId: string,
  message: string,
  uploads: WebUpload[],
  send: (obj: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  // 预解析注入：agent 不必先调一次 read_local_file 才知道文件里是什么
  const attachmentContext = await preparseUploads(uploads);
  const messages: ModelMessage[] = [
    ...contextMessages(sessionId),
    { role: "user", content: message + attachmentContext },
  ];
  const startedAt = Date.now();
  const toolStart = new Map<string, { name: string; at: number; input?: unknown }>();
  let text = "";
  let think = "";
  let failure: string | null = null;

  try {
    const stream = await agent.stream({ messages, abortSignal: signal });
    for await (const p of stream.fullStream as AsyncIterable<StreamEvent>) {
      switch (p.type) {
        case "text-delta": {
          const t = deltaOf(p);
          if (t) {
            text += t;
            send({ t: "text", v: t });
          }
          break;
        }
        // 思考过程走独立的 think 通道，前端渲染成草稿卡片：和正文分开累积，
        // 绝不混进 text（混进去会既当正文渲染、又被当成回答写回下一轮上下文）
        case "reasoning-delta": {
          const t = deltaOf(p);
          if (t) {
            think += t;
            send({ t: "think", v: t });
          }
          break;
        }
        case "reasoning-end": {
          // 只发段末标记（全文已经逐字发过）：前端据此把这一段定格折叠
          send({ t: "think", phase: "end" });
          break;
        }
        case "tool-call": {
          if (p.toolCallId)
            toolStart.set(p.toolCallId, {
              name: p.toolName ?? "tool",
              at: Date.now(),
              input: p.input,
            });
          send({
            t: "tool",
            phase: "start",
            id: p.toolCallId ?? "",
            name: p.toolName ?? "tool",
            args: previewJson(p.input),
          });
          break;
        }
        case "tool-result": {
          const t0 = p.toolCallId ? toolStart.get(p.toolCallId) : undefined;
          const files = filesOfToolOutput(p.output);
          const pomodoro = pomodoroOfToolOutput(p.output);
          send({
            t: "tool",
            phase: "end",
            id: p.toolCallId ?? "",
            name: p.toolName ?? "tool",
            dur: t0 ? Date.now() - t0.at : undefined,
            brief: summarizeResult(p.output),
            out: previewJson(p.output),
            // 有成品文件时前端在工具卡下方渲染下载行
            ...(files.length ? { files } : {}),
            // 新建番茄钟时前端在工具卡下方渲染实时倒计时卡片
            ...(pomodoro ? { pomodoro } : {}),
            // manage_pomodoro 的取消/查询也可能改了状态：让页面把
            // 顶部恢复卡等处的倒计时卡对表收掉（10 秒轮询的即时版）
            ...(p.toolName === "manage_pomodoro" ? { pomoSync: true } : {}),
          });
          break;
        }
        case "tool-error": {
          const msg = p.error instanceof Error ? p.error.message : String(p.error ?? "");
          send({
            t: "tool",
            phase: "error",
            id: p.toolCallId ?? "",
            name: p.toolName ?? "tool",
            brief: msg,
            // 教务凭证等未配置导致的失败：网页端自动推出设置面板，用户补填后重试
            ...(NEED_SETUP_RE.test(msg) ? { panel: "settings" } : {}),
          });
          break;
        }
        case "error": {
          failure = p.error instanceof Error ? p.error.message : String(p.error ?? "");
          break;
        }
        default:
          break;
      }
    }
  } catch (e) {
    if (!signal.aborted) failure = e instanceof Error ? e.message : String(e);
  }

  if (failure) send({ t: "err", v: failure });
  send({ t: "end", dur: Date.now() - startedAt, sid: sessionId });

  // 完整跑完的一轮才进历史（中断的半截回复会污染下一轮上下文）；
  // 落盘在 chat-sessions 里做，重启后历史仍在。思考跟着同一轮的助手消息
  // 存成 think 字段，只给界面回看，不会再被喂回模型
  if (!signal.aborted) {
    appendRound(sessionId, message, text.trim() ? text : null, think.trim() || null, {
      attachments: uploads.map(({ id, name, storedPath }) => ({ id, name, storedPath })),
    });
    // 落盘后顺手让模型给会话定个像样的标题（首轮触发一次即定题）
    await maybeAutoTitle(sessionId);
  }
}

// ── 前端单页 ─────────────────────────────────────────────────
// Markdown 用 marked 渲染（/vendor/marked.min.js）；渲染前先整段转义
// HTML 特殊字符，保证最终 DOM 里只有 marked 生成的标签——模型输出里
// 夹带的 <script> 之类会以纯文本形式出现，不构成注入面。
//
// ⚠ 整个页面是一个 TS 模板字符串：页面 JS 里的换行符必须写 \\n（如
// buf.split("\\n")），页面代码禁用反引号模板串与 ${——它们会被外层解析。
