#!/usr/bin/env node
/**
 * raptor 全局命令入口：终端对话 + QQ 机器人（已配置时）一并启动
 * 前台运行，Ctrl+C 退出
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = path.join(__dirname, "..");

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
