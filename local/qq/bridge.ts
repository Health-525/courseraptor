/**
 * QQ 官方机器人桥：把 CourseRaptor agent 接入 QQ（官方开放平台路线）
 *
 * 两种运行方式：
 * - 嵌入模式（默认）：`raptor` 启动终端 TUI 时自动拉起（日志写文件，
 *   见 local/qq/logger.ts，避免破坏 TUI 渲染）
 * - 独立模式：`npm run qq` 只跑桥（日志走控制台）
 *
 * - 场景：单聊（C2C）直接对话；群聊需 @机器人 触发（mentionGate）
 * - 授权：白名单制。官方平台只给 openid（非 QQ 号），首次使用发送
 *   暗号（QQBOT_PASSCODE）激活，openid 落盘 qq-allowlist.json
 * - 会话：每发送者独立历史（内存滑动窗口 20 条）；每轮问答另外写进
 *   网页那套会话档案（data/chat-sessions.json），侧栏能回看 QQ 里的对话
 */

import "../../src/adapters";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  concurrencyGuard,
  contentSanitizer,
  errorHandler,
  mentionGate,
  messageFilter,
  QQBot,
} from "@tencent-connect/qqbot-nodejs";
import type { ModelMessage } from "ai";
import { createRaptorAgent } from "../../src/core/agent";
import { quarantineCorruptFile, writeFileAtomic } from "../../src/core/atomic-write";
import { attachmentIdForSource, findByUrl, putAttachment } from "../../src/core/attachment-store";
import { appendRound } from "../../src/core/chat-sessions";
import { config } from "../../src/core/config";
import { drainGeneratedRound, runInDocumentRound } from "../../src/core/document/save";
import { isRaptorError, isSessionExpiredError } from "../../src/core/errors";
import { registerQQPushSender } from "../../src/core/notify";
import { ensureCredentials } from "../../src/core/onboarding";
import { migratedDataPath } from "../../src/core/paths";
import { maybeAutoTitle } from "../../src/core/session-titles";
import { isTableFilename } from "../../src/core/spreadsheet";
import { localOnlyCommandMessage } from "../cli/tui/slash-menu";
import { composeInboundQuestion, mdToPlain, type QqAttachmentLike, splitMessage } from "./format";
import { type QqArchiveInput, qqArchiveSlot } from "./session-archive";

type BridgeLogger = Pick<Console, "log" | "info" | "warn" | "error" | "debug">;

/**
 * 回传本轮生成的文档成品到 QQ。
 * bot.sendFile 走「上传媒体 + 文件消息(msg_type)」，官方机器人需具备文件消息
 * 权限，未开通会抛错——此时降级成一条文字，把文件名与本机路径告知用户，
 * 绝不静默吞掉。target 复用消息自带的 replyTarget，私聊/群聊都适用。
 */
type SendFileFn = QQBot["sendFile"];
async function deliverGeneratedFiles(
  bot: QQBot,
  target: Parameters<SendFileFn>[0],
  roundId: string,
  log: BridgeLogger,
): Promise<void> {
  const files = drainGeneratedRound(roundId);
  for (const f of files) {
    try {
      await bot.sendFile(target, { localPath: f.filePath }, { fileName: f.filename });
      log.log(`[qq] 已回传文件 ${f.filename}`);
    } catch (e) {
      log.warn(`[qq] 文件回传失败 ${f.filename}：${(e as Error)?.message ?? e}`);
      await bot
        .sendText(target, `📄 ${f.filename}\n（文件消息发送失败，已存本机：${f.filePath}）`)
        .catch(() => {});
    }
  }
}

// ── QQ 附件落地：抢在链接失效前下载入附件缓存 ──────────────────

/** 与附件主链路同款大小护栏：超此值不落地（退回链接标记，读不了为常态） */
const QQ_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 把入站 QQ 附件在收到当下下载进附件缓存（attachment-store）——QQ 的附件
 * 链接很快失效，等 agent 跑到工具调用那步再取就 404 了。同一 URL 重复
 * 发送直接命中缓存。只落地文件/图片/视频（语音自带识别文本）；单个失败
 * 只记日志、原样返回该项，组装时退回链接标记，绝不拦截回复。
 */
async function persistQqAttachments(
  attachments: readonly { content_type: string; url?: string; filename?: string }[] | undefined,
  log: BridgeLogger,
): Promise<QqAttachmentLike[]> {
  const out: QqAttachmentLike[] = [];
  if (!attachments) return out;
  for (const a of attachments) {
    const type = (a.content_type ?? "").trim();
    const url = (a.url ?? "").trim();
    const downloadable =
      url !== "" && (type === "file" || type.startsWith("image/") || type.startsWith("video/"));
    if (!downloadable) {
      out.push(a);
      continue;
    }
    try {
      const cached = findByUrl(url);
      if (cached) {
        out.push({ ...a, localPath: cached.storedPath, cacheId: cached.id });
        continue;
      }
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > QQ_ATTACHMENT_MAX_BYTES) throw new Error(`超过 50MB 上限`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > QQ_ATTACHMENT_MAX_BYTES) throw new Error(`超过 50MB 上限`);
      const filename = (a.filename ?? "").trim() || "qq附件";
      const meta = await putAttachment({
        id: attachmentIdForSource("url", url),
        filename,
        kind: isTableFilename(filename) ? "table" : "other",
        format:
          filename
            .toLowerCase()
            .match(/\.[a-z0-9]{1,8}$/)?.[0]
            ?.slice(1) ?? "",
        source: "url",
        url,
        buf,
      });
      out.push({ ...a, localPath: meta.storedPath, cacheId: meta.id });
      log.log(`[qq] 附件已落地 ${filename}（${meta.storedPath}）`);
    } catch (e) {
      log.warn(
        `[qq] 附件下载失败（${(a.filename ?? "").trim() || type}）：${(e as Error)?.message ?? e}`,
      );
      out.push(a);
    }
  }
  return out;
}

// ── 授权：白名单 + 暗号激活 ────────────────────────────────────

const ALLOWLIST_FILE = migratedDataPath("qq-allowlist.json");
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
  await writeFileAtomic(ALLOWLIST_FILE, JSON.stringify({ openids: [...allowedOpenids] }, null, 2));
}

// ── 会话历史（每发送者独立，滑动窗口）─────────────────────────
// 这里只是喂模型的上下文窗口。网页侧栏看到的「历史记录」是另一条线：
// 每轮问答另外写进 chat-sessions（见 local/qq/session-archive.ts 的归档
// 粒度），只写不读——网页里删改 QQ 档不会反过来影响这里的上下文。

const MAX_HISTORY_TURNS = 20;
/** 上下文窗口的发送者数量上限：陌生人刷屏不会让 Map 无界膨胀 */
const MAX_HISTORY_SENDERS = 500;
const histories = new Map<string, ModelMessage[]>();

/** LRU 触碰：活跃用户的窗口不会被后来者挤掉 */
function touchHistory(senderId: string): ModelMessage[] {
  const history = histories.get(senderId) ?? [];
  if (histories.has(senderId)) {
    histories.delete(senderId);
    histories.set(senderId, history);
  }
  return history;
}

function rememberHistory(senderId: string, turns: ModelMessage[]): void {
  while (histories.size >= MAX_HISTORY_SENDERS) {
    const oldest = histories.keys().next().value;
    if (oldest === undefined) break;
    histories.delete(oldest);
  }
  histories.set(senderId, turns);
}

/**
 * QQ 官方机器人是被动回复，窗口约 5 分钟。而长耗时工具可能一跑几分钟——
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
    const text = beat === 1 ? "🦖 收到，正在查…" : `…还在查（已 ${sec} 秒），马上回你`;
    void send(text).catch(() => {});
    timer = setTimeout(tick, HEARTBEAT_MS);
  };
  timer = setTimeout(tick, ACK_DELAY_MS);

  return () => clearTimeout(timer);
}

/**
 * 把技术错误转译成人话，并给出下一步动作。
 * 用户不需要知道 SESSION_EXPIRED 是什么，只需要知道「重试就好」还是「这功能坏了」。
 * RaptorError 先按 code 精确分诊；裸 Error（http 层网络异常等）再退回文案正则。
 */
function humanizeError(e: unknown): string {
  const raw = (e as Error)?.message ?? String(e);
  if (isSessionExpiredError(e) || /SESSION_EXPIRED|登录|login|未授权/i.test(raw)) {
    return "教务登录态掉了，我正在重新登录。稍等几秒再问一次就好。";
  }
  if (isRaptorError(e, "NETWORK", "UPSTREAM")) {
    return "教务系统这会儿连不上，多半是线路抖动。稍等一两分钟再试一次。";
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
 *
 * 落盘后顺手让模型给会话定个像样的侧栏标题（与网页同一套命名）：同步
 * 部分只有 appendRound，命名在后台尽力而为——调用方不等待也不该等待，
 * 慢了/败了标题就保持「QQ｜首问截断」兜底。返回 Promise 仅供单测钉住
 * 「命名确实发生过」。
 */
export async function archiveQQRound(
  msg: QqArchiveInput,
  answer: string | null,
  log: BridgeLogger = console,
): Promise<void> {
  const slot = qqArchiveSlot(msg);
  if (!slot) return;
  try {
    appendRound(slot.id, slot.userText, answer, null, {
      titlePrefix: slot.titlePrefix,
    });
  } catch (e) {
    log.error(`[qq] 历史落盘失败：${(e as Error)?.message ?? e}`);
    return;
  }
  await maybeAutoTitle(slot.id, { titlePrefix: slot.titlePrefix });
}

// ── 主流程 ────────────────────────────────────────────────────

/** 桥是否已连上（设置面板保存凭证后据此决定是热拉起还是提示重启切换） */
let bridgeOnline = false;
/** 进行中的启动：连点保存/多处触发也只连一次 WebSocket */
let bridgeStarting: Promise<void> | null = null;

export function isQQBridgeOnline(): boolean {
  return bridgeOnline;
}

export function startQQBridge(opts: { logger?: BridgeLogger } = {}): Promise<void> {
  bridgeStarting ??= launchQQBridge(opts).finally(() => {
    bridgeStarting = null;
  });
  return bridgeStarting;
}

/**
 * 桥热启动（供网页设置保存 QQ 凭证后即时拉起，宿主经 setQQBridgeLauncher 注入）。
 * 未在跑则拉起；已在跑则沿用启动时的凭证（重启后切换），失败如实说明。
 * 返回追加到保存结果里的用户文案。
 */
export async function ensureQQBridgeOnline(): Promise<string> {
  if (isQQBridgeOnline()) {
    return "；QQ 桥已在线（沿用启动时的凭证），重启 raptor 后切换为新凭证";
  }
  try {
    const { createQQFileLogger } = await import("./logger");
    // 20 秒没连上就先回话：桥后台继续尝试，凭证已加密保存
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("连接超时（20 秒）")), 20_000);
    });
    await Promise.race([startQQBridge({ logger: createQQFileLogger() }), timeout]);
    return "；QQ 桥已拉起，到 QQ 里给机器人发激活暗号即可开始使用";
  } catch (error) {
    // 与 web 侧 oneLine 同口径：压平空白、超长截断加省略号
    const flat = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim();
    const detail = flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
    return `；QQ 桥拉起失败：${detail}。凭证已保存，可稍后重启 raptor 重试`;
  }
}

async function launchQQBridge(opts: { logger?: BridgeLogger }): Promise<void> {
  const log = opts.logger ?? console;

  if (bridgeOnline) return;
  if (!config.qqBotAppId || !config.qqBotAppSecret) {
    throw new Error(
      "缺少 QQ 机器人配置：请在 .env 或网页「设置」里填写 QQBOT_APP_ID / QQBOT_APP_SECRET（q.qq.com 开放平台获取）",
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

  // 拒绝回复防刷：每个陌生人只提示一次，避免被刷被动回复额度。
  // FIFO 上限防 Map 被海量陌生 openid 撑大（挤出最老的，被挤出者会再收到
  // 一次提示——量级在正常使用中不可感知）
  const rejectedNotified = new Set<string>();
  const MAX_REJECTED_NOTIFIED = 5000;
  const noteRejection = (senderId: string): void => {
    if (rejectedNotified.has(senderId)) return;
    while (rejectedNotified.size >= MAX_REJECTED_NOTIFIED) {
      const oldest = rejectedNotified.values().next().value;
      if (oldest === undefined) break;
      rejectedNotified.delete(oldest);
    }
    rejectedNotified.add(senderId);
  };

  bot.on("message", async (_ctx, msg) => {
    const senderId = msg.senderId;

    // 未授权：暗号激活或拒绝
    if (!allowedOpenids.has(senderId)) {
      if (config.qqBotPasscode && msg.content.trim() === config.qqBotPasscode) {
        allowedOpenids.add(senderId);
        await saveAllowlist();
        log.log(`[auth] 新授权 openid=${senderId}`);
        await bot.sendText(
          msg.replyTarget,
          "✅ 已授权，迅猛龙上线！直接说需求即可：查课表 / 查成绩 / 查考试 / 读教务通知。",
        );
      } else if (!rejectedNotified.has(senderId)) {
        noteRejection(senderId);
        await bot.sendText(
          msg.replyTarget,
          "⛔ 未授权。首次使用请发送激活暗号（管理员在 .env 或网页「设置」里设置）。",
        );
      }
      return;
    }

    // 组装给模型的问题：正文 + 附件标记（文件/图片消息正文常为空，
    // 只看 content 会把纯附件消息静默丢掉——用户发文件就石沉大海）。
    // QQ 的附件链接很快失效（agent 晚一步去取就 404），所以收到当下先抢着
    // 下载入附件缓存（attachment-store），把本机路径/缓存 id 交给模型用
    // query_table / read_local_file 读；下载失败退回给链接，行为不变。
    // 无正文也无可用附件（question 为空）才跳过。
    const attachments = await persistQqAttachments(msg.attachments, log);
    const question = composeInboundQuestion(msg.content, attachments);
    if (!question) return;

    const localOnlyMessage = localOnlyCommandMessage(msg.content.trim());
    if (localOnlyMessage) {
      await bot.sendText(msg.replyTarget, localOnlyMessage);
      return;
    }

    const history = touchHistory(senderId);
    const userMsg: ModelMessage = { role: "user", content: question };

    // 网页侧栏的历史记录：私聊每人一档、群聊每群一档（粒度见 session-archive.ts）。
    // 一轮只记一次——成功记整轮问答，失败只留「他在 QQ 里问过这句」。
    // archiveQQRound 已改异步（落盘后还要让模型定标题），这里不等待：
    // 同步落盘先行，命名在后台尽力而为，绝不拖住 QQ 回复。
    // 附件消息把组装后的 question 落档（原始 content 是空的，看不出问了什么）。
    const archiveMsg: QqArchiveInput = { ...msg, content: question };
    let archived = false;
    const archive = (answer: string | null): void => {
      if (archived) return;
      archived = true;
      void archiveQQRound(archiveMsg, answer, log);
    };

    const stopNotices = startWaitingNotices((t) => bot.sendText(msg.replyTarget, t));
    try {
      // 给这一轮对话打一个 roundId：文档生成工具落盘时会盖上此章，
      // 结束后按章回捞，只把「本轮生成的成品」回传（跨用户并行也不串台）。
      const roundId = `${senderId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const result = await runInDocumentRound(roundId, () =>
        agent.generate({
          messages: [...history, userMsg],
        }),
      );
      stopNotices();
      const reply = mdToPlain(result.text || "（无输出）");
      // 先留档再发送：分段发送中途被限流，这一轮也已经进得了历史
      archive(result.text || null);
      for (const seg of splitMessage(reply)) {
        await bot.sendText(msg.replyTarget, seg);
      }
      // 回传本轮生成的文档成品（官方机器人文件消息需权限，失败降级为文字告知路径）
      await deliverGeneratedFiles(bot, msg.replyTarget, roundId, log);
      const assistantMsg: ModelMessage = {
        role: "assistant",
        content: result.text,
      };
      rememberHistory(senderId, [...history, userMsg, assistantMsg].slice(-MAX_HISTORY_TURNS));
    } catch (e) {
      stopNotices();
      // 答砸了也把「他在 QQ 里问过这句」留下：只有提问，跟网页侧同一口径
      archive(null);
      log.error(`[qq] 处理失败（openid=${senderId}）：${(e as Error)?.message ?? e}`);
      await bot.sendText(msg.replyTarget, `❌ ${humanizeError(e)}`);
    }
  });

  // 在线状态跟随连接生命周期：SDK 自带断线重连（error→离线，
  // ready/resumed→恢复在线）。重试耗尽时 SDK 只记日志不发事件，
  // 状态会停在离线——设置面板如实显示，热拉起也能重新建连
  bot.on("ready", () => {
    bridgeOnline = true;
  });
  bot.on("resumed", () => {
    bridgeOnline = true;
  });
  bot.on("error", (err) => {
    bridgeOnline = false;
    log.warn(`[qq] 连接异常（SDK 自动重连中）：${err.message}`);
  });

  await bot.start();
  bridgeOnline = true;
  log.log("🦖 CourseRaptor QQ 桥已启动（官方机器人 · WebSocket）");
  log.log(`已授权用户：${allowedOpenids.size} 个（暗号激活：发送 QQBOT_PASSCODE）`);

  // 主动推送通道：只发 QQBOT_PUSH_OPENIDS 显式列出的 openid（宿主本人）。
  // 白名单是对话授权名单（同学激活后都能聊），不是推送名单——待办等提醒
  // 读的是本机单用户数据，广播给全部授权用户等于把宿主私事发给同学。
  // target 省略 msgId 即主动消息；平台对主动推送有频率限制，失败只记
  // 日志、不影响桥本体
  const pushTargets = config.qqPushOpenids;
  if (pushTargets.length === 0) {
    log.log(
      "主动推送未启用：待办提醒不会发到 QQ。想接收请把本人 openid 填进 .env 的 QQBOT_PUSH_OPENIDS（openid 见启动日志 [auth] 行）",
    );
  } else {
    const notAuthorized = pushTargets.filter((id) => !allowedOpenids.has(id));
    if (notAuthorized.length > 0) {
      log.warn(`[qq] 推送目标尚未授权，先在 QQ 里给机器人发暗号激活：${notAuthorized.join("、")}`);
    }
    log.log(`主动推送目标：${pushTargets.length} 个 openid`);
  }
  registerQQPushSender(async (text) => {
    for (const openid of pushTargets) {
      await bot.sendText({ scope: "c2c", targetId: openid }, text).catch((e) => {
        log.warn(`[qq] 主动推送失败（openid=${openid}）：${(e as Error)?.message ?? e}`);
      });
    }
  });
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
  ensureCredentials(): Promise<void>;
  startBridge(): Promise<void>;
}

/** 独立 QQ 入口与主程序共用相同的授权前置条件。 */
export async function startStandaloneQQ(
  dependencies: StandaloneQQDependencies = {
    // 引导现在可跳过（返回 configured/skipped）；桥只关心流程走完与否
    ensureCredentials: async () => {
      await ensureCredentials();
    },
    startBridge: () => startQQBridge(),
  },
): Promise<void> {
  await dependencies.ensureCredentials();
  await dependencies.startBridge();
}

if (isEntry) {
  // 侧栏会话标题的模型命名：独立跑桥也照常装配（与嵌入模式的 index.ts
  // 同一个注册表），QQ 落进档案的会话同样有模型定的标题
  await import("../../src/core/session-titles").then(({ installDefaultTitleMaker }) =>
    installDefaultTitleMaker(),
  );
  await startStandaloneQQ();
  // 独立跑桥时待办提醒照常工作（主入口 index.ts 里另有启动）
  const { startTodoReminderScheduler } = await import("../../src/core/todo-reminders");
  startTodoReminderScheduler();
}
