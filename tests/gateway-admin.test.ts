import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createGatewayServer } = await import("../server/gateway/app.mjs");
const { createRegistry } = await import("../server/gateway/registry.mjs");

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
    startReaper() {
      return () => {};
    },
  };
}

async function startGateway(
  t: { after: (fn: () => void) => void },
  options: { backendPort: number; adminPassword?: string },
) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-admin-"));
  const registry = createRegistry({ stateDir });
  const spawner = fakeSpawner(options.backendPort);
  const server = createGatewayServer({
    registry,
    spawner,
    secret: "unit-test-secret-0123456789",
    adminPassword: options.adminPassword,
    maxConcurrent: 4,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, registry, spawner };
}

async function adminLogin(base: string, password: string) {
  const res = await fetch(`${base}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
    redirect: "manual",
  });
  return { status: res.status, cookie: res.headers.get("set-cookie") ?? "" };
}

test("管理台：未设密码时显示未启用，API 一律 404", async (t) => {
  const backendPort = await startBackend(t);
  const { base } = await startGateway(t, { backendPort });
  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /未启用/);
  const api = await fetch(`${base}/admin/api/overview`);
  assert.equal(api.status, 404);
});

test("管理台：密码登录→会话→总览/用户/邀请码/动作全链路", async (t) => {
  const backendPort = await startBackend(t);
  const { base, registry } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
  });

  // 未登录：页面是登录表单，API 401
  const anonPage = await fetch(`${base}/admin`);
  assert.match(await anonPage.text(), /管理密码/);
  assert.equal((await fetch(`${base}/admin/api/overview`)).status, 401);

  // 错误密码 401，正确密码 303 + 管理会话 Cookie
  assert.equal((await adminLogin(base, "wrong-password")).status, 401);
  const login = await adminLogin(base, "admin-master-pw");
  assert.equal(login.status, 303);
  assert.match(login.cookie, /raptor_admin=/);
  assert.match(login.cookie, /HttpOnly/);
  const cookie = login.cookie;

  // 造一个真实用户 + 邀请码，总览应反映
  const [invite] = await registry.createInvites({ count: 1, note: "测试" });
  const user = await registry.createUser({ username: "classmate1", password: "password123" });
  await registry.addTurns(user.id, 7);

  const overview = await fetch(`${base}/admin/api/overview`, { headers: { cookie } });
  assert.equal(overview.status, 200);
  const data = (await overview.json()) as { users: number; invitesLeft: number; turnsToday: number };
  assert.equal(data.users, 1);
  assert.equal(data.invitesLeft, 1);
  assert.equal(data.turnsToday, 7);

  // 用户列表带在线标记（未访问过 → 不在线）
  const users = (await (await fetch(`${base}/admin/api/users`, { headers: { cookie } })).json()) as Array<{
    username: string;
    online: boolean;
  }>;
  assert.equal(users[0].username, "classmate1");
  assert.equal(users[0].online, false);

  // 网页生成邀请码
  const created = await fetch(`${base}/admin/api/invite`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ count: 2, note: "网页生成" }),
  });
  assert.equal(created.status, 200);
  const invites = (await (await fetch(`${base}/admin/api/invites`, { headers: { cookie } })).json()) as Array<{
    note: string;
  }>;
  assert.equal(invites.filter((i) => i.note === "网页生成").length, 2);

  // 停用后该同学登录被拒
  const disable = await fetch(`${base}/admin/api/user/disable`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ user: "classmate1" }),
  });
  assert.equal(disable.status, 200);
  const userLogin = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "classmate1", password: "password123" }),
    redirect: "manual",
  });
  assert.equal(userLogin.status, 401);
  assert.match(await userLogin.text(), /已被停用/);

  // 重置密码：旧密码失效、新密码可登录（先启用回来）
  await fetch(`${base}/admin/api/user/enable`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ user: user.id }),
  });
  const reset = await fetch(`${base}/admin/api/user/reset-pass`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ user: "classmate1", password: "new-password-9" }),
  });
  assert.equal(reset.status, 200);
  const oldLogin = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "classmate1", password: "password123" }),
    redirect: "manual",
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "classmate1", password: "new-password-9" }),
    redirect: "manual",
  });
  assert.equal(newLogin.status, 303);
});

test("管理台：会话互不通用（管理 Cookie 打不开同学页面，反之亦然）", async (t) => {
  const backendPort = await startBackend(t);
  const { base, registry } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
  });
  const adminCookie = (await adminLogin(base, "admin-master-pw")).cookie;

  // 管理会话不能充当同学会话：GET / 应跳登录页
  const asUser = await fetch(`${base}/`, { headers: { cookie: adminCookie }, redirect: "manual" });
  assert.equal(asUser.status, 303);
  assert.equal(asUser.headers.get("location"), "/login");

  // 同学会话打不开管理 API：先注册一个同学
  const [invite] = await registry.createInvites({ count: 1 });
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite: invite.code,
      username: "classmate2",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  const userCookie = reg.headers.get("set-cookie") ?? "";
  assert.match(userCookie, /raptor_sess=/);
  const asAdmin = await fetch(`${base}/admin/api/overview`, { headers: { cookie: userCookie } });
  assert.equal(asAdmin.status, 401);
});

test("管理台：登录失败五次锁定", async (t) => {
  const backendPort = await startBackend(t);
  const { base } = await startGateway(t, { backendPort, adminPassword: "admin-master-pw" });
  for (let i = 0; i < 5; i++) {
    assert.equal((await adminLogin(base, "nope-nope")).status, 401);
  }
  const locked = await adminLogin(base, "admin-master-pw");
  assert.equal(locked.status, 429);
});
