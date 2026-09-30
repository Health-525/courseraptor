/**
 * 管理台 v3 新增能力测试：新增用户 / 删除用户（含数据目录回收）/
 * 删除邀请码 / 操作审计日志 / 构建产物静态下发。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  options: { backendPort: number; usersDir: string },
) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-crud-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const registry = createRegistry({ stateDir });
  const spawner = fakeSpawner(options.backendPort);
  const server = createGatewayServer({
    registry,
    spawner,
    secret: "unit-test-secret-0123456789",
    adminPassword: "admin-master-pw",
    maxConcurrent: 4,
    usersDir: options.usersDir,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, registry, spawner };
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

test("管理台 CRUD：新增用户 → 登录可用 → 删除后除名并清数据目录", async (t) => {
  const backendPort = await startBackend(t);
  const usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-crud-u-"));
  t.after(() => fs.rmSync(usersDir, { recursive: true, force: true }));
  const { base } = await startGateway(t, { backendPort, usersDir });
  const cookie = await adminLogin(base);

  // 新增用户：非法输入被拒；合法输入建号成功
  const bad = await fetch(`${base}/admin/api/user/create`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ username: "x", password: "short" }),
  });
  assert.equal(bad.status, 400);
  const created = (await (
    await fetch(`${base}/admin/api/user/create`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "madebyadmin", password: "password123" }),
    })
  ).json()) as { ok: boolean; user: { id: string; username: string } };
  assert.ok(created.ok);
  assert.equal(created.user.username, "madebyadmin");

  // 建好的号能登录
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "madebyadmin", password: "password123" }),
    redirect: "manual",
  });
  assert.equal(login.status, 303);

  // 造一个数据目录 + 一条待审重置申请：删除时应一并清理
  fs.mkdirSync(path.join(usersDir, created.user.id, "data"), { recursive: true });
  fs.writeFileSync(path.join(usersDir, created.user.id, "data", "keep.txt"), "x");
  await fetch(`${base}/forgot`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "madebyadmin" }),
  });

  const del = await fetch(`${base}/admin/api/user/delete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ user: "madebyadmin" }),
  });
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(path.join(usersDir, created.user.id)), false, "数据目录应一并删除");

  // 除名后：登录被拒、列表无此人、其重置申请消失
  const login2 = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "madebyadmin", password: "password123" }),
    redirect: "manual",
  });
  assert.equal(login2.status, 401);
  const users = (await (
    await fetch(`${base}/admin/api/users`, { headers: { cookie } })
  ).json()) as Array<{ username: string }>;
  assert.equal(users.filter((u) => u.username === "madebyadmin").length, 0);
  const boot = (await (
    await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie } })
  ).json()) as { resets: { pending: unknown[] } };
  assert.equal(boot.resets.pending.length, 0);

  // 删除不存在的人 → 404
  const ghost = await fetch(`${base}/admin/api/user/delete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ user: "nobody-here" }),
  });
  assert.equal(ghost.status, 404);
});

test("管理台：邀请码删除——未使用可删，已使用被拒", async (t) => {
  const backendPort = await startBackend(t);
  const usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-inv-"));
  t.after(() => fs.rmSync(usersDir, { recursive: true, force: true }));
  const { base, registry } = await startGateway(t, { backendPort, usersDir });
  const cookie = await adminLogin(base);

  const [unused, used] = await registry.createInvites({ count: 2, note: "测试" });
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      invite: used.code,
      username: "inviteuser",
      password: "password123",
      password2: "password123",
    }),
    redirect: "manual",
  });
  assert.equal(reg.status, 303);

  // 已使用的码删除被拒；未使用的可删
  const delUsed = await fetch(`${base}/admin/api/invite/delete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: used.code }),
  });
  assert.equal(delUsed.status, 400);
  const delUnused = await fetch(`${base}/admin/api/invite/delete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: unused.code }),
  });
  assert.equal(delUnused.status, 200);

  const invites = (await (
    await fetch(`${base}/admin/api/invites`, { headers: { cookie } })
  ).json()) as Array<{ code: string }>;
  assert.equal(invites.filter((i) => i.code === unused.code).length, 0);
  assert.equal(invites.filter((i) => i.code === used.code).length, 1);
});

test("管理台：操作写审计日志，bootstrap 带出", async (t) => {
  const backendPort = await startBackend(t);
  const usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-log-"));
  t.after(() => fs.rmSync(usersDir, { recursive: true, force: true }));
  const { base } = await startGateway(t, { backendPort, usersDir });
  const cookie = await adminLogin(base);

  await fetch(`${base}/admin/api/invite`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ count: 1, note: "日志测试" }),
  });
  const boot = (await (
    await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie } })
  ).json()) as { log: Array<{ text: string }> };
  assert.ok(
    boot.log.some(
      (entry) => entry.text.includes("生成 1 个邀请码") && entry.text.includes("日志测试"),
    ),
    "审计日志应记录邀请码生成",
  );
  // 独立日志端点与 bootstrap 一致
  const log = (await (
    await fetch(`${base}/admin/api/log`, { headers: { cookie } })
  ).json()) as Array<{
    text: string;
  }>;
  assert.ok(log.length > 0);
  assert.equal(log.length, boot.log.length);
});

test("管理台：构建产物按内容类型下发、白名单外路径 404", async (t) => {
  const backendPort = await startBackend(t);
  const usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-ast-"));
  t.after(() => fs.rmSync(usersDir, { recursive: true, force: true }));
  const { base } = await startGateway(t, { backendPort, usersDir });

  // 从提交的 dist/index.html 里取一个真实资产引用（顺带保证 dist 已提交）
  const distRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "admin",
    "dist",
  );
  const indexHtml = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
  const ref = /(?:src|href)="(\/admin\/assets\/[^"]+)"/.exec(indexHtml);
  assert.ok(ref, "admin/dist/index.html 应引用构建产物");
  const rel = ref[1].replace("/admin/", "");
  assert.ok(fs.existsSync(path.join(distRoot, rel)), "index.html 引用的资产应存在于 admin/dist");

  // js 与 css 都能下发且内容类型正确
  for (const ext of ["js", "css"]) {
    const file = fs
      .readdirSync(path.join(distRoot, "assets"))
      .find((name) => name.endsWith(`.${ext}`));
    assert.ok(file, `assets 里应有 .${ext} 产物`);
    const res = await fetch(`${base}/admin/assets/${file}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", ext === "js" ? /javascript/ : /text\/css/);
  }

  const traversal = await fetch(`${base}/admin/assets/..%2f..%2f..%2fetc%2fpasswd`);
  assert.ok(traversal.status === 404 || traversal.status === 400, "dist 外的路径不得读文件");

  const unknown = await fetch(`${base}/admin/assets/nope.js`);
  assert.equal(unknown.status, 404);
});

test("管理台页面：SPA 入口可服务（登录与否一致）", async (t) => {
  const backendPort = await startBackend(t);
  const usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-page-"));
  t.after(() => fs.rmSync(usersDir, { recursive: true, force: true }));
  const { base } = await startGateway(t, { backendPort, usersDir });
  const cookie = await adminLogin(base);
  const html = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  assert.match(html, /<div id="root">/);
  assert.match(html, /\/admin\/assets\//);
});
