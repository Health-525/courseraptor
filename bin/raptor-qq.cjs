#!/usr/bin/env node
/**
 * raptor-qq 全局命令入口：手动启动 QQ 机器人桥（前台运行，Ctrl+C 退出）
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = path.join(__dirname, "..");

const result = spawnSync(
  process.execPath,
  ["--import", pathToFileURL(require.resolve("tsx")).href, "./src/qq/bridge.ts"],
  { cwd: projectRoot, stdio: "inherit" }
);

if (result.error) {
  console.error("raptor-qq 启动失败：", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
