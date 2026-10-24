/**
 * 凭证文件位置：默认跟着 dataDir() 走（命令行 / 网页 / 桌面端共用同一份），
 * RAPTOR_CREDENTIALS_FILE 显式指定时优先（托管多用户 / 测试隔离）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join("D:\\work", "cred-loc-"));
const dataA = path.join(root, "a");
const dataB = path.join(root, "b");
fs.mkdirSync(dataA, { recursive: true });
fs.mkdirSync(dataB, { recursive: true });
delete process.env.RAPTOR_CREDENTIALS_FILE;
process.env.RAPTOR_DATA_DIR = dataA;

const { hasStoredCredentials, loadCredentialsStore, saveCredentialsStore } = await import(
  "../src/core/credentials"
);

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("默认把凭证写进 RAPTOR_DATA_DIR 下，而不是项目根", () => {
  saveCredentialsStore({ providerId: "deepseek" });
  assert.ok(fs.existsSync(path.join(dataA, "credentials.enc")));
  assert.equal(loadCredentialsStore()?.providerId, "deepseek");
});

test("数据目录切换后凭证跟着数据目录走（同一目录三端共用）", () => {
  process.env.RAPTOR_DATA_DIR = dataB;
  assert.equal(hasStoredCredentials(), false);
  process.env.RAPTOR_DATA_DIR = dataA;
  assert.equal(hasStoredCredentials(), true);
});

test("RAPTOR_CREDENTIALS_FILE 显式指定时优先于数据目录", () => {
  const explicit = path.join(root, "explicit.enc");
  process.env.RAPTOR_CREDENTIALS_FILE = explicit;
  try {
    saveCredentialsStore({ providerId: "zhenze" });
    assert.ok(fs.existsSync(explicit));
    assert.equal(loadCredentialsStore()?.providerId, "zhenze");
  } finally {
    delete process.env.RAPTOR_CREDENTIALS_FILE;
  }
});
