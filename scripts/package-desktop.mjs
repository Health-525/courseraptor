#!/usr/bin/env node

/**
 * 打 Windows x64「桌面版」安装包：Electron 壳 + 便携包整包做 payload。
 *
 * 步骤：
 *   1) buildPortable({ keep: true })  产出 <work>/CourseRaptor/{app,runtime} + 便携 zip
 *   2) 把便携 zip 拷到 desktop/build-resources/payload.zip（单文件做 extraResources。
 *      不能直接拷 app/、runtime/ 目录树：electron-builder 对目录名 node_modules
 *      是整棵硬丢弃，目录树进包必然缺依赖）
 *   2b) 从 README logo 现生成 build-resources/icon.ico（NSIS 只认 .ico；多尺寸
 *      16/32/48/256 PNG-in-ICO，不入库，构建期现做，与 package-exe.mjs 同款写法）
 *   3) npm --prefix desktop run build  （typecheck + esbuild 打主进程；
 *      electron-updater 已 bundle 进 dist/main.js，不依赖外部 node_modules）
 *   4) electron-builder                （cwd=desktop，读 electron-builder.yml；
 *      输出目录默认 desktop/release；可用 --out <目录> 输出到别处，
 *      避开对仓库目录实时扫描咬住 .asar 的 EBUSY 问题）
 *   5) 清理 build-resources/
 *
 * 安装后首次启动：主进程把 payload.zip 解到 %APPDATA%/CourseRaptor/backend/
 * <应用版本>/（见 desktop/src/payload.ts），按版本分目录、.ready 标记幂等，
 * 顺手清旧版本；用户数据（userData/data）与其隔离，升级不丢数据。
 *
 * 用法：
 *   node scripts/package-desktop.mjs            # 用 package.json 版本
 *   node scripts/package-desktop.mjs --keep     # 保留 build-resources/ 便于排查
 *   node scripts/package-desktop.mjs --out D:\dist  # 产物输出到指定目录
 *
 * 产物：<输出目录> 下的 NSIS 安装包与 portable exe
 * 前提：Windows、可联网、已装 desktop/ 依赖（npm --prefix desktop install）
 */

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPortable } from "./package-portable.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const RESOURCES = path.join(DESKTOP, "build-resources");

async function run() {
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
  const { portableDir, version, finalZip } = await buildPortable({ keep: true });
  if (!portableDir || !existsSync(portableDir)) {
    throw new Error("buildPortable 未回传 portableDir（检查 package-portable.mjs）。");
  }
  if (!finalZip || !existsSync(finalZip)) {
    throw new Error("buildPortable 未回传便携 zip（检查 package-portable.mjs）。");
  }

  console.log("② 便携 zip 做 payload 进 desktop/build-resources/ ...");
  rmSync(RESOURCES, { recursive: true, force: true });
  mkdirSync(RESOURCES, { recursive: true });
  copyFileSync(finalZip, path.join(RESOURCES, "payload.zip"));

  console.log("②b README logo → 多尺寸 ICO（NSIS 安装包图标）...");
  makeIconIco(path.join(ROOT, "docs", "courseraptor-logo.png"), path.join(RESOURCES, "icon.ico"));

  try {
    console.log("③ 构建桌面主进程（typecheck + esbuild）...");
    execSync("npm run build", { cwd: DESKTOP, stdio: "inherit" });

    console.log("④ electron-builder 打安装包 ...");
    console.log(`   输出目录：${outDir}`);
    // 先清掉上次的半成品：win-unpacked 残留会让 electron-builder 误判为已构建完成，
    // 直接跳过 NSIS/portable 产物（上次只出 win-unpacked 没出 setup 就是这么来的）
    for (const stale of ["win-unpacked", "win-unpacked.tmp"]) {
      rmSync(path.join(outDir, stale), { recursive: true, force: true });
    }
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
  await run();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

/**
 * README logo → 多尺寸 ICO（16/32/48/256，PNG-in-ICO 写法，与 package-exe.mjs 同款）。
 * 缩放用 System.Drawing（本脚本只跑 Windows，与 exe 打包同款写法）；单尺寸 PNG
 * 直接拼 ICO（Vista+ 支持）会让任务栏小图标糊成一团，故此处必须多尺寸。
 */
function makeIconIco(pngSrc, icoOut) {
  if (!existsSync(pngSrc)) throw new Error(`缺少应用图标源图：${pngSrc}`);
  const sizes = [16, 32, 48, 256];
  const dir = path.dirname(icoOut);
  const ps1 = path.join(dir, "icon-resize.ps1");
  writeFileSync(
    ps1,
    [
      "param([string]$src, [string]$outDir)",
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Drawing",
      "$img = [System.Drawing.Image]::FromFile($src)",
      `foreach ($s in ${sizes.join(",")}) {`,
      "  $bmp = New-Object System.Drawing.Bitmap $s, $s",
      "  $g = [System.Drawing.Graphics]::FromImage($bmp)",
      "  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
      "  $g.DrawImage($img, 0, 0, $s, $s)",
      "  $g.Dispose()",
      '  $bmp.Save((Join-Path $outDir ("icon-$s.png")), [System.Drawing.Imaging.ImageFormat]::Png)',
      "  $bmp.Dispose()",
      "}",
      "$img.Dispose()",
    ].join("\r\n"),
    "utf8",
  );
  try {
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}" -src "${pngSrc}" -outDir "${dir}"`,
      {
        stdio: "inherit",
      },
    );
    const images = sizes.map((s) => {
      const png = readFileSync(path.join(dir, `icon-${s}.png`));
      rmSync(path.join(dir, `icon-${s}.png`), { force: true });
      return { size: s, png };
    });
    const count = images.length;
    const headerLen = 6 + 16 * count;
    const header = Buffer.alloc(headerLen);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(count, 4);
    let offset = headerLen;
    images.forEach(({ size, png }, i) => {
      const o = 6 + 16 * i;
      header.writeUInt8(size >= 256 ? 0 : size, o);
      header.writeUInt8(size >= 256 ? 0 : size, o + 1);
      header.writeUInt8(0, o + 2);
      header.writeUInt8(0, o + 3);
      header.writeUInt16LE(1, o + 4);
      header.writeUInt16LE(32, o + 6);
      header.writeUInt32LE(png.length, o + 8);
      header.writeUInt32LE(offset, o + 12);
      offset += png.length;
    });
    writeFileSync(icoOut, Buffer.concat([header, ...images.map((i) => i.png)]));
    console.log(`   图标已生成：${icoOut}（${sizes.join("/")}px）`);
  } finally {
    rmSync(ps1, { force: true });
  }
}
