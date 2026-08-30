/**
 * 多会话对话存储 — data/chat-sessions.json（网页与 QQ 共用一份历史）
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
 * - 写入方有两个：网页（读写都走这里）和 QQ 桥（只往里落盘，上下文仍用
 *   自己那份内存窗口）。QQ 档 id 由 src/qq/session-archive.ts 生成，
 *   统一带 qq- 前缀，与网页的 uuid/default 天然不串档
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
  /** 助手消息可选：本轮模型的思考过程（reasoning）。只供界面回看，
   * contextMessages 不读它——把思考喂回去会污染上下文、白烧 token */
  think?: string;
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
/** 单轮思考文本落盘上限（字）：思考只给人在界面上回看，超长尾部截断即可，
 *  不然一次深思考几千字会把会话档案文件撑肥 */
export const MAX_THINK_CHARS = 4000;
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

/** 一行标题：首问压成空格并截断；渠道前缀（如「QQ」）拼在最前面 */
function titleOf(text: string, prefix?: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const topic = flat.length > 24 ? flat.slice(0, 24) + "…" : flat;
  const p = prefix?.trim();
  return p ? `${p}｜${topic}` : topic;
}

/** 思考文本入库前的收口：空→null，超长→截断（只为界面回看，不必完整） */
function clampThink(text: string | null | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  return t.length > MAX_THINK_CHARS
    ? `${t.slice(0, MAX_THINK_CHARS)}…（思考内容过长，已截断）`
    : t;
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

/** 完整的一轮问答入库（回答为空只存提问）；会话不存在则建档。
 *  reasoningText 是本轮模型的思考过程：挂在 assistant 消息的 think 字段上
 *  供界面回看，不单独成条、不进上下文。没有正文的半截轮次照旧不入库。
 *  opts.titlePrefix 给非网页渠道标记来源（QQ 桥传「QQ」/「QQ群」）：只在
 *  建档那一刻跟着首问拼进标题，已有标题的会话不会被改写。 */
export function appendRound(
  id: string,
  userText: string,
  assistantText: string | null,
  reasoningText?: string | null,
  opts: { titlePrefix?: string } = {},
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
    const msg: StoredMessage = { role: "assistant", text: assistantText.trim(), ts: now };
    const think = clampThink(reasoningText);
    if (think) msg.think = think;
    s.messages.push(msg);
  }
  if (!s.title) {
    const firstUser = s.messages.find((m) => m.role === "user");
    if (firstUser) s.title = titleOf(firstUser.text, opts.titlePrefix);
  }
  if (s.messages.length > MAX_STORED_MSGS) {
    s.messages = s.messages.slice(-MAX_STORED_MSGS);
  }
  s.updatedAt = now;
  writeSessions(list.sort(byRecent).slice(0, MAX_SESSIONS));
}

/** 本轮发给 Agent 的上下文：最后 CONTEXT_WINDOW 条，转 ModelMessage 形状。
 *  只读 text——助手消息上的 think（思考过程）刻意不回流给模型 */
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
