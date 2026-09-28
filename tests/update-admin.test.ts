import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createUpdateServer } = await import("../server/app.mjs");

const TOKEN = "test-admin-token";

type TestContext = { after: (fn: () => void) => void };

async function startServer(t: TestContext, adminDistDir?: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-update-admin-"));
  const server = createUpdateServer({
    dataDir,
    adminToken: TOKEN,
    ...(adminDistDir ? { adminDistDir } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, dataDir };
}

function publish(baseUrl: string, version: string, notes: string, content = `zip-${version}`) {
  return fetch(`${baseUrl}/publish`, {
    method: "POST",
    headers: {
      "x-admin-token": TOKEN,
      "x-version": version,
      "x-notes": encodeURIComponent(notes),
    },
    body: Buffer.from(content),
  });
}

test("发布后记录版本历史，重复发布同版本只更新不重复", async (t) => {
  const { baseUrl, dataDir } = await startServer(t);

  const first = await publish(baseUrl, "1.2.3", "开放下载");
  assert.equal(first.status, 200);
  const second = await publish(baseUrl, "1.2.3", "修复更新说明");
  assert.equal(second.status, 200);

  const versions = await (
    await fetch(`${baseUrl}/admin/api/versions`, {
      headers: { "x-admin-token": TOKEN },
    })
  ).json();
  assert.equal(versions.versions.length, 1);
  assert.equal(versions.versions[0].version, "1.2.3");
  assert.equal(versions.versions[0].notes, "修复更新说明");
  assert.equal(versions.versions[0].isCurrent, true);
  assert.ok(versions.versions[0].sizeBytes > 0);

  const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, "versions.json"), "utf8"));
  assert.equal(parsed.versions.length, 1);
});

test("手动放进数据目录的 zip 也会出现在历史列表里", async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  await publish(baseUrl, "1.2.3", "正式版");
  fs.writeFileSync(path.join(dataDir, "courseraptor-v0.9.0.zip"), Buffer.from("old-zip"));

  const { versions } = await (
    await fetch(`${baseUrl}/admin/api/versions`, {
      headers: { "x-admin-token": TOKEN },
    })
  ).json();
  assert.deepEqual(
    versions.map((v: { version: string }) => v.version),
    ["1.2.3", "0.9.0"],
  );
  const old = versions.find((v: { version: string }) => v.version === "0.9.0");
  assert.equal(old.isCurrent, false);
  assert.equal(old.notes, "");
  assert.equal(old.sizeBytes, 7);
});

test("overview 返回当前版本与服务器概况", async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  await publish(baseUrl, "1.2.3", "开放下载");

  const res = await fetch(`${baseUrl}/admin/api/overview`, {
    headers: { "x-admin-token": TOKEN },
  });
  assert.equal(res.status, 200);
  const overview = await res.json();
  assert.equal(overview.current.version, "1.2.3");
  assert.equal(overview.current.notes, "开放下载");
  assert.ok(overview.stats.versionCount >= 1);
  assert.ok(overview.stats.diskBytes > 0);
  assert.equal(overview.stats.nodeVersion, process.version);
  assert.equal(overview.stats.dataDir, dataDir);
});

test("回滚把 /latest 与 /download 指回旧版本", async (t) => {
  const { baseUrl } = await startServer(t);
  await publish(baseUrl, "1.2.3", "开放下载");
  await publish(baseUrl, "1.2.4", "有问题的版本");

  const rolled = await fetch(`${baseUrl}/admin/api/rollback`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ version: "1.2.3" }),
  });
  assert.equal(rolled.status, 200);

  const latest = await (await fetch(`${baseUrl}/latest`)).json();
  assert.equal(latest.version, "1.2.3");
  assert.equal(latest.notes, "开放下载");
  assert.equal(latest.download, "/download");
  const download = await fetch(`${baseUrl}/download`);
  assert.equal(await download.text(), "zip-1.2.3");

  const missing = await fetch(`${baseUrl}/admin/api/rollback`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ version: "9.9.9" }),
  });
  assert.equal(missing.status, 404);
});

test("回滚可以附带新的更新说明", async (t) => {
  const { baseUrl } = await startServer(t);
  await publish(baseUrl, "1.2.3", "开放下载");
  await publish(baseUrl, "1.2.4", "有问题的版本");

  await fetch(`${baseUrl}/admin/api/rollback`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ version: "1.2.3", notes: "回滚修复线上问题" }),
  });
  const latest = await (await fetch(`${baseUrl}/latest`)).json();
  assert.equal(latest.notes, "回滚修复线上问题");
});

test("删除：当前版本禁止，旧版本连同 zip 与索引一起移除", async (t) => {
  const { baseUrl, dataDir } = await startServer(t);
  await publish(baseUrl, "1.2.3", "旧版");
  await publish(baseUrl, "1.2.4", "当前");

  const current = await fetch(`${baseUrl}/admin/api/delete`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ version: "1.2.4" }),
  });
  assert.equal(current.status, 400);

  const removed = await fetch(`${baseUrl}/admin/api/delete`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ version: "1.2.3" }),
  });
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, "courseraptor-v1.2.3.zip")), false);
  const { versions } = await (
    await fetch(`${baseUrl}/admin/api/versions`, {
      headers: { "x-admin-token": TOKEN },
    })
  ).json();
  assert.deepEqual(
    versions.map((v: { version: string }) => v.version),
    ["1.2.4"],
  );

  const again = await fetch(`${baseUrl}/admin/api/delete`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ version: "1.2.3" }),
  });
  assert.equal(again.status, 404);
});

test("admin API 需要令牌，连续失败触发锁定", async (t) => {
  const { baseUrl } = await startServer(t);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`${baseUrl}/admin/api/overview`, {
      headers: { "x-admin-token": "wrong" },
    });
    assert.equal(res.status, 401);
  }
  const fifth = await fetch(`${baseUrl}/admin/api/overview`, {
    headers: { "x-admin-token": "wrong" },
  });
  assert.equal(fifth.status, 429);

  // 锁定期间即使密钥正确也拒绝
  const locked = await fetch(`${baseUrl}/admin/api/overview`, {
    headers: { "x-admin-token": TOKEN },
  });
  assert.equal(locked.status, 429);
});

test("/admin 提供面板静态资源，路径穿越被拒绝", async (t) => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-admin-dist-"));
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>admin</title>");
  fs.writeFileSync(path.join(distDir, "assets", "app.js"), "console.log(1);");

  const { baseUrl } = await startServer(t, distDir);

  const redirect = await fetch(`${baseUrl}/admin`, { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/admin/");

  const index = await fetch(`${baseUrl}/admin/`);
  assert.equal(index.status, 200);
  assert.ok(index.headers.get("content-type")?.includes("text/html"));
  assert.ok(index.headers.get("cache-control")?.includes("no-cache"));
  assert.ok((await index.text()).includes("admin"));

  const asset = await fetch(`${baseUrl}/admin/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.ok(asset.headers.get("content-type")?.includes("text/javascript"));
  assert.ok(asset.headers.get("cache-control")?.includes("immutable"));
  assert.equal(await asset.text(), "console.log(1);");

  // %2f（编码斜杠）不会被 URL 解析器规范化，服务器解码后即为 ../..，真正打到穿越防护
  const traversal = await fetch(`${baseUrl}/admin/assets/%2e%2e%2f..%2fmeta.json`);
  assert.equal(traversal.status, 403);
});

test("SPA 前端路由刷新回 index.html，API 前缀不受影响", async (t) => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-admin-dist-"));
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>admin</title>");

  const { baseUrl } = await startServer(t, distDir);

  const spaRoute = await fetch(`${baseUrl}/admin/versions`);
  assert.equal(spaRoute.status, 200);
  assert.ok(spaRoute.headers.get("content-type")?.includes("text/html"));
  assert.ok((await spaRoute.text()).includes("admin"));

  // API 前缀不回退到 SPA，仍按 JSON 接口处理（此处是无 token 的 401）
  const apiRoute = await fetch(`${baseUrl}/admin/api/overview`);
  assert.equal(apiRoute.status, 401);
  assert.ok(apiRoute.headers.get("content-type")?.includes("application/json"));
});

test("面板未构建时 /admin/ 返回构建指引而不是报错", async (t) => {
  const { baseUrl } = await startServer(t, path.join(os.tmpdir(), "raptor-admin-dist-missing"));
  const res = await fetch(`${baseUrl}/admin/`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("admin:build"));
});
