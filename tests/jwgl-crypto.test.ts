/**
 * 正方登录密码 RSA 加密（jwgl/crypto）—— 安全核心，离线往返验证：
 * 自造 RSA 密钥对 → encryptJwglPassword 加密 → 私钥解密必须还原明文。
 * 这层以前零测试，加密参数（padding/DER 编码）错一点登录就全挂。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { encryptJwglPassword } from "../src/jwgl/crypto";

function makeKeyPair(modulusLength: 1024 | 2048 = 2048): {
  modulusB64: string;
  exponentB64: string;
  privateKey: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength });
  // 按正方前端的姿势取 modulus/exponent 的裸 base64（JWK 的 n/e 是 base64url）
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return {
    modulusB64: Buffer.from(jwk.n, "base64url").toString("base64"),
    exponentB64: Buffer.from(jwk.e, "base64url").toString("base64"),
    privateKey: privateKey.export({ type: "pkcs1", format: "pem" }) as string,
  };
}

test("encryptJwglPassword：RSA 往返——私钥能解开还原明文（2048 位密钥）", () => {
  const { modulusB64, exponentB64, privateKey } = makeKeyPair(2048);
  const pwd = "P@ssw0rd教务密码123";
  const encrypted = encryptJwglPassword(pwd, modulusB64, exponentB64);

  assert.ok(encrypted.length > 0);
  const decrypted = crypto
    .privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(encrypted, "base64"),
    )
    .toString("utf8");
  assert.equal(decrypted, pwd);
});

test("encryptJwglPassword：1024 位密钥（正方现役形状）同样往返成功", () => {
  const { modulusB64, exponentB64, privateKey } = makeKeyPair(1024);
  const encrypted = encryptJwglPassword("abc123", modulusB64, exponentB64);
  const decrypted = crypto
    .privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(encrypted, "base64"),
    )
    .toString("utf8");
  assert.equal(decrypted, "abc123");
});

test("encryptJwglPassword：同一明文两次加密结果不同（PKCS1 随机填充），但都能解回", () => {
  const { modulusB64, exponentB64, privateKey } = makeKeyPair();
  const a = encryptJwglPassword("abc123", modulusB64, exponentB64);
  const b = encryptJwglPassword("abc123", modulusB64, exponentB64);
  assert.notEqual(a, b);
  for (const c of [a, b]) {
    const back = crypto
      .privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(c, "base64"),
      )
      .toString("utf8");
    assert.equal(back, "abc123");
  }
});
