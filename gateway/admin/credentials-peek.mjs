/**
 * 读取某位同学的加密凭证，判断是否启用了「自己的 DeepSeek Key」。
 *
 * 与 src/core/credentials.ts 同一套派生与加密方案（scrypt(主机名|系统用户名|
 * courseraptor-v1, salt) → AES-256-GCM）——网关与实例跑在同一 OS 用户下，
 * 本就能解密；这里只读取 override 标记做限额豁免判断，不外传任何明文。
 * 读取失败（文件不存在/损坏/格式不符）一律按「未自带」处理。
 */

import { createDecipheriv, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function deriveKey(saltB64) {
  const fingerprint = `${os.hostname()}|${os.userInfo().username}|courseraptor-v1`;
  return scryptSync(fingerprint, Buffer.from(saltB64, "base64"), 32);
}

async function decryptStore(file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (raw?.v !== 1 || !raw.salt || !raw.iv || !raw.tag || !raw.data) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(raw.salt),
      Buffer.from(raw.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(raw.data, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * 该同学是否保存了自己的 DeepSeek Key（override 生效）。
 * 带 mtime 缓存：每次对话都查，别反复 scrypt。
 */
const cache = new Map();

export async function ownDeepseekKeyActive(usersDir, userId) {
  const file = path.join(usersDir, userId, "credentials.enc");
  let mtime = 0;
  try {
    mtime = (await import("node:fs")).statSync(file).mtimeMs;
  } catch {
    cache.delete(userId);
    return false;
  }
  const hit = cache.get(userId);
  if (hit && hit.mtime === mtime) return hit.active;
  const store = await decryptStore(file);
  const active = Boolean(store?.deepseekApiKeyOverride && store?.deepseekApiKey);
  cache.set(userId, { mtime, active });
  return active;
}

/**
 * 切回站点免费额度：清掉该同学存储的自己 Key（重新加密落盘，其他字段保留）。
 * 文件不存在/解不开时静默成功——本来就没有自己的 Key。
 */
export async function clearOwnDeepseekKey(usersDir, userId) {
  const { writeFile, rename } = await import("node:fs/promises");
  const { randomBytes, createCipheriv } = await import("node:crypto");
  const file = path.join(usersDir, userId, "credentials.enc");
  let store = await decryptStore(file);
  if (!store) store = {};
  if (!store.deepseekApiKey && !store.deepseekApiKeyOverride) {
    cache.delete(userId);
    return;
  }
  store.deepseekApiKey = "";
  store.deepseekApiKeyOverride = false;
  const saltB64 = randomBytes(16).toString("base64");
  const iv = randomBytes(12);
  const key = scryptSync(
    `${os.hostname()}|${os.userInfo().username}|courseraptor-v1`,
    Buffer.from(saltB64, "base64"),
    32,
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(store)), cipher.final()]);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temp,
    JSON.stringify({
      v: 1,
      salt: saltB64,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    }),
  );
  await rename(temp, file);
  cache.delete(userId);
}
