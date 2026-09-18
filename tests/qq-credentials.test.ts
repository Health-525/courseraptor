/**
 * QQ 机器人凭证测试：解析优先级、保存校验与脱敏
 *
 * 加密存储指向临时文件（RAPTOR_CREDENTIALS_FILE），绝不碰真机 credentials.enc。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-qq-cred-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(dataDir, "credentials.enc");

const { config, resolveQQBotCredentials } = await import("../src/config");
const { loadCredentialsStore } = await import("../src/credentials");
const { getQQBotStatus, maskQQAppId, setQQBotCredentials } = await import("../src/onboarding");

test("resolveQQBotCredentials：env 成对优先，半套 env 整体回退加密存储", () => {
  const envWin = resolveQQBotCredentials({
    environmentAppId: "e-app",
    environmentAppSecret: "e-secret",
    environmentPasscode: "e-pass",
  });
  assert.equal(envWin.appId, "e-app");
  assert.equal(envWin.appSecret, "e-secret");
  assert.equal(envWin.passcode, "e-pass");
  assert.equal(envWin.source, "env");

  // .env 只有 AppID 没有 Secret 时不算可用：整体回退存储，绝不拼接两处来源
  const fallback = resolveQQBotCredentials({
    environmentAppId: "half-env",
    storedAppId: "s-app",
    storedAppSecret: "s-secret",
    storedPasscode: "s-pass",
  });
  assert.equal(fallback.appId, "s-app");
  assert.equal(fallback.appSecret, "s-secret");
  assert.equal(fallback.passcode, "s-pass");
  assert.equal(fallback.source, "encrypted");

  // 两边都没有：只有 passcode 可独立存在，来源是 unset
  const empty = resolveQQBotCredentials({ storedPasscode: "only-pass" });
  assert.equal(empty.appId, undefined);
  assert.equal(empty.source, "unset");
  assert.equal(empty.passcode, "only-pass");
});

test("setQQBotCredentials：成对校验、加密落盘、运行时热生效", () => {
  // 半套直接拒绝，不落任何东西
  const rejected = setQQBotCredentials({ appId: "1023456789" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /一起/);

  const saved = setQQBotCredentials({
    appId: "1023456789",
    appSecret: "sec-1",
    passcode: "暗号-1",
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.complete, true);

  // 热生效：config 立即可用（桥拉起读的就是这里）
  assert.equal(config.qqBotAppId, "1023456789");
  assert.equal(config.qqBotAppSecret, "sec-1");
  assert.equal(config.qqBotPasscode, "暗号-1");
  assert.equal(config.qqBotSource, "encrypted");

  // 加密落盘：重启后 config 从这里回读
  const stored = loadCredentialsStore();
  assert.equal(stored?.qqBotAppId, "1023456789");
  assert.equal(stored?.qqBotAppSecret, "sec-1");
  assert.equal(stored?.qqBotPasscode, "暗号-1");

  // 只改暗号：不动 AppID/Secret
  const passOnly = setQQBotCredentials({ passcode: "暗号-2" });
  assert.equal(passOnly.ok, true);
  assert.equal(config.qqBotAppSecret, "sec-1");
  assert.equal(config.qqBotPasscode, "暗号-2");

  // 什么都不给：明确拒绝
  const nothing = setQQBotCredentials({});
  assert.equal(nothing.ok, false);
});

test("getQQBotStatus：只回脱敏 AppID，绝不带 AppSecret", () => {
  const st = getQQBotStatus();
  assert.equal(st.configured, true);
  assert.equal(st.passcodeSet, true);
  assert.equal(st.appIdMasked, "1023••••89");
  assert.ok(!JSON.stringify(st).includes("sec-1"), "状态里不得出现 AppSecret");
});

test("maskQQAppId：过短值只报已配置，正常值首尾可见", () => {
  assert.equal(maskQQAppId("1234"), "已配置");
  assert.equal(maskQQAppId("1023456789"), "1023••••89");
  assert.equal(maskQQAppId("  1023456789  "), "1023••••89");
});
