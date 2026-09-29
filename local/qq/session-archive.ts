/**
 * QQ 消息 → 网页历史档案的映射（纯函数，不引 SDK、不碰网络，便于单测）
 *
 * QQ 桥原本只在内存里给每个发送者留 20 条滑动窗口，进程一退就没了，
 * 网页侧栏也就看不到 QQ 里的对话。这里把「哪条 QQ 消息该进哪个档案、
 * 档案叫什么」一次算清楚，交给 chat-sessions.appendRound 落盘。
 *
 * 归档粒度：
 * - 私聊（c2c）/频道私信（dm）→ 每个发送者一档
 * - 群聊（group）→ 每个群一档（群里多人发言，提问前补 [昵称] 才看得清是谁）
 * - 频道（guild）→ 每个频道一档
 *
 * 只落盘、不回读：QQ 侧的模型上下文照旧走自己的内存窗口，网页里删掉
 * 或改出一条 QQ 档都不会影响 QQ 对话，反之亦然。
 */

import { createHash } from "node:crypto";

/** 与 SDK 的 InboundMessage.kind 对齐；拿不到时按私聊处理 */
export type QqChatKind = "c2c" | "group" | "guild" | "dm";

/** 映射需要的几个消息字段（结构上兼容 SDK 的入站消息，不硬依赖其类型） */
export interface QqArchiveInput {
  kind?: string;
  senderId?: string;
  senderName?: string;
  content?: string;
  groupOpenid?: string;
  channelId?: string;
  guildId?: string;
}

/** 一个归档落点：写哪个档案、标题前缀、落盘显示的提问文本 */
export interface QqArchiveSlot {
  /** chat-sessions 的会话 id（qq- 前缀 + 目标摘要，必定落在网页 id 白名单内） */
  id: string;
  /** 建档标题前缀，标记来源渠道 */
  titlePrefix: string;
  /** 群聊/频道带 [昵称] ，私聊原样 */
  userText: string;
}

const ID_PREFIX = "qq-";
/** openid 动辄三四十位且字符集不受控，摘要后固定长度，稳稳落在 SESSION_ID_RE 里 */
const ID_DIGEST_LEN = 20;

const TITLE_PREFIX: Record<QqChatKind, string> = {
  c2c: "QQ",
  group: "QQ群",
  guild: "QQ频道",
  dm: "QQ私信",
};

function kindOf(kind: string | undefined): QqChatKind {
  return kind === "group" || kind === "guild" || kind === "dm" ? kind : "c2c";
}

/** 归档目标键：私聊看人、群聊看群、频道看频道。缺关键字段就退回按人归档 */
function targetKey(kind: QqChatKind, msg: QqArchiveInput): string | null {
  if (kind === "group") {
    const id = msg.groupOpenid || msg.senderId;
    return id ? `group:${id}` : null;
  }
  if (kind === "guild") {
    const id = msg.channelId || msg.guildId || msg.senderId;
    return id ? `guild:${id}` : null;
  }
  const id = msg.senderId;
  return id ? `${kind}:${id}` : null;
}

/** 昵称里可能带换行/方括号，压平一下，别让 [某某] 变成多行或伪标记 */
function flatName(name: string): string {
  return name.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim().slice(0, 16);
}

/**
 * 算出这条 QQ 消息该进哪个档案。没有稳定归属（连 senderId 都没有）时返回
 * null，调用方跳过落盘——宁可少记一条，也不要糊进别人的档案。
 */
export function qqArchiveSlot(msg: QqArchiveInput): QqArchiveSlot | null {
  const kind = kindOf(msg.kind);
  const key = targetKey(kind, msg);
  if (!key) return null;

  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  const text = (msg.content ?? "").trim();
  const name = msg.senderName ? flatName(msg.senderName) : "";
  const multiParty = kind === "group" || kind === "guild";

  return {
    id: ID_PREFIX + digest.slice(0, ID_DIGEST_LEN),
    titlePrefix: TITLE_PREFIX[kind],
    userText: multiParty && name && text ? `[${name}] ${text}` : text,
  };
}
