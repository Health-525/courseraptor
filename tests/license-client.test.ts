import assert from "node:assert/strict";
import { test } from "node:test";

const { LicenseClientError, createLicenseClient } = await import("../src/license");

test("授权客户端激活时提交密钥与安装 ID", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createLicenseClient({
    serverUrl: "https://license.example.com/",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, license: { status: "active" } }), { status: 200 });
    },
  });

  await client.activate({ licenseKey: "CR-ABCDE-FGHIJ-KLMNP-QRSTU", deviceId: "device-a-0123456789abcdef" });

  assert.equal(calls[0].url, "https://license.example.com/license/activate");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    licenseKey: "CR-ABCDE-FGHIJ-KLMNP-QRSTU",
    deviceId: "device-a-0123456789abcdef",
  });
});

test("授权客户端将服务端拒绝转换为可识别错误", async () => {
  const client = createLicenseClient({
    serverUrl: "https://license.example.com",
    fetchImpl: async () => new Response(JSON.stringify({ error: "密钥已被禁用", code: "disabled" }), { status: 403 }),
  });

  await assert.rejects(
    () => client.check({ licenseKey: "CR-ABCDE-FGHIJ-KLMNP-QRSTU", deviceId: "device-a-0123456789abcdef" }),
    (error: unknown) => error instanceof LicenseClientError && error.code === "disabled"
  );
});

test("授权客户端拒绝公网 HTTP 地址，避免激活密钥在传输中泄露", () => {
  assert.throws(
    () => createLicenseClient({ serverUrl: "http://license.example.com" }),
    /HTTPS/
  );
});
