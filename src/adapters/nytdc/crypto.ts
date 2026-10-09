/**
 * NYTDC（南京邮电大学通达学院）正方教务系统 - RSA 加密
 *
 * 正方新版登录前必须把明文密码用服务端下发的 RSA 公钥加密成 Base64。
 * 公钥以 modulus/exponent（Base64）形式下发，这里手工拼出 DER 再包 PEM，
 * 交给 node:crypto 做 PKCS#1 v1.5 加密。
 *
 * 维护者：社区适配（由 CourseRaptor 适配流程生成，实机验证见 git log）
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
  // modulus 有 256 字节，长度本身要两个字节。
  function derLength(len: number): Buffer {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x100) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, len >> 8, len & 0xff]);
  }

  function derInt(buf: Buffer): Buffer {
    let b = buf;
    while (b.length > 1 && b[0] === 0) b = b.slice(1);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([Buffer.from([0x02]), derLength(b.length), b]);
  }

  const seq = Buffer.concat([derInt(mb), derInt(eb)]);
  const der = Buffer.concat([Buffer.from([0x30]), derLength(seq.length), seq]);

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
