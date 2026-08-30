/**
 * QQ 官方机器人桥：把 CourseRaptor agent 接入 QQ（官方开放平台路线）
 *
 * 两种运行方式：
 * - 嵌入模式（默认）：`raptor` 启动终端 TUI 时自动拉起（日志写文件，
 *   见 src/qq/logger.ts，避免破坏 TUI 渲染）
 * - 独立模式：`npm run qq` 只跑桥（日志走控制台）
 *
 * - 场景：单聊（C2C）直接对话；群聊需 @机器人 触发（mentionGate）
 * - 授权：白名单制。官方平台只给 openid（非 QQ 号），首次使用发送
 *   暗号（QQBOT_PASSCODE）激活，openid 落盘 qq-allowlist.json
 * - 会话：每发送者独立历史（内存滑动窗口 20 条）；每轮问答另外写进
 *   网页那套会话档案（data/chat-sessions.json），侧栏能回看 QQ 里的对话
 */

import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelMessage } from "ai";
import {
  QQBot,
  errorHandler,
  messageFilter,
  contentSanitizer,
  mentionGate,
  concurrencyGuard,
} from "@tencent-connect/qqbot-nodejs";

import { config, PROJECT_ROOT } from "../config";
import { ensureLicense } from "../license";
import { ensureCredentials } from "../onboarding";
import { createRaptorAgent } from "../agent";
import { quarantineCorruptFile, writeFileAtomic } from "../atomic-write";
import { appendRound } from "../chat-sessions";
import { mdToPlain, splitMessage } from "./format";
import { qqArchiveSlot, type QqArchiveInput } from "./session-archive";
import { localOnlyCommandMessage } from "../tui/slash-menu";

type BridgeLogger = Pick<Console, "log" | "info" | "warn" | "error" | "debug">;

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
    // 白名单坏了却静默当空，下次有人激活就会以空集合回写，把已授权的人全清掉
    await quarantineCorruptFile(ALLOWLIST_FILE);
  }
}

async function saveAllowlist(): Promise<void> {
  await writeFileAtomic(
    ALLOWLIST_FILE,
    JSON.stringify({ openids: [...allowedOpenids] }, null, 2)
  );
}

// ── 会话历史（每发送者独立，滑动窗口）─────────────────────────
// 这里只是喂模型的上下文窗口。网页侧栏看到的「历史记录」是另一条线：
// 每轮问答另外写进 chat-sessions（见 src/qq/session-archive.ts 的归档
// 粒度），只写不读——网页里删改 QQ 档不会反过来影响这里的上下文。

const MAX_HISTORY_TURNS = 20;
const histories = new Map<string, ModelMessage[]>();

/**
 * QQ 官方机器人是被动回复，窗口约 5 分钟。而抢课类工具默认要跑 600 秒——
 * 同步等任务跑完再回，用户发出的那条早就过了窗口，结果永远收不到。
 * 所以：先应答、再心跳，保证窗口内始终有消息；任务跑完再推真实结果。
 */
const ACK_DELAY_MS = 4000;
const HEARTBEAT_MS = 100_000;

/** 等待期间的心跳提示；返回停止函数 */
function startWaitingNotices(send: (text: string) => Promise<unknown>): () => void {
  const startedAt = Date.now();
  let beat = 0;
  let timer: ReturnType<typeof setTimeout>;

  const tick = () => {
    beat++;
    const sec = Math.round((Date.now() - startedAt) / 1000);
    const text =
      beat === 1 ? "🦖 收到，正在查…" : `…还在查（已 ${sec} 秒），马上回你`;
    void send(text).catch(() => {});
    timer = setTimeout(tick, HEARTBEAT_MS);
  };
  timer = setTimeout(tick, ACK_DELAY_MS);

  return () => clearTimeout(timer);
}

/**
 * 把技术错误转译成人话，并给出下一步动作。
 * 用户不需要知道 SESSION_EXPIRED 是什么，只需要知道「重试就好」还是「这功能坏了」。
 */
function humanizeError(e: unknown): string {
  const raw = (e as Error)?.message ?? String(e);
  if (/SESSION_EXPIRED|登录|login|未授权/i.test(raw)) {
    return "教务登录态掉了，我正在重新登录。稍等几秒再问一次就好。";
  }
  if (/ETIMEDOUT|ECONN|ENOTFOUND|fetch failed|network|timeout|socket|EOF/i.test(raw)) {
    return "教务系统这会儿连不上，多半是线路抖动。稍等一两分钟再试一次。";
  }
  if (/JSON|parse|解析|Unexpected|结构/i.test(raw)) {
    return "教务页面结构可能变了，这个查询暂时用不了。其他功能不受影响。";
  }
  return "这件事没办成。稍后再试一次，或者换个说法告诉我。";
}

/**
 * 把一轮 QQ 问答写进网页那套会话档案（data/chat-sessions.json）。
 *
 * 只写不读：QQ 的模型上下文照旧走上面的内存窗口，网页里删改这些档案
 * 不会反过来影响 QQ 对话。落盘是附加品，写坏了只记日志，绝不让用户在
 * 那头等不到回复。抽成具名函数是为了能被单测钉住「桥确实会写」。
 */
export function archiveQQRound(
  msg: QqArchiveInput,
  answer: string | null,
  log: BridgeLogger = console
): void {
  const slot = qqArchiveSlot(msg);
  if (!slot) return;
  try {
    appendRound(slot.id, slot.userText, answer, null, {
      titlePrefix: slot.titlePrefix,
    });
  } catch (e) {
    log.error(`[qq] 历史落盘失败：${(e as Error)?.message ?? e}`);
  }
}

// ── 主流程 ────────────────────────────────────────────────────

export async function startQQBridge(
  opts: { logger?: BridgeLogger } = {}
): Promise<void> {
  const log = opts.logger ?? console;

  if (!config.qqBotAppId || !config.qqBotAppSecret) {
    throw new Error(
      "缺少 QQ 机器人配置：请在 .env 填写 QQBOT_APP_ID / QQBOT_APP_SECRET（q.qq.com 开放平台获取）"
    );
  }
  await loadAllowlist();
  // qq 渠道：注入 QQ 排版规则，让模型原生输出纯文本列表
  const agent = await createRaptorAgent("qq");

  const bot = new QQBot({
    appId: config.qqBotAppId,
    appSecret: config.qqBotAppSecret,
    logger: log,
  });

  bot.use(errorHandler());
  bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5000 } }));
  bot.use(contentSanitizer({ stripBotMention: true }));
  bot.use(mentionGate({ requireMentionInGroup: true }));
  bot.use(concurrencyGuard());
  // 白名单不用 accessPolicy 中间件：它会拦截未授权消息，导致
  // 「首条消息发暗号激活」永远走不到；处理器内自带校验 + 激活流程

  // 拒绝回复防刷：每个陌生人只提示一次，避免被刷被动回复额度
  const rejectedNotified = new Set<string>();

  bot.on("message", async (ctx, msg) => {
    const senderId = msg.senderId;

    // 未授权：暗号激活或拒绝
    if (!allowedOpenids.has(senderId)) {
      if (config.qqBotPasscode && msg.content.trim() === config.qqBotPasscode) {
        allowedOpenids.add(senderId);
        await saveAllowlist();
        log.log(`[auth] 新授权 openid=${senderId}`);
        await bot.sendText(
          msg.replyTarget,
          "✅ 已授权，迅猛龙上线！直接说需求即可：查课表 / 盯课 / 抢课 / 读教务通知。"
        );
      } else if (!rejectedNotified.has(senderId)) {
        rejectedNotified.add(senderId);
        await bot.sendText(
          msg.replyTarget,
          "⛔ 未授权。首次使用请发送激活暗号（管理员在 .env 的 QQBOT_PASSCODE 中设置）。"
        );
      }
      return;
    }

    const text = msg.content.trim();
    if (!text) return;

    const localOnlyMessage = localOnlyCommandMessage(text);
    if (localOnlyMessage) {
      await bot.sendText(msg.replyTarget, localOnlyMessage);
      return;
    }

    const history = histories.get(senderId) ?? [];
    const userMsg: ModelMessage = { role: "user", content: text };

    // 网页侧栏的历史记录：私聊每人一档、群聊每群一档（粒度见 session-archive.ts）。
    // 一轮只记一次——成功记整轮问答，失败只留「他在 QQ 里问过这句」
    let archived = false;
    const archive = (answer: string | null): void => {
      if (archived) return;
      archived = true;
      archiveQQRound(msg, answer, log);
    };

    const stopNotices = startWaitingNotices((t) =>
      bot.sendText(msg.replyTarget, t)
    );
    try {
      const result = await agent.generate({
        messages: [...history, userMsg],
      });
      stopNotices();
      const reply = mdToPlain(result.text || "（无输出）");
      // 先留档再发送：分段发送中途被限流，这一轮也已经进得了历史
      archive(result.text || null);
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
      stopNotices();
      // 答砸了也把「他在 QQ 里问过这句」留下：只有提问，跟网页侧同一口径
      archive(null);
      log.error(`[qq] 处理失败（openid=${senderId}）：${(e as Error)?.message ?? e}`);
      await bot.sendText(msg.replyTarget, `❌ ${humanizeError(e)}`);
    }
  });

  await bot.start();
  log.log("🦖 CourseRaptor QQ 桥已启动（官方机器人 · WebSocket）");
  log.log(`已授权用户：${allowedOpenids.size} 个（暗号激活：发送 QQBOT_PASSCODE）`);
}

// 独立入口（npm run qq）时自动启动；被 raptor 嵌入引用时不执行
const isEntry = (() => {
  try {
    return (
      realpathSync(process.argv[1] ?? "").toLowerCase() ===
      realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
    );
  } catch {
    return false;
  }
})();

export interface StandaloneQQDependencies {
  ensureLicense(): Promise<void>;
  ensureCredentials(): Promise<void>;
  startBridge(): Promise<void>;
}

/** 独立 QQ 入口与主程序共用相同的授权前置条件。 */
export async function startStandaloneQQ(
  dependencies: StandaloneQQDependencies = {
    ensureLicense,
    ensureCredentials,
    startBridge: () => startQQBridge(),
  },
): Promise<void> {
  await dependencies.ensureLicense();
  await dependencies.ensureCredentials();
  await dependencies.startBridge();
}

if (isEntry) {
  await startStandaloneQQ();
}
