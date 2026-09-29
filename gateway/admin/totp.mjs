/**
 * 管理台两步验证（TOTP，RFC 6238）与恢复码的纯函数实现。
 *
 * 只用 node:crypto，不引第三方库：HMAC-SHA1 动态码（6 位 / 30 秒 /
 * 允许 ±1 步时钟漂移）+ 一次性恢复码（sha256 落盘哈希）。RFC 6238 的
 * 标准测试向量见 tests/gateway-admin-totp.test.ts。
 */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;
/** 恢复码字符集：去掉 0/1/O/I/L 等易混字符 */
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** 生成 20 字节随机密钥（160 位，base32 编码后 32 字符，验证器通用长度） */
export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  const clean = String(text ?? "")
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** HOTP（RFC 4226）：counter（从 Unix 起算的 30 秒步数）→ 6 位十进制动态码 */
function hotp(secretBytes, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secretBytes).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * 校验 6 位动态码：窗口 ±1 步（容忍手机与服务器各 30 秒的时钟漂移）。
 * lastUsedCounter 之后的步数才有效（同一个码 30 秒内不重放）。
 * 命中返回 { ok: true, counter }；码本身对但已过水位返回 { ok: false, replay: true }，
 * 便于上层提示「等下一枚」而不是笼统的「不正确」。
 */
export function verifyTotp(secretBase32, candidate, { window = 1, now = Date.now(), lastUsedCounter = -1 } = {}) {
  const candidateCode = String(candidate ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(candidateCode)) return { ok: false };
  const secretBytes = base32Decode(secretBase32);
  if (secretBytes.length === 0) return { ok: false };
  const current = Math.floor(now / 1000 / STEP_SECONDS);
  let replayed = false;
  // 从新到旧尝试：同一时刻命中多个窗口时绑定较新的 counter，推进防重放水位
  for (let drift = window; drift >= -window; drift--) {
    const counter = current + drift;
    const expected = Buffer.from(hotp(secretBytes, counter));
    const given = Buffer.from(candidateCode);
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      if (counter <= lastUsedCounter) {
        replayed = true;
        continue;
      }
      return { ok: true, counter };
    }
  }
  return replayed ? { ok: false, replay: true } : { ok: false };
}

/** 验证器扫码用的 otpauth:// URI（issuer/account 保持 ASCII，免 URI 编码歧义） */
export function otpauthUri({ secret, issuer = "CourseRaptor", account = "admin" }) {
  return `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** 生成 n 枚恢复码明文（形如 7Q3KD-M9W2P，只展示这一次） */
export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]);
    codes.push(`${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`);
  }
  return codes;
}

/** 恢复码统一形态：大写、去空格与连字符（输入 "m9w2p-7q3kd" 与 "M9W2P7Q3KD" 等价） */
export function normalizeRecoveryCode(input) {
  return String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

/** 恢复码只存哈希：与明文形态一一对应，落盘/比对都用它 */
export function hashRecoveryCode(input) {
  return createHash("sha256").update(normalizeRecoveryCode(input)).digest("hex");
}
