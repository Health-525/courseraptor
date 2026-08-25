/**
 * QQ 官方机器人桥：把 CourseRaptor agent 接入 QQ（官方开放平台路线）
 *
 * 启动：npm run qq（需在 .env 配置 QQBOT_APP_ID / QQBOT_APP_SECRET）
 *
 * - 传输：官方 SDK @tencent-connect/qqbot-nodejs（WebSocket + 心跳 + RESUME）
 * - 场景：单聊（C2C）直接对话；群聊需 @机器人 触发（mentionGate）
 * - 授权：白名单制。官方平台只给 openid（非 QQ 号），首次使用发送
 *   暗号（QQBOT_PASSCODE）激活，openid 落盘 qq-allowlist.json
 * - 会话：每发送者独立历史（内存滑动窗口 20 条）；
 *   注意与终端 TUI 共用 session.json 捕获，二者勿同时长跑
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ModelMessage } from "ai";
import {
  QQBot,
  errorHandler,
  messageFilter,
  contentSanitizer,
  mentionGate,
  accessPolicy,
  concurrencyGuard,
} from "@tencent-connect/qqbot-nodejs";

import { config, PROJECT_ROOT } from "../config";
import { createRaptorAgent } from "../agent";
import { mdToPlain, splitMessage } from "./format";

// ── 授权：白名单 + 暗号激活 ────────────────────────────────────

const ALLOWLIST_FILE = path.join(PROJECT_ROOT, "qq-allowlist.json");
const allowedOpenids = new Set<string>();

async function loadAllowlist(): Promise<void> {
  try {
    const data = JSON.parse(await fs.readFile(ALLOWLIST_FILE, "utf8"));
    for (const id of Array.isArray(data.openids) ? data.openids : []) {
      allowedOpenids.add(String(id));
    }
  } catch {
    /* 首次运行为空 */
  }
}

async function saveAllowlist(): Promise<void> {
  await fs.writeFile(
    ALLOWLIST_FILE,
    JSON.stringify({ openids: [...allowedOpenids] }, null, 2),
    "utf8"
  );
}

// ── 会话历史（每发送者独立，滑动窗口）─────────────────────────

const MAX_HISTORY_TURNS = 20;
const histories = new Map<string, ModelMessage[]>();

// ── Markdown -> QQ 纯文本（见 ./format.ts）────────────────────

// ── 主流程 ────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!config.qqBotAppId || !config.qqBotAppSecret) {
    throw new Error(
      "缺少 QQ 机器人配置：请在 .env 填写 QQBOT_APP_ID / QQBOT_APP_SECRET（q.qq.com 开放平台获取）"
    );
  }
  await loadAllowlist();
  const agent = await createRaptorAgent();

  const bot = new QQBot({
    appId: config.qqBotAppId,
    appSecret: config.qqBotAppSecret,
    logger: console,
  });

  bot.use(errorHandler());
  bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5000 } }));
  bot.use(contentSanitizer({ stripBotMention: true }));
  bot.use(mentionGate({ requireMentionInGroup: true }));
  bot.use(
    accessPolicy({
      c2c: { mode: "allowlist", allow: [(ctx) => allowedOpenids.has(ctx.message.senderId)] },
      group: { mode: "allowlist", allow: [(ctx) => allowedOpenids.has(ctx.message.senderId)] },
      onBlock: (ctx) =>
        console.log(`[access] 拦截未授权消息 sender=${ctx.message.senderId}`),
    })
  );
  bot.use(concurrencyGuard());

  bot.on("message", async (ctx, msg) => {
    const senderId = msg.senderId;

    // 未授权：暗号激活或拒绝
    if (!allowedOpenids.has(senderId)) {
      if (config.qqBotPasscode && msg.content.trim() === config.qqBotPasscode) {
        allowedOpenids.add(senderId);
        await saveAllowlist();
        console.log(`[auth] 新授权 openid=${senderId}`);
        await bot.sendText(
          msg.replyTarget,
          "✅ 已授权，迅猛龙上线！直接说需求即可：查课表 / 盯课 / 抢课 / 读教务通知。"
        );
      } else {
        await bot.sendText(
          msg.replyTarget,
          "⛔ 未授权。首次使用请发送激活暗号（管理员在 .env 的 QQBOT_PASSCODE 中设置）。"
        );
      }
      return;
    }

    const text = msg.content.trim();
    if (!text) return;

    const history = histories.get(senderId) ?? [];
    const userMsg: ModelMessage = { role: "user", content: text };
    try {
      const result = await agent.generate({
        messages: [...history, userMsg],
      });
      const reply = mdToPlain(result.text || "（无输出）");
      for (const seg of splitMessage(reply)) {
        await bot.sendText(msg.replyTarget, seg);
      }
      const assistantMsg: ModelMessage = {
        role: "assistant",
        content: result.text,
      };
      histories.set(
        senderId,
        [...history, userMsg, assistantMsg].slice(-MAX_HISTORY_TURNS)
      );
    } catch (e) {
      await bot.sendText(
        msg.replyTarget,
        `❌ 处理失败：${(e as Error).message.slice(0, 120)}`
      );
    }
  });

  await bot.start();
  console.log("🦖 CourseRaptor QQ 桥已启动（官方机器人 · WebSocket）");
  console.log(`已授权用户：${allowedOpenids.size} 个（暗号激活：发送 QQBOT_PASSCODE）`);
}

await main();
