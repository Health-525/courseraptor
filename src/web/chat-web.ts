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
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelMessage } from "ai";
import {
  appendRound,
  contextMessages,
  DEFAULT_ID,
  deleteSession,
  getSession,
  listSessions,
  resetAll,
} from "../chat-sessions";
import { config } from "../config";
import { saveCredentialsStore } from "../credentials";
import { generatedDir } from "../document/save";
import { getDeepSeekKeyStatus, setDeepSeekApiKey } from "../onboarding";
import { chatPage } from "./chat-page";

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
      void handle(req, res);
    });
    // unref：不让网页服务拖住进程退出——终端 UI 退出时主程序该走就走
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(`http://localhost:${addr.port}`);
      } else {
        reject(new Error("server address unavailable"));
      }
    });
  });
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
  const root = path.resolve(generatedDir());
  const target = path.resolve(filePath);
  return target.startsWith(root + path.sep);
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
  if (!target.startsWith(root + path.sep)) {
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
  return {
    jwgl: {
      configured: !!(config.jwglUsername && config.jwglPassword),
      username: config.jwglUsername || "",
      sourceLabel: SOURCE_LABEL[config.credentialsSource] ?? config.credentialsSource,
    },
    deepseek: { ...ds, sourceLabel: SOURCE_LABEL[ds.source] ?? ds.source },
    model: config.model,
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
  }
  if (!results.length) {
    results.push({ field: "none", ok: true, message: "没有需要保存的修改" });
  }
  return { ok: results.every((r) => r.ok), results, status: settingsPayload() };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "";
  if (req.method === "GET") {
    if (url.startsWith("/files/")) {
      await serveGeneratedFile(url.slice("/files/".length), res);
      return;
    }
    if (url === "/vendor/marked.min.js") {
      try {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(fs.readFileSync(MARKED_UMD));
      } catch {
        res.writeHead(404);
        res.end("// marked 不可用，页面会退回纯文本渲染");
      }
      return;
    }
    if (url === "/logo.png" || url === "/favicon.ico") {
      try {
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
        });
        res.end(fs.readFileSync(LOGO_PNG));
      } catch {
        // 图没了也只是没图标，不能连累页面
        res.writeHead(404);
        res.end();
      }
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
        messages: s.messages,
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(chatPage());
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
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        json(res, { error: "请求体需要是 JSON" }, 400);
        return;
      }
      const r = applySettings(body ?? {});
      json(res, r, r.ok ? 200 : 400);
      return;
    }
    if (url === "/api/chat") {
      await handleChat(req, res);
      return;
    }
  }
  if (req.method === "DELETE" && url.startsWith(SESSIONS_PREFIX)) {
    const raw = decodeURIComponent(url.slice(SESSIONS_PREFIX.length));
    const ok = SESSION_ID_RE.test(raw) && deleteSession(raw);
    json(res, ok ? { ok: true } : { error: "会话不存在" }, ok ? 200 : 404);
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
  for await (const chunk of req) message += chunk;
  let sessionId = DEFAULT_ID;
  try {
    const body = JSON.parse(message) as { message?: unknown; sessionId?: unknown };
    message = typeof body.message === "string" ? body.message.trim() : "";
    sessionId = sidOf(body.sessionId);
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
    .then(() => runTurn(agent, sessionId, message, send, abort.signal))
    .catch(() => {})
    .finally(() => {
      if (!res.writableEnded) res.end();
    });
  await prev;
}

async function runTurn(
  agent: ChatStreamableAgent,
  sessionId: string,
  message: string,
  send: (obj: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const messages: ModelMessage[] = [
    ...contextMessages(sessionId),
    { role: "user", content: message },
  ];
  const startedAt = Date.now();
  const toolStart = new Map<string, { name: string; at: number }>();
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
            toolStart.set(p.toolCallId, { name: p.toolName ?? "tool", at: Date.now() });
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
    appendRound(sessionId, message, text.trim() ? text : null, think.trim() || null);
  }
}

// ── 前端单页 ─────────────────────────────────────────────────
// Markdown 用 marked 渲染（/vendor/marked.min.js）；渲染前先整段转义
// HTML 特殊字符，保证最终 DOM 里只有 marked 生成的标签——模型输出里
// 夹带的 <script> 之类会以纯文本形式出现，不构成注入面。
//
// ⚠ 整个页面是一个 TS 模板字符串：页面 JS 里的换行符必须写 \\n（如
// buf.split("\\n")），页面代码禁用反引号模板串与 ${——它们会被外层解析。
