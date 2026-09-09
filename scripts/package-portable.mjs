#!/usr/bin/env node
/**
 * 打 Windows x64「便携包」：内置 Node 运行时 + 生产依赖，同学解压后双击 start.bat 即用，
 * 无需自己安装 Node.js、无需联网 npm ci。
 *
 * 与 publish-release.mjs 的关键区别：
 *   - publish-release 传源码 zip 到自建更新后台（要求同学装 Node）。
 *   - 本脚本产出的是「免装 Node」的自包含便携 zip，用于 GitHub Release 直接给同学下载。
 *
 * 用法：
 *   node scripts/package-portable.mjs            # 用 package.json 版本，产物打印路径
 *   node scripts/package-portable.mjs --keep     # 额外保留临时目录便于排查
 *
 * 产物：<系统临时目录>/courseraptor-vX.Y.Z-portable-win-x64.zip
 *   顶层目录 CourseRaptor/：start.bat（便携启动器）+ runtime/（内置 Node）+ app/（应用+生产依赖）
 *
 * 前提：Windows、可联网（下载 Node 运行时 + npm ci）、系统装有 PowerShell 与 curl。
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldPackagePath } from "./package-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;

// 与本机、package.json engines(>=24) 对齐的 Node LTS 版本；换版本只改这里。
const NODE_VER = "v24.8.0";
const RUNTIME_ZIP_URL = `https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-win-x64.zip`;

const ARTIFACT = `courseraptor-v${version}-portable-win-x64.zip`;
const keep = process.argv.includes("--keep");

if (process.platform !== "win32") {
  console.error("本脚本只在 Windows 上构建（打包的是 Windows 便携运行时 + start.bat）。");
  process.exit(1);
}

// ── 临时工作区（全部在项目外，避免 cpSync 自嵌套）──
const work = path.join(tmpdir(), `raptor-portable-${Date.now()}`);
const portable = path.join(work, "CourseRaptor"); // 解压后的顶层文件夹
const appDir = path.join(portable, "app");
const runtimeDir = path.join(portable, "runtime");
mkdirSync(appDir, { recursive: true });
console.log(`工作目录：${work}`);

// ── 1) 暂存应用源码：与发版同一份白名单（自动排除 data/、.env、credentials.enc、日志、密钥）──
cpSync(ROOT, appDir, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src).split(path.sep).join("/");
    return shouldPackagePath(rel);
  },
});
if (existsSync(path.join(appDir, ".env"))) {
  rmSync(path.join(appDir, ".env"), { force: true }); // 双保险：绝不带出本机 .env
  console.log("已剔除 app/.env");
}
console.log("源码已暂存（node_modules / data 未包含）");

// ── 2) 生产依赖装进 app（npm ci 会跑 postinstall: patch-tui，补丁随包固化）──
console.log("npm ci --omit=dev（首次联网，可能几分钟）...");
execSync("npm ci --omit=dev --no-audit --no-fund", { cwd: appDir, stdio: "inherit" });

// ── 3) 下载并解压内置 Node 运行时到 runtime/ ──
const dl = path.join(work, "node-runtime.zip");
console.log(`下载 Node 运行时 ${NODE_VER} ...`);
execSync(`curl -L --fail --retry 3 -o "${dl}" "${RUNTIME_ZIP_URL}"`, { stdio: "inherit" });
// PowerShell 一律走临时 .ps1 + -File：拼成一行塞进 -Command 会经过 cmd.exe 的转义，
// Windows 路径里的 \t、\r 等会被吃掉，属于随机炸的写法。
const unzipPs1 = path.join(work, "unzip-runtime.ps1");
writeFileSync(
  unzipPs1,
  ["param([string]$Archive, [string]$Destination)", "$ErrorActionPreference='Stop'", "Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force"].join(
    "\r\n",
  ),
  "utf8",
);
execSync(
  `powershell -NoProfile -ExecutionPolicy Bypass -File "${unzipPs1}" -Archive "${dl}" -Destination "${path.join(work, "node")}"`,
  { stdio: "inherit" },
);
const nodeUnpacked = path.join(work, "node", `node-${NODE_VER}-win-x64`);
mkdirSync(runtimeDir, { recursive: true });
cpSync(nodeUnpacked, runtimeDir, { recursive: true }); // node.exe + npm.cmd + npx + node_modules/npm
console.log("内置运行时已就位");

// ── 4) 顶层便携启动器：用自带 node.exe 跑 raptor，把 runtime 加入 PATH（供 /update 用自带 npm）──
const startBat = [
  "@echo off",
  "rem CourseRaptor 便携版：内置 Node 运行时，解压即用，无需安装 Node.js。",
  "chcp 65001 >nul",
  'cd /d "%~dp0"',
  'set "PATH=%~dp0runtime;%PATH%"',
  'set "NODE=%~dp0runtime\\node.exe"',
  'if not exist "%NODE%" (',
  "  echo [!] 便携包缺少 runtime\\node.exe，请重新下载完整 zip。",
  "  pause",
  "  exit /b 1",
  ")",
  'if not exist "%~dp0app\\node_modules\\tsx\\package.json" (',
  "  echo [!] app\\node_modules 不完整，请重新下载完整 zip。",
  "  pause",
  "  exit /b 1",
  ")",
  "echo 🦖 CourseRaptor 便携版启动中...",
  '"%NODE%" "%~dp0app\\bin\\raptor.cjs"',
  "if errorlevel 1 pause",
  "",
].join("\r\n");
writeFileSync(path.join(portable, "start.bat"), startBat, "utf8");
console.log("start.bat（便携启动器）已生成");

// ── 5) 冒烟测试：用内置 node 跑只读自检，证明解压即用能启动 ──
console.log("冒烟测试：runtime\\node.exe 运行 doctor ...");
execSync(`"${path.join(runtimeDir, "node.exe")}" "${path.join(appDir, "scripts", "doctor.mjs")}"`, {
  stdio: "inherit",
});

// ── 6) 打 zip：手工写条目，条目统一用正斜杠 '/'、保留顶层 CourseRaptor/ 前缀 ──
//  .NET Framework 的 ZipFile.CreateFromDirectory 会用 '\' 分隔条目，非标准、命令行 unzip 会踩坑。
//  这里逐文件 CreateEntryFromFile，把相对路径的 '\' 规范化为 '/'，产出符合 ZIP 规范的包。
const outZip = path.join(work, ARTIFACT);
console.log("压缩为 zip（规范化条目分隔符）...");
// 注意：这段必须落成 .ps1 文件用 -File 跑。拼成一行传给 -Command 时，字符串要再过一遍
// cmd.exe 的转义，`.Replace('\','/')` 的反斜杠会被吞成 `.Replace('','/')`，路径里的
// \t、\r 还会被解释成控制字符——表现为「路径中有非法字符」或 ForEach 里对 null 调方法。
const zipPs1 = path.join(work, "zip-normalized.ps1");
const zipScript = [
  "param([string]$src, [string]$out)",
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.IO.Compression",
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  "if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }",
  "$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)",
  "$base = $src.TrimEnd('\\').Length + 1",
  "$prefix = Split-Path -Leaf $src",
  "$n = 0",
  "Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {",
  "  $rel = $_.FullName.Substring($base).Replace('\\', '/')",
  "  $entry = $prefix + '/' + $rel",
  "  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null",
  "  $n += 1",
  "}",
  "$zip.Dispose()",
  "Write-Output (\"zip 条目数: $n -> $out\")",
].join("\r\n");
writeFileSync(zipPs1, zipScript, "utf8");
execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${zipPs1}" -src "${portable}" -out "${outZip}"`, {
  stdio: "inherit",
});

// ── 7) 产物搬到临时根目录的固定文件名（供上传步骤使用），再清理工作区 ──
const finalZip = path.join(tmpdir(), ARTIFACT);
copyFileSync(outZip, finalZip);
const mb = (statSync(finalZip).size / 1024 / 1024).toFixed(1);
if (!keep) rmSync(work, { recursive: true, force: true });

console.log("\n✅ 便携包完成");
console.log(`   文件：${ARTIFACT}`);
console.log(`   大小：${mb} MB`);
console.log(`   路径：${finalZip}`);
if (keep) console.log(`   临时目录保留：${portable}`);
console.log(
  `\n上传命令：\n  gh release upload v${version} "${finalZip}" --clobber --repo Health-525/courseraptor`,
);
