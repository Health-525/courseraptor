/**
 * 更新检查：对比「更新后台」上的最新版本与本地版本，有新版则提示。
 * 后台 = server/update-server.mjs（发版用 npm run publish 推上去）。
 *
 * 设计约束：
 *  - 每 24h 最多真正联网一次，结果（含「没有新版」）缓存 data/update-check.json，
 *    网络不通时下次启动不再白等超时；
 *  - 联网失败/超时静默跳过，绝不拖慢或打断启动；
 *  - 未配置后台时兜底读 origin 的 vX.Y.Z git tag（私有仓库也能用，走本地 git 凭证）；
 *  - RAPTOR_NO_UPDATE_CHECK=1（.env 或环境变量）关闭。
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { PROJECT_ROOT } from "./paths";
import { writeFileAtomic } from "./atomic-write";

const exec = promisify(execCb);

/**
 * 部署更新后台后，把地址填到这里（形如 http://1.2.3.4:8787，结尾不带 /），
 * 同学端无需任何配置；.env 里配 RAPTOR_UPDATE_SERVER 可覆盖此默认值。
 */
const DEFAULT_UPDATE_SERVER = "";

const RAW_URL = "https://raw.githubusercontent.com/Health-525/courseraptor/master/package.json";
const CACHE_FILE = path.join(PROJECT_ROOT, "data", "update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
const GIT_TIMEOUT_MS = 6000;

/** 更新后台地址：环境变量优先，其次代码内默认值（见 DEFAULT_UPDATE_SERVER） */
export function getUpdateServerUrl(): string {
  return (process.env.RAPTOR_UPDATE_SERVER || DEFAULT_UPDATE_SERVER).replace(/\/+$/, "");
}

export interface UpdateInfo {
  latest: string;
  current: string;
  /** 发版说明（后台发布时填写，可能为空） */
  notes?: string;
}

interface CacheEntry {
  checkedAt: number;
  /** 最近一次查到的远端最新版本；null = 查过但没有更新（也要缓存，避免每次启动都等网络超时） */
  latest: string | null;
  notes?: string;
}

function getLocalVersion(): string | null {
  try {
    const require = createRequire(path.join(PROJECT_ROOT, "package.json"));
    return require("./package.json").version as string;
  } catch {
    return null; // 读不到本地版本就不检查，不影响启动
  }
}

/** 版本比较：>0 表示 a 更新，<0 表示 b 更新，0 相等 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 逐段数字比较，"0.2.0" > "0.1.10" */
const isNewer = (a: string, b: string) => compareVersions(a, b) > 0;

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** 主通道：自有更新后台的 /latest 接口 */
async function fetchLatestFromServer(
  server: string,
): Promise<{ version: string; notes?: string } | null> {
  try {
    const res = await fetch(`${server}/latest`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string; notes?: string };
    if (typeof data.version !== "string" || !SEMVER_RE.test(data.version)) return null;
    return { version: data.version, notes: data.notes };
  } catch {
    return null;
  }
}

/**
 * 兜底通道一：读 origin 的 vX.Y.Z tag（私有仓库也能用，走同学 clone 时缓存的
 * git 凭证）。zip 解压的目录没有 .git 则跳过。
 */
async function fetchLatestViaGitTag(): Promise<string | null> {
  if (!existsSync(path.join(PROJECT_ROOT, ".git"))) return null;
  try {
    const { stdout } = await exec("git ls-remote --tags origin", {
      encoding: "utf8",
      cwd: PROJECT_ROOT,
      timeout: GIT_TIMEOUT_MS,
    }); // 凭证缺失时直接 reject 走兜底，不会卡住启动
    const versions = [...stdout.matchAll(/refs\/tags\/v(\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]);
    return versions.length ? versions.sort(compareVersions)[versions.length - 1] : null;
  } catch {
    return null;
  }
}

/** 兜底通道二：公开仓库直接读 master 上的 package.json 版本 */
async function fetchLatestViaRaw(): Promise<string | null> {
  try {
    const res = await fetch(RAW_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const pkg = (await res.json()) as { version?: string };
    return typeof pkg.version === "string" && SEMVER_RE.test(pkg.version) ? pkg.version : null;
  } catch {
    return null;
  }
}

async function readCache(): Promise<CacheEntry | null> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}

async function writeCache(latest: string | null, notes?: string): Promise<void> {
  try {
    // 原子写：半截的缓存会被 readCache 当成「没缓存」，于是每次启动都联网查
    await writeFileAtomic(
      CACHE_FILE,
      JSON.stringify({ checkedAt: Date.now(), latest, notes } satisfies CacheEntry)
    );
  } catch {
    /* 缓存写失败无所谓，下次再查 */
  }
}

/** 有新版返回 UpdateInfo，否则 null。每 24h 真正联网一次（无论结果成败都入缓存） */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (process.env.RAPTOR_NO_UPDATE_CHECK === "1") return null;
  const current = getLocalVersion();
  if (!current) return null;

  const cached = await readCache();
  let latest: string | null;
  let notes: string | undefined;
  if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
    latest = cached.latest; // 24h 内查过（包括"没有新版"），直接用缓存
    notes = cached.notes;
  } else {
    const server = getUpdateServerUrl();
    const fromServer = server ? await fetchLatestFromServer(server) : null;
    latest = fromServer
      ? fromServer.version
      : (await fetchLatestViaGitTag()) ?? (await fetchLatestViaRaw());
    notes = fromServer?.notes;
    await writeCache(latest, notes); // 查不到（网络不通/还没发过版）也记下来，下次启动不再白等
  }

  return latest && isNewer(latest, current) ? { latest, current, notes } : null;
}

/** 完整提示行：给行内模式 / 卡片模式启动前的控制台输出 */
export function formatUpdateBanner(info: UpdateInfo): string {
  const noteLine = info.notes ? `\n   更新说明：${info.notes}` : "";
  return (
    `🔄 有新版本 v${info.latest}（当前 v${info.current}），对话里输入 /update 一键更新` +
    `${noteLine}`
  );
}

/** 短徽标：拼进 TUI 常驻标题（过长会被截断，所以放靠前的位置） */
export function formatUpdateBadge(info: UpdateInfo): string {
  return `🔄 新版 v${info.latest}，/update 可更新`;
}
