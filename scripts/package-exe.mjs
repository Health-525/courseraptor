#!/usr/bin/env node
/**
 * 打 Windows x64「单文件 exe」：复用 package-portable 的便携 zip，作为资源嵌进一个
 * .NET 启动器（Windows 自带的 csc.exe 编译，不需要第三方打包器，也不做代码签名）。
 *
 * 同学侧体验：下载这一个 exe，双击——
 *   - 首次：在 exe 旁边释放出 CourseRaptor 文件夹（exe 放哪就释放到哪，绿色便携；
 *     RAPTOR_PORTABLE_HOME 可整体重定向），进入终端对话；
 *   - 之后：直接启动，秒开；
 *   - 升级 = 把新 exe 放进原来的文件夹再双击：版本号变化才重新释放，本地 data/、凭证等运行数据不受影响。
 *
 * 用法：
 *   node scripts/package-exe.mjs                # 产物路径打印在最后（便携 zip 一并产出）
 *   node scripts/package-exe.mjs --selftest     # 构建后跑两遍内置自检（首释放 + 秒开路径）
 *   node scripts/package-exe.mjs --keep         # 额外保留临时目录便于排查
 *
 * 产物：<系统临时目录>/courseraptor-vX.Y.Z-portable-win-x64.exe
 * 前提：同 package-portable（Windows、联网、PowerShell、curl），外加 .NET Framework 4.x 的 csc.exe。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPortable, PORTABLE_TOP_DIR } from "./package-portable.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;

const ARTIFACT = `courseraptor-v${version}-portable-win-x64.exe`;
const RESOURCE_ID = "raptor.portable.zip"; // 与 exe-launcher.cs 的 ResourceId 一致
const CSC_CANDIDATES = [
  path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];

const keep = process.argv.includes("--keep");
const selftest = process.argv.includes("--selftest");

if (process.platform !== "win32") {
  console.error("本脚本只在 Windows 上构建（嵌入的是 Windows 便携运行时）。");
  process.exit(1);
}

const work = path.join(tmpdir(), `raptor-exe-${Date.now()}`);
mkdirSync(work, { recursive: true });
console.log(`工作目录：${work}`);

// ── 1) 便携 zip（内部含 doctor 冒烟测试，全过才继续）──
const { finalZip } = buildPortable();

// ── 2) 校验 zip 顶层目录约定：启动器释放时按 PORTABLE_TOP_DIR 剥掉一层 ──
const JSZip = (await import("jszip")).default;
const zip = await JSZip.loadAsync(readFileSync(finalZip));
const stray = Object.keys(zip.files).filter((name) => !name.startsWith(`${PORTABLE_TOP_DIR}/`));
if (stray.length > 0) {
  throw new Error(`便携 zip 存在顶层目录之外的条目（示例：${stray.slice(0, 3).join("、")}），exe 释放会错位。`);
}
// 启动器释放用普通路径（不用 \\?\ 前缀，.NET 路径校验会拒绝其中的 '?'），
// 总长必须离 MAX_PATH=260 有余量：默认安装根 %LOCALAPPDATA%\CourseRaptor 约 40-60 字符。
const MAX_REL = 150;
let maxRel = 0;
for (const name of Object.keys(zip.files)) {
  const rel = name.length - PORTABLE_TOP_DIR.length - 1;
  if (rel > maxRel) maxRel = rel;
}
if (maxRel > MAX_REL) {
  throw new Error(`zip 条目相对路径最长 ${maxRel} 字符，超过 ${MAX_REL} 护栏：exe 释放可能撞 MAX_PATH，需要改造启动器后再发版。`);
}
console.log(`zip 顶层目录约定校验通过（${Object.keys(zip.files).length} 条，最长相对路径 ${maxRel} 字符）`);

// ── 3) 图标：docs/courseraptor-mascot.png 缩到 256，包成单图 PNG-in-ICO ──
const iconIco = path.join(work, "app.ico");
const iconSrc = path.join(ROOT, "docs", "courseraptor-mascot.png");
const iconArgs = [];
if (existsSync(iconSrc)) {
  const png256 = path.join(work, "icon-256.png");
  const resizePs1 = path.join(work, "icon-resize.ps1");
  writeFileSync(
    resizePs1,
    [
      "param([string]$src, [string]$out)",
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Drawing",
      "$img = [System.Drawing.Image]::FromFile($src)",
      "$bmp = New-Object System.Drawing.Bitmap 256, 256",
      "$g = [System.Drawing.Graphics]::FromImage($bmp)",
      "$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
      "$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality",
      "$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality",
      "$g.DrawImage($img, 0, 0, 256, 256)",
      "$g.Dispose(); $img.Dispose()",
      "$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)",
      "$bmp.Dispose()",
    ].join("\r\n"),
    "utf8",
  );
  execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${resizePs1}" -src "${iconSrc}" -out "${png256}"`,
    { stdio: "inherit" },
  );
  pngToIco(png256, iconIco);
  iconArgs.push(`/win32icon:"${iconIco}"`);
  console.log("应用图标已生成");
} else {
  console.log("[!] 缺少 docs/courseraptor-mascot.png，本次产物不带自定义图标");
}

// ── 4) 生成 launcher.cs：注入版本号；UTF-8 带 BOM，csc 才能把中文字面量读对 ──
const launcherCs = path.join(work, "launcher.cs");
writeFileSync(
  launcherCs,
  `\ufeff${readFileSync(path.join(ROOT, "scripts", "exe-launcher.cs"), "utf8").replace("__RAPTOR_VERSION__", version)}`,
);

// ── 5) csc 编译：zip 作为托管资源嵌入 ──
const csc = CSC_CANDIDATES.find((p) => existsSync(p));
if (!csc) throw new Error("未找到 .NET Framework 自带的 csc.exe，请确认已启用 .NET Framework 4.x。");
const exeOut = path.join(work, "courseraptor.exe");
console.log("csc 编译启动器（嵌入 zip，稍等）...");
execSync(
  `"${csc}" /nologo /target:exe /out:"${exeOut}" ${iconArgs.join(" ")} /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /resource:"${finalZip}",${RESOURCE_ID} "${launcherCs}"`,
  { stdio: "inherit" },
);

// ── 6) 自测：同一安装目录跑两遍，验证「首释放」与「版本标记命中秒开」两条路径 ──
if (selftest) {
  const home = path.join(work, "selftest-home");
  const env = { ...process.env, RAPTOR_PORTABLE_HOME: home };
  console.log("\n自测 1/2：首次释放 + doctor 自检（会解 110MB，稍等）...");
  execSync(`"${exeOut}" --raptor-selftest`, { stdio: "inherit", env });
  console.log("自测 2/2：二次启动（应跳过释放直接 doctor）...");
  execSync(`"${exeOut}" --raptor-selftest`, { stdio: "inherit", env });
}

// ── 7) 产物落位到临时根目录固定文件名，清理工作区 ──
const finalExe = path.join(tmpdir(), ARTIFACT);
copyFileSync(exeOut, finalExe);
const mb = (statSync(finalExe).size / 1024 / 1024).toFixed(1);
if (!keep) rmSync(work, { recursive: true, force: true });

console.log("\n✅ 单文件 exe 完成");
console.log(`   文件：${ARTIFACT}`);
console.log(`   大小：${mb} MB`);
console.log(`   路径：${finalExe}`);
if (keep) console.log(`   临时目录保留：${work}`);
console.log(
  `\n上传命令（zip + exe 一起传）：\n  gh release upload v${version} "${finalZip}" "${finalExe}" --clobber --repo Health-525/courseraptor`,
);

/** 单张 256px PNG 包装成 ICO：ICONDIR + ICONDIRENTRY + 原始 PNG 数据（Vista+ 支持）。 */
function pngToIco(pngPath, icoPath) {
  const png = readFileSync(pngPath);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 类型：图标
  header.writeUInt16LE(1, 4); // 图像数量
  header.writeUInt8(0, 6); // 宽 256 编码为 0
  header.writeUInt8(0, 7); // 高 256 编码为 0
  header.writeUInt8(0, 8); // 无调色板
  header.writeUInt8(0, 9); // reserved
  header.writeUInt16LE(1, 10); // 颜色平面
  header.writeUInt16LE(32, 12); // 位深
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // 数据偏移 = 头长度
  writeFileSync(icoPath, Buffer.concat([header, png]));
}
