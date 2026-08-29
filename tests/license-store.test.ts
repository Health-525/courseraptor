import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-license-"));
const { LicenseStoreError, createLicenseStore } = await import("../server/license-store.mjs");

function makeStore(now = "2026-08-29T00:00:00.000Z") {
  return createLicenseStore({
    databasePath: path.join(tmpDir, `${Math.random()}.sqlite`),
    secret: "test-license-secret",
    now: () => new Date(now),
  });
}

test("新建密钥只在创建结果中返回明文，列表不泄露密钥", () => {
  const store = makeStore();
  const issued = store.createLicense({ note: "测试同学" });

  assert.match(issued.licenseKey, /^CR-(?:[A-Z2-9]{5}-){3}[A-Z2-9]{5}$/);
  assert.equal(issued.status, "active");
  assert.equal(Object.hasOwn(store.listLicenses()[0], "licenseKey"), false);
  assert.equal(store.listLicenses()[0].keyHint, issued.licenseKey.slice(-5));
});

test("首次激活绑定设备，同一设备可重复校验", () => {
  const store = makeStore();
  const { licenseKey } = store.createLicense({});

  const activated = store.activate({
    licenseKey,
    deviceId: "device-a-0123456789abcdef",
  });
  const checked = store.check({ licenseKey, deviceId: "device-a-0123456789abcdef" });

  assert.equal(activated.deviceBound, true);
  assert.equal(Object.hasOwn(activated, "deviceName"), false);
  assert.equal(checked.status, "active");
});

test("不同设备不能复用已绑定的密钥，重置后可绑定新设备", () => {
  const store = makeStore();
  const { id, licenseKey } = store.createLicense({});
  store.activate({ licenseKey, deviceId: "device-a-0123456789abcdef" });

  assert.throws(
    () => store.activate({ licenseKey, deviceId: "device-b-0123456789abcdef" }),
    (error: unknown) => error instanceof LicenseStoreError && error.code === "device_mismatch"
  );

  store.resetDevice(id);
  const activated = store.activate({ licenseKey, deviceId: "device-b-0123456789abcdef" });
  assert.equal(activated.deviceBound, true);
});

test("禁用或过期的密钥不能通过校验", () => {
  const store = makeStore();
  const disabled = store.createLicense({});
  store.disableLicense(disabled.id);
  assert.throws(
    () => store.check({ licenseKey: disabled.licenseKey, deviceId: "device-a-0123456789abcdef" }),
    (error: unknown) => error instanceof LicenseStoreError && error.code === "disabled"
  );

  const expiredStore = makeStore("2026-09-01T00:00:00.000Z");
  const expired = expiredStore.createLicense({ expiresAt: "2026-08-31T23:59:59.000Z" });
  assert.throws(
    () => expiredStore.activate({ licenseKey: expired.licenseKey, deviceId: "device-a-0123456789abcdef" }),
    (error: unknown) => error instanceof LicenseStoreError && error.code === "expired"
  );
});
