/**
 * 本地版匿名使用统计：存储聚合（gateway/local-usage.mjs）+
 * 公开上报端点 POST /api/local-usage（限流/校验）+ 管理台只读接口。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createGatewayServer } = await import("../gateway/app.mjs");
const { createRegistry } = await import("../gateway/registry.mjs");
const { createLocalUsageStore } = await import("../gateway/local-usage.mjs");

function fakeSpawner(port: number) {
  const running = new Set<string>();
  return {
    async acquire(userId: string) {
      running.add(userId);
      return port;
    },
    noteActivity() {},
    kick(userId: string) {
      running.delete(userId);
    },
    async stopAll() {},
    runningCount() {
      return running.size;
    },
    isRunning(userId: string) {
      return running.has(userId);
    },
    listRunning() {
      return [...running].map((userId) => ({
        userId,
        port,
        startedAt: Date.now(),
        lastRequestAt: Date.now(),
        restarts: 0,
      }));
    },
    startReaper() {
      return () => {};
    },
  };
}

async function startBackend(t: { after: (fn: () => void) => void }) {
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("backend-ok");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => backend.close());
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function startGateway(
  t: { after: (fn: () => void) => void },
  options: { backendPort: number; withStore?: boolean },
) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-usage-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const registry = createRegistry({ stateDir });
  const localUsage = options.withStore === false ? null : createLocalUsageStore({ stateDir });
  const server = createGatewayServer({
    registry,
    spawner: fakeSpawner(options.backendPort),
    secret: "unit-test-secret-0123456789",
    adminPassword: "admin-master-pw",
    localUsage,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, stateDir };
}

async function adminLogin(base: string) {
  const res = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "admin-master-pw" }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie") ?? "";
}

const VALID_PING = {
  id: "01234567-89ab-cdef-0123-456789abcdef",
  version: "0.3.1",
  channel: "tui",
  platform: "win32",
};

test("local-usage 存储：记录与聚合口径（今日按北京时间、7/30 天窗口、版本分布、id 打码）", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-usage-store-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const store = createLocalUsageStore({ stateDir });

  // 形状校验：脏载荷不落盘
  assert.equal(await store.record({ ...VALID_PING, id: "short" }), false);
  assert.equal(await store.record({ ...VALID_PING, channel: "web" }), false);

  assert.equal(await store.record(VALID_PING), true);
  assert.equal(
    await store.record({
      ...VALID_PING,
      id: "fedcba98-7654-3210-fedc-ba9876543210",
      version: "0.3.0",
    }),
    true,
  );
  assert.equal(
    await store.record({ ...VALID_PING, id: "aaaaaaaaaaaaaaaa", platform: "linux" }),
    true,
  );

  // 回填历史设备：一台 25 小时前（北京时间昨日，掉出今日窗口）、一台 40 天前（全掉）
  const file = path.join(stateDir, "local-usage.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    clients: Record<string, { lastSeen: number; firstSeen: number }>;
  };
  const ids = Object.keys(raw.clients);
  raw.clients[ids[1]].lastSeen = Date.now() - 25 * 3600_000;
  raw.clients[ids[2]].lastSeen = Date.now() - 40 * 24 * 3600_000;
  fs.writeFileSync(file, JSON.stringify(raw));

  const stats = await store.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.activeToday, 1); // 只有刚刚上报的那台
  assert.equal(stats.active7d, 2);
  assert.equal(stats.active30d, 2);
  // 版本分布按设备数计数
  const v031 = stats.versions.find((v) => v.name === "0.3.1");
  assert.equal(v031?.count, 2);
  // 最近列表按 lastSeen 降序，id 只保留前 8 位
  assert.equal(stats.recent[0].id.length, 8);
  assert.ok(stats.recent[0].lastSeen >= stats.recent[1].lastSeen);
});

test("上报端点：合法 204 落盘 / 脏载荷 400 / 未启用 501 / 管理台未登录 401", async (t) => {
  const backendPort = await startBackend(t);
  const { base, stateDir } = await startGateway(t, { backendPort });

  const ok = await fetch(`${base}/api/local-usage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(VALID_PING),
  });
  assert.equal(ok.status, 204);
  assert.equal(ok.body, null);

  const store = JSON.parse(fs.readFileSync(path.join(stateDir, "local-usage.json"), "utf8")) as {
    clients: Record<string, unknown>;
  };
  assert.ok(store.clients[VALID_PING.id], "合法上报应落盘");

  const bad = await fetch(`${base}/api/local-usage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "x", version: 1 }),
  });
  assert.equal(bad.status, 400);

  const unauthed = await fetch(`${base}/admin/api/local-usage`);
  assert.equal(unauthed.status, 401);

  const cookie = await adminLogin(base);
  const stats = (await (
    await fetch(`${base}/admin/api/local-usage`, { headers: { cookie } })
  ).json()) as { total: number; activeToday: number };
  assert.equal(stats.total, 1);
  assert.equal(stats.activeToday, 1);
});

test("上报端点：同 IP 每分钟 60 次限流，第 61 次 429", async (t) => {
  const backendPort = await startBackend(t);
  const { base } = await startGateway(t, { backendPort });

  let last = 0;
  for (let i = 0; i <= 60; i++) {
    last = (
      await fetch(`${base}/api/local-usage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...VALID_PING, id: `dev-${String(i).padStart(4, "0")}` }),
      })
    ).status;
  }
  assert.equal(last, 429, "第 61 次同 IP 上报应被限流");
});

test("上报端点：未装配 localUsage 时 501（本地开发网关不背这个端点）", async (t) => {
  const backendPort = await startBackend(t);
  const { base } = await startGateway(t, { backendPort, withStore: false });
  const res = await fetch(`${base}/api/local-usage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(VALID_PING),
  });
  assert.equal(res.status, 501);
});
