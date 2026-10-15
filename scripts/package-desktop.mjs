#!/usr/bin/env node

/**
 * 打 Windows x64「桌面版」安装包：Electron 壳 + 复用便携包的后端（app + 内置 Node 运行时）。
 *
 * 步骤：
 *   1) buildPortable({ keep: true })  产出 <work>/CourseRaptor/{app,runtime}
 *   2) 把 app/ 与 runtime/ 复制到 desktop/build-resources/（electron-builder 的 extraResources 源）
 *   3) npm --prefix desktop run build  （typecheck + esbuild 打主进程）
 *   4) electron-builder                （cwd=desktop，读 electron-builder.yml；
 *      输出目录默认 desktop/release；可用 --out <目录> 输出到别处，
 *      避开对仓库目录实时扫描咬住 .asar 的 EBUSY 问题）
 *   5) 清理 build-resources/
 *
 * 用法：
 *   node scripts/package-desktop.mjs            # 用 package.json 版本
 *   node scripts/package-desktop.mjs --keep     # 保留 build-resources/ 便于排查
 *   node scripts/package-desktop.mjs --out D:\dist  # 产物输出到指定目录
 *
 * 产物：desktop/release/ 下的 NSIS 安装包与 portable exe
 * 前提：Windows、可联网、已装 desktop/ 依赖（npm --prefix desktop install）
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPortable } from "./package-portable.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const RESOURCES = path.join(DESKTOP, "build-resources");

function run() {
  if (process.platform !== "win32") {
    throw new Error("本脚本当前只在 Windows 上构建桌面安装包。");
  }
  const keep = process.argv.includes("--keep");
  // --out <目录>：electron-builder 输出改到指定目录（默认 desktop/release）。
  // 若杀软实时扫描咬住仓库目录的 .asar 报 EBUSY，--out 指向 %TEMP% 下目录即可绕过
  const outIdx = process.argv.indexOf("--out");
  const outDir =
    outIdx >= 0 && process.argv[outIdx + 1]
      ? path.resolve(process.argv[outIdx + 1])
      : path.join(DESKTOP, "release");
  mkdirSync(outDir, { recursive: true });

  console.log("① 构建便携后端（app + 内置 Node 运行时）...");
  const { portableDir, version } = buildPortable({ keep: true });
  if (!portableDir || !existsSync(portableDir)) {
    throw new Error("buildPortable 未回传 portableDir（检查 package-portable.mjs）。");
  }

  console.log("② 复制后端资源到 desktop/build-resources/ ...");
  rmSync(RESOURCES, { recursive: true, force: true });
  mkdirSync(RESOURCES, { recursive: true });
  for (const name of ["app", "runtime"]) {
    const from = path.join(portableDir, name);
    if (!existsSync(from)) throw new Error(`便携产物缺少 ${name}/：${from}`);
    cpSync(from, path.join(RESOURCES, name), { recursive: true });
  }

  try {
    console.log("③ 构建桌面主进程（typecheck + esbuild）...");
    execSync("npm run build", { cwd: DESKTOP, stdio: "inherit" });

    console.log("④ electron-builder 打安装包 ...");
    console.log(`   输出目录：${outDir}`);
    // 注意：--out 不是 electron-builder 参数；用 -c.directories.output 重定向输出
    execSync(`npx electron-builder --publish=never -c.directories.output="${outDir}"`, {
      cwd: DESKTOP,
      stdio: "inherit",
    });

    console.log("\n✅ 桌面安装包完成");
    console.log(`   产物目录：${outDir}`);
    console.log(
      `\n上传命令：\n  gh release upload v${version} "${outDir}/<产物>.exe" --clobber --repo Health-525/courseraptor`,
    );
  } finally {
    if (!keep) rmSync(RESOURCES, { recursive: true, force: true });
    else console.log(`   build-resources 保留：${RESOURCES}`);
  }
}

try {
  run();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
