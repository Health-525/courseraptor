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
 * 该同学是否保存了「当前供应商」自己的 Key（多厂商：读 providerKeys 里该
 * 供应商的值；老格式 deepseekApiKey+Override 迁移兼容，与
 * src/core/config.ts effectiveProviderKeys 同语义）。
 * 带 mtime 缓存：每次对话都查，别反复 scrypt。
 */
const cache = new Map();

export async function ownDeepseekKeyActive(usersDir, userId, providerId = "deepseek") {
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
  const keys = store?.providerKeys ?? {};
  const active = Boolean(
    keys[providerId] ||
      (providerId === "deepseek" && store?.deepseekApiKeyOverride && store?.deepseekApiKey),
  );
  cache.set(userId, { mtime, active });
  return active;
}

/**
 * 实际生效的供应商：同学自选（users.json providerId）> 站点默认
 * （site.json defaultProvider，管理台「站点默认模型」）> deepseek——
 * 与 spawner 的注入链一致；/api/quota 展示与 /api/chat 分账都按它判
 * 「当前供应商」，否则站点默认切到别家时会查错同学的自有 Key。
 */
export async function effectiveProviderIdFor(registry, user) {
  if (user?.providerId) return user.providerId;
  try {
    const site = await registry.getSiteSettings();
    if (site.defaultProvider) return site.defaultProvider;
  } catch {
    // 查询失败按未配置站点默认处理
  }
  return "deepseek";
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
