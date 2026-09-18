/**
 * 会话自动命名 — 让模型给对话起一个像样的标题
 *
 * 旧版标题是「首问截 24 个字」，列表里全是断在半截的句子。这里在每轮
 * 完整落盘后，把该会话最近几条消息交给模型，换一个 2~8 字的主题式标题
 * （如「高数重修咨询」「通识学分盘点」）。
 *
 * 约束：
 * - 命名发生在轮次结束、appendRound 落盘之后：标题未定（titleSet 未置）
 *   才写，人工改过名/模型已命过名的会话不再覆盖；
 * - 命名是尽力而为：agent 未就绪、联网失败、返回为空/超长都静默放弃，
 *   保留首问兜底标题，绝不影响对话主流程；
 * - maker 可注入（index.ts 装配真实模型实现，测试注入替身不联网）。
 */

import type { StoredMessage } from "../chat-sessions";

export interface TitleMakerInput {
  /** 最近几轮的消息（时间正序，取自会话存档） */
  messages: Array<Pick<StoredMessage, "role" | "text">>;
}

export type TitleMaker = (input: TitleMakerInput) => Promise<string | null>;

const TITLE_PROMPT = `根据下面的对话内容，用一个极简的中文短语概括这个会话的主题。

要求：
- 2~8 个字，像档案卷宗的标题（例：高数答疑 / 通识学分盘点 / 选课策略 / 实验报告排版）
- 概括整个会话在聊什么，不要复述原句，不要引号、标点或解释
- 只输出标题本身，不要任何前后缀`;

/** 送给命名 maker 的窗口：首轮问答就够定题，多轮会话取最近的几条 */
const TITLE_WINDOW = 6;

export function buildTitlePrompt(messages: Array<Pick<StoredMessage, "role" | "text">>): string {
  const recent = messages
    .slice(-TITLE_WINDOW)
    .filter((m) => m.text?.trim())
    .map(
      (m) =>
        `${m.role === "user" ? "用户" : "助手"}：${m.text.replace(/\s+/g, " ").trim().slice(0, 200)}`,
    )
    .join("\n");
  return `${TITLE_PROMPT}\n\n${recent}`;
}

/** 收口模型输出：去引号/空白，超出短语的返回 null（宁可不改也不要烂标题） */
export function cleanTitle(raw: string | null | undefined): string | null {
  const t = String(raw ?? "")
    .replace(/["'「」『』《》“”]/g, "")
    .replace(/^[：:\s]+|[：:\s.。]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  if (t.length > 12) return null;
  return t;
}
