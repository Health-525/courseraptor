/**
 * 匿名使用情况上报（装机量/活跃度监控，仅此而已）。
 *
 * 上报内容只有四样：随机设备号（本机首次运行时生成，与本机任何账号/
 * 凭证无关）、程序版本、运行平台、渠道。不含学号、不含教务账号、不含
 * 对话内容，服务器也无法从设备号反查到人。
 *
 * 设计约束（与 update-check 同族）：
 *  - 每 24h 最多真正联网一次（结果连同设备号缓存在 data/usage-ping.json，
 *    设备号所在的 data/ 目录在 /update 覆盖安装时本就保留）；
 *  - fire-and-forget：超时 4s，失败/断网静默跳过，绝不拖慢或打断启动；
 *  - 未配置上报地址（源码开发态占位符未替换）时整体 no-op；
 *  - RAPTOR_NO_TELEMETRY=1（.env 或环境变量）一键关闭；
 *  - 发版脚本会把占位符替换为网关公网地址并随安装包分发（scripts/package-portable.mjs）。
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { dataDir, PROJECT_ROOT } from "./paths";

const DEFAULT_TELEMETRY_URL = "__RAPTOR_TELEMETRY_URL__";
const CACHE_FILE = path.join(dataDir(), "usage-ping.json");
const PING_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

interface PingState {
  /** 随机设备号：首次生成后长期稳定，是服务器去重统计的唯一键 */
  id: string;
  /** 最近一次成功/尝试上报的时间戳；24h 内不再重复上报 */
  lastPing: number;
}

/** 上报地址：环境变量优先（本地测试用），其次是发版时写进安装包的网关地址。 */
export function getTelemetryUrl(): string {
  const bundled = DEFAULT_TELEMETRY_URL.startsWith("__RAPTOR_") ? "" : DEFAULT_TELEMETRY_URL;
  return (process.env.RAPTOR_TELEMETRY_URL || bundled).replace(/\/+$/, "");
}

function localVersion(): string {
  try {
    const require = createRequire(path.join(PROJECT_ROOT, "package.json"));
    return String(require("./package.json").version ?? "");
  } catch {
    return "";
  }
}

async function readState(): Promise<PingState | null> {
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, "utf8")) as PingState;
    if (typeof parsed.id !== "string" || parsed.id.length < 8) return null;
    return { id: parsed.id, lastPing: Number(parsed.lastPing) || 0 };
  } catch {
    return null;
  }
}

async function writeState(state: PingState): Promise<void> {
  try {
    await writeFileAtomic(CACHE_FILE, JSON.stringify(state));
  } catch {
    /* 写不进缓存无所谓，大不了 24h 后再上报一次 */
  }
}

/**
 * 匿名上报一次本地版使用情况（channel 标记启动渠道，目前只有终端入口）。
 * 任何情况下都不会抛错、不会阻塞——调用方可以放心地 fire-and-forget。
 */
export async function pingUsage(channel = "tui"): Promise<void> {
  try {
    if (process.env.RAPTOR_NO_TELEMETRY === "1") return;
    const server = getTelemetryUrl();
    if (!server) return;

    let state = await readState();
    if (!state) {
      state = { id: randomUUID(), lastPing: 0 };
    }
    if (Date.now() - state.lastPing < PING_INTERVAL_MS) return;

    const version = localVersion();
    await fetch(server, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: state.id,
        version,
        channel,
        platform: process.platform,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 请求送达（无论服务器回什么状态码）即记 24h 节流；网络层失败走下面的
    // catch 不记账，下次启动再试
    await writeState({ id: state.id, lastPing: Date.now() });
  } catch {
    /* 断网/超时/地址失效：静默，下次启动再试 */
  }
}
