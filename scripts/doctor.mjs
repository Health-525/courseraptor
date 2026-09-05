#!/usr/bin/env node
/** 只读自检：不加载 .env、不解密凭证、不请求网络，只报告运行前提。 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const checks = [];
const record = (id, ok, message) => checks.push({ id, status: ok ? "ok" : "error", message });
record("node", Number(process.versions.node.split(".")[0]) >= 24,
  `Node.js ${process.versions.node}；需要 24 或更高版本。`);
for (const name of Object.keys(pkg.dependencies)) {
  let found = false;
  try { found = existsSync(fileURLToPath(import.meta.resolve(name))); } catch { /* 按 ESM 条件解析，不执行依赖。 */ }
  record(`dependency:${name}`, found, found ? `${name} 可用` : `${name} 缺失；请在项目目录运行 npm ci。`);
}
for (const file of ["src/index.ts", "src/demo.ts", "docs/courseraptor-logo.png", "node_modules/marked/lib/marked.umd.js"]) {
  record(`file:${file}`, existsSync(path.join(root, file)), `${file} ${existsSync(path.join(root, file)) ? "存在" : "缺失，请重新安装或获取完整项目"}`);
}
checks.push({ id: "credentials", status: "info", message: existsSync(path.join(root, "credentials.enc"))
  ? "检测到加密凭证文件；未读取或验证内容。"
  : "未发现加密凭证；npm start 可引导配置，npm run demo 无需账号。" });
checks.push({ id: "scope", status: "info", message: "本检查不验证网络、登录、API Key 余额、模型可用性或校方接口状态；不会展示个人信息。" });
const ok = checks.every((check) => check.status !== "error");
if (process.argv.includes("--json")) console.log(JSON.stringify({ ok, version: pkg.version, checks }, null, 2));
else {
  console.log(`CourseRaptor ${pkg.version} 启动自检\n`);
  for (const check of checks) console.log(`[${check.status.toUpperCase()}] ${check.message}`);
  console.log(ok ? "\n运行前提已就绪。先体验：npm run demo；正式使用：npm start。" : "\n请先解决上面的 ERROR，再重新运行 npm run doctor。");
}
process.exitCode = ok ? 0 : 1;
