import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

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
  options: {
    backendPort: number;
    adminPassword?: string;
    updateServerUrl?: string;
    updateAdminToken?: string;
  },
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
    updateServerUrl: options.updateServerUrl,
    updateAdminToken: options.updateAdminToken,
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
  const data = (await overview.json()) as {
    users: number;
    invitesLeft: number;
    turnsToday: number;
  };
  assert.equal(data.users, 1);
  assert.equal(data.invitesLeft, 1);
  assert.equal(data.turnsToday, 7);

  // 用户列表带在线标记（未访问过 → 不在线）
  const users = (await (
    await fetch(`${base}/admin/api/users`, { headers: { cookie } })
  ).json()) as Array<{
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
  const invites = (await (
    await fetch(`${base}/admin/api/invites`, { headers: { cookie } })
  ).json()) as Array<{
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

/** 假更新后台：校验 x-admin-token，提供 overview/versions/rollback/delete */
async function startFakeUpdateServer(t: { after: (fn: () => void) => void }, token: string) {
  const seen: string[] = [];
  const rolledBack: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} token=${req.headers["x-admin-token"]}`);
    if (req.headers["x-admin-token"] !== token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "管理员密钥无效" }));
      return;
    }
    if (req.method === "GET" && req.url === "/admin/api/overview") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          current: { version: "0.3.0", notes: "测试版", publishedAt: "2026-09-28T00:00:00Z" },
          stats: {},
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/admin/api/versions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          versions: [
            {
              version: "0.3.0",
              notes: "测试版",
              publishedAt: "2026-09-28T00:00:00Z",
              sizeBytes: 1048576,
              isCurrent: true,
            },
            {
              version: "0.2.0",
              notes: "旧版",
              publishedAt: "2026-09-01T00:00:00Z",
              sizeBytes: 2097152,
              isCurrent: false,
            },
          ],
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      (req.url === "/admin/api/rollback" || req.url === "/admin/api/delete")
    ) {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (req.url === "/admin/api/rollback") rolledBack.push(String(body.version));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, seen, rolledBack };
}

test("管理台·版本发布：代理到更新后台（带鉴权），回滚动作透传", async (t) => {
  const backendPort = await startBackend(t);
  const update = await startFakeUpdateServer(t, "update-token-123");
  const { base } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
    updateServerUrl: update.url,
    updateAdminToken: "update-token-123",
  });
  const cookie = (await adminLogin(base, "admin-master-pw")).cookie;

  const overview = (await (
    await fetch(`${base}/admin/api/update/overview`, { headers: { cookie } })
  ).json()) as {
    data?: { current?: { version: string } };
  };
  assert.equal(overview.data?.current?.version, "0.3.0");
  assert.ok(
    update.seen.some((s) => s.includes("GET /admin/api/overview token=update-token-123")),
    "令牌应原样转发",
  );

  const versions = (await (
    await fetch(`${base}/admin/api/update/versions`, { headers: { cookie } })
  ).json()) as {
    data?: { versions: Array<{ version: string; isCurrent: boolean }> };
  };
  assert.equal(versions.data?.versions.length, 2);
  assert.equal(versions.data?.versions[0].isCurrent, true);

  const rollback = await fetch(`${base}/admin/api/update/rollback`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ version: "0.2.0" }),
  });
  assert.equal(rollback.status, 200);
  assert.deepEqual(update.rolledBack, ["0.2.0"]);
});

test("管理台·版本发布：令牌不符时返回可读错误，未配置时返回未接入", async (t) => {
  const backendPort = await startBackend(t);
  const update = await startFakeUpdateServer(t, "real-token");

  // 令牌不对：更新后台 401 → 网关转成可读错误
  const wrong = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
    updateServerUrl: update.url,
    updateAdminToken: "wrong-token",
  });
  const wrongCookie = (await adminLogin(wrong.base, "admin-master-pw")).cookie;
  const wrongResult = (await (
    await fetch(`${wrong.base}/admin/api/update/overview`, { headers: { cookie: wrongCookie } })
  ).json()) as { error?: string };
  assert.match(wrongResult.error ?? "", /令牌/);

  // 完全未配置：unavailable 标记，前端显示「未接入」提示
  const off = await startGateway(t, { backendPort, adminPassword: "admin-master-pw" });
  const offCookie = (await adminLogin(off.base, "admin-master-pw")).cookie;
  const offResult = (await (
    await fetch(`${off.base}/admin/api/update/overview`, { headers: { cookie: offCookie } })
  ).json()) as { unavailable?: boolean };
  assert.equal(offResult.unavailable, true);

  // 未登录依然 401
  assert.equal((await fetch(`${off.base}/admin/api/update/overview`)).status, 401);
});

test("管理台·bootstrap：一次往返带回全部面板数据", async (t) => {
  const backendPort = await startBackend(t);
  const update = await startFakeUpdateServer(t, "update-token-123");
  const { base, registry } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
    updateServerUrl: update.url,
    updateAdminToken: "update-token-123",
  });
  const [invite] = await registry.createInvites({ count: 1 });
  const user = await registry.createUser({ username: "bootuser", password: "password123" });
  await registry.addTurns(user.id, 4);

  const cookie = (await adminLogin(base, "admin-master-pw")).cookie;
  const boot = (await (
    await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie } })
  ).json()) as {
    overview: { users: number; turnsToday: number; invitesLeft: number };
    users: Array<{ username: string; online: boolean }>;
    invites: unknown[];
    update: {
      overview: { data?: { current?: { version: string } } };
      versions: { data?: { versions: unknown[] } };
    };
  };
  assert.equal(boot.overview.users, 1);
  assert.equal(boot.overview.turnsToday, 4);
  assert.equal(boot.overview.invitesLeft, 1);
  assert.equal(boot.users[0].username, "bootuser");
  assert.equal(boot.invites.length, 1);
  assert.equal(boot.update.overview.data?.current?.version, "0.3.0");
  assert.equal(boot.update.versions.data?.versions.length, 2);
  // 未登录不给
  assert.equal((await fetch(`${base}/admin/api/bootstrap`)).status, 401);
});

test("管理台页面：内嵌脚本必须是合法 JavaScript（防编辑事故回归）", async (t) => {
  const backendPort = await startBackend(t);
  const { base } = await startGateway(t, { backendPort, adminPassword: "admin-master-pw" });
  const cookie = (await adminLogin(base, "admin-master-pw")).cookie;
  const html = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  const match = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(match, "仪表盘应包含内嵌脚本");
  // 只编译不执行：语法错误（如括号不闭合）在这里抛出
  new vm.Script(match[1]);
});

test("按人限额与站点 Key 管理", async (t) => {
  const backendPort = await startBackend(t);
  const { base, registry } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
  });
  const cookie = (await adminLogin(base, "admin-master-pw")).cookie;
  const [invite] = await registry.createInvites({ count: 1 });
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite: invite.code,
      username: "quotauser",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  const userCookie = reg.headers.get("set-cookie") ?? "";

  // 站点默认 dailyTurns=100：第 101 轮被拒（先手动把今日计数灌到 100）
  const user = await registry.findUserByName("quotauser");
  await registry.addTurns(user!.id, 100);
  const blocked = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie: userCookie },
    body: "{}",
  });
  assert.equal(blocked.status, 429);

  // 给这位同学单独放开到 150：第 101 轮放行
  const quota = await fetch(`${base}/admin/api/user/quota`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ user: "quotauser", turns: 150 }),
  });
  assert.equal(quota.status, 200);
  const pass = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie: userCookie },
    body: "{}",
  });
  assert.equal(pass.status, 200);

  // 再收紧到 100：立刻又被拒（今日已 101）
  await fetch(`${base}/admin/api/user/quota`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ user: "quotauser", turns: 100 }),
  });
  const blocked2 = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie: userCookie },
    body: "{}",
  });
  assert.equal(blocked2.status, 429);

  // 非法限额值被拒
  const bad = await fetch(`${base}/admin/api/user/quota`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ user: "quotauser", turns: -5 }),
  });
  assert.equal(bad.status, 400);

  // 站点 Key：非法格式被拒；合法格式保存后 GET 只回打码
  const badKey = await fetch(`${base}/admin/api/site`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ deepseekKey: "not-a-key" }),
  });
  assert.equal(badKey.status, 400);
  const saved = await fetch(`${base}/admin/api/site`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ deepseekKey: "sk-test-1234567890abcdef" }),
  });
  assert.equal(saved.status, 200);
  const site = (await (await fetch(`${base}/admin/api/site`, { headers: { cookie } })).json()) as {
    deepseekKeySet: boolean;
    deepseekKeyMasked: string;
    defaultDailyTurns: number;
  };
  assert.equal(site.deepseekKeySet, true);
  assert.equal(site.deepseekKeyMasked, "sk-••••••••cdef");
  assert.ok(
    !JSON.stringify(site).includes("sk-test-1234567890abcdef"),
    "完整 Key 不得出现在响应里",
  );
  assert.equal(site.defaultDailyTurns, 100);
});

/** 用与 src/core/credentials.ts 相同的派生方式造一个加密凭证文件 */
async function craftCredentials(usersDir: string, userId: string, override: boolean) {
  const { scryptSync, createCipheriv, randomBytes } = await import("node:crypto");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const fsMod = await import("node:fs");
  const salt = randomBytes(16);
  const key = scryptSync(`${os.hostname()}|${os.userInfo().username}|courseraptor-v1`, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([
    cipher.update(
      JSON.stringify({
        deepseekApiKey: override ? "sk-own-key-1234567890" : "",
        deepseekApiKeyOverride: override,
      }),
    ),
    cipher.final(),
  ]);
  const dir = pathMod.join(usersDir, userId);
  fsMod.mkdirSync(dir, { recursive: true });
  fsMod.writeFileSync(
    pathMod.join(dir, "credentials.enc"),
    JSON.stringify({
      v: 1,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: payload.toString("base64"),
    }),
  );
}

test("学生端额度接口与自带 Key 豁免", async (t) => {
  const backendPort = await startBackend(t);
  const usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-quota-"));
  t.after(() => fs.rmSync(usersDir, { recursive: true, force: true }));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-quota-st-"));
  const registry = createRegistry({ stateDir });
  const server = createGatewayServer({
    registry,
    spawner: fakeSpawner(backendPort),
    secret: "unit-test-secret-0123456789",
    dailyTurns: 3,
    usersDir,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const [invite] = await registry.createInvites({ count: 1 });
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite: invite.code,
      username: "quotauser2",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  const cookie = reg.headers.get("set-cookie") ?? "";
  const user = await registry.findUserByName("quotauser2");
  await registry.addTurns(user!.id, 3);

  // 未自带 Key：额度 0 剩余、对话被拒
  const q1 = (await (await fetch(`${base}/api/quota`, { headers: { cookie } })).json()) as {
    used: number;
    limit: number;
    remaining: number;
    ownKeyActive: boolean;
  };
  assert.deepEqual(q1, { used: 3, limit: 3, remaining: 0, ownKeyActive: false, source: "site" });
  const blocked = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  assert.equal(blocked.status, 429);

  // 造一个自带 Key 的凭证文件：额度接口翻转为不占额度，对话放行
  await craftCredentials(usersDir, user!.id, true);
  const q2 = (await (await fetch(`${base}/api/quota`, { headers: { cookie } })).json()) as {
    ownKeyActive: boolean;
  };
  assert.equal(q2.ownKeyActive, true);
  const pass = await fetch(`${base}/api/chat`, { method: "POST", headers: { cookie }, body: "{}" });
  assert.equal(pass.status, 200);

  // override=false 的文件（只存了别的字段）：不豁免
  await craftCredentials(usersDir, user!.id, false);
  const q3 = (await (await fetch(`${base}/api/quota`, { headers: { cookie } })).json()) as {
    ownKeyActive: boolean;
  };
  assert.equal(q3.ownKeyActive, false);
});

test("同学自助修改登录密码", async (t) => {
  const backendPort = await startBackend(t);
  const { base, registry } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
  });
  const [invite] = await registry.createInvites({ count: 1 });
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite: invite.code,
      username: "passuser",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  const cookie = reg.headers.get("set-cookie") ?? "";

  // 当前密码错 → 401；新密码太短 → 400
  const wrong = await fetch(`${base}/api/password`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ current: "nope-nope", next: "newpassword99" }),
  });
  assert.equal(wrong.status, 401);
  const short = await fetch(`${base}/api/password`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ current: "password123", next: "short" }),
  });
  assert.equal(short.status, 400);

  // 正确流程：改完后旧密码登不上、新密码能登，且当前会话仍有效
  const ok = await fetch(`${base}/api/password`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ current: "password123", next: "newpassword99" }),
  });
  assert.equal(ok.status, 200);
  const stillValid = await fetch(`${base}/api/quota`, { headers: { cookie } });
  assert.equal(stillValid.status, 200, "改密码后当前会话不应失效");
  const oldLogin = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "passuser", password: "password123" }),
    redirect: "manual",
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "passuser", password: "newpassword99" }),
    redirect: "manual",
  });
  assert.equal(newLogin.status, 303);

  // 未登录调用 → 401
  const anon = await fetch(`${base}/api/password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ current: "a", next: "b" }),
  });
  assert.equal(anon.status, 401);
});
