import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createUpdateServer } = await import("../update/app.mjs");

const TOKEN = "test-admin-token";

type TestContext = { after: (fn: () => void) => void };

async function startServer(t: TestContext) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-admin-keys-"));
  const server = createUpdateServer({ dataDir, adminToken: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, dataDir };
}

async function createKey(baseUrl: string, name?: string) {
  const res = await fetch(`${baseUrl}/admin/api/keys`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify(name === undefined ? {} : { name }),
  });
  return { status: res.status, body: await res.json() };
}

function getKeys(baseUrl: string, token = TOKEN) {
  return fetch(`${baseUrl}/admin/api/keys`, { headers: { "x-admin-token": token } });
}

test("创建密钥返回一次性明文，该密钥可调用全部管理接口", async (t) => {
  const { baseUrl } = await startServer(t);
  const created = await createKey(baseUrl, "发布机");
  assert.equal(created.status, 200);
  assert.match(created.body.token, /^crak_[A-Za-z0-9_-]{32}$/);
  assert.equal(created.body.key.name, "发布机");
  assert.equal(created.body.key.isEnv, false);

  const headers = { "x-admin-token": created.body.token };
  const overview = await fetch(`${baseUrl}/admin/api/overview`, { headers });
  assert.equal(overview.status, 200);
  const versions = await fetch(`${baseUrl}/admin/api/versions`, { headers });
  assert.equal(versions.status, 200);
  const publish = await fetch(`${baseUrl}/publish`, {
    method: "POST",
    headers: { ...headers, "x-version": "1.2.3", "x-notes": "" },
    body: Buffer.from("zip"),
  });
  assert.equal(publish.status, 200);
});

test("密钥列表包含主密钥与面板密钥，不泄露明文与哈希", async (t) => {
  const { baseUrl } = await startServer(t);
  const created = await createKey(baseUrl, "值班同学");
  const res = await getKeys(baseUrl);
  assert.equal(res.status, 200);
  const { keys } = await res.json();

  assert.equal(keys.length, 2);
  assert.deepEqual(
    keys.map((k: { id: string }) => k.id === "__env__"),
    [true, false],
  );
  const envKey = keys.find((k: { isEnv: boolean }) => k.isEnv);
  assert.equal(envKey.name, "主密钥（环境变量）");
  const panelKey = keys.find((k: { isEnv: boolean }) => !k.isEnv);
  assert.equal(panelKey.name, "值班同学");
  assert.ok(panelKey.createdAt);

  // 响应里绝不能出现密钥明文或哈希
  const raw = JSON.stringify(keys);
  assert.ok(!raw.includes(created.body.token));
  assert.ok(!/[0-9a-f]{64}/.test(raw));
});

test("使用密钥后 lastUsedAt 更新", async (t) => {
  const { baseUrl } = await startServer(t);
  const { body } = await createKey(baseUrl);
  assert.equal(body.key.lastUsedAt, null);

  await getKeys(baseUrl, body.token);
  const { keys } = await (await getKeys(baseUrl)).json();
  const used = keys.find((k: { id: string }) => k.id === body.key.id);
  assert.ok(used.lastUsedAt);
});

test("删除密钥后立即失效，主密钥不受影响", async (t) => {
  const { baseUrl } = await startServer(t);
  const { body } = await createKey(baseUrl, "临时密钥");

  const removed = await fetch(`${baseUrl}/admin/api/keys/delete`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ id: body.key.id }),
  });
  assert.equal(removed.status, 200);

  const denied = await getKeys(baseUrl, body.token);
  assert.equal(denied.status, 401);

  const stillOk = await getKeys(baseUrl, TOKEN);
  assert.equal(stillOk.status, 200);
  const { keys } = await stillOk.json();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].isEnv, true);
});

test("主密钥不能在面板删除；未知 id 返回 404", async (t) => {
  const { baseUrl } = await startServer(t);

  const envDelete = await fetch(`${baseUrl}/admin/api/keys/delete`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ id: "__env__" }),
  });
  assert.equal(envDelete.status, 400);

  const missing = await fetch(`${baseUrl}/admin/api/keys/delete`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000000" }),
  });
  assert.equal(missing.status, 404);
});

test("名称缺省用默认值，空白与超长名称会被规整", async (t) => {
  const { baseUrl } = await startServer(t);

  const unnamed = await createKey(baseUrl);
  assert.equal(unnamed.body.key.name, "未命名密钥");

  const blank = await createKey(baseUrl, "   ");
  assert.equal(blank.body.key.name, "未命名密钥");

  const long = await createKey(baseUrl, "很".repeat(100));
  assert.equal(long.body.key.name.length, 64);
});

test("密钥与使用记录跨服务重启持久化", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-admin-keys-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const first = createUpdateServer({ dataDir, adminToken: TOKEN });
  await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
  const firstAddress = first.address();
  assert.ok(firstAddress && typeof firstAddress !== "string");
  const baseUrl = `http://127.0.0.1:${firstAddress.port}`;
  const { body } = await createKey(baseUrl, "重启后还在");
  await getKeys(baseUrl, body.token); // 触发 lastUsedAt
  await new Promise<void>((resolve) => first.close(() => resolve()));

  // 模拟进程重启：同一数据目录新建服务，密钥仍然有效
  const second = createUpdateServer({ dataDir, adminToken: TOKEN });
  await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve));
  t.after(() => second.close());
  const secondAddress = second.address();
  assert.ok(secondAddress && typeof secondAddress !== "string");
  const secondUrl = `http://127.0.0.1:${secondAddress.port}`;

  const stillValid = await getKeys(secondUrl, body.token);
  assert.equal(stillValid.status, 200);
  const { keys } = await (await getKeys(secondUrl)).json();
  const persisted = keys.find((k: { id: string }) => k.id === body.key.id);
  assert.equal(persisted.name, "重启后还在");
  assert.ok(persisted.lastUsedAt);

  // 落盘文件本身也只有哈希，没有明文
  const stored = fs.readFileSync(path.join(dataDir, "admin-keys.json"), "utf8");
  assert.ok(stored.includes("tokenHash"));
  assert.ok(!stored.includes(body.token));
});

test("密钥接口同样受防爆破锁定保护", async (t) => {
  const { baseUrl } = await startServer(t);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await getKeys(baseUrl, "wrong-token");
    assert.equal(res.status, attempt === 4 ? 429 : 401);
  }
});
