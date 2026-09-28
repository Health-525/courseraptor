#!/usr/bin/env node
/**
 * CourseRaptor 多用户网关入口。
 *
 * 运行（生产用 systemd 注入环境变量，见 docs/multi-user-deploy.md）：
 *   GATEWAY_SECRET=至少16位随机串 \
 *   GATEWAY_DEEPSEEK_KEY=站点统一 DeepSeek Key（可空=同学必须自带） \
 *   GATEWAY_STATE_DIR=/var/lib/raptor-gateway \
 *   GATEWAY_USERS_DIR=/var/lib/raptor-users \
 *   node server/gateway/gateway.mjs
 *
 * 可调参数：GATEWAY_PORT(8080) / GATEWAY_MAX_CONCURRENT(4) /
 * GATEWAY_IDLE_MINUTES(30) / GATEWAY_DAILY_TURNS(100)
 * 本服务直接对公网监听（MVP 无 TLS）；上 HTTPS 时改由 Nginx 前置并调整
 * GATEWAY_HOST 为 127.0.0.1。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayServer } from "./app.mjs";
import { createRegistry } from "./registry.mjs";
import { createSpawner } from "./spawner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const env = process.env;

const secret = env.GATEWAY_SECRET;
if (!secret || secret.length < 16) {
  console.error("启动失败：请设置 GATEWAY_SECRET（至少 16 位随机串）");
  process.exit(1);
}

const stateDir = env.GATEWAY_STATE_DIR || path.join(ROOT, "server", "gateway", "state");
const usersDir = env.GATEWAY_USERS_DIR || path.join(ROOT, "server", "gateway", "users");
const port = Number(env.GATEWAY_PORT) || 8080;
const host = env.GATEWAY_HOST || "0.0.0.0";

const registry = createRegistry({ stateDir });
const spawner = createSpawner({
  projectRoot: ROOT,
  usersDir,
  deepseekKey: env.GATEWAY_DEEPSEEK_KEY || "",
  maxConcurrent: Number(env.GATEWAY_MAX_CONCURRENT) || 4,
  idleMinutes: Number(env.GATEWAY_IDLE_MINUTES) || 30,
});
const stopReaper = spawner.startReaper();
const server = createGatewayServer({
  registry,
  spawner,
  secret,
  dailyTurns: Number(env.GATEWAY_DAILY_TURNS) || 100,
  projectRoot: ROOT,
});

server.listen(port, host, () => {
  console.log(`✅ CourseRaptor 多用户网关已启动：http://${host}:${port}`);
  console.log(`   用户数据目录：${usersDir}`);
  console.log(`   并发上限 ${env.GATEWAY_MAX_CONCURRENT || 4} · 空闲回收 ${env.GATEWAY_IDLE_MINUTES || 30} 分钟 · 每日每人 ${env.GATEWAY_DAILY_TURNS || 100} 轮`);
  console.log("   生成邀请码：node server/gateway/admin.mjs invite");
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[gateway] 收到 ${signal}，回收全部实例后退出`);
  stopReaper();
  void spawner.stopAll().then(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
