/**
 * 后端 payload 的首次启动解压。
 *
 * 背景：electron-builder 的文件拷贝对目录名 `node_modules` 是硬编码整棵丢弃
 * （app-builder-lib/out/util/filter.js 的 createFilter：拷贝源根相对路径恰为
 * `node_modules` 直接 return false，yml 里 filter 配什么都救不回来）。
 * 所以 backend/app、backend/runtime 这种目录树不能走 extraResources，只能把
 * 便携包整包（payload.zip，单文件）随机身安装，首次启动解到用户数据目录。
 *
 * 落点：%APPDATA%/CourseRaptor/backend/<应用版本>/CourseRaptor/{app,runtime}
 *   - 版本分目录：升级后新 payload 解到新目录，旧数据（userData/data）不动
 *   - .ready 标记幂等：同版本二次启动直接复用，不重复解压
 *   - 解完顺手清掉其它版本目录（用户目录可写；安装目录的 payload.zip 留着可修复）
 * 解压用 Windows 自带 Expand-Archive（PowerShell 一条命令，无新依赖），
 * 与 scripts/package-portable.mjs 的解压写法同款（临时 .ps1 + -File）。
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

export interface ResolvedBackend {
  /** 含 local/host/headless.ts 的目录 */
  appPath: string;
  /** 内置 Node 24 可执行文件 */
  nodeBin: string;
}

/**
 * 旧版本把 credentials.enc 放在后端目录里（backend/<版本>/CourseRaptor/app/），
 * 升级清理旧版本目录时会一并丢掉。凭证改放 dataDir 后，这里在清理前把旧版凭证
 * 搬过去：数据目录里已有则不覆盖；多个旧版本取最新修改的那份。
 */
export function rescueLegacyCredentials(dataDir: string): void {
  const target = path.join(dataDir, "credentials.enc");
  const base = path.join(app.getPath("userData"), "backend");
  try {
    if (fs.existsSync(target) || !fs.existsSync(base)) return;
    const found = fs
      .readdirSync(base)
      .map((v) => path.join(base, v, "CourseRaptor", "app", "credentials.enc"))
      .filter((f) => fs.existsSync(f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const newest = found[0];
    if (!newest) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(newest, target);
  } catch {
    /* 抢救失败不挡启动：用户重新配置一次即可 */
  }
}

export async function ensureBackendExtracted(payloadZip: string): Promise<ResolvedBackend> {
  const version = app.getVersion();
  const base = path.join(app.getPath("userData"), "backend");
  const root = path.join(base, version);
  const ready = path.join(root, ".ready");
  const appPath = path.join(root, "CourseRaptor", "app");
  const nodeExe = process.platform === "win32" ? "node.exe" : "node";
  const nodeBin = path.join(root, "CourseRaptor", "runtime", nodeExe);
  const headless = path.join(appPath, "local", "host", "headless.ts");

  if (fs.existsSync(ready) && fs.existsSync(headless) && fs.existsSync(nodeBin)) {
    pruneOldVersions(base, version);
    return { appPath, nodeBin };
  }

  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  await expandArchive(payloadZip, root);
  if (!fs.existsSync(headless) || !fs.existsSync(nodeBin)) {
    throw new Error(`后端解压不完整（缺 local/host/headless.ts 或 ${nodeExe}），请重装应用`);
  }
  fs.writeFileSync(ready, new Date().toISOString(), "utf8");
  pruneOldVersions(base, version);
  return { appPath, nodeBin };
}

function pruneOldVersions(base: string, keep: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keep) continue;
    try {
      fs.rmSync(path.join(base, name), { recursive: true, force: true });
    } catch {
      /* 用户目录偶发占用：删不掉下次启动再说，不挡主流程 */
    }
  }
}

function expandArchive(zip: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ps1 = path.join(os.tmpdir(), `raptor-expand-${process.pid}.ps1`);
    fs.writeFileSync(
      ps1,
      [
        "param([string]$Archive, [string]$Destination)",
        "$ErrorActionPreference='Stop'",
        "Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force",
      ].join("\r\n"),
      "utf8",
    );
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ps1,
        "-Archive",
        zip,
        "-Destination",
        dest,
      ],
      (err) => {
        try {
          fs.rmSync(ps1, { force: true });
        } catch {
          /* 临时脚本清不掉无所谓 */
        }
        if (err) reject(new Error(`后端解压失败：${err.message}`));
        else resolve();
      },
    );
  });
}
