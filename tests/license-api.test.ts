import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createUpdateServer } = await import("../server/app.mjs");

async function startServer(t: { after: (fn: () => void) => void }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-license-api-"));
  const server = createUpdateServer({
    dataDir,
    adminToken: "test-admin-token",
    licenseSecret: "test-license-secret",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, dataDir };
}

function adminHeaders() {
  return {
    "content-type": "application/json",
    "x-admin-token": "test-admin-token",
  };
}

async function issueLicense(baseUrl: string) {
  const response = await fetch(`${baseUrl}/admin/licenses`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ note: "测试授权" }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: number; licenseKey: string };
}

test("管理员可创建独立密钥，列表接口不返回明文", async (t) => {
  const { baseUrl } = await startServer(t);
  const issued = await issueLicense(baseUrl);
  assert.match(issued.licenseKey, /^CR-/);

  const response = await fetch(`${baseUrl}/admin/licenses`, {
    headers: { "x-admin-token": "test-admin-token" },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { licenses: Array<Record<string, unknown>> };
  assert.equal(body.licenses.length, 1);
  assert.equal(body.licenses[0].licenseKey, undefined);
});

test("激活绑定设备，换设备和未授权下载都被拒绝", async (t) => {
  const { baseUrl } = await startServer(t);
  const issued = await issueLicense(baseUrl);
  const deviceId = "device-a-0123456789abcdef";

  const activate = await fetch(`${baseUrl}/license/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseKey: issued.licenseKey, deviceId, deviceName: "测试电脑" }),
  });
  assert.equal(activate.status, 200);

  const blockedDevice = await fetch(`${baseUrl}/license/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseKey: issued.licenseKey, deviceId: "device-b-0123456789abcdef" }),
  });
  assert.equal(blockedDevice.status, 409);
  assert.equal((await blockedDevice.json() as { code: string }).code, "device_mismatch");

  const publish = await fetch(`${baseUrl}/publish`, {
    method: "POST",
    headers: {
      "x-admin-token": "test-admin-token",
      "x-version": "1.2.3",
      "x-notes": encodeURIComponent("测试发布"),
    },
    body: Buffer.from("zip-content"),
  });
  assert.equal(publish.status, 200);

  assert.equal((await fetch(`${baseUrl}/download`)).status, 401);
  const download = await fetch(`${baseUrl}/download`, {
    headers: { "x-license-key": issued.licenseKey, "x-device-id": deviceId },
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "zip-content");
});

test("管理员可禁用密钥，之后校验和下载立即失效", async (t) => {
  const { baseUrl } = await startServer(t);
  const issued = await issueLicense(baseUrl);
  const deviceId = "device-a-0123456789abcdef";
  await fetch(`${baseUrl}/license/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseKey: issued.licenseKey, deviceId }),
  });

  const publish = await fetch(`${baseUrl}/publish`, {
    method: "POST",
    headers: { "x-admin-token": "test-admin-token", "x-version": "1.2.3" },
    body: Buffer.from("zip-content"),
  });
  assert.equal(publish.status, 200);

  const disable = await fetch(`${baseUrl}/admin/licenses/${issued.id}/disable`, {
    method: "POST",
    headers: { "x-admin-token": "test-admin-token" },
  });
  assert.equal(disable.status, 200);

  const check = await fetch(`${baseUrl}/license/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseKey: issued.licenseKey, deviceId }),
  });
  assert.equal(check.status, 403);
  assert.equal((await check.json() as { code: string }).code, "disabled");

  const download = await fetch(`${baseUrl}/download`, {
    headers: { "x-license-key": issued.licenseKey, "x-device-id": deviceId },
  });
  assert.equal(download.status, 403);
});
