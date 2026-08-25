/**
 * 短期记忆：会话历史的捕获与恢复（session.json）
 *
 * 实现方式：agent.ts 用 wrapLanguageModel 中间件在每次模型调用时
 * 捕获完整 prompt（TUI 的对话是无状态重放的，最后一次调用即全量对话），
 * 逐轮落盘；下次启动时把上次会话转写为对话记录注入系统提示词，
 * 实现跨重启的短期记忆延续。
 */

import fs from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT } from "../config";

const SESSION_FILE = path.join(PROJECT_ROOT, "session.json");
const MAX_PERSIST_MESSAGES = 200;
const MAX_TRANSCRIPT_CHARS = 3000;

interface CapturedMessage {
  role: string;
  content: unknown;
}

let writeChain: Promise<void> = Promise.resolve();

/** 由模型中间件每轮调用；落盘当前完整对话（去掉 system，限量） */
export function captureSessionPrompt(prompt: unknown): void {
  if (!Array.isArray(prompt)) return;
  const messages = prompt
    .filter(
      (m): m is CapturedMessage =>
        !!m && typeof (m as CapturedMessage).role === "string" &&
        (m as CapturedMessage).role !== "system"
    )
    .slice(-MAX_PERSIST_MESSAGES);
  if (messages.length === 0) return;

  // 串行化写入，避免并发覆盖
  writeChain = writeChain
    .then(() =>
      fs.writeFile(
        SESSION_FILE,
        JSON.stringify(
          { savedAt: new Date().toISOString(), messages },
          null,
          2
        ),
        "utf8"
      )
    )
    .catch(() => {
      /* 落盘失败不影响对话 */
    });
}

/** 兜底：进程正常退出前确保最后一轮已落盘（写入本身是逐轮即时做的） */
export async function flushCapturedSession(): Promise<void> {
  await writeChain;
}

/** 从消息 content（string 或 parts 数组）提取纯文本 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { text: string } =>
        !!p && typeof p === "object" && (p as { type?: string }).type === "text"
    )
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join(" ");
}

interface SavedSession {
  savedAt?: string;
  messages?: CapturedMessage[];
}

/** 读取上次会话并转写为注入提示词的区块 */
export async function loadLastSessionTranscript(): Promise<string> {
  let data: SavedSession;
  try {
    data = JSON.parse(await fs.readFile(SESSION_FILE, "utf8"));
  } catch {
    return "";
  }
  const messages = Array.isArray(data.messages) ? data.messages : [];
  if (messages.length === 0) return "";

  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = extractText(m.content);
    if (!text) continue;
    lines.push(`${m.role === "user" ? "你" : "🦖"}: ${text}`);
  }
  if (lines.length === 0) return "";

  let transcript = lines.join("\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript =
      "…（更早已截断）\n" +
      transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS);
  }
  const savedAt = data.savedAt ? new Date(data.savedAt).toLocaleString("zh-CN") : "未知时间";
  return `## 上次会话记录（${savedAt}，短期记忆自动恢复）\n\n${transcript}`;
}
