#!/usr/bin/env node

/**
 * 安装 git hooks（lefthook）。供 package.json 的 postinstall 调用。
 *
 * 为什么不能直接写 `lefthook install`：
 * 便携包（scripts/package-portable.mjs）在临时目录里 `npm ci --omit=dev` 后同样会跑
 * postinstall，而那个目录不是 git 仓库、也没装 lefthook 二进制，lefthook 会以
 * "not a git repository" 退出 128，把整个打包打断。发版产物不需要 git hooks，
 * 所以这里按仓库特征决定装不装。
 *
 * 行为：
 *  - 有 .git（开发机 / CI checkout）：装 hooks；lefthook 缺失或失败只告警不阻断
 *    （装依赖不该因为钩子工具缺失而失败）。
 *  - 无 .git（便携包、zip 分发的 app/）：跳过，退出 0。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(path.join(ROOT, ".git"))) {
  console.log("[install-hooks] 非 git 仓库（便携包/分发物），跳过 git hooks 安装");
  process.exit(0);
}

const res = spawnSync("lefthook", ["install"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (res.error || res.status !== 0) {
  const why = res.error ? res.error.message.split("\n")[0] : `exit ${res.status}`;
  console.warn(`[install-hooks] 跳过 git hooks：${why}（不影响安装，可手动 npx lefthook install）`);
}

process.exit(0);
