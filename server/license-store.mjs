import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LICENSE_KEY_RE = /^CR-(?:[A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{16,128}$/;

export class LicenseStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LicenseStoreError";
    this.code = code;
  }
}

function hash(secret, value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function createLicenseKey() {
  const chars = Array.from(randomBytes(20), (byte) => KEY_ALPHABET[byte % KEY_ALPHABET.length]);
  return `CR-${chars.slice(0, 5).join("")}-${chars.slice(5, 10).join("")}-${chars.slice(10, 15).join("")}-${chars.slice(15, 20).join("")}`;
}

function normaliseLicenseKey(value) {
  const key = String(value ?? "").trim().toUpperCase();
  if (!LICENSE_KEY_RE.test(key)) {
    throw new LicenseStoreError("invalid_key", "激活密钥格式不正确");
  }
  return key;
}

function normaliseDeviceId(value) {
  const deviceId = String(value ?? "").trim();
  if (!DEVICE_ID_RE.test(deviceId)) {
    throw new LicenseStoreError("invalid_device", "设备标识格式不正确");
  }
  return deviceId;
}

function normaliseExpiry(value) {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new LicenseStoreError("invalid_expiry", "过期时间格式不正确");
  }
  return date.toISOString();
}

function toPublicLicense(row) {
  return {
    id: Number(row.id),
    // 管理员靠末 5 位区分记录；完整密钥只在生成时显示一次。
    keyHint: row.key_hint,
    status: row.status,
    note: row.note,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    lastCheckAt: row.last_check_at,
    deviceBound: Boolean(row.device_hash),
  };
}

/**
 * 授权码的唯一持久化边界。
 * 数据库只保存密钥、随机安装 ID 的 HMAC 及授权管理所需的状态/时间；
 * 明文密钥只在 createLicense() 的返回值中出现一次。
 */
export function createLicenseStore({ databasePath, secret, now = () => new Date() }) {
  if (!databasePath) throw new Error("databasePath is required");
  if (!secret || String(secret).length < 16) {
    throw new Error("LICENSE_SECRET 至少需要 16 个字符");
  }

  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_hash TEXT NOT NULL UNIQUE,
      key_hint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')) DEFAULT 'active',
      note TEXT NOT NULL DEFAULT '',
      expires_at TEXT,
      device_hash TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      last_check_at TEXT
    );
    CREATE INDEX IF NOT EXISTS licenses_status_idx ON licenses(status);
  `);

  const insertLicense = db.prepare(`
    INSERT INTO licenses (license_hash, key_hint, note, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const findByHash = db.prepare("SELECT * FROM licenses WHERE license_hash = ?");
  const findById = db.prepare("SELECT * FROM licenses WHERE id = ?");
  const list = db.prepare("SELECT * FROM licenses ORDER BY id DESC");
  const bindUnboundDevice = db.prepare(`
    UPDATE licenses
    SET device_hash = ?, activated_at = ?, last_check_at = ?
    WHERE id = ? AND device_hash IS NULL
  `);
  const touch = db.prepare("UPDATE licenses SET last_check_at = ? WHERE id = ?");
  const resetDevice = db.prepare(`
    UPDATE licenses
    SET device_hash = NULL, activated_at = NULL, last_check_at = NULL
    WHERE id = ?
  `);
  const setStatus = db.prepare("UPDATE licenses SET status = ? WHERE id = ?");

  function readValidLicense(licenseKey) {
    const key = normaliseLicenseKey(licenseKey);
    const row = findByHash.get(hash(secret, key));
    if (!row) throw new LicenseStoreError("not_found", "激活密钥无效");
    if (row.status !== "active") throw new LicenseStoreError("disabled", "激活密钥已被禁用");
    if (row.expires_at && new Date(row.expires_at).getTime() < now().getTime()) {
      throw new LicenseStoreError("expired", "激活密钥已过期");
    }
    return row;
  }

  function deviceMatches(storedHash, deviceId) {
    const actual = Buffer.from(hash(secret, deviceId), "hex");
    const expected = Buffer.from(storedHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  return {
    createLicense({ note = "", expiresAt } = {}) {
      const safeNote = String(note).trim();
      if (safeNote.length > 200) {
        throw new LicenseStoreError("invalid_note", "备注不能超过 200 个字符");
      }
      const expiry = normaliseExpiry(expiresAt);
      const createdAt = now().toISOString();
      for (let attempt = 0; attempt < 5; attempt++) {
        const licenseKey = createLicenseKey();
        try {
          const result = insertLicense.run(
            hash(secret, licenseKey),
            licenseKey.slice(-5),
            safeNote,
            expiry,
            createdAt
          );
          const row = findById.get(Number(result.lastInsertRowid));
          return { ...toPublicLicense(row), licenseKey };
        } catch (error) {
          if (attempt === 4) throw error;
        }
      }
      throw new Error("无法生成唯一密钥");
    },

    listLicenses() {
      return list.all().map(toPublicLicense);
    },

    activate({ licenseKey, deviceId }) {
      const row = readValidLicense(licenseKey);
      const safeDeviceId = normaliseDeviceId(deviceId);
      const deviceHash = hash(secret, safeDeviceId);
      if (row.device_hash && !deviceMatches(row.device_hash, safeDeviceId)) {
        throw new LicenseStoreError("device_mismatch", "该激活密钥已绑定其他设备");
      }

      const checkedAt = now().toISOString();
      if (!row.device_hash) {
        // 条件更新让多个进程同时首次激活时只有一个设备能够取得绑定权。
        const result = bindUnboundDevice.run(deviceHash, checkedAt, checkedAt, row.id);
        if (Number(result.changes) === 0) {
          const current = findById.get(row.id);
          if (!current?.device_hash || !deviceMatches(current.device_hash, safeDeviceId)) {
            throw new LicenseStoreError("device_mismatch", "该激活密钥已绑定其他设备");
          }
          touch.run(checkedAt, row.id);
        }
      } else {
        touch.run(checkedAt, row.id);
      }
      return { ...toPublicLicense(findById.get(row.id)), deviceBound: true };
    },

    check({ licenseKey, deviceId }) {
      const row = readValidLicense(licenseKey);
      const safeDeviceId = normaliseDeviceId(deviceId);
      if (!row.device_hash) {
        throw new LicenseStoreError("not_activated", "请先在设备上激活密钥");
      }
      if (!deviceMatches(row.device_hash, safeDeviceId)) {
        throw new LicenseStoreError("device_mismatch", "该激活密钥已绑定其他设备");
      }
      touch.run(now().toISOString(), row.id);
      return toPublicLicense(findById.get(row.id));
    },

    disableLicense(id) {
      if (!findById.get(id)) throw new LicenseStoreError("not_found", "密钥不存在");
      setStatus.run("disabled", id);
      return toPublicLicense(findById.get(id));
    },

    enableLicense(id) {
      if (!findById.get(id)) throw new LicenseStoreError("not_found", "密钥不存在");
      setStatus.run("active", id);
      return toPublicLicense(findById.get(id));
    },

    resetDevice(id) {
      if (!findById.get(id)) throw new LicenseStoreError("not_found", "密钥不存在");
      resetDevice.run(id);
      return toPublicLicense(findById.get(id));
    },

    close() {
      db.close();
    },
  };
}
