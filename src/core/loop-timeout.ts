/**
 * agent 循环超时看门狗 — AI SDK v7 原生 timeout 的集中配置
 *
 * 背景（借鉴 OpenMAIC agent-runtime 的 tool-timeout，结论见
 * skills/openmaic/README.md 的「工程模式」）：上游 pi-agent 循环对
 * tool.execute 没有任何截止时间——一个既不 resolve 也不 reject 的挂起
 * 请求（供应商请求不返回、库调用卡在不可取消的 await 上）能把会话永久
 * 楔住，租约还在心跳，修复永远不会发生。我们的网络助手（core/http.ts）
 * 本就自带 AbortSignal.timeout，但流式模型调用与本地重活
 * （generate_document / convert_document / ppt_save）没有统一硬上限。
 *   SDK v7 的 timeout 配置正好覆盖这几类，且经 AbortSignal 下发——集中
 * 在这一处配置，四端共享（网页 / TUI 流式；QQ 桥走 generate，只继承
 * 工具级预算）。
 *
 * 三个字段的分工（语义实测自 ai@7 源码：agent.stream 的 timeout 一路
 * 传进内含工具循环的 streamText，totalMs 管整轮、stepMs 管单步、
 * toolMs 合并进每个工具的 abortSignal）：
 * - toolMs：单次工具执行的默认预算。超时即向该工具发中止——尊重信号的
 *   工具会抛错，SDK 把它转成错误 tool-result 喂回模型，模型可重试或
 *   改口，轮次不死（这正是上游「会话不死」的设计）。
 * - firstChunkMs（仅流式）：等模型首个内容 chunk 的上限，治深思模型
 *   的「转圈圈」。generateText 不支持它，QQ 桥的 generate 路不配。
 * - chunkMs（仅流式）：正文 chunk 间的最大间隔，治流中途停滞。
 *
 * 刻意不配 totalMs / stepMs：整轮预算会误杀合法的深轮（20 步 × 多
 * 工具的长任务），步级预算已被 toolMs + 流式看门狗覆盖。
 *
 * 已知边界：toolMs 只约束「尊重 AbortSignal 的工具」——信号是协商不是
 * 强制，无视信号的 await 仍会挂住（上游为此额外包了一层 promise 赛跑）。
 * 新增耗时不可控的工具时，主动接 execute 入参里的 abortSignal。
 *
 * 可调环境变量（与上游 OPENMAIC_AGENT_TOOL_TIMEOUT_MS 同思路）：
 * - RAPTOR_TOOL_TIMEOUT_MS：默认工具预算，默认 300000（5 分钟）
 * - RAPTOR_STREAM_FIRST_CHUNK_MS：首 chunk 等待，默认 120000
 * - RAPTOR_STREAM_CHUNK_MS：chunk 间隔，默认 60000
 */

/** 默认单次工具执行预算（毫秒）。宽松是故意的：我们的工具大多秒回，
 *  网络助手另有 15-30s 内置超时，这里只是兜底看门狗 */
export const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60_000;

/** 已知长任务的单工具覆盖预算（照上游 AGENT_TOOL_TIMEOUT_OVERRIDES 惯例：
 *  把部署自己对「这个工具 legit 能跑多久」的知识写进地图，赢过默认值） */
export const TOOL_TIMEOUT_OVERRIDES_MS: Readonly<Record<string, number>> = {
  // 文档三件套：渲染/转换大文件时分钟级是正常的
  generate_document: 10 * 60_000,
  convert_document: 10 * 60_000,
  export_schedule_image: 2 * 60_000,
};

/** 等模型首个内容 chunk 的上限（流式）。深思模型首 token 分钟级合法，故放宽到 2 分钟 */
export const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 2 * 60_000;

/** 正文 chunk 间最大间隔（流式）。超过这个数还没动静，基本是流挂了 */
export const DEFAULT_CHUNK_TIMEOUT_MS = 60_000;

export const TOOL_TIMEOUT_ENV = "RAPTOR_TOOL_TIMEOUT_MS";
export const FIRST_CHUNK_TIMEOUT_ENV = "RAPTOR_STREAM_FIRST_CHUNK_MS";
export const CHUNK_TIMEOUT_ENV = "RAPTOR_STREAM_CHUNK_MS";

/** 读毫秒环境变量：缺失、非数字、非正数一律回落默认（不许半个配置把循环搞瘸） */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** 默认工具执行预算（毫秒） */
export function toolTimeoutMs(): number {
  return envMs(TOOL_TIMEOUT_ENV, DEFAULT_TOOL_TIMEOUT_MS);
}

/** 首 chunk 等待预算（毫秒，流式专用） */
export function firstChunkTimeoutMs(): number {
  return envMs(FIRST_CHUNK_TIMEOUT_ENV, DEFAULT_FIRST_CHUNK_TIMEOUT_MS);
}

/** chunk 间隔预算（毫秒，流式专用） */
export function chunkTimeoutMs(): number {
  return envMs(CHUNK_TIMEOUT_ENV, DEFAULT_CHUNK_TIMEOUT_MS);
}

/** generate/stream 两路都安全的配置子集。刻意不含 firstChunkMs/chunkMs——
 *  它们是流式专属，generateText 遇到会打 unsupported 警告（QQ 桥每轮
 *  一条，日志会被刷满） */
export interface LoopTimeoutConfig {
  toolMs: number;
  /** 键为 `${工具名}Ms`（SDK 的 per-tool 覆盖形状） */
  tools: Record<string, number>;
}

/** 流式调用点专用：在工具看门狗之上加流式看门狗 */
export interface LoopStreamTimeoutConfig extends LoopTimeoutConfig {
  firstChunkMs: number;
  chunkMs: number;
}

function perToolOverrides(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, ms] of Object.entries(TOOL_TIMEOUT_OVERRIDES_MS)) {
    out[`${name}Ms`] = ms;
  }
  return out;
}

/** 工具级看门狗配置：agent 组装时进 settings（QQ 桥的 generate 路也吃这份） */
export function toolTimeoutConfig(): LoopTimeoutConfig {
  return { toolMs: toolTimeoutMs(), tools: perToolOverrides() };
}

/** 流式看门狗配置：网页 SSE 与 TUI 行内的 stream 调用点用 */
export function streamTimeoutConfig(): LoopStreamTimeoutConfig {
  return { ...toolTimeoutConfig(), firstChunkMs: firstChunkTimeoutMs(), chunkMs: chunkTimeoutMs() };
}

/** 看门狗到点时 SDK 给出的 reason（如 "TimeoutError: First chunk timeout of
 *  60000ms exceeded"）→ 用户看得懂的中文一句话。识别不了的原文返回，
 *  不许翻成猜的话 */
export function watchdogHint(reason: string): string {
  if (/first chunk timeout/i.test(reason)) return "等待模型响应超时（首个响应超过预算）";
  if (/chunk timeout/i.test(reason)) return "模型响应中途停滞超时（响应间隔超过预算）";
  if (/total timeout/i.test(reason)) return "整轮对话超时（总时长超过预算）";
  if (/tool/i.test(reason) && /timeout/i.test(reason))
    return "工具执行超时（单次工具调用超过预算）";
  return reason || "未知原因";
}

/**
 * fullStream 的 abort part（或 catch 里的超时错误）→ 给用户的失败说明。
 *
 * 为什么需要：SDK 看门狗到点时不抛错，而是发一个 {type:"abort"} part 后
 * 让流正常结束——此前这个 part 在翻译层落进 default 被丢掉，用户侧表现
 * 为「闪一下什么也没发生」（无正文、无报错、还照常入不了库）。这里把
 * 它变成可见的失败，并带上调预算的口子。
 */
export function abortFailure(reason: unknown): string {
  const text =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : String(reason ?? "");
  return `本轮已中止：${watchdogHint(text)}。重发一次试试；若频繁超时，可调大对应预算（RAPTOR_STREAM_FIRST_CHUNK_MS / RAPTOR_STREAM_CHUNK_MS / RAPTOR_TOOL_TIMEOUT_MS）。`;
}
