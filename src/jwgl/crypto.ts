/**
 * 正方教务系统 RSA 加密模块
 * 搬自 timetable/scripts/lib/zf-crypto.js，改为 TypeScript
 *
 * 用法: const encrypted = encryptPassword(password, modulus, exponent);
 */

import crypto from "node:crypto";

/**
 * RSA 加密密码（正方教务系统登录）
 * @param pwd - 明文密码
 * @param modulusB64 - RSA modulus (base64)
 * @param exponentB64 - RSA exponent (base64)
 * @returns base64 编码的加密结果
 */
export function encryptJwglPassword(pwd: string, modulusB64: string, exponentB64: string): string {
  const mb = Buffer.from(modulusB64, "base64");
  const eb = Buffer.from(exponentB64, "base64");

  // DER 长度：短格式 <0x80；否则 0x81/0x82 + 大端长度。2048 位密钥的
  // modulus 有 256 字节，长度本身要两个字节——以前只写 0x81 一个字节，
  // 256 截断成 0，整个结构作废（服务器升 2048 位密钥时登录会全挂）
  function derLength(len: number): Buffer {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x100) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, len >> 8, len & 0xff]);
  }

  function derInt(buf: Buffer): Buffer {
    let b = buf;
    // Remove leading zeros
    while (b.length > 1 && b[0] === 0) b = b.slice(1);
    // Add leading zero if high bit set
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([Buffer.from([0x02]), derLength(b.length), b]);
  }

  const seq = Buffer.concat([derInt(mb), derInt(eb)]);
  const der = Buffer.concat([Buffer.from([0x30]), derLength(seq.length), seq]);

  // base64 逐 64 字符分行包 PEM；match 一定命中（非空字符串），仍给空数组兜底
  const b64 = der.toString("base64");
  const pemLines = b64.match(/.{1,64}/g) ?? [b64];
  const pem = `-----BEGIN RSA PUBLIC KEY-----\n${pemLines.join("\n")}\n-----END RSA PUBLIC KEY-----`;

  return crypto
    .publicEncrypt(
      { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(pwd, "utf8"),
    )
    .toString("base64");
}
