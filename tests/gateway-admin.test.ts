import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createGatewayServer } = await import("../gateway/app.mjs");
const { createRegistry } = await import("../gateway/registry.mjs");

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

async function startGateway(
  t: { after: (fn: () => void) => void },
  options: {
    backendPort: number;
    adminPassword?: string;
    updateServerUrl?: string;
    updateAdminToken?: string;
    appVersion?: string;
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
    appVersion: options.appVersion,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, registry, spawner };
}

async function adminLogin(base: string, password: string) {
  const res = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
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

  // 未登录：页面是 React SPA 的 index.html（登录态由前端经 /admin/api/session 探测），API 401
  const anonPage = await fetch(`${base}/admin`);
  assert.equal(anonPage.status, 200);
  assert.match(await anonPage.text(), /<div id="root">/);
  const anonSession = (await (await fetch(`${base}/admin/api/session`)).json()) as {
    authed: boolean;
  };
  assert.equal(anonSession.authed, false);
  assert.equal((await fetch(`${base}/admin/api/overview`)).status, 401);

  // 错误密码 401，正确密码 200 + 管理会话 Cookie（JSON 登录）
  assert.equal((await adminLogin(base, "wrong-password")).status, 401);
  const login = await adminLogin(base, "admin-master-pw");
  assert.equal(login.status, 200);
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

/** 假更新后台：校验 x-admin-token，提供 overview/versions/rollback/delete/publish/keys */
async function startFakeUpdateServer(t: { after: (fn: () => void) => void }, token: string) {
  const seen: string[] = [];
  const rolledBack: string[] = [];
  const published: Array<{ version: string; notes: string; bytes: number; body: string }> = [];
  const panelKeys: Array<{ id: string; name: string; isEnv: boolean; createdAt: string | null }> = [
    { id: "__env__", name: "主密钥（环境变量）", isEnv: true, createdAt: null },
  ];
  let keySeq = 0;
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} token=${req.headers["x-admin-token"]}`);
    if (req.headers["x-admin-token"] !== token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "管理员密钥无效" }));
      return;
    }
    if (req.method === "GET" && req.url === "/admin/api/keys") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: panelKeys.map((k) => ({ ...k, lastUsedAt: null })) }));
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/keys") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const trimmed = String(body.name ?? "").trim();
        const key = {
          id: `key-${++keySeq}`,
          name: trimmed ? trimmed.slice(0, 64) : "未命名密钥",
          isEnv: false,
          createdAt: "2026-09-29T00:00:00Z",
        };
        panelKeys.push(key);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ token: `crak_fake_${key.id}`, key: { ...key, lastUsedAt: null } }),
        );
      });
      return;
    }
    if (req.method === "POST" && req.url === "/admin/api/keys/delete") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const id = String(body.id ?? "");
        const index = panelKeys.findIndex((k) => k.id === id);
        if (id === "__env__") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "主密钥不能删除" }));
          return;
        }
        if (index < 0) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "密钥不存在" }));
          return;
        }
        panelKeys.splice(index, 1);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/publish") {
      const version = String(req.headers["x-version"] ?? "");
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "x-version 必须是 x.y.z" }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        published.push({
          version,
          notes: decodeURIComponent(String(req.headers["x-notes"] ?? "")),
          bytes: body.length,
          body,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, version, publishedAt: "2026-09-29T00:00:00Z" }));
      });
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
  return { url: `http://127.0.0.1:${address.port}`, seen, rolledBack, published, panelKeys };
}

test("管理台·发版：上传 zip 流式转发到更新后台，版本/说明原样透传", async (t) => {
  const backendPort = await startBackend(t);
  const update = await startFakeUpdateServer(t, "update-token-123");
  const { base } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
    updateServerUrl: update.url,
    updateAdminToken: "update-token-123",
  });
  const cookie = (await adminLogin(base, "admin-master-pw")).cookie;

  const zip = Buffer.from("PK-fake-zip-content-发布用");
  const res = await fetch(`${base}/admin/api/update/publish`, {
    method: "POST",
    headers: {
      cookie,
      "x-version": "0.4.0",
      "x-notes": encodeURIComponent("修复课表周次；新增深色模式"),
      "content-type": "application/zip",
      "content-length": String(zip.length),
    },
    body: zip,
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { version?: string }).version, "0.4.0");
  assert.equal(update.published.length, 1);
  assert.equal(update.published[0].version, "0.4.0");
  assert.equal(update.published[0].notes, "修复课表周次；新增深色模式");
  assert.equal(update.published[0].body, zip.toString("utf8"), "包体应原样流式转发");
});

test("管理台·发版：版本号不合法 / 超限 / 未接入 / 未登录", async (t) => {
  const backendPort = await startBackend(t);
  const update = await startFakeUpdateServer(t, "update-token-123");
  const { base } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
    updateServerUrl: update.url,
    updateAdminToken: "update-token-123",
  });
  const cookie = (await adminLogin(base, "admin-master-pw")).cookie;

  // 版本号不合法：网关直接拒绝，不打到更新后台
  const bad = await fetch(`${base}/admin/api/update/publish`, {
    method: "POST",
    headers: { cookie, "x-version": "1.2", "content-type": "application/zip" },
    body: "zip",
  });
  assert.equal(bad.status, 400);
  assert.equal(update.published.length, 0);

  // 声明的包体超过 200 MB：413，不读 body（fetch 会校验 content-length 与 body 一致，故用原生 http）
  const hugeStatus = await new Promise<number>((resolve) => {
    const req = http.request(
      new URL(`${base}/admin/api/update/publish`),
      {
        method: "POST",
        headers: {
          cookie,
          "x-version": "1.2.3",
          "content-type": "application/zip",
          "content-length": String(201 * 1024 * 1024),
        },
      },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.destroy();
      },
    );
    req.on("error", () => resolve(0));
    req.end();
  });
  assert.equal(hugeStatus, 413);

  // 未配置更新后台：返回未接入
  const off = await startGateway(t, { backendPort, adminPassword: "admin-master-pw" });
  const offCookie = (await adminLogin(off.base, "admin-master-pw")).cookie;
  const offRes = (await (
    await fetch(`${off.base}/admin/api/update/publish`, {
      method: "POST",
      headers: { cookie: offCookie, "x-version": "1.2.3", "content-type": "application/zip" },
      body: "zip",
    })
  ).json()) as { error?: string };
  assert.match(offRes.error ?? "", /未接入/);

  // 未登录：401
  const anon = await fetch(`${base}/admin/api/update/publish`, {
    method: "POST",
    headers: { "x-version": "1.2.3", "content-type": "application/zip" },
    body: "zip",
  });
  assert.equal(anon.status, 401);
});

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

test("管理台·密钥管理：代理到更新后台，创建/删除/主密钥保护全链路", async (t) => {
  const backendPort = await startBackend(t);
  const update = await startFakeUpdateServer(t, "update-token-123");
  const { base } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
    updateServerUrl: update.url,
    updateAdminToken: "update-token-123",
  });
  const cookie = (await adminLogin(base, "admin-master-pw")).cookie;

  // 列表：一开始只有主密钥
  const list1 = (await (
    await fetch(`${base}/admin/api/update/keys`, { headers: { cookie } })
  ).json()) as { data?: { keys: Array<{ id: string; name: string; isEnv: boolean }> } };
  assert.equal(list1.data?.keys.length, 1);
  assert.equal(list1.data?.keys[0].isEnv, true);

  // 创建：网关代理转发名称，响应带一次性明文令牌
  const created = (await (
    await fetch(`${base}/admin/api/update/keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "  发布机  " }),
    })
  ).json()) as { data?: { token: string; key: { id: string; name: string } } };
  assert.equal(created.data?.key.name, "发布机", "名称由更新后台规整");
  assert.match(created.data?.token ?? "", /^crak_/);
  const keyId = created.data?.key.id ?? "";
  assert.ok(
    update.seen.some((s) => s.includes("POST /admin/api/keys token=update-token-123")),
    "令牌应原样转发",
  );

  // 删除主密钥：更新后台 400 → 网关透传 400
  const envDelete = await fetch(`${base}/admin/api/update/keys/delete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id: "__env__" }),
  });
  assert.equal(envDelete.status, 400);

  // 删除面板密钥：成功后列表只剩主密钥
  const del = await fetch(`${base}/admin/api/update/keys/delete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id: keyId }),
  });
  assert.equal(del.status, 200);
  assert.equal(update.panelKeys.length, 1);
  assert.equal(update.panelKeys[0].isEnv, true);

  // bootstrap 也带回密钥列表
  const boot = (await (
    await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie } })
  ).json()) as { update: { keys: { data?: { keys: unknown[] } } } };
  assert.equal(boot.update.keys.data?.keys.length, 1);

  // 未登录不给
  assert.equal((await fetch(`${base}/admin/api/update/keys`)).status, 401);
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
    appVersion: "9.9.9-test",
  });
  const [invite] = await registry.createInvites({ count: 1 });
  // 已过期的邀请码不应计入「可用邀请码」
  await registry.createInvites({ count: 1, expiresDays: -1 });
  const user = await registry.createUser({ username: "bootuser", password: "password123" });
  await registry.addTurns(user.id, 4);
  await registry.addTurns(user.id, 2, "own");

  const cookie = (await adminLogin(base, "admin-master-pw")).cookie;
  const boot = (await (
    await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie } })
  ).json()) as {
    overview: {
      users: number;
      turnsToday: number;
      ownTurnsToday: number;
      invitesLeft: number;
      pendingResets: number;
      version: string;
    };
    users: Array<{ username: string; online: boolean; dsMode: string }>;
    invites: unknown[];
    site: { envDeepseekKeySet: boolean; defaultDailyTurns: number };
    update: {
      overview: { data?: { current?: { version: string } } };
      versions: { data?: { versions: unknown[] } };
    };
  };
  assert.equal(boot.overview.users, 1);
  assert.equal(boot.overview.turnsToday, 4);
  assert.equal(boot.overview.ownTurnsToday, 2);
  assert.equal(boot.overview.invitesLeft, 1);
  assert.equal(boot.overview.pendingResets, 0);
  assert.equal(boot.overview.version, "9.9.9-test");
  assert.equal(boot.users[0].username, "bootuser");
  assert.equal(boot.users[0].dsMode, "");
  assert.equal(boot.site.envDeepseekKeySet, false);
  assert.equal(boot.invites.length, 2);
  assert.equal(boot.update.overview.data?.current?.version, "0.3.0");
  assert.equal(boot.update.versions.data?.versions.length, 2);
  // 未登录不给
  assert.equal((await fetch(`${base}/admin/api/bootstrap`)).status, 401);
});

test("注册·邀请码绑定：用户名被占不废码，bootstrap 带出码↔账号绑定关系", async (t) => {
  const backendPort = await startBackend(t);
  const { base, registry } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
  });
  const cookie = (await adminLogin(base, "admin-master-pw")).cookie;

  await registry.createUser({ username: "taken", password: "password123" });
  const [invite] = await registry.createInvites({ count: 1, note: "班级群" });
  const regForm = (username: string) =>
    new URLSearchParams({
      invite: invite.code,
      username,
      password: "password123",
      password2: "password123",
    });

  // 第一次注册撞了已有用户名：失败，但邀请码不应被 pending 占位废掉
  const fail = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: regForm("taken"),
    redirect: "manual",
  });
  assert.equal(fail.status, 400);

  // 同一个码、换个用户名：应能注册成功
  const ok = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: regForm("newmate"),
    redirect: "manual",
  });
  assert.equal(ok.status, 303);

  // bootstrap 下发的邀请码已回填使用者，管理台两边的绑定关系都靠它渲染
  const boot = (await (
    await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie } })
  ).json()) as { invites: Array<{ code: string; note: string; usedBy: string[] }> };
  const used = boot.invites.find((i) => i.code === invite.code);
  assert.ok(used);
  assert.equal(used.note, "班级群");
  assert.deepEqual(used.usedBy, ["newmate"]);
});

test("管理台 SPA：index 下发、前端路由回落、资产防穿越、API 未知 404", async (t) => {
  const backendPort = await startBackend(t);
  const { base } = await startGateway(t, { backendPort, adminPassword: "admin-master-pw" });

  // 入口是 React SPA 的 index.html，引用构建产物资产
  const html = await (await fetch(`${base}/admin`)).text();
  assert.match(html, /<div id="root">/);
  const assetRef = /(?:src|href)="(\/admin\/assets\/[^"]+)"/.exec(html);
  assert.ok(assetRef, "index.html 应引用 /admin/assets/ 构建产物");
  const asset = await fetch(`${base}${assetRef[1]}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/, "带哈希的构建产物应长缓存");

  // 前端路由（如 /admin/users）回落 index.html，不 404
  const spaRoute = await fetch(`${base}/admin/users`);
  assert.equal(spaRoute.status, 200);
  assert.match(await spaRoute.text(), /<div id="root">/);

  // 资产目录不存在的文件 404（不回落 index.html，避免吞掉资源错误）
  assert.equal((await fetch(`${base}/admin/assets/nope.js`)).status, 404);
  const traversal = await fetch(`${base}/admin/assets/..%2f..%2f..%2fetc%2fpasswd`);
  assert.ok(traversal.status === 404 || traversal.status === 400, "不得读 dist 外的文件");

  // API 未知路径仍是 JSON 404（不回落 SPA）
  const unknownApi = await fetch(`${base}/admin/api/nope`, {
    headers: { cookie: (await adminLogin(base, "admin-master-pw")).cookie },
  });
  assert.equal(unknownApi.status, 404);
  assert.match(unknownApi.headers.get("content-type") ?? "", /application\/json/);

  // 会话探测接口：登录后 authed=true
  const session = (await (
    await fetch(`${base}/admin/api/session`, {
      headers: { cookie: (await adminLogin(base, "admin-master-pw")).cookie },
    })
  ).json()) as { authed: boolean; mfaRequired: boolean };
  assert.equal(session.authed, true);
  assert.equal(session.mfaRequired, false);
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
async function craftCredentials(
  usersDir: string,
  userId: string,
  override: boolean,
  providerKeys?: Record<string, string>,
) {
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
        ...(providerKeys ? { providerKeys } : {}),
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
    ownUsed: number;
    hasOwnKey: boolean;
    ownKeyActive: boolean;
  };
  assert.deepEqual(q1, {
    username: "quotauser2",
    used: 3,
    limit: 3,
    remaining: 0,
    ownUsed: 0,
    hasOwnKey: false,
    ownKeyActive: false,
    providerId: "deepseek",
    dsMode: "own",
    source: "site",
  });
  const blocked = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  assert.equal(blocked.status, 429);

  // 造一个自带 Key 的凭证文件：额度接口翻转为不占额度，对话放行且记到自己的账
  await craftCredentials(usersDir, user!.id, true);
  const q2 = (await (await fetch(`${base}/api/quota`, { headers: { cookie } })).json()) as {
    ownKeyActive: boolean;
  };
  assert.equal(q2.ownKeyActive, true);
  const pass = await fetch(`${base}/api/chat`, { method: "POST", headers: { cookie }, body: "{}" });
  assert.equal(pass.status, 200);
  assert.equal(await registry.turnsToday(user!.id), 3, "站点账不新增");
  assert.equal(await registry.ownTurnsToday(user!.id), 1, "自己的 Key 记自己的账");

  // 钉到站点模式（Key 保留不删）：额度恢复拦截，hasOwnKey 仍为真
  const pin = await fetch(`${base}/api/ds-mode`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ mode: "site" }),
  });
  assert.equal(pin.status, 200);
  const q4 = (await (await fetch(`${base}/api/quota`, { headers: { cookie } })).json()) as {
    hasOwnKey: boolean;
    ownKeyActive: boolean;
    dsMode: string;
  };
  assert.equal(q4.hasOwnKey, true, "Key 保留未删");
  assert.equal(q4.ownKeyActive, false, "但不再生效");
  assert.equal(q4.dsMode, "site", "同学的选择如实下发，前端开关据此渲染");
  const blocked2 = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  assert.equal(blocked2.status, 429, "站点额度恢复拦截");
  assert.equal(await registry.turnsToday(user!.id), 3, "被拦截的请求不计数");

  // 切回跟随模式：立刻恢复用自己的 Key
  const back = await fetch(`${base}/api/ds-mode`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ mode: "own" }),
  });
  assert.equal(back.status, 200);
  const pass2 = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  assert.equal(pass2.status, 200);
  assert.equal(await registry.ownTurnsToday(user!.id), 2);

  // override=false 的文件（只存了别的字段）：不豁免
  await craftCredentials(usersDir, user!.id, false);
  const q3 = (await (await fetch(`${base}/api/quota`, { headers: { cookie } })).json()) as {
    ownKeyActive: boolean;
  };
  assert.equal(q3.ownKeyActive, false);
});

test("满载 503 的对话轮不烧额度：记账在拉起实例成功之后", async (t) => {
  const backendPort = await startBackend(t);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-busy-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const registry = createRegistry({ stateDir });
  const busySpawner = {
    ...fakeSpawner(backendPort),
    async acquire() {
      throw Object.assign(new Error("当前在线人数较多，请稍后再试"), { code: "ECONCURRENCY" });
    },
  };
  const server = createGatewayServer({
    registry,
    spawner: busySpawner,
    secret: "unit-test-secret-0123456789",
    dailyTurns: 5,
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
      username: "busyspender",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  const cookie = reg.headers.get("set-cookie") ?? "";
  const user = await registry.findUserByName("busyspender");

  const hit = await fetch(`${base}/api/chat`, { method: "POST", headers: { cookie }, body: "{}" });
  assert.equal(hit.status, 503);
  assert.equal(
    await registry.turnsToday(user!.id),
    0,
    "被满载/拉起失败拒绝的轮次没有真正发给模型，不烧当日额度",
  );
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

test("忘记密码全链路：申请→管理员同意出码→同学自设新密码", async (t) => {
  const backendPort = await startBackend(t);
  const { base, registry } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
  });
  const [invite] = await registry.createInvites({ count: 1 });
  await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite: invite.code,
      username: "forgotuser",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });

  // 1) 登录页有忘记密码入口；申请接口对存在/不存在的用户名回同样的话
  const loginHtml = await (await fetch(`${base}/login`)).text();
  assert.match(loginHtml, /忘记密码/);
  const req1 = await fetch(`${base}/forgot`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "forgotuser" }),
  });
  assert.match(await req1.text(), /申请已提交/);
  const req2 = await fetch(`${base}/forgot`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "who-no-exist" }),
  });
  assert.match(await req2.text(), /申请已提交/, "不存在的用户名也回同一句话");

  // 2) 管理台看到待审申请；同意后拿到一次性码
  const cookie = (await adminLogin(base, "admin-master-pw")).cookie;
  const boot = (await (
    await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie } })
  ).json()) as {
    resets: { pending: Array<{ id: string; username: string }>; codes: unknown[] };
  };
  const pending = boot.resets.pending.find((r) => r.username === "forgotuser");
  assert.ok(pending, "申请应出现在管理台");
  const approve = (await (
    await fetch(`${base}/admin/api/reset/approve`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: pending.id }),
    })
  ).json()) as { ok: boolean; code: string };
  assert.ok(approve.ok && /^[0-9a-f]{12}$/.test(approve.code), "重置码 6 字节（48 位熵）");

  // 3) 错码 401；正确码改密成功并跳登录页；旧密码失效、新密码可登
  const wrong = await fetch(`${base}/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "forgotuser",
      code: "deadbeef",
      next: "new-forgot-1",
      next2: "new-forgot-1",
    }),
    redirect: "manual",
  });
  assert.equal(wrong.status, 401);
  const ok = await fetch(`${base}/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "forgotuser",
      code: approve.code,
      next: "new-forgot-1",
      next2: "new-forgot-1",
    }),
    redirect: "manual",
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/login?reset=1");
  // 码是一次性的：再用应失败
  const replay = await fetch(`${base}/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "forgotuser",
      code: approve.code,
      next: "another-pass-9",
      next2: "another-pass-9",
    }),
    redirect: "manual",
  });
  assert.equal(replay.status, 401, "重置码用后即焚");
  const oldLogin = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "forgotuser", password: "password123" }),
    redirect: "manual",
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "forgotuser", password: "new-forgot-1" }),
    redirect: "manual",
  });
  assert.equal(newLogin.status, 303);
});

test("重置码兑换防爆破：连错五次锁 15 分钟，锁定期间正确码也不可兑换", async (t) => {
  const backendPort = await startBackend(t);
  const { base, registry } = await startGateway(t, {
    backendPort,
    adminPassword: "admin-master-pw",
  });
  const [invite] = await registry.createInvites({ count: 1 });
  await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite: invite.code,
      username: "bruteforcer",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });

  // 出一枚真码（校验锁定期间连真码也进不去，防「先试后抢」）
  await registry.createResetRequest(
    (await registry.findUserByName("bruteforcer"))!.id,
    "bruteforcer",
  );
  const admin = await adminLogin(base, "admin-master-pw");
  const boot = (await (
    await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie: admin.cookie } })
  ).json()) as { resets: { pending: Array<{ id: string; username: string }> } };
  const pending = boot.resets.pending.find((r) => r.username === "bruteforcer");
  const approve = (await (
    await fetch(`${base}/admin/api/reset/approve`, {
      method: "POST",
      headers: { cookie: admin.cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: pending!.id }),
    })
  ).json()) as { code: string };

  const post = (code: string) =>
    fetch(`${base}/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "bruteforcer",
        code,
        next: "newpassword456",
        next2: "newpassword456",
      }),
      redirect: "manual",
    });

  for (let i = 0; i < 5; i++) {
    const res = await post("ffffffffffff");
    assert.equal(res.status, 401, `第 ${i + 1} 次错码应 401`);
  }
  const locked = await post(approve.code);
  assert.equal(locked.status, 429, "连错五次后锁定，正确码也不可兑换");
});

test("模型供应商切换接口：合法 id 落库并踢实例，custom 与脏值被拒", async (t) => {
  const backendPort = await startBackend(t);
  const usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-prov-"));
  t.after(() => fs.rmSync(usersDir, { recursive: true, force: true }));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-prov-st-"));
  const registry = createRegistry({ stateDir });
  const spawner = fakeSpawner(backendPort);
  const server = createGatewayServer({
    registry,
    spawner,
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
      username: "provuser",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  const cookie = reg.headers.get("set-cookie") ?? "";
  const user = await registry.findUserByName("provuser");
  spawner.acquire(user!.id);

  const call = (body: unknown) =>
    fetch(`${base}/api/provider`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // 合法切换：落 users.json、踢实例、quota 下发新值
  const ok = await call({ providerId: "glm" });
  assert.equal(ok.status, 200);
  assert.equal((await registry.findUserByName("provuser"))?.providerId, "glm");
  assert.equal(spawner.isRunning(user!.id), false, "切换后实例被踢，下次请求以新供应商拉起");
  const q = (await (await fetch(`${base}/api/quota`, { headers: { cookie } })).json()) as {
    providerId: string;
  };
  assert.equal(q.providerId, "glm");

  // custom 是 SSRF 口子，脏值同拒
  assert.equal((await call({ providerId: "custom" })).status, 400);
  assert.equal((await call({ providerId: "../etc/passwd" })).status, 400);
  assert.equal((await call({})).status, 200, "空值回落 deepseek（归一化）");
  assert.equal((await registry.findUserByName("provuser"))?.providerId, "deepseek");
});

test("多厂商自带 Key 分账：hasOwnKey 按当前供应商判定", async (t) => {
  const backendPort = await startBackend(t);
  const usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-prov2-"));
  t.after(() => fs.rmSync(usersDir, { recursive: true, force: true }));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-prov2-st-"));
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
      username: "provuser2",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  const cookie = reg.headers.get("set-cookie") ?? "";
  const user = await registry.findUserByName("provuser2");
  await registry.addTurns(user!.id, 3);

  // 只有旧格式 deepseek Key，但同学已切到智谱：智谱没有自有 Key，不豁免
  await craftCredentials(usersDir, user!.id, true);
  await registry.setProviderId(user!.id, "glm");
  const q1 = (await (await fetch(`${base}/api/quota`, { headers: { cookie } })).json()) as {
    providerId: string;
    hasOwnKey: boolean;
  };
  assert.equal(q1.providerId, "glm");
  assert.equal(q1.hasOwnKey, false, "deepseek 的 Key 不该给智谱会话豁免");
  const blocked = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  assert.equal(blocked.status, 429, "站点额度照常拦截");

  // 补上智谱的 Key（providerKeys 多厂商格式）：豁免成立、记自有账
  await craftCredentials(usersDir, user!.id, true, { glm: "opaque-glm-key-0123456789" });
  const q2 = (await (await fetch(`${base}/api/quota`, { headers: { cookie } })).json()) as {
    hasOwnKey: boolean;
    ownKeyActive: boolean;
  };
  assert.equal(q2.hasOwnKey, true);
  assert.equal(q2.ownKeyActive, true);
  const pass = await fetch(`${base}/api/chat`, { method: "POST", headers: { cookie }, body: "{}" });
  assert.equal(pass.status, 200);
  assert.equal(await registry.ownTurnsToday(user!.id), 1, "智谱自有 Key 记自己的账");
});
