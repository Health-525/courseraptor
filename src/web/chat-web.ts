/**
 * 网页对话窗口 — 浏览器里直接和 Agent 聊
 *
 * 终端 TUI 之外的第二对话入口：随主程序自动启动，地址显示在欢迎卡片
 * 下方，浏览器打开即聊。单页零依赖（Node 内置 http + 原生前端），
 * 只绑 127.0.0.1 不暴露局域网，端口默认 3210（RAPTOR_WEB_PORT 可改）。
 *
 * 界面是「红头档案」编辑部风：暖纸底 + 墨色字 + 单一朱砂红，楷体报头、
 * 等宽小字数据行、圆形印章徽章。设计令牌全部在 chatPage() 的 CSS :root。
 *
 * 协议：POST /api/chat 用 SSE 流式回传（text=文本增量 / tool=工具卡片 /
 * err=错误 / end=结束并携带 sid），与行内 TUI 消费的是同一个 agent.fullStream。
 * 多会话历史由 chat-sessions.ts 落盘（data/chat-sessions.json），重启不丢；
 * 每轮把该会话最后 40 条转成 ModelMessage 传给 agent，多轮上下文完整。
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelMessage } from "ai";
import { config } from "../config";
import { saveCredentialsStore } from "../credentials";
import { getDeepSeekKeyStatus, setDeepSeekApiKey } from "../onboarding";
import {
  appendRound,
  contextMessages,
  DEFAULT_ID,
  deleteSession,
  getSession,
  listSessions,
  resetAll,
} from "../chat-sessions";

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
        case "tool-call": {
          if (p.toolCallId) toolStart.set(p.toolCallId, { name: p.toolName ?? "tool", at: Date.now() });
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
          send({
            t: "tool",
            phase: "end",
            id: p.toolCallId ?? "",
            name: p.toolName ?? "tool",
            dur: t0 ? Date.now() - t0.at : undefined,
            brief: summarizeResult(p.output),
            out: previewJson(p.output),
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
  // 落盘在 chat-sessions 里做，重启后历史仍在
  if (!signal.aborted) appendRound(sessionId, message, text.trim() ? text : null);
}

// ── 前端单页 ─────────────────────────────────────────────────
// Markdown 用 marked 渲染（/vendor/marked.min.js）；渲染前先整段转义
// HTML 特殊字符，保证最终 DOM 里只有 marked 生成的标签——模型输出里
// 夹带的 <script> 之类会以纯文本形式出现，不构成注入面。
//
// ⚠ 整个页面是一个 TS 模板字符串：页面 JS 里的换行符必须写 \\n（如
// buf.split("\\n")），页面代码禁用反引号模板串与 ${——它们会被外层解析。

function chatPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CourseRaptor</title>
<script src="/vendor/marked.min.js"></script>
<style>
  /* ── 设计令牌：红头档案（编辑部排版风）──
     暖纸底 + 墨色字 + 单一朱砂红；报头楷体、数据等宽小字、正文系统黑体。
     没有渐变、没有光斑、没有玻璃——所有颜色只在这一个 :root 里定义。 */
  :root {
    color-scheme: light;
    --paper: #F5F3EC;   /* 纸面 */
    --card: #FBFAF6;    /* 浮起的纸片 */
    --shade: #ECE8DD;   /* 压深的纸（表头/代码底） */
    --ink: #26231D;     /* 墨 */
    --ink-2: #5C574C;
    --ink-3: #948E7F;
    --rule: #E3DED1;    /* 细线 */
    --rule-2: #CCC5B3;  /* 重一点的线 */
    --accent: #AF3A2C;      /* 朱砂 */
    --accent-deep: #8C2D22;
    --accent-soft: #F4E5E1;
    --serif: Georgia, "Times New Roman", "Songti SC", SimSun, serif;
    --kai: "KaiTi", "STKaiti", "Kaiti SC", var(--serif);
    --sans: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --mono: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  /* 锁定整页：只有消息区能滚，输入/发送条永远钉在视口底部；
     dvh 让移动端键盘弹出时底栏跟着抬进可见区而不是被顶出屏幕 */
  body { margin: 0; display: grid; grid-template-columns: 268px 1fr;
         height: 100vh; height: 100dvh; overflow: hidden;
         background: var(--paper); color: var(--ink);
         font-family: var(--sans); font-size: 14px; line-height: 1.75; }
  ::selection { background: var(--accent-soft); }
  button, input, textarea { font-family: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ── 左栏：档头 ── */
  aside { display: flex; flex-direction: column; gap: 26px; min-height: 0;
          padding: 24px 20px 18px; border-right: 1px solid var(--rule);
          overflow-y: auto; }
  .mast h1 { margin: 0; font-family: var(--kai); font-weight: 400;
             font-size: 23px; color: var(--accent); letter-spacing: .5px; }
  .sec h2 { display: flex; justify-content: space-between; align-items: baseline;
            margin: 0 0 10px; padding-bottom: 6px;
            font-family: var(--mono); font-size: 10.5px; font-weight: 600;
            letter-spacing: .18em; color: var(--ink-3);
            border-bottom: 1px solid var(--rule); }
  .sec h2 span { letter-spacing: .04em; font-weight: 400; }
  .mastbtns { display: flex; gap: 8px; }
  .mastbtns .tbtn.primary { flex: 1; background: var(--accent);
                            border-color: var(--accent); color: var(--card);
                            font-weight: 600; letter-spacing: .12em; }
  .mastbtns .tbtn.primary:hover { background: var(--accent-deep);
                                  border-color: var(--accent-deep); color: #fff; }
  .foot-btn { margin-top: auto; width: 100%; }

  /* 会话档案列表：标题 + 时间元数据，悬停出删除 */
  .sess { list-style: none; margin: 0; padding: 0; }
  .sess li { display: grid; grid-template-columns: 1fr 18px; column-gap: 6px;
             padding: 7px 8px 7px 10px; border-left: 2px solid transparent;
             cursor: pointer; }
  .sess li:hover { background: var(--card); }
  .sess li.on { border-left-color: var(--accent); background: var(--card); }
  .sess .st { font-size: 12.5px; color: var(--ink-2); overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
  .sess li.on .st { color: var(--ink); font-weight: 600; }
  .sess .sm { grid-column: 1; font-family: var(--mono); font-size: 9.5px;
              color: var(--ink-3); letter-spacing: .05em; }
  .sess .sx { grid-row: 1; grid-column: 2; justify-self: end; border: 0;
              background: none; color: var(--ink-3); opacity: .5;
              font-size: 11px; cursor: pointer; padding: 0 4px;
              transition: opacity .15s ease, color .15s ease; }
  .sess .sx:hover { opacity: 1; color: var(--accent); }
  .sess .snone { display: block; color: var(--ink-3); font-size: 12px;
                 padding: 4px 2px; cursor: default; }

  .tbtn { background: none; border: 1px solid var(--rule-2); color: var(--ink-2);
          font-size: 12.5px; padding: 5px 14px; border-radius: 2px;
          cursor: pointer; transition: border-color .15s ease, color .15s ease; }
  .tbtn:hover { border-color: var(--accent); color: var(--accent); }

  /* ── 右栏：正文 ── */
  main { display: flex; flex-direction: column; min-width: 0; min-height: 0;
         height: 100%; }
  .topbar { display: none; align-items: center; gap: 10px;
            padding: 10px 14px; border-bottom: 1px solid var(--rule);
            background: var(--paper); }
  .topbar .tb-title { font-family: var(--kai); font-size: 16px;
                      color: var(--accent); }
  .topbar .tbtn { margin-left: auto; padding: 4px 10px; font-size: 11.5px; }
  #log { flex: 1; min-height: 0; overflow-y: auto; padding: 38px 28px 28px; }
  .inner { max-width: 672px; margin: 0 auto; }

  /* 对话按「往来文书」排版：一行题注 + 正文，不做聊天气泡 */
  .turn { margin: 0 0 34px; }
  .cap { display: flex; align-items: baseline; gap: 10px; margin-bottom: 7px;
         font-family: var(--mono); font-size: 10px; letter-spacing: .14em;
         color: var(--ink-3); }
  .cap .who { font-weight: 600; letter-spacing: .28em; color: var(--ink-2); }
  .turn.user .cap .who { color: var(--accent-deep); }
  .turn.user .msg { border-left: 3px solid var(--accent); background: var(--card);
                    padding: 9px 16px; white-space: pre-wrap;
                    word-break: break-word; font-size: 14px; }
  .turn.bot .msg { font-size: 15px; line-height: 1.9; word-break: break-word; }
  .cursor::after { content: "▌"; color: var(--accent); margin-left: 2px;
                   animation: blink 1s steps(2, start) infinite; }
  @keyframes blink { to { visibility: hidden; } }

  /* 工具调用卡片：独立建模，details 展开看参数与结果预览 */
  .tl { flex-direction: column; gap: 4px; margin-bottom: 9px; }
  .tl:not(:empty) { display: flex; }
  .tl:empty { display: none; }
  .tool { border: 1px solid var(--rule); background: var(--card); }
  .tool summary { display: flex; align-items: center; gap: 9px;
                  padding: 4px 10px; cursor: pointer; list-style: none;
                  font-family: var(--mono); font-size: 11px;
                  color: var(--ink-2); }
  .tool summary::-webkit-details-marker { display: none; }
  .tool summary:hover .tname { color: var(--accent); }
  .tool .tw { flex: none; width: 12px; color: var(--ink-3); }
  .tool .tname { flex: none; }
  .tool .tsum { flex: 1; min-width: 0; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap;
                color: var(--ink-3); }
  .tool .tdur { flex: none; color: var(--ink-3); }
  .tool.ok .tw { color: var(--accent); }
  .tool.bad { border-color: var(--accent); }
  .tool.bad .tw, .tool.bad .tname { color: var(--accent-deep); }
  .tool .tbody { border-top: 1px dashed var(--rule); padding: 2px 10px 8px; }
  .tool .tbody:empty { display: none; }
  .tool .psec { margin-top: 6px; }
  .tool .plabel { display: block; font-family: var(--mono); font-size: 9px;
                  letter-spacing: .2em; color: var(--ink-3);
                  margin-bottom: 3px; }
  .tool pre { margin: 0; padding: 6px 8px; background: var(--paper);
              border: 1px solid var(--rule); max-height: 160px;
              overflow: auto; font-family: var(--mono); font-size: 10.5px;
              line-height: 1.6; color: var(--ink-2);
              white-space: pre-wrap; word-break: break-all; }

  /* 兜底错误行（网络错误 / 中断这类非工具事件仍是等宽一行） */
  .tline { display: flex; gap: 8px; font-family: var(--mono); font-size: 11px;
           line-height: 1.7; padding: 2px 0; word-break: break-all; }
  .tline .mark { flex: none; width: 12px; }
  .tline.bad { color: var(--accent-deep); }
  .acts { margin-top: 9px; display: flex; gap: 8px; }
  .acts:empty { display: none; }
  .acts .tbtn { padding: 3px 12px; font-size: 11.5px; color: var(--ink-3);
                border-color: var(--rule); }

  /* ── 首屏：一张盖了章的空白纸 ── */
  .hero { padding: 13vh 8px 30px; text-align: center; }
  .hero .seal { position: relative; width: 92px; height: 92px;
                margin: 0 auto 22px; transform: rotate(-7deg); }
  .hero .seal::before { content: ""; position: absolute; inset: 0;
                        border: 2px solid var(--accent); border-radius: 50%;
                        opacity: .9; }
  .hero .seal::after { content: ""; position: absolute; inset: 6px;
                       border: 1px solid var(--accent); border-radius: 50%;
                       opacity: .45; }
  .hero .seal b { position: absolute; inset: 0; display: grid;
                  place-items: center; font-size: 34px; font-weight: 400; }
  .hero h2 { margin: 0 0 10px; font-family: var(--kai); font-weight: 400;
             font-size: 30px; letter-spacing: 1px; }
  .hero p { margin: 0 auto; max-width: 430px; font-size: 13px;
            color: var(--ink-2); line-height: 2; }
  .hero .hint { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3);
                letter-spacing: .05em; }

  /* ── Markdown 正文样式 ── */
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0.6em 0; }
  .md h1, .md h2, .md h3, .md h4 { font-family: var(--kai); font-weight: 400;
                                   margin: 1.2em 0 0.5em; line-height: 1.5; }
  .md h1 { font-size: 1.3em; } .md h2 { font-size: 1.2em; }
  .md h3 { font-size: 1.1em; } .md h4 { font-size: 1em; }
  .md ul, .md ol { margin: 0.6em 0; padding-left: 1.6em; }
  .md li { margin: 0.25em 0; }
  .md li::marker { color: var(--accent); }
  .md strong { font-weight: 650; }
  .md table { border-collapse: collapse; margin: 0.8em 0; font-size: 13px;
              display: block; overflow-x: auto; max-width: 100%;
              border: 1px solid var(--rule); background: var(--card); }
  .md th, .md td { border: 1px solid var(--rule); padding: 6px 12px;
                   text-align: left; }
  .md th { background: var(--shade); font-family: var(--mono); font-size: 11px;
           letter-spacing: .06em; font-weight: 600; }
  .md code { font-family: var(--mono); font-size: 0.86em; background: var(--shade);
             border: 1px solid var(--rule); padding: 1px 5px; border-radius: 2px; }
  .md pre { background: var(--card); border: 1px solid var(--rule);
            padding: 12px 14px; overflow-x: auto; margin: 0.8em 0; }
  .md pre code { background: none; border: 0; padding: 0; }
  .md blockquote { margin: 0.8em 0; padding: 2px 14px;
                   border-left: 3px solid var(--accent); color: var(--ink-2);
                   background: var(--card); }
  .md a { color: var(--accent); text-decoration: underline;
          text-underline-offset: 2px; }
  .md hr { border: 0; border-top: 1px solid var(--rule-2); margin: 1.2em 0; }

  /* ── 底部：快速提问常驻 + 档案「留言」栏 ── */
  form { flex: none; border-top: 1px solid var(--rule); background: var(--paper);
         padding: 12px 28px 12px; }
  .quickbar { display: flex; align-items: center; gap: 10px;
              max-width: 672px; margin: 0 auto 8px; }
  .qlabel { flex: none; font-family: var(--mono); font-size: 9.5px;
            letter-spacing: .22em; color: var(--ink-3); }
  .qchips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { border: 1px solid var(--rule-2); background: var(--card);
          color: var(--ink-2); font-size: 12px; padding: 4px 12px;
          border-radius: 2px; cursor: pointer;
          transition: border-color 0.15s ease, color 0.15s ease; }
  .chip:hover { border-color: var(--accent); color: var(--accent); }
  .composer { max-width: 672px; margin: 0 auto; }
  .cwrap { display: flex; align-items: center; gap: 12px;
           background: var(--card); border: 1px solid var(--rule-2);
           border-radius: 3px; padding: 6px 7px 6px 16px;
           transition: border-color 0.15s ease, box-shadow 0.15s ease; }
  .cwrap:focus-within { border-color: var(--accent);
                        box-shadow: 0 0 0 3px var(--accent-soft); }
  .clabel { flex: none; font-family: var(--kai); font-size: 16px;
            letter-spacing: 2px; color: var(--ink-3);
            border-right: 1px solid var(--rule); padding-right: 12px;
            align-self: stretch; display: flex; align-items: center;
            transition: color 0.15s ease; user-select: none; }
  .cwrap:focus-within .clabel { color: var(--accent); }
  textarea { flex: 1; background: none; border: 0; outline: none; resize: none;
             color: var(--ink); font-size: 14.5px; line-height: 1.6;
             padding: 6px 0; max-height: 180px; align-self: center; }
  textarea::placeholder { color: var(--ink-3); }
  #b { flex: none; align-self: center; display: inline-flex;
       align-items: center; gap: 7px;
       border: 1px solid var(--accent); background: var(--accent);
       color: #FBFAF6; font-size: 13.5px; font-weight: 600; padding: 8px 18px;
       border-radius: 2px; cursor: pointer;
       transition: background 0.15s ease, color 0.15s ease,
                   border-color 0.15s ease, opacity 0.15s ease; }
  #b .kbd { font-family: var(--mono); font-size: 11px; opacity: .7; }
  #b:hover:not(:disabled) { background: var(--accent-deep);
                            border-color: var(--accent-deep); }
  #b:disabled { background: none; border-color: var(--rule-2);
                color: var(--ink-3); cursor: default; }
  /* 流式进行中按钮变「停止」：反白描边 */
  #b.stop { background: none; color: var(--accent); }
  #b.stop:hover:not(:disabled) { background: var(--accent-soft);
                                 color: var(--accent-deep);
                                 border-color: var(--accent-deep); }
  .fhint { margin: 6px 4px 0; text-align: right; font-family: var(--mono);
           font-size: 9.5px; letter-spacing: .14em; color: var(--ink-3); }

  /* ── 设置弹窗：一张盖了红头的办理单 ── */
  .overlay { position: fixed; inset: 0; z-index: 50;
             background: rgba(38, 35, 29, 0.42);
             display: grid; place-items: center; padding: 20px; }
  .overlay[hidden] { display: none; }
  .dlg { width: min(440px, 100%); background: var(--paper);
         border: 1px solid var(--rule-2);
         box-shadow: 0 18px 60px rgba(38, 35, 29, 0.28); }
  .dlg-head { display: flex; align-items: center; justify-content: space-between;
              padding: 14px 18px 8px; }
  .dlg-head span { font-family: var(--kai); font-size: 19px;
                   color: var(--accent); letter-spacing: 2px; }
  .dclose { border: 0; background: none; color: var(--ink-3);
            cursor: pointer; font-size: 13px; }
  .dclose:hover { color: var(--accent); }
  .dlg-rule { border-bottom: 2px solid var(--accent); margin: 0 18px; }
  .dlg-body { padding: 16px 18px 6px; }
  .fld-l { font-family: var(--mono); font-size: 9.5px; letter-spacing: .2em;
           color: var(--ink-3); padding-bottom: 5px; margin: 16px 0 10px;
           border-bottom: 1px solid var(--rule); }
  .fld-l:first-child { margin-top: 0; }
  .fld { display: grid; grid-template-columns: 72px 1fr; align-items: center;
         gap: 10px; margin: 8px 0; }
  .fld span { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3);
              letter-spacing: .1em; }
  .fld input { width: 100%; border: 1px solid var(--rule-2);
               background: var(--card); color: var(--ink);
               font-family: var(--mono); font-size: 12.5px; padding: 7px 10px;
               border-radius: 2px; outline: none; }
  .fld input:focus { border-color: var(--accent); }
  .cur { font-family: var(--mono); font-size: 10px; color: var(--ink-3);
         margin-left: 82px; letter-spacing: .04em; min-height: 14px; }
  .setnote { font-size: 11.5px; color: var(--ink-3); margin: 14px 0 2px;
             line-height: 1.8; }
  .setmsg { font-family: var(--mono); font-size: 11px; min-height: 16px;
            margin-top: 6px; white-space: pre-wrap; color: var(--accent-deep); }
  .setmsg.good { color: var(--ink-2); }
  .dlg-foot { display: flex; justify-content: flex-end; gap: 8px;
              padding: 12px 18px 16px; }
  .dlg-foot .tbtn.primary { background: var(--accent);
                            border-color: var(--accent); color: var(--card);
                            font-weight: 600; }
  .dlg-foot .tbtn.primary:hover { background: var(--accent-deep);
                                  border-color: var(--accent-deep); color: #fff; }
  .dlg-foot .tbtn:disabled { opacity: .5; cursor: default; }

  #toBottom { position: fixed; right: 30px; bottom: 104px; z-index: 5;
              background: var(--card); border: 1px solid var(--rule-2);
              color: var(--ink-2); font-size: 12px; padding: 6px 13px;
              border-radius: 2px; cursor: pointer;
              box-shadow: 0 2px 10px rgba(38, 35, 29, 0.08); }
  #toBottom[hidden] { display: none; }
  #toBottom:hover { border-color: var(--accent); color: var(--accent); }

  #log::-webkit-scrollbar, aside::-webkit-scrollbar { width: 10px; }
  #log::-webkit-scrollbar-thumb, aside::-webkit-scrollbar-thumb {
    background: var(--rule-2); border: 3px solid transparent;
    background-clip: content-box; border-radius: 5px; }
  #log::-webkit-scrollbar-thumb:hover, aside::-webkit-scrollbar-thumb:hover {
    background: var(--ink-3); background-clip: content-box; }
  #log::-webkit-scrollbar-track, aside::-webkit-scrollbar-track {
    background: transparent; }

  @media (max-width: 860px) {
    body { grid-template-columns: 1fr; }
    aside { display: none; }
    .topbar { display: flex; }
    #log { padding: 22px 16px; }
    form { padding: 10px 14px 10px; }
    .quickbar { margin-bottom: 7px; }
    .fhint { display: none; }
    #toBottom { right: 14px; bottom: 96px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important;
                             transition: none !important; }
  }
</style>
</head>
<body>
<aside>
  <div class="mast">
    <h1>CourseRaptor</h1>
  </div>
  <div class="mastbtns">
    <button class="tbtn primary" id="newSession" title="另起一个会话（旧会话保留在档案里）">新会话</button>
  </div>
  <section class="sec">
    <h2>会话档案<span id="sessCount"></span></h2>
    <ul class="sess" id="sessList"></ul>
  </section>
  <button class="tbtn foot-btn" id="openSettings" title="教务账号与 API Key">设置</button>
</aside>
<main>
  <div class="topbar">
    <span class="tb-title">CourseRaptor</span>
    <button class="tbtn" id="newSessionM">新会话</button>
    <button class="tbtn" id="openSettingsM">设置</button>
  </div>
  <div id="log"><div class="inner" id="inner">
    <div class="hero" id="hero">
      <div class="seal" aria-hidden="true"><b>🦖</b></div>
      <h2>同学，你好。</h2>
      <p>课表、成绩、考试、通知——直接用一句话问。<br>
      <span class="hint">对话只在本机流转（127.0.0.1）；会话自动存档，重启不丢。</span></p>
    </div>
  </div></div>
  <form id="f">
    <div class="quickbar">
      <span class="qlabel">常用</span>
      <span class="qchips" id="qchips"></span>
    </div>
    <div class="composer">
      <div class="cwrap">
        <span class="clabel" aria-hidden="true">留言</span>
        <textarea id="i" rows="1" placeholder="课表、成绩、考试、通知，直接问…"></textarea>
        <button id="b">发送<span class="kbd">⏎</span></button>
      </div>
      <div class="fhint">⏎ 发送 · ⇧⏎ 换行 · 会话自动存档</div>
    </div>
  </form>
</main>
<div class="overlay" id="overlay" hidden>
  <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
    <div class="dlg-head"><span id="dlgTitle">设置</span><button class="dclose" id="closeSettings" aria-label="关闭设置">✕</button></div>
    <div class="dlg-rule"></div>
    <div class="dlg-body">
      <div class="fld-l">教务系统</div>
      <label class="fld"><span>学号</span><input id="sUser" type="text" autocomplete="off"></label>
      <label class="fld"><span>密码</span><input id="sPass" type="password" autocomplete="new-password"></label>
      <div class="cur" id="curJwgl"></div>
      <div class="fld-l">模型服务</div>
      <label class="fld"><span>API KEY</span><input id="sKey" type="password" autocomplete="new-password"></label>
      <div class="cur" id="curKey"></div>
      <div class="setnote">留空即不修改。教务密码与 Key 仅 AES 加密保存在本机（credentials.enc），接口只回传脱敏摘要。</div>
      <div class="setmsg" id="setMsg"></div>
    </div>
    <div class="dlg-foot">
      <button class="tbtn" id="cancelSettings">取消</button>
      <button class="tbtn primary" id="saveSettings">保存</button>
    </div>
  </div>
</div>
<button id="toBottom" hidden>↓ 回到底部</button>
<script>
const logScroll = document.getElementById("log");
const inner = document.getElementById("inner");
const hero = document.getElementById("hero");
const input = document.getElementById("i");
const btn = document.getElementById("b");
let busy = false;
let controller = null;
/* 最近一轮的用户消息：失败重试用 */
let lastPrompt = "";

/* ── 多会话状态：正文以服务端存档为准，本地只记当前会话 id ── */
const ACTIVE_KEY = "raptor-web-active-session";
let activeId = "";
let msgs = [];
let lastSessions = [];
function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function lsSet(k, v) {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {}
}
activeId = lsGet(ACTIVE_KEY);
/* uuid 客户端先生成：第一条消息发出时服务端才建档，不留空壳会话 */
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : "s" + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
}

/* ── 小工具 ── */
function el(cls) {
  const div = document.createElement("div");
  div.className = cls;
  return div;
}
function el2(cls, text) {
  const n = el(cls);
  n.textContent = text;
  return n;
}
function pad(x) { return (x < 10 ? "0" : "") + x; }
function clock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function fmtWhen(ts) {
  const d = new Date(ts), n = new Date();
  return d.toDateString() === n.toDateString()
    ? clock(ts) : (d.getMonth() + 1) + "月" + d.getDate() + "日";
}

/* ── 快速提问：常驻在输入框上方 ── */
const QUESTIONS = ["这周课表", "教务处最近有什么通知", "我的成绩和 GPA", "最近的考试安排"];
const qchips = document.getElementById("qchips");
QUESTIONS.forEach((q) => {
  const c = document.createElement("button");
  c.type = "button";
  c.className = "chip";
  c.dataset.q = q;
  c.textContent = q;
  qchips.appendChild(c);
});
qchips.addEventListener("click", (e) => {
  const c = e.target.closest("button[data-q]");
  if (c && !busy) send(c.dataset.q);
});

/* ── 智能滚动：用户上翻（离底 > 60px）就不再自动拽底 ── */
const toBottom = document.getElementById("toBottom");
let pinned = true;
logScroll.addEventListener("scroll", () => {
  pinned = logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 60;
  toBottom.hidden = pinned;
});
toBottom.addEventListener("click", () => scroll(true));

const HAS_MARKED = typeof marked !== "undefined";
/* 只转义 & 和 <：堵住 HTML 标签注入面（标签必须以 < 开头），同时保留
   Markdown 自己的语法字符——> 若被转义成 &gt;，块引用就失效了 */
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function renderMd(text) {
  if (!HAS_MARKED) return null;
  try {
    return marked.parse(escHtml(text), { gfm: true, breaks: true, async: false });
  } catch { return null; }
}

/* 流式期间每个 delta 都整段重渲 Markdown 会卡：合并到下一帧 */
let raf = 0;
let pending = null;
function renderStreaming(node, raw) {
  pending = { node, raw };
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!pending) return;
    const html = renderMd(pending.raw);
    if (html != null) pending.node.innerHTML = html;
    else pending.node.textContent = pending.raw;
    scroll(false);
  });
}

function scroll(force) {
  if (force || pinned) logScroll.scrollTop = logScroll.scrollHeight;
}

function clearTurns() {
  [...inner.querySelectorAll(".turn")].forEach((n) => n.remove());
}

/* ── 消息渲染：一行题注（谁 · 时间 · 耗时）+ 正文 ── */
function addTurn(cls) {
  const sec = el("turn " + cls);
  const cap = el("cap");
  cap.appendChild(el2("who", cls === "user" ? "你" : "助手"));
  const tm = el2("tm", "");
  const dur = el2("dur", "");
  cap.appendChild(tm);
  cap.appendChild(dur);
  sec.appendChild(cap);
  return { sec, cap, tm, dur };
}

function addUser(text, ts) {
  const { sec, tm } = addTurn("user");
  tm.textContent = clock(ts || Date.now());
  sec.appendChild(el2("msg", text));
  inner.appendChild(sec);
  scroll(true);
}

/** 助手一轮：题注 + 工具卡片区 + 回答正文 + 操作行 */
function addBotShell() {
  const { sec, tm, dur } = addTurn("bot");
  const tl = el("tl");
  const msg = el("msg md");
  const acts = el("acts");
  sec.appendChild(tl);
  sec.appendChild(msg);
  sec.appendChild(acts);
  inner.appendChild(sec);
  scroll(true);
  /* 工具卡片索引：id 精确配对为主，同名排队兜底 */
  return { sec, tm, dur, tl, msg, acts, tools: new Map(), queue: {} };
}

function addCopyButton(acts, raw) {
  if (!raw.trim()) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tbtn";
  b.textContent = "复制";
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(raw);
      b.textContent = "已复制";
      setTimeout(() => (b.textContent = "复制"), 1200);
    } catch { /* 剪贴板不可用就静默 */ }
  });
  acts.appendChild(b);
}

/** 定格一条完整助手消息（openSession 重绘历史用） */
function addBotMessage(raw, ts) {
  const shell = addBotShell();
  shell.tm.textContent = clock(ts);
  const html = renderMd(raw);
  if (html != null) shell.msg.innerHTML = html;
  else shell.msg.textContent = raw;
  addCopyButton(shell.acts, raw);
  scroll(false);
  return shell;
}

/* ── 工具卡片：▸ 执行中 / ✓ 完成 / ✗ 失败，点开看参数与结果预览 ── */
function appendPre(body, label, text) {
  const w = el("psec");
  w.appendChild(el2("plabel", label));
  const pre = document.createElement("pre");
  pre.textContent = text;
  w.appendChild(pre);
  body.appendChild(w);
}

function toolCard(shell, ev) {
  const det = document.createElement("details");
  det.className = "tool run";
  const sum = document.createElement("summary");
  sum.appendChild(el2("tw", "▸"));
  sum.appendChild(el2("tname", ev.name || "tool"));
  sum.appendChild(el2("tsum", "执行中…"));
  sum.appendChild(el2("tdur", ""));
  det.appendChild(sum);
  const body = el("tbody");
  if (ev.args) appendPre(body, "参数", ev.args);
  det.appendChild(body);
  shell.tl.appendChild(det);
  const item = { det, body };
  if (ev.id) shell.tools.set("id:" + ev.id, item);
  const name = ev.name || "tool";
  (shell.queue[name] = shell.queue[name] || []).push(item);
  scroll(false);
  return item;
}

function toolTake(shell, ev) {
  let item = ev.id ? shell.tools.get("id:" + ev.id) : null;
  if (item) shell.tools.delete("id:" + ev.id);
  if (!item) {
    const q = shell.queue[ev.name] || [];
    item = q.shift() || null;
  }
  /* start 事件丢失等兜底：直接补一张已建好的卡再定格 */
  if (!item) item = toolCard(shell, { id: "", name: ev.name, args: "" });
  return item;
}

function toolDone(shell, ev, ok) {
  const item = toolTake(shell, ev);
  item.det.className = "tool " + (ok ? "ok" : "bad");
  item.det.querySelector(".tw").textContent = ok ? "✓" : "✗";
  item.det.querySelector(".tsum").textContent = String(ev.brief || (ok ? "完成" : "失败"));
  item.det.querySelector(".tdur").textContent =
    ev.dur != null ? (ev.dur / 1000).toFixed(1) + "s" : "";
  if (ev.out) appendPre(item.body, "结果", ev.out);
  scroll(false);
}

/** 非工具错误（网络失败 / 中断 / agent err）：仍是等宽一行 */
function lineBad(tl, text, mark) {
  const p = el("tline bad");
  p.appendChild(el2("mark", mark || "✗"));
  p.appendChild(el2("st", text));
  tl.appendChild(p);
  scroll(false);
}

/* ── 会话档案：列表 / 打开 / 删除 / 新会话 ── */
const sessList = document.getElementById("sessList");
function renderSessList() {
  sessList.innerHTML = "";
  document.getElementById("sessCount").textContent =
    lastSessions.length ? lastSessions.length + " 个" : "";
  if (!lastSessions.length) {
    const li = document.createElement("li");
    li.className = "snone";
    li.textContent = "暂无历史会话";
    sessList.appendChild(li);
    return;
  }
  lastSessions.forEach((s) => {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    if (s.id === activeId) li.className = "on";
    li.title = s.title || "新会话";
    li.appendChild(el2("st", s.title || "新会话"));
    const x = document.createElement("button");
    x.type = "button";
    x.className = "sx";
    x.dataset.del = s.id;
    x.title = "删除会话";
    x.textContent = "✕";
    li.appendChild(x);
    li.appendChild(el2("sm", fmtWhen(s.updatedAt) + " · " + s.count + " 条"));
    sessList.appendChild(li);
  });
}

function refreshSessions() {
  return fetch("/api/sessions").then((r) => r.json()).then((d) => {
    lastSessions = d.sessions || [];
    renderSessList();
  }).catch(() => {});
}

function openSession(id) {
  activeId = id;
  lsSet(ACTIVE_KEY, id);
  return fetch("/api/sessions/" + encodeURIComponent(id))
    .then((r) => (r.ok ? r.json() : null)).then((d) => {
      msgs = (d && d.messages) || [];
      clearTurns();
      if (!msgs.length) { hero.style.display = ""; renderSessList(); return; }
      hero.style.display = "none";
      /* 重绘历史：渲染函数不写 msgs（它已是服务端数据的镜像） */
      msgs.forEach((m) => {
        if (m.role === "user") addUser(m.text, m.ts);
        else addBotMessage(m.text, m.ts);
      });
      scroll(true);
      renderSessList();
    }).catch(() => {});
}

function delSession(id) {
  if (busy) return;
  if (!window.confirm("删除这个会话？不可恢复。")) return;
  fetch("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" })
    .then(() => refreshSessions())
    .then(() => {
      if (id !== activeId) return;
      if (lastSessions.length) return openSession(lastSessions[0].id);
      activeId = "";
      lsSet(ACTIVE_KEY, "");
      startFresh();
    }).catch(() => {});
}

function startFresh() {
  activeId = uuid();
  lsSet(ACTIVE_KEY, activeId);
  msgs = [];
  clearTurns();
  hero.style.display = "";
  renderSessList();
  input.focus();
}

sessList.addEventListener("click", (e) => {
  const del = e.target.closest("button[data-del]");
  if (del) { delSession(del.dataset.del); return; }
  const li = e.target.closest("li[data-id]");
  if (li && !busy) openSession(li.dataset.id);
});

async function doNewSession() {
  if (busy) return;
  /* 当前会话还没说过话：不重复建档，光标归位即可 */
  if (!msgs.length) { input.focus(); return; }
  startFresh();
}
document.getElementById("newSession").addEventListener("click", doNewSession);
document.getElementById("newSessionM").addEventListener("click", doNewSession);

/* ── 设置弹窗：教务账号 + DeepSeek API Key（后端走 /key 同一套加密热生效）── */
const overlay = document.getElementById("overlay");
const sUser = document.getElementById("sUser");
const sPass = document.getElementById("sPass");
const sKey = document.getElementById("sKey");
const setMsg = document.getElementById("setMsg");
let setStatus = null;
function showSettings() {
  overlay.hidden = false;
  setMsg.className = "setmsg";
  setMsg.textContent = "";
  sPass.value = ""; sKey.value = "";
  fetch("/api/settings").then((r) => r.json()).then((d) => {
    setStatus = d;
    sUser.value = "";
    sUser.placeholder = d.jwgl.username || "教务系统学号";
    sPass.placeholder = d.jwgl.configured ? "已保存，留空不修改" : "教务系统登录密码";
    document.getElementById("curJwgl").textContent = d.jwgl.configured
      ? "当前：学号 " + d.jwgl.username + "（" + d.jwgl.sourceLabel + "）"
      : "当前：未配置教务账号";
    document.getElementById("curKey").textContent = d.deepseek.configured
      ? "当前：" + (d.deepseek.masked || "已配置") + "（" + d.deepseek.sourceLabel + "）· 模型 " + d.model
      : "当前：未配置 API Key · 模型 " + d.model;
    sKey.placeholder = "sk-…（留空不修改）";
    (d.jwgl.configured ? sPass : sUser).focus();
  }).catch(() => { setMsg.textContent = "读取设置失败：本地服务没在跑？"; });
}
function hideSettings() { overlay.hidden = true; }
document.getElementById("openSettings").addEventListener("click", showSettings);
document.getElementById("openSettingsM").addEventListener("click", showSettings);
document.getElementById("closeSettings").addEventListener("click", hideSettings);
document.getElementById("cancelSettings").addEventListener("click", hideSettings);
overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) hideSettings(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !overlay.hidden) hideSettings();
});
document.getElementById("saveSettings").addEventListener("click", () => {
  const body = {};
  const u = sUser.value.trim(), pw = sPass.value, k = sKey.value.trim();
  if (pw) {
    /* 只改密码时自动带上现有学号，免得来回填 */
    body.jwglPassword = pw;
    body.jwglUsername = u || (setStatus && setStatus.jwgl.username) || "";
  } else if (u) {
    setMsg.className = "setmsg";
    setMsg.textContent = "只改学号不行：请连同新密码一起提交";
    return;
  }
  if (k) body.apiKey = k;
  if (!Object.keys(body).length) { hideSettings(); return; }
  const saveBtn = document.getElementById("saveSettings");
  saveBtn.disabled = true;
  fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json().then((d) => ({ ok: r.ok, d }))).then(({ ok, d }) => {
    saveBtn.disabled = false;
    setMsg.className = "setmsg" + (ok ? " good" : "");
    setMsg.textContent = (d.results || []).map((x) => x.message).join("\\n");
    if (ok) setTimeout(hideSettings, 900);
  }).catch(() => {
    saveBtn.disabled = false;
    setMsg.textContent = "保存失败：本地服务没在跑？";
  });
});

/* ── 启动：拉会话列表，进上次打开的会话（没有就进最近一个）── */
refreshSessions().then(() => {
  const pick = lastSessions.find((s) => s.id === activeId) || lastSessions[0];
  if (pick) return openSession(pick.id);
  activeId = "";
  lsSet(ACTIVE_KEY, "");
  renderSessList();
});

async function send(text) {
  if (!text || busy) return;
  busy = true;
  lastPrompt = text;
  hero.style.display = "none";
  const t0 = Date.now();
  msgs.push({ role: "user", text, ts: t0 });
  addUser(text, t0);
  const shell = addBotShell();
  shell.msg.classList.add("cursor");
  btn.classList.add("stop");
  btn.innerHTML = '停止<span class="kbd">⏎</span>';
  let raw = "";
  controller = new AbortController();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, sessionId: activeId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "HTTP " + res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.t === "text") {
          if (!raw) shell.tm.textContent = clock(Date.now());
          raw += ev.v;
          renderStreaming(shell.msg, raw);
        } else if (ev.t === "tool") {
          if (ev.phase === "start") toolCard(shell, ev);
          else toolDone(shell, ev, ev.phase === "end");
        } else if (ev.t === "err") {
          lineBad(shell.tl, ev.v);
        } else if (ev.t === "end") {
          if (ev.dur != null) shell.dur.textContent = "· " + (ev.dur / 1000).toFixed(1) + "s";
          /* 服务端可能把无名新会话建档成 default 档：认领回来的 id */
          if (ev.sid) { activeId = String(ev.sid); lsSet(ACTIVE_KEY, activeId); }
        }
      }
    }
    /* 完整跑完的一轮才写进本地镜像（和服务端落盘同一口径）。
       定格在流式已有的气泡上——再建一行会留下空行+重复回复 */
    if (raw.trim()) {
      const html = renderMd(raw);
      if (html != null) shell.msg.innerHTML = html;
      else shell.msg.textContent = raw;
      addCopyButton(shell.acts, raw);
      msgs.push({ role: "bot", text: raw, ts: Date.now() });
    } else {
      shell.msg.textContent = "这轮没有输出，再问一次试试";
    }
  } catch (e) {
    shell.tm.textContent = clock(Date.now());
    if (e.name === "AbortError") {
      /* 用户中断：显示已生成的半截，但不进历史（同服务端口径） */
      if (raw.trim()) {
        const html = renderMd(raw);
        if (html != null) shell.msg.innerHTML = html;
        else shell.msg.textContent = raw;
        lineBad(shell.tl, "已中断", "⏸");
      } else {
        shell.msg.textContent = "已中断";
      }
    } else {
      lineBad(shell.tl, String(e.message || e));
      if (!raw.trim()) shell.msg.textContent = "这轮没有输出，再问一次试试";
      /* 失败给一键重试（中断不给：是用户主动停的） */
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "tbtn";
      retry.textContent = "重试本轮";
      retry.addEventListener("click", () => { if (!busy) send(lastPrompt); });
      shell.acts.appendChild(retry);
    }
  } finally {
    shell.msg.classList.remove("cursor");
    busy = false; controller = null;
    btn.classList.remove("stop");
    btn.innerHTML = '发送<span class="kbd">⏎</span>';
    syncBtn();
    /* 标题可能挂着完成提醒；切走了就补一次亮灯 */
    if (document.hidden) document.title = "● 回复完成 · CourseRaptor";
    refreshSessions();
    input.focus();
  }
}

/* ── 输入区：textarea 自适应高度；Enter 发送、Shift+Enter 换行；
   进行中再按 = 中断（按钮同样）；空文时发送键落灰 ─────────── */
const form = document.getElementById("f");
function fit() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}
/* 空内容时发送键禁用；流式进行中永远可点（此时它是「停止」） */
function syncBtn() {
  btn.disabled = !busy && !input.value.trim();
}
input.addEventListener("input", () => { fit(); syncBtn(); });
syncBtn();
input.addEventListener("keydown", (e) => {
  /* 中文输入法组词中的 Enter 是确认候选词，不是发送（keyCode 229 = 组词中） */
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) { controller?.abort(); return; }
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  fit();
  send(text);
});

/* 切回本页时复位标题（后台完成时的 ● 提示只留到看见为止） */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) document.title = "CourseRaptor";
});
input.focus();
</script>
</body>
</html>`;
}
