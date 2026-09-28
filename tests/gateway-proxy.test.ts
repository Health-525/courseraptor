import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createGatewayServer } = await import("../server/gateway/app.mjs");
const { createRegistry } = await import("../server/gateway/registry.mjs");

/**
 * 假后端：扮演某位同学的 CourseRaptor 实例。记录收到的 Host / Origin，
 * GET /marker 返回标记文本，POST /api/chat 返回两段流式数据。
 */
async function startFakeBackend(t: { after: (fn: () => void) => void }) {
  const seen: { host: string; origin: string | undefined }[] = [];
  const backend = http.createServer((req, res) => {
    seen.push({ host: String(req.headers.host ?? ""), origin: req.headers.origin });
    if (req.method === "GET" && req.url === "/marker") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("backend-ok");
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second\n\n");
        res.end();
      }, 30);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => backend.close());
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  return { port: address.port, seen };
}

function fakeSpawner(port: number) {
  const calls: string[] = [];
  return {
    calls,
    async acquire(userId: string) {
      calls.push(`acquire:${userId}`);
      return port;
    },
    noteActivity(userId: string) {
      calls.push(`note:${userId}`);
    },
    kick() {},
    async stopAll() {},
    runningCount() {
      return 1;
    },
    isRunning(userId: string) {
      return calls.includes(`acquire:${userId}`);
    },
    startReaper() {
      return () => {};
    },
  };
}

async function startGateway(
  t: { after: (fn: () => void) => void },
  options: { dailyTurns?: number; backendPort: number },
) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-app-"));
  const registry = createRegistry({ stateDir });
  const spawner = fakeSpawner(options.backendPort);
  const server = createGatewayServer({
    registry,
    spawner,
    secret: "unit-test-secret-0123456789",
    dailyTurns: options.dailyTurns ?? 100,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, registry, spawner };
}

async function registerAndLogin(base: string, username: string, invite: string) {
  const register = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite,
      username,
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  assert.equal(register.status, 303);
  return register.headers.get("set-cookie") ?? "";
}

test("网关：未登录访问跳登录页，注册后代理到实例并改写 Host / 剥 Origin", async (t) => {
  const backend = await startFakeBackend(t);
  const { base, registry } = await startGateway(t, { backendPort: backend.port });
  const [invite] = await registry.createInvites({ count: 1 });

  // 未登录：页面请求 303 到 /login，API 请求 401 JSON
  const anonPage = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(anonPage.status, 303);
  assert.equal(anonPage.headers.get("location"), "/login");
  const anonApi = await fetch(`${base}/api/sessions`);
  assert.equal(anonApi.status, 401);

  // 注册即登录：拿到会话 Cookie
  const cookie = await registerAndLogin(base, "student01", invite.code);
  assert.match(cookie, /raptor_sess=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  // 带 Cookie 的请求被代理到「实例」，后端看到的 Host 是本机端口、无 Origin
  const page = await fetch(`${base}/marker`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "backend-ok");
  const last = backend.seen.at(-1);
  assert.equal(last?.host, `127.0.0.1:${backend.port}`);
  assert.equal(last?.origin, undefined);
});

test("网关：SSE 流式透传（chat 分片到达客户端）", async (t) => {
  const backend = await startFakeBackend(t);
  const { base, registry } = await startGateway(t, { backendPort: backend.port });
  const [invite] = await registry.createInvites({ count: 1 });
  const cookie = await registerAndLogin(base, "student01", invite.code);

  const chat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(chat.status, 200);
  assert.match(chat.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await chat.text();
  assert.ok(text.includes("first") && text.includes("second"), "两段数据都要到达");
});

test("网关：每日轮数限额生效", async (t) => {
  const backend = await startFakeBackend(t);
  const { base, registry } = await startGateway(t, { backendPort: backend.port, dailyTurns: 1 });
  const [invite] = await registry.createInvites({ count: 1 });
  const cookie = await registerAndLogin(base, "student01", invite.code);

  const first = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  assert.equal(first.status, 200);
  const second = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  assert.equal(second.status, 429);
  assert.match(String((await second.json()).error), /已用完/);
});

test("网关：登录失败五次锁定，锁定期内正确密码也被拒", async (t) => {
  const backend = await startFakeBackend(t);
  const { base, registry } = await startGateway(t, { backendPort: backend.port });
  const [invite] = await registry.createInvites({ count: 1 });
  const cookie = await registerAndLogin(base, "student01", invite.code);
  assert.ok(cookie);

  for (let i = 0; i < 5; i++) {
    const wrong = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "student01", password: "nope-nope" }),
      redirect: "manual",
    });
    assert.equal(wrong.status, 401);
  }
  const locked = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "student01", password: "password123" }),
    redirect: "manual",
  });
  assert.equal(locked.status, 429, "正确密码在锁定期内也应被拒");
});

test("网关：停用账号密码正确也拒绝登录", async (t) => {
  const backend = await startFakeBackend(t);
  const { base, registry } = await startGateway(t, { backendPort: backend.port });
  const [invite] = await registry.createInvites({ count: 1 });
  await registerAndLogin(base, "student02", invite.code);

  const user2 = await registry.findUserByName("student02");
  assert.ok(user2);
  await registry.setDisabled(user2.id, true);
  const disabledLogin = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "student02", password: "password123" }),
    redirect: "manual",
  });
  assert.equal(disabledLogin.status, 401);
  assert.match(await disabledLogin.text(), /已被停用/);
});

test("网关：邀请码无效或密码不一致时注册被拒", async (t) => {
  const backend = await startFakeBackend(t);
  const { base, registry } = await startGateway(t, { backendPort: backend.port });
  const [invite] = await registry.createInvites({ count: 1 });

  const badInvite = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite: "wrong-code",
      username: "student09",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  assert.equal(badInvite.status, 400);
  assert.match(await badInvite.text(), /邀请码无效/);

  const mismatch = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite: invite.code,
      username: "student09",
      password: "password123",
      password2: "password456",
    }),
    redirect: "manual",
  });
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /不一致/);

  // 消耗掉的邀请码不应影响后续合法注册
  const again = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite: invite.code,
      username: "student09",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  assert.equal(again.status, 303);
});

test("网关：/health 公开、伪造 Cookie 被拒", async (t) => {
  const backend = await startFakeBackend(t);
  const { base } = await startGateway(t, { backendPort: backend.port });
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const forged = await fetch(`${base}/marker`, {
    headers: { cookie: "raptor_sess=u_deadbeef.9999999999999.0000" },
    redirect: "manual",
  });
  assert.equal(forged.status, 303, "签名不符应视为未登录");
});
