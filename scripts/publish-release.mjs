#!/usr/bin/env node
/**
 * 发版：bump 版本 -> 打包工作区 zip -> 发布到更新后台。
 * 同学端 raptor 启动时即会提示，/update 一键更新。
 *
 * 用法：
 *   npm run publish -- "更新说明文字"              # patch：0.1.0 -> 0.1.1
 *   npm run publish -- minor "更新说明文字"        # 0.1.0 -> 0.2.0
 *   npm run publish -- major "更新说明文字"        # 0.1.0 -> 1.0.0
 *
 * 依赖 .env 里的两个配置：
 *   UPDATE_SERVER_URL=http://你的后台地址:8787
 *   UPDATE_ADMIN_TOKEN=后台启动时设的发布密钥
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 读 .env（后台地址 + 发布密钥），不覆盖已有环境变量 ──
const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const SERVER = (process.env.UPDATE_SERVER_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.UPDATE_ADMIN_TOKEN;
if (!SERVER || !TOKEN) {
  console.error("缺配置：请在 .env 里加 UPDATE_SERVER_URL 和 UPDATE_ADMIN_TOKEN。");
  process.exit(1);
}
try {
  if (new URL(SERVER).protocol !== "https:") throw new Error("not https");
} catch {
  console.error("UPDATE_SERVER_URL 必须是可公开访问的 HTTPS 地址。");
  process.exit(1);
}

// ── 参数 ──
const rest = process.argv.slice(2);
const bump = ["patch", "minor", "major"].includes(rest[0]) ? rest.shift() : "patch";
const notes = rest.join(" ").trim();

// ── bump 版本 ──
const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
pkg.version =
  bump === "major"
    ? `${maj + 1}.0.0`
    : bump === "minor"
      ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
const version = pkg.version;
console.log(`版本号 -> v${version}${notes ? `（${notes}）` : ""}`);

// ── 打包：工作区 -> 暂存目录（排除本机数据/隐私）-> zip ──
// 注意：data/ 下的 term-dates.json 是「随代码下发」的校历真值，必须进包；
// 只排除 data 里的运行时产物（更新缓存 / 下载暂存 / 打包暂存）。
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "downloads", "update-data", "server", ".workbuddy",
]);
// 相对路径（/ 分隔）精确排除；命中自身或其任一父级目录即跳过
const EXCLUDE_PATHS = new Set([
  ".env", "credentials.enc", "session.json", "memory.json", "qq-allowlist.json",
  "data/update-check.json", "data/update-download", "data/publish",
]);
const isExcluded = (rel) => {
  const seg = rel.split("/");
  for (let i = 1; i <= seg.length; i++) {
    if (EXCLUDE_PATHS.has(seg.slice(0, i).join("/"))) return true;
  }
  return false;
};
// 暂存目录必须放在项目外：cpSync 源目录嵌在项目里会自我嵌套报 ERR_FS_CP_EINVAL
const publishWork = path.join(tmpdir(), `raptor-publish-${Date.now()}`);
const stage = path.join(publishWork, "stage");
const zipFile = path.join(publishWork, `courseraptor-v${version}.zip`);
mkdirSync(stage, { recursive: true });
cpSync(ROOT, stage, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src).split(path.sep).join("/");
    if (!rel) return true;
    const top = rel.split("/")[0];
    return !EXCLUDE_DIRS.has(top) && !top.endsWith(".log") && !isExcluded(rel);
  },
});

// 仅在待发布副本写入更新服务地址；源码本地开发无需配置更新后台。
const stagedUpdateCheck = path.join(stage, "src", "update-check.ts");
const updateCheckSource = readFileSync(stagedUpdateCheck, "utf8");
const placeholderLine = 'const DEFAULT_UPDATE_SERVER = "__RAPTOR_RELEASE_SERVER__";';
if (!updateCheckSource.includes(placeholderLine)) {
  throw new Error("未找到客户端更新服务器占位符，已中止打包");
}
writeFileSync(
  stagedUpdateCheck,
  updateCheckSource.replace(placeholderLine, `const DEFAULT_UPDATE_SERVER = ${JSON.stringify(SERVER)};`),
);

function compress(dir, out) {
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command ` +
        `Compress-Archive -Path (Join-Path '${dir}' '*') -DestinationPath '${out}' -Force`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`cd '${dir}' && zip -qr '${out}' .`, { stdio: "inherit" });
  }
}
compress(stage, zipFile);
const zipSize = (existsSync(zipFile) && readFileSync(zipFile).length / 1024 / 1024).toFixed(2);
console.log(`打包完成：courseraptor-v${version}.zip（${zipSize} MB，不含 node_modules）`);

// ── 发布到后台 ──
try {
  const res = await fetch(`${SERVER}/publish`, {
    method: "POST",
    headers: {
      "x-admin-token": TOKEN,
      "x-version": version,
      "x-notes": encodeURIComponent(notes),
      "content-type": "application/zip",
    },
    body: readFileSync(zipFile),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  console.log(`✅ v${version} 已发布到 ${SERVER}`);
  console.log("   同学端下次启动 raptor 即会提示更新，/update 一键升级。");
  console.log("   别忘了把 package.json 的版本号变更提交到 git。");
  rmSync(publishWork, { recursive: true, force: true }); // 发布成功才清理，失败要留 zip 重试
} catch (e) {
  console.error(`❌ 发布失败：${e.message}`);
  console.error(`   手动重试：curl -X POST "${SERVER}/publish" -H "x-admin-token: $UPDATE_ADMIN_TOKEN" ` +
    `-H "x-version: ${version}" --data-binary @"${zipFile}"`);
  process.exit(1);
}
