#!/usr/bin/env node
/**
 * CourseRaptor 多用户网关入口。
 *
 * 运行（生产用 systemd 注入环境变量，见 docs/multi-user-deploy.md）：
 *   GATEWAY_SECRET=至少16位随机串 \
 *   GATEWAY_DEEPSEEK_KEY=站点统一 DeepSeek Key（可空=同学必须自带） \
 *   GATEWAY_STATE_DIR=/var/lib/raptor-gateway \
 *   GATEWAY_USERS_DIR=/var/lib/raptor-users \
 *   node gateway/gateway.mjs
 *
 * 可调参数：GATEWAY_PORT(8080) / GATEWAY_MAX_CONCURRENT(4) /
 * GATEWAY_IDLE_MINUTES(30) / GATEWAY_DAILY_TURNS(100)
 * 本服务直接对公网监听（MVP 无 TLS）；上 HTTPS 时改由 Nginx 前置并调整
 * GATEWAY_HOST 为 127.0.0.1。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayServer } from "./app.mjs";
import { createLocalUsageStore } from "./local-usage.mjs";
import { createRegistry } from "./registry.mjs";
import { createSpawner } from "./spawner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const { version: appVersion } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

const secret = env.GATEWAY_SECRET;
if (!secret || secret.length < 16) {
  console.error("启动失败：请设置 GATEWAY_SECRET（至少 16 位随机串）");
  process.exit(1);
}

const stateDir = env.GATEWAY_STATE_DIR || path.join(ROOT, "gateway", "state");
const usersDir = env.GATEWAY_USERS_DIR || path.join(ROOT, "gateway", "users");
const port = Number(env.GATEWAY_PORT) || 8080;
const host = env.GATEWAY_HOST || "0.0.0.0";

const registry = createRegistry({ stateDir });

// 启动自检：状态文件损坏（users.json 等）时立即退出并指明修复路径，
// 而不是等到第一个请求才 500——registry 对损坏文件的策略是「拒绝读取
// 以防空表覆盖落盘」，这里让该策略在启动时就可见
try {
  await registry.listUsers();
  await registry.listInvites();
} catch (e) {
  console.error(`启动失败：网关状态文件自检未通过——${e?.message ?? e}`);
  process.exit(1);
}
const spawner = createSpawner({
  projectRoot: ROOT,
  usersDir,
  deepseekKey: env.GATEWAY_DEEPSEEK_KEY || "",
  // 管理台改站点 Key 后，新拉起的实例即用新值（已在线实例重启后切换）
  getDeepseekKey: () => registry.getSiteSettings().then((s) => s.deepseekKey),
  // 同学钉在「站点免费额度」模式时，实例禁用其保存的自己 Key（Key 保留不删）
  getForceSiteKey: (userId) => registry.findUserById(userId).then((u) => u?.dsMode === "site"),
  // 同学当前选的模型供应商（users.json，/api/provider 切换后踢实例生效）
  getProviderId: (userId) => registry.findUserById(userId).then((u) => u?.providerId || "deepseek"),
  // 指定供应商的站点 Key（site.json providerKeys；deepseek 回退 env GATEWAY_DEEPSEEK_KEY）
  getProviderSiteKey: async (providerId) => {
    const keys = await registry.getSiteProviderKeys();
    if (keys[providerId]) return keys[providerId];
    if (providerId === "deepseek") return env.GATEWAY_DEEPSEEK_KEY || "";
    return "";
  },
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
  adminPassword: env.GATEWAY_ADMIN_PASSWORD || "",
  maxConcurrent: Number(env.GATEWAY_MAX_CONCURRENT) || 4,
  updateServerUrl: env.GATEWAY_UPDATE_URL || "",
  updateAdminToken: env.GATEWAY_UPDATE_TOKEN || "",
  usersDir,
  // 管理台展示用：当前部署的代码版本，以及 env 是否兜底配了站点 Key
  appVersion: String(appVersion || ""),
  envDeepseekKeySet: Boolean(env.GATEWAY_DEEPSEEK_KEY),
  // 本地版（安装包/TUI）匿名使用统计：POST /api/local-usage 收，管理台看
  localUsage: createLocalUsageStore({ stateDir }),
});

// 连接保活拉长到 72s：跨公网 RTT 大、且前端有分钟级轮询，
// 复用连接可省掉每次 ~200ms+ 的 TCP 握手（默认 5s 内就断了）
server.keepAliveTimeout = 72_000;
server.headersTimeout = 76_000;

server.listen(port, host, () => {
  console.log(`✅ CourseRaptor 多用户网关已启动：http://${host}:${port}`);
  console.log(`   用户数据目录：${usersDir}`);
  console.log(
    `   并发上限 ${env.GATEWAY_MAX_CONCURRENT || 4} · 空闲回收 ${env.GATEWAY_IDLE_MINUTES || 30} 分钟 · 每日每人 ${env.GATEWAY_DAILY_TURNS || 100} 轮`,
  );
  console.log(
    env.GATEWAY_ADMIN_PASSWORD
      ? "   网页管理台：http://" + host + ":" + port + "/admin"
      : "   网页管理台未启用（设置 GATEWAY_ADMIN_PASSWORD 开启）；命令行：node gateway/admin/cli.mjs invite",
  );
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[gateway] 收到 ${signal}，回收全部实例后退出`);
  stopReaper();
  void spawner
    .stopAll()
    .then(() => server.close(() => process.exit(0)))
    .catch((e) => {
      console.error(`[gateway] 关闭时回收实例出错：${e?.message ?? e}`);
      process.exit(1);
    });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
