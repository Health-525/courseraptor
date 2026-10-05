/**
 * 网关 Token 用量链路：账本存储聚合（gateway/token-usage.mjs）+
 * 实例上报端点 POST /internal/usage-report（per-instance 令牌鉴权）+
 * 管理台筛选查询 GET /admin/api/token-usage + spawner 上报 env 注入。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createGatewayServer } = await import("../gateway/app.mjs");
const { createRegistry } = await import("../gateway/registry.mjs");
const { buildInstanceEnv } = await import("../gateway/spawner.mjs");
const { createTokenUsageStore } = await import("../gateway/token-usage.mjs");

function tempDir(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── 账本存储 ─────────────────────────────────────────────────────

test("token-usage 存储：record 落盘形状 + 脏载荷拒绝", async (t) => {
  const stateDir = tempDir(t, "raptor-gw-tokstore-");
  const store = createTokenUsageStore({ stateDir });

  assert.equal(
    await store.record({ userId: "u_1", model: "deepseek/deepseek-chat", in: 100, out: 20 }),
    true,
  );
  assert.equal(
    await store.record({ userId: "u_1", model: "deepseek/deepseek-chat", in: 50, out: 10 }),
    true,
  );
  assert.equal(
    await store.record({ userId: "u_2", model: "zhenze/glm-5.3", in: 30, out: 5 }),
    true,
  );

  // 脏载荷：空用户 / 非法模型字符 / 超上限 / 全零
  assert.equal(await store.record({ userId: "", model: "m", in: 1, out: 1 }), false);
  assert.equal(await store.record({ userId: "u_1", model: "bad name", in: 1, out: 1 }), false);
  assert.equal(await store.record({ userId: "u_1", model: "m", in: 99_999_999, out: 1 }), false);
  assert.equal(await store.record({ userId: "u_1", model: "m", in: 0, out: 0 }), false);

  const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "token-usage.json"), "utf8")) as {
    days: Record<string, Record<string, Record<string, { in: number; out: number }>>>;
  };
  const day = Object.values(raw.days)[0];
  assert.equal(day.u_1["deepseek/deepseek-chat"].in, 150, "同日同用户同模型累计");
  assert.equal(day.u_2["zhenze/glm-5.3"].out, 5);
});

test("token-usage 查询：范围×用户×模型三向筛选 + 补零 + facets", async (t) => {
  const stateDir = tempDir(t, "raptor-gw-tokquery-");
  const store = createTokenUsageStore({ stateDir });

  await store.record({ userId: "u_1", model: "deepseek/deepseek-chat", in: 100, out: 20 });
  await store.record({ userId: "u_1", model: "zhenze/glm-5.3", in: 40, out: 10 });
  await store.record({ userId: "u_2", model: "deepseek/deepseek-chat", in: 7, out: 3 });

  const all = await store.query({ range: "7" });
  assert.equal(all.days.length, 7, "近 7 天固定 7 行（逐日补零）");
  assert.equal(all.total.total, 180);
  assert.equal(all.facets.users.sort().join(","), "u_1,u_2");
  assert.equal(all.facets.models.sort().join(","), "deepseek/deepseek-chat,zhenze/glm-5.3");
  // byUser：全部用户的排行
  assert.equal(all.byUser[0].id, "u_1");
  assert.equal(all.byUser[0].total, 170);

  // model 筛选：曲线只算该模型；byUser 显示「谁用它最多」；byModel 不受影响
  const byModelFiltered = await store.query({ range: "7", model: "deepseek/deepseek-chat" });
  assert.equal(byModelFiltered.total.total, 130);
  assert.equal(byModelFiltered.byUser.length, 2);
  assert.equal(byModelFiltered.byUser.find((u) => u.id === "u_2")?.total, 10);
  assert.equal(byModelFiltered.byModel.length, 2, "byModel 排行不受模型筛选影响");

  // user 筛选：byModel 显示「TA 用什么最多」
  const byUserFiltered = await store.query({ range: "7", user: "u_1" });
  assert.equal(byUserFiltered.total.total, 170);
  assert.equal(byUserFiltered.byModel.length, 2);
  assert.equal(byUserFiltered.byModel[0].model, "deepseek/deepseek-chat");
});

test("token-usage 查询：过期日期不进结果（窗口硬边界）", async (t) => {
  const stateDir = tempDir(t, "raptor-gw-tokold-");
  const store = createTokenUsageStore({ stateDir });
  // 直接塞一笔 100 天前的旧账 + 一笔今天的
  const file = path.join(stateDir, "token-usage.json");
  const old = new Date(Date.now() - 100 * 86_400_000 + 8 * 3600_000).toISOString().slice(0, 10);
  fs.writeFileSync(file, JSON.stringify({ days: { [old]: { u_1: { m: { in: 5, out: 5 } } } } }));
  await store.record({ userId: "u_1", model: "m", in: 1, out: 1 });

  const week = await store.query({ range: "7" });
  assert.equal(week.total.total, 2, "7 天窗口不应计入 100 天前的旧账");
  const all = await store.query({ range: "all" });
  assert.equal(all.days.length, 90, "all 与 90 同窗口（账本保留上限）");
});

// ── 上报端点 + 管理台查询 ────────────────────────────────────────

function fakeSpawner(port: number, options: { reportToken?: string; userId?: string } = {}) {
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
      return [];
    },
    startReaper() {
      return () => {};
    },
    ...(options.reportToken
      ? {
          resolveReportToken(token: string) {
            return token === options.reportToken ? (options.userId ?? "u_report") : null;
          },
        }
      : {}),
  };
}

async function startGateway(
  t: { after: (fn: () => void) => void },
  options: {
    reportToken?: string;
    userId?: string;
    withStore?: boolean;
    spawnerWithoutResolve?: boolean;
  },
) {
  const stateDir = tempDir(t, "raptor-gw-tokapp-");
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("backend-ok");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => backend.close());
  const backendPort = (backend.address() as { port: number }).port;
  const registry = createRegistry({ stateDir });
  await registry.createUser({ username: "alice", password: "password123" });
  const tokenUsage = options.withStore === false ? null : createTokenUsageStore({ stateDir });
  const server = createGatewayServer({
    registry,
    spawner: options.spawnerWithoutResolve
      ? fakeSpawner(backendPort)
      : fakeSpawner(backendPort, options),
    secret: "unit-test-secret-0123456789",
    adminPassword: "admin-master-pw",
    tokenUsage,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
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

test("上报端点：合法 204 落盘 / 无效令牌 403 / 脏载荷 400 / 未启用 501", async (t) => {
  const { base, stateDir } = await startGateway(t, {
    reportToken: "tok-live-instance",
    userId: "u_report",
  });

  const ok = await fetch(`${base}/internal/usage-report`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-report-token": "tok-live-instance" },
    body: JSON.stringify({ model: "deepseek/deepseek-chat", in: 1200, out: 300 }),
  });
  assert.equal(ok.status, 204);

  const file = JSON.parse(fs.readFileSync(path.join(stateDir, "token-usage.json"), "utf8")) as {
    days: Record<string, Record<string, Record<string, { in: number }>>>;
  };
  const day = Object.values(file.days)[0];
  assert.equal(day.u_report["deepseek/deepseek-chat"].in, 1200);

  const badToken = await fetch(`${base}/internal/usage-report`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-report-token": "wrong" },
    body: JSON.stringify({ model: "m", in: 1, out: 1 }),
  });
  assert.equal(badToken.status, 403);

  const badPayload = await fetch(`${base}/internal/usage-report`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-report-token": "tok-live-instance" },
    body: JSON.stringify({ model: "m", in: -3, out: 1 }),
  });
  assert.equal(badPayload.status, 400);
});

test("上报端点：spawner 未实现令牌解析（旧测试替身/本地开发网关）一律 403", async (t) => {
  const { base } = await startGateway(t, { spawnerWithoutResolve: true });
  const res = await fetch(`${base}/internal/usage-report`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-report-token": "anything" },
    body: JSON.stringify({ model: "m", in: 1, out: 1 }),
  });
  assert.equal(res.status, 403);
});

test("上报端点：未装配 tokenUsage 时 501", async (t) => {
  const { base } = await startGateway(t, {
    reportToken: "tok-x",
    withStore: false,
  });
  const res = await fetch(`${base}/internal/usage-report`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-report-token": "tok-x" },
    body: JSON.stringify({ model: "m", in: 1, out: 1 }),
  });
  assert.equal(res.status, 501);
});

test("管理台查询：未登录 401 / 登录后筛选 + 用户名映射", async (t) => {
  const { base } = await startGateway(t, {
    reportToken: "tok-live-instance",
    userId: "u_report",
  });
  // 先报一笔（属于 u_report）
  await fetch(`${base}/internal/usage-report`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-report-token": "tok-live-instance" },
    body: JSON.stringify({ model: "deepseek/deepseek-chat", in: 900, out: 100 }),
  });

  const unauthed = await fetch(`${base}/admin/api/token-usage`);
  assert.equal(unauthed.status, 401);

  const cookie = await adminLogin(base);
  const stats = (await (
    await fetch(`${base}/admin/api/token-usage?range=7`, { headers: { cookie } })
  ).json()) as {
    total: { total: number };
    byUser: Array<{ id: string; username: string; total: number }>;
    facets: { users: Array<{ id: string; username: string }> };
  };
  assert.equal(stats.total.total, 1000);
  // 已注册用户显示用户名；u_report 不在注册表里回退 id
  const row = stats.byUser[0];
  assert.equal(row.id, "u_report");
  assert.equal(row.username, "u_report");
  assert.equal(stats.facets.users[0].username, "u_report");
});

// ── spawner env 注入 ───────────────────────────────────────────

test("buildInstanceEnv：上报端点成对注入，缺一不设", () => {
  const env = buildInstanceEnv(
    {},
    {
      port: 1,
      dataDir: "d",
      credFile: "c",
      reportUrl: "http://127.0.0.1:8080/internal/usage-report",
      reportToken: "tok-abc",
    },
  );
  assert.equal(env.RAPTOR_USAGE_REPORT_URL, "http://127.0.0.1:8080/internal/usage-report");
  assert.equal(env.RAPTOR_USAGE_REPORT_TOKEN, "tok-abc");

  const bare = buildInstanceEnv({}, { port: 2, dataDir: "d", credFile: "c" });
  assert.equal(bare.RAPTOR_USAGE_REPORT_URL, undefined);
  assert.equal(bare.RAPTOR_USAGE_REPORT_TOKEN, undefined);

  const half = buildInstanceEnv(
    {},
    { port: 3, dataDir: "d", credFile: "c", reportUrl: "http://x" },
  );
  assert.equal(half.RAPTOR_USAGE_REPORT_URL, undefined, "只有 URL 没有令牌时不设");
});
