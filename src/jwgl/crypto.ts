/**
 * 正方教务系统 RSA 加密模块
 * 搬自 timetable/scripts/lib/zf-crypto.js，改为 TypeScript
 *
 * 用法: const encrypted = encryptPassword(password, modulus, exponent);
 */

import crypto from "crypto";

/**
 * RSA 加密密码（正方教务系统登录）
 * @param pwd - 明文密码
 * @param modulusB64 - RSA modulus (base64)
 * @param exponentB64 - RSA exponent (base64)
 * @returns base64 编码的加密结果
 */
export function encryptJwglPassword(
  pwd: string,
  modulusB64: string,
  exponentB64: string
): string {
  const mb = Buffer.from(modulusB64, "base64");
  const eb = Buffer.from(exponentB64, "base64");

  function derInt(buf: Buffer): Buffer {
    let b = buf;
    // Remove leading zeros
    while (b.length > 1 && b[0] === 0) b = b.slice(1);
    // Add leading zero if high bit set
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    const len = b.length;
    if (len < 128) {
      return Buffer.concat([Buffer.from([0x02, len]), b]);
    }
    return Buffer.concat([Buffer.from([0x02, 0x81, len]), b]);
  }

  const seq = Buffer.concat([derInt(mb), derInt(eb)]);
  const sl = seq.length;
  const der =
    sl < 128
      ? Buffer.concat([Buffer.from([0x30, sl]), seq])
      : Buffer.concat([Buffer.from([0x30, 0x81, sl]), seq]);

  const pem =
    "-----BEGIN RSA PUBLIC KEY-----\n" +
    der.toString("base64").match(/.{1,64}/g)!.join("\n") +
    "\n-----END RSA PUBLIC KEY-----";

  return crypto
    .publicEncrypt(
      { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(pwd, "utf8")
    )
    .toString("base64");
}
