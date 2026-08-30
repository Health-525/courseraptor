/**
 * 网页对话的多会话存储 — data/chat-sessions.json
 *
 * 之前网页对话只有一份内存历史：主程序一重启就全丢（交接文档
 * 「已知取舍」里的头一条）。这个模块把会话变成可管理的档案：
 *
 * - 每个会话 {id,title,createdAt,updatedAt,messages[]}，标题自动取
 *   第一条提问的截断；第一条消息发出时才建档（不留空壳会话）
 * - 每轮完整问答原子写盘，重启不丢；中断/失败的半截照旧不进历史
 * - 给 Agent 的上下文取最后 CONTEXT_WINDOW 条（语义同旧 MAX_HISTORY）
 * - 会话数、单会话消息数都有上限，防文件无限膨胀
 * - RAPTOR_DATA_DIR 可指到临时目录做测试隔离（与 schedule-cache 同款）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelMessage } from "ai";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "./atomic-write";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** 数据目录（测试可用 RAPTOR_DATA_DIR 指到临时目录） */
function dataDir(): string {
  return process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data");
}

function storePath(): string {
  return path.join(dataDir(), "chat-sessions.json");
}

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

/** 列表接口返回的瘦身元数据（不含正文） */
export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
}

export const MAX_SESSIONS = 30;
/** 单会话显示存档上限（条） */
export const MAX_STORED_MSGS = 200;
/** 每轮传给 Agent 的上下文窗口（条）——旧版内存历史的 MAX_HISTORY */
export const CONTEXT_WINDOW = 40;
/** 请求不带 sessionId 时使用（兼容旧行为与既有测试） */
export const DEFAULT_ID = "default";

function isValid(s: unknown): s is ChatSession {
  const o = s as ChatSession;
  return !!o && typeof o.id === "string" && Array.isArray(o.messages);
}

/** 每次现读（本地小文件，读盘代价可忽略）；读坏按 .corrupt- 备份后当空处理 */
export function readSessions(): ChatSession[] {
  if (!fs.existsSync(storePath())) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as {
      sessions?: unknown[];
    };
    return (Array.isArray(parsed.sessions) ? parsed.sessions : []).filter(isValid);
  } catch {
    quarantineCorruptFileSync(storePath());
    return [];
  }
}

function writeSessions(list: ChatSession[]): void {
  try {
    writeFileAtomicSync(
      storePath(),
      JSON.stringify({ savedAt: Date.now(), sessions: list }, null, 2),
    );
  } catch (e) {
    console.error("[chat-sessions] 保存失败:", e);
  }
}

const byRecent = (a: ChatSession, b: ChatSession): number => b.updatedAt - a.updatedAt;

/** 一行标题：首问压成空格并截断 */
function titleOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 24 ? flat.slice(0, 24) + "…" : flat;
}

export function listSessions(): SessionMeta[] {
  return readSessions()
    .sort(byRecent)
    .map((s) => ({
      id: s.id,
      title: s.title || "新会话",
      updatedAt: s.updatedAt,
      count: s.messages.length,
    }));
}

export function getSession(id: string): ChatSession | null {
  return readSessions().find((s) => s.id === id) ?? null;
}

export function deleteSession(id: string): boolean {
  const list = readSessions();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  writeSessions(next);
  return true;
}

/** 完整的一轮问答入库（回答为空只存提问）；会话不存在则建档 */
export function appendRound(
  id: string,
  userText: string,
  assistantText: string | null,
): void {
  const list = readSessions();
  let s = list.find((x) => x.id === id);
  if (!s) {
    s = { id, title: "", createdAt: Date.now(), updatedAt: 0, messages: [] };
    list.push(s);
  }
  const now = Date.now();
  s.messages.push({ role: "user", text: userText, ts: now });
  if (assistantText && assistantText.trim()) {
    s.messages.push({ role: "assistant", text: assistantText.trim(), ts: now });
  }
  if (!s.title) {
    const firstUser = s.messages.find((m) => m.role === "user");
    if (firstUser) s.title = titleOf(firstUser.text);
  }
  if (s.messages.length > MAX_STORED_MSGS) {
    s.messages = s.messages.slice(-MAX_STORED_MSGS);
  }
  s.updatedAt = now;
  writeSessions(list.sort(byRecent).slice(0, MAX_SESSIONS));
}

/** 本轮发给 Agent 的上下文：最后 CONTEXT_WINDOW 条，转 ModelMessage 形状 */
export function contextMessages(id: string): ModelMessage[] {
  const s = getSession(id);
  if (!s) return [];
  return s.messages.slice(-CONTEXT_WINDOW).map((m): ModelMessage =>
    m.role === "user"
      ? { role: "user", content: m.text }
      : { role: "assistant", content: [{ type: "text", text: m.text }] },
  );
}

/** 清空全部会话档案（/api/reset 背后，UI 不挂按钮，留给自救与测试） */
export function resetAll(): void {
  writeSessions([]);
}
