/**
 * 会话自动命名 — 让模型给对话起一个像样的标题
 *
 * 旧版标题是「首问截 24 个字」，列表里全是断在半截的句子。这里在每轮
 * 完整落盘后，把该会话最近几条消息交给模型，换一个 2~8 字的主题式标题
 * （如「高数重修咨询」「通识学分盘点」）。
 *
 * 网页（web/chat-web）与 QQ 桥（qq/bridge）写的是同一份会话档案，命名
 * 也走这里同一个注册表：QQ 渠道的标题保留「QQ｜」前缀，模型只定主题。
 *
 * 约束：
 * - 命名发生在轮次结束、appendRound 落盘之后：人工改过名（titleSet 置位）
 *   的会话从此让位；其余每轮都可重新定题——话题会演进，标题跟着走；
 * - 命名是尽力而为：maker 未装配、联网失败、返回为空/超长都静默放弃，
 *   保留首问兜底标题，绝不影响对话主流程；
 * - maker 可注入（installDefaultTitleMaker 装配真实模型实现，测试注入替身不联网）。
 */

import { getSession, type StoredMessage, setAutoTitle } from "./chat-sessions";

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

// ── maker 注册表：主程序装配真实实现，测试注入替身 ──────────────

/** 当前装配的命名实现；null 时（测试未注入/主程序未装配）自动命名静默关闭 */
let titleMaker: TitleMaker | null = null;

export function setTitleMaker(maker: TitleMaker | null): void {
  titleMaker = maker;
}

/**
 * 一轮完整落盘后调用（网页与 QQ 共用）：会话尚未人工定题（titleSet 未置）
 * 才交给模型命名。尽力而为——maker 缺席、联网失败、输出不合形状都直接放弃，
 * 标题保持首问兜底，绝不影响对话主流程，也不抛错打断落盘链。
 */
export async function maybeAutoTitle(
  sessionId: string,
  opts: { titlePrefix?: string } = {},
): Promise<void> {
  if (!titleMaker) return;
  try {
    const s = getSession(sessionId);
    if (!s || s.titleSet || !s.messages.length) return;
    const raw = await titleMaker({
      messages: s.messages.map(({ role, text }) => ({ role, text })),
    });
    const title = cleanTitle(raw);
    if (title) setAutoTitle(sessionId, title, opts.titlePrefix);
  } catch {
    // 命名失败无关紧要：兜底标题还在
  }
}

/**
 * 装配真实的模型命名实现：直调模型 API（不带工具）。嵌入模式由 index.ts
 * 调、独立跑桥（npm run qq）由入口调——两个入口写的是同一份档案，标题
 * 也该由同一个模型来定。失败静默，标题还有首问兜底。
 */
export async function installDefaultTitleMaker(): Promise<void> {
  const { generateText } = await import("ai");
  const { createDeepSeek } = await import("@ai-sdk/deepseek");
  const { config } = await import("./config");
  const deepseek = createDeepSeek(
    config.deepseekBaseUrl ? { baseURL: config.deepseekBaseUrl } : {},
  );
  setTitleMaker(async (input) => {
    const result = await generateText({
      model: deepseek(config.model),
      prompt: buildTitlePrompt(input.messages),
      maxOutputTokens: 30,
      abortSignal: AbortSignal.timeout(15_000),
    });
    return result.text;
  });
}
