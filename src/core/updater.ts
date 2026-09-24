/**
 * 一键自更新（/update 斜杠命令）：从更新后台下载新版 zip → 解压 → 覆盖到
 * 项目目录（跳过凭证/记忆等本机数据）→ 自动 npm install → 提示重启。
 *
 * 安全边界：
 *  - 版本对比在 checkForUpdate() 里做，本地不比远端新才会动文件；
 *  - 覆盖时跳过 .env / credentials.enc / session.json / memory.json /
 *    qq-allowlist.json / node_modules / .git / data / downloads，
 *    同学的凭证、记忆、会话永远不会被新包冲掉。
 */

import { exec as execCb } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "./paths";
import { checkForUpdate, requireSecureUpdateServerUrl } from "./update-check";

const exec = promisify(execCb);

/**
 * 覆盖安装时按相对路径（/ 分隔）排除：命中自身或任一父级目录即跳过。
 * data/ 整目录保留（会话、附件、成品、个人校历修正）；公共校历种子随源码更新。
 */
const PROTECTED_PATHS = new Set([
  // 本机凭证 / 记忆 / 会话 / 授权名单
  ".env",
  "credentials.enc",
  "session.json",
  "memory.json",
  "qq-allowlist.json",
  // 依赖与版本库
  "node_modules",
  ".git",
  // 运行时产物
  "downloads",
  "data",
  "outputs",
]);

/** 相对路径命中保护名单（自身或任一父级目录）则跳过 */
export function isProtected(rel: string): boolean {
  const seg = rel.replaceAll("\\", "/").split("/");
  for (let i = 1; i <= seg.length; i++) {
    if (PROTECTED_PATHS.has(seg.slice(0, i).join("/"))) return true;
  }
  return false;
}

const WORK_DIR = path.join(PROJECT_ROOT, "data", "update-download");
const DOWNLOAD_TIMEOUT_MS = 120_000;
const EXTRACT_TIMEOUT_MS = 60_000;
const NPM_INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * 从后台下载新版并覆盖安装。
 * @param log 进度回调（每步一条，直接打到对话界面上）
 * @returns 给用户看的最终结果文案
 */
export async function applyUpdate(log: (msg: string) => void = () => {}): Promise<string> {
  const server = requireSecureUpdateServerUrl();
  if (!server) {
    return "未配置更新后台地址（RAPTOR_UPDATE_SERVER），请找维护者要安装包手动覆盖。";
  }
  const info = await checkForUpdate();
  if (!info) return "当前已是最新版本，无需更新。";

  log(`发现新版本 v${info.latest}${info.notes ? `：${info.notes}` : ""}，下载中…`);
  const zipPath = await downloadPackage(server);

  log("解压中…");
  const extractDir = await extractZip(zipPath);

  log("覆盖安装中（你的凭证/记忆/会话不会被动）…");
  await cp(extractDir, PROJECT_ROOT, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(extractDir, src).split(path.sep).join("/");
      if (!rel) return true;
      return !isProtected(rel);
    },
  });

  log("安装依赖中，可能需要一两分钟…");
  await runNpmInstall();

  return `✅ 已更新到 v${info.latest}。重启 raptor（退出后重新运行）即可使用新版。`;
}

async function downloadPackage(server: string): Promise<string> {
  const res = await fetch(`${server}/download`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}（后台可能还没发过版）`);
  const buf = Buffer.from(await res.arrayBuffer());
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(WORK_DIR, { recursive: true });
  const zipPath = path.join(WORK_DIR, "update.zip");
  await writeFile(zipPath, buf);
  return zipPath;
}

/** Windows 用系统自带 Expand-Archive，其他平台依次试 unzip / tar（bsdtar 支持 zip） */
async function extractZip(zipPath: string): Promise<string> {
  const extractDir = path.join(WORK_DIR, "extracted");
  await mkdir(extractDir, { recursive: true });
  if (process.platform === "win32") {
    await exec(
      `powershell -NoProfile -Command ` +
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
      { timeout: EXTRACT_TIMEOUT_MS },
    );
  } else {
    try {
      await exec(`unzip -o '${zipPath}' -d '${extractDir}'`, { timeout: EXTRACT_TIMEOUT_MS });
    } catch {
      await exec(`tar -xf '${zipPath}' -C '${extractDir}'`, { timeout: EXTRACT_TIMEOUT_MS });
    }
  }
  return extractDir;
}

async function runNpmInstall(): Promise<void> {
  try {
    await exec("npm install", { cwd: PROJECT_ROOT, timeout: NPM_INSTALL_TIMEOUT_MS });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    const detail = (err.stderr || err.message).trim().split("\n").slice(-3).join(" | ");
    throw new Error(`npm install 失败（新代码已就位）：${detail || "未知错误"}`);
  }
}

/**
 * 斜杠命令入口（卡片 / 行内共用）。卡片模式的全屏 TUI 会冲掉 console 输出，
 * 进度建议在行内模式（/inline）看；两种模式最终都会把结果打出来。
 */
export function runUpdateCommand(): void {
  void applyUpdate((msg) => console.log(msg))
    .then((msg) => console.log(msg))
    .catch((e) => console.error(`❌ 更新失败：${(e as Error).message}`));
}
