#!/usr/bin/env node
/**
 * raptor 全局命令入口
 *
 * npm link 后由 npm 生成的 raptor.cmd / raptor shim 调起本文件，
 * 再以 node --import tsx 运行 ESM 入口（顶层 await 需要 true ESM 环境）。
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = path.join(__dirname, "..");

// 以项目根为 cwd + 相对路径入口：绕开 Windows 下 Node CLI
// 对绝对路径/file:// URL 主入口的两种解析 bug（'d:' 协议 / 相对化拼接）
const result = spawnSync(
  process.execPath,
  ["--import", pathToFileURL(require.resolve("tsx")).href, "./src/index.ts"],
  { cwd: projectRoot, stdio: "inherit" }
);

if (result.error) {
  console.error("raptor 启动失败：", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
