/**
 * 教务凭证安全存储
 *
 * 首次运行引导录入学号/密码 -> AES-256-GCM 加密落盘 credentials.enc，
 * 启动时解密注入。密钥由机器指纹（主机名 + 系统用户名）派生：
 * 凭证文件被拷贝到其他机器无法解密，防住云同步/误分享等明文泄露路径。
 * 边界：对同机同用户的恶意程序无防护作用（本机派生密钥本机可解）。
 *
 * 优先级：.env 的 JWGL_* > credentials.enc > 首次运行引导录入
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROJECT_ROOT } from "./paths";

const CRED_FILE = path.join(PROJECT_ROOT, "credentials.enc");

export interface StoredCredentials {
  username: string;
  password: string;
  savedAt: string;
}

/** 机器指纹派生密钥（salt 随文件存储，不是秘密） */
function machineKey(salt: string): Buffer {
  const fingerprint = `${os.hostname()}|${os.userInfo().username}|courseraptor-v1`;
  return crypto.scryptSync(fingerprint, salt, 32);
}

/** 加密存储的凭证（通用 KV：教务账号 + API Key 等） */
export interface CredentialsStore {
  username?: string;
  password?: string;
  deepseekApiKey?: string;
  savedAt: string;
}

/** 读取并解密本地凭证；文件不存在或跨机器无法解密时返回 null */
export function loadCredentialsStore(): CredentialsStore | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CRED_FILE, "utf8")) as {
      salt: string;
      iv: string;
      tag: string;
      data: string;
    };
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      machineKey(raw.salt),
      Buffer.from(raw.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(raw.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plain) as CredentialsStore;
  } catch {
    return null;
  }
}

/** 合并加密保存（patch 部分字段，保留未提及字段） */
export function saveCredentialsStore(patch: Partial<CredentialsStore>): void {
  const existing = loadCredentialsStore();
  const payload: CredentialsStore = {
    ...existing,
    ...patch,
    savedAt: new Date().toISOString(),
  };
  const salt = crypto.randomBytes(16).toString("base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", machineKey(salt), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  fs.writeFileSync(
    CRED_FILE,
    JSON.stringify(
      {
        v: 1,
        salt,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      },
      null,
      2
    )
  );
}

/** 旧接口兼容（onboarding 使用） */
export function loadStoredCredentials(): CredentialsStore | null {
  return loadCredentialsStore();
}

export function saveStoredCredentials(username: string, password: string): void {
  saveCredentialsStore({ username, password });
}

export function clearStoredCredentials(): void {
  try {
    fs.unlinkSync(CRED_FILE);
  } catch {
    /* 不存在 */
  }
}

export function hasStoredCredentials(): boolean {
  return fs.existsSync(CRED_FILE);
}
