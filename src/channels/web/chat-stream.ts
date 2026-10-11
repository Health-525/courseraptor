/** 对话流：POST /api/chat 的 SSE 轮次（会话串行化排队、请求体解析、上传预解析、
 *  fullStream 事件转发落盘），以及 URL 会话 id 段的解码与白名单校验。 */

import type http from "node:http";
import type { ModelMessage } from "ai";
import { type AttachmentResult, openLocalFile } from "../../core/attachments";
import { appendRound, contextMessages, DEFAULT_ID } from "../../core/chat-sessions";
import { pptPreviewOfToolOutput } from "../../core/document/pptx-theme";
import { maybeAutoTitle } from "../../core/session-titles";
import { getUploads, type WebUpload } from "../../core/workspace-data";
import { agentProvider, type ChatStreamableAgent } from "./web-agent-gate";
import { json } from "./web-http";
import {
  deltaOf,
  filesOfToolOutput,
  NEED_SETUP_RE,
  openPanelIdOf,
  pomodoroOfToolOutput,
  previewJson,
  type StreamEvent,
  summarizeResult,
} from "./web-tool-events";

// ── 轮次串行化 ──────────────────────────────────────────────

/** 按会话串行化：同一会话上一轮没跑完时新请求排队，避免并发把会话文件写花。
 * 跨会话不互相排队——此前全局单链会让长耗时轮次把
 * 另一个标签页的普通提问整个卡住。落盘（appendRound 等）是同步原子写，
 * 不同会话交错追加不会丢数据。轮次结束后删键，Map 不随会话数增长。 */
const sessionTurns = new Map<string, Promise<void>>();

export async function jsonBody(
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

export const SESSIONS_PREFIX = "/api/sessions/";
/** 会话 id 白名单：uuid/十六进制/default。注意必须放行字母——无 sessionId
 * 的对话落 default 档，只收十六进制会让侧栏点击默认档被误判非法而 404 */
export const SESSION_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
export const sidOf = (v: unknown): string =>
  typeof v === "string" && SESSION_ID_RE.test(v) ? v : DEFAULT_ID;

/** 解码 URL 里的会话 id 段。半截百分号编码（如「/api/sessions/%」）会让
 * decodeURIComponent 抛 URIError——按无效会话返回 null（404），绝不让它
 * 变成未处理 rejection 把整个服务带崩（Node 24 默认直接退出进程）。 */
export function decodeSessionSegment(url: string): string | null {
  try {
    return decodeURIComponent(url.slice(SESSIONS_PREFIX.length));
  } catch {
    return null;
  }
}

export async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
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

  // 排队执行：对本会话的存档读写做串行化。本轮全部事件发完后必须 res.end()
  // 关闭 SSE——不关的话浏览器/测试的 reader 永远等不到流结束
  const prev = sessionTurns.get(sessionId) ?? Promise.resolve();
  const next = prev
    .then(() => runTurn(agent, sessionId, message, uploads, send, abort.signal))
    .catch(() => {})
    .finally(() => {
      if (sessionTurns.get(sessionId) === next) sessionTurns.delete(sessionId);
      if (!res.writableEnded) res.end();
    });
  sessionTurns.set(sessionId, next);
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

/** 课表导入用的附件 → 纯文本：表格给数据行（表头+预览行），长文给全文；不支持解析的格式给空 */
export function importTextOf(result: AttachmentResult): string {
  if (result.mode === "text") return result.text;
  if (result.mode === "table") return result.sheets.map((s) => s.preview.join("\n")).join("\n\n");
  if (result.mode === "search") return result.matches.join("\n");
  if (result.mode === "firecrawl") return result.markdown;
  return "";
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
          const ppt = pptPreviewOfToolOutput(p.output);
          // open_panel：模型点名的面板随事件带给前端自动推出（同 NEED_SETUP 的 panel 通道）
          const openPanel = openPanelIdOf(p.toolName, t0?.input);
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
            // pptx 成品带预览载荷：前端渲染可翻页的幻灯片预览卡
            ...(ppt ? { ppt } : {}),
            // manage_pomodoro 的取消/查询也可能改了状态：让页面把
            // 顶部恢复卡等处的倒计时卡对表收掉（10 秒轮询的即时版）
            ...(p.toolName === "manage_pomodoro" ? { pomoSync: true } : {}),
            ...(openPanel ? { panel: openPanel } : {}),
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
