/**
 * 多会话对话存储 — data/chat-sessions.json（网页与 QQ 共用一份历史）
 *
 * 之前网页对话只有一份内存历史：主程序一重启就全丢（交接文档
 * 「已知取舍」里的头一条）。这个模块把会话变成可管理的档案：
 *
 * - 每个会话 {id,title,createdAt,updatedAt,messages[]}，标题先取
 *   第一条提问的截断兜底，随后由模型命名覆盖（人工改名优先级最高）；
 *   第一条消息发出时才建档（不留空壳会话）
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
import type { ModelMessage } from "ai";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "./atomic-write";
import { dataDir } from "./paths";

function storePath(): string {
  return path.join(dataDir(), "chat-sessions.json");
}

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
  /** 网页上传的附件引用。路径只供本机 Agent 读取；HTTP 接口会在返回前移除。 */
  attachments?: Array<{ id: string; name: string; storedPath: string }>;
  /** 助手消息可选：本轮模型的思考过程（reasoning）。只供界面回看，
   * contextMessages 不读它——把思考喂回去会污染上下文、白烧 token */
  think?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  /** 人工命名后置位：此后自动命名让位（模型命名不置位，标题随话题每轮可更新） */
  titleSet?: boolean;
  pinned?: boolean;
  /** 已归档：不出现在主列表，进归档视图，可随时恢复 */
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

/** 列表接口返回的瘦身元数据（不含正文） */
export interface SessionMeta {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
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

/**
 * 进程内读缓存（按 storePath 键控，写穿）：readSessions 是热路径——一轮
 * 对话至少读 3 次（contextMessages / appendRound / 自动命名），列表接口
 * 在上限规模（30×200 条）下每读一次都是全量 parse。缓存返回同一引用，
 * 调用方的就地修改随 writeSessions 写穿；写盘失败不回滚（改动留在内存，
 * 下次写盘带上——与调用方视角一致，磁盘在成功补写前暂时落后）。
 * 不做写去抖：守住「每轮原子写盘、重启不丢」的承诺，写仅每轮 1-2 次，
 * 不是热路径。RAPTOR_DATA_DIR 变化时键跟着变，测试隔离不受影响。
 */
const readCache = new Map<string, ChatSession[]>();

/** 读坏按 .corrupt- 备份后当空处理；无文件不算错误也不入缓存 */
export function readSessions(): ChatSession[] {
  const file = storePath();
  const cached = readCache.get(file);
  if (cached) return cached;
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      sessions?: unknown[];
    };
    const list = (Array.isArray(parsed.sessions) ? parsed.sessions : []).filter(isValid);
    readCache.set(file, list);
    return list;
  } catch {
    quarantineCorruptFileSync(file);
    return [];
  }
}

function writeSessions(list: ChatSession[]): void {
  try {
    writeFileAtomicSync(
      storePath(),
      JSON.stringify({ savedAt: Date.now(), sessions: list }, null, 2),
    );
    // 写穿：落盘成功才更新缓存，读方与磁盘始终一致
    readCache.set(storePath(), list);
  } catch (e) {
    console.error("[chat-sessions] 保存失败:", e);
  }
}

/* 排序：置顶最前、按最近活跃；归档的沉到末尾（主列表在前端按标记过滤，
   全量返回时也让归档条目天然落在列表尾部） */
const byRecent = (a: ChatSession, b: ChatSession): number =>
  Number(!!a.archived) - Number(!!b.archived) ||
  Number(!!b.pinned) - Number(!!a.pinned) ||
  b.updatedAt - a.updatedAt;

/** 一行标题：压成空格并截断（24 字，侧栏两行内可见全）；渠道前缀（如「QQ」）拼在最前面 */
function titleOf(text: string, prefix?: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const topic = flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
  const p = prefix?.trim();
  return p ? `${p}｜${topic}` : topic;
}

/** 思考文本入库前的收口：空→null，超长→截断（只为界面回看，不必完整） */
function clampThink(text: string | null | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  return t.length > MAX_THINK_CHARS ? `${t.slice(0, MAX_THINK_CHARS)}…（思考内容过长，已截断）` : t;
}

export function listSessions(): SessionMeta[] {
  return readSessions()
    .sort(byRecent)
    .map((s) => ({
      id: s.id,
      title: s.title || "新会话",
      pinned: !!s.pinned,
      archived: !!s.archived,
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

/** 修改会话的人工标题、置顶或归档状态。空标题不会覆盖现有标题。 */
export function updateSession(
  id: string,
  patch: { title?: string; pinned?: boolean; archived?: boolean },
): ChatSession | null {
  const list = readSessions();
  const session = list.find((s) => s.id === id);
  if (!session) return null;
  if (typeof patch.title === "string") {
    const title = titleOf(patch.title);
    if (!title) return null;
    session.title = title;
    session.titleSet = true; // 人工命名优先级最高，自动命名从此让位
  }
  if (typeof patch.pinned === "boolean") session.pinned = patch.pinned;
  if (typeof patch.archived === "boolean") session.archived = patch.archived;
  writeSessions(list.sort(byRecent));
  return session;
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
  opts: {
    titlePrefix?: string;
    attachments?: Array<{ id: string; name: string; storedPath: string }>;
  } = {},
): void {
  const list = readSessions();
  let s = list.find((x) => x.id === id);
  if (!s) {
    s = { id, title: "", createdAt: Date.now(), updatedAt: 0, messages: [] };
    list.push(s);
  }
  const now = Date.now();
  s.messages.push({
    role: "user",
    text: userText,
    ts: now,
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
  });
  if (assistantText?.trim()) {
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

/**
 * 模型命名写入：只在会话尚未人工定题（titleSet 未置）时生效，模型命名
 * 不置位——话题演进后下一轮还能跟着更新。prefix 给非网页渠道保留标记
 * （QQ 桥传「QQ」/「QQ群」）：标题形如「QQ｜高数答疑」。
 * 兜底规则：命名失败或返回空时不被调用，标题保持「首问截断」，
 * 绝不静默清空已有标题；置顶过的会话同样尊重 titleSet。
 */
export function setAutoTitle(id: string, title: string, prefix?: string): ChatSession | null {
  const list = readSessions();
  const s = list.find((x) => x.id === id);
  if (!s || s.titleSet) return null;
  const t = titleOf(title, prefix);
  if (!t) return null;
  s.title = t;
  writeSessions(list.sort(byRecent));
  return s;
}

/** 本轮发给 Agent 的上下文：最后 CONTEXT_WINDOW 条，转 ModelMessage 形状。
 *  只读 text——助手消息上的 think（思考过程）刻意不回流给模型 */
export function contextMessages(id: string): ModelMessage[] {
  const s = getSession(id);
  if (!s) return [];
  return s.messages.slice(-CONTEXT_WINDOW).map(
    (m): ModelMessage =>
      m.role === "user"
        ? {
            role: "user",
            content:
              m.text +
              (m.attachments?.length
                ? `\n\n${m.attachments
                    .map((a) => `[网页附件：${a.name}；本机路径：${a.storedPath}]`)
                    .join("\n")}`
                : ""),
          }
        : { role: "assistant", content: [{ type: "text", text: m.text }] },
  );
}

/** 清空全部会话档案（/api/reset 背后，UI 不挂按钮，留给自救与测试） */
export function resetAll(): void {
  writeSessions([]);
}
