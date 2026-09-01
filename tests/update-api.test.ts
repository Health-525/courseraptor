import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createUpdateServer } = await import("../server/app.mjs");

async function startServer(t: { after: (fn: () => void) => void }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-update-api-"));
  const server = createUpdateServer({ dataDir, adminToken: "test-admin-token" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("发布新版需要管理员令牌，最新版本和下载面向所有用户开放", async (t) => {
  const baseUrl = await startServer(t);
  const unauthorized = await fetch(`${baseUrl}/publish`, {
    method: "POST",
    headers: { "x-version": "1.2.3" },
    body: Buffer.from("zip-content"),
  });
  assert.equal(unauthorized.status, 401);

  const published = await fetch(`${baseUrl}/publish`, {
    method: "POST",
    headers: {
      "x-admin-token": "test-admin-token",
      "x-version": "1.2.3",
      "x-notes": encodeURIComponent("开放下载"),
    },
    body: Buffer.from("zip-content"),
  });
  assert.equal(published.status, 200);

  const latest = await fetch(`${baseUrl}/latest`);
  assert.equal(latest.status, 200);
  assert.deepEqual(await latest.json(), {
    version: "1.2.3",
    notes: "开放下载",
    publishedAt: (await fetch(`${baseUrl}/latest`).then((res) => res.json())).publishedAt,
    download: "/download",
  });

  const download = await fetch(`${baseUrl}/download`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "zip-content");
});
