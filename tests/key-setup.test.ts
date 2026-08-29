import assert from "node:assert/strict";
import { test } from "node:test";
import {
  maskDeepSeekApiKey,
  resolveDeepSeekApiKey,
} from "../src/config";
import {
  runDeepSeekKeySetup,
  type KeySetupIO,
} from "../src/onboarding";

const NEW_KEY = "sk-NewKey1234567890ABCDE";

test("用户覆盖的加密 API Key 在重启后优先于 .env 旧值", () => {
  assert.deepEqual(
    resolveDeepSeekApiKey({
      environmentKey: "sk-EnvironmentOld123456",
      storedKey: NEW_KEY,
      storedOverride: true,
    }),
    { key: NEW_KEY, source: "encrypted" },
  );
});

test("API Key 脱敏只显示 sk- 前缀与末尾四位", () => {
  assert.equal(maskDeepSeekApiKey(NEW_KEY), "sk-••••••••••••BCDE");
  assert.equal(maskDeepSeekApiKey("sk-short"), "已配置");
});

test("确认覆盖后静音读取新 Key，界面只显示脱敏旧 Key", async () => {
  const output: string[] = [];
  const saved: string[] = [];
  const io: KeySetupIO = {
    write: (message) => output.push(message),
    confirm: async () => true,
    readSecret: async () => NEW_KEY,
  };

  const result = await runDeepSeekKeySetup(io, {
    getStatus: () => ({
      configured: true,
      masked: "sk-••••••••••••BCDE",
      source: "env",
    }),
    setKey: (key) => {
      saved.push(key);
      return { ok: true, message: "✅ API Key 已加密保存并立即生效" };
    },
  });

  assert.equal(result, "saved");
  assert.deepEqual(saved, [NEW_KEY]);
  assert.ok(output.some((message) => message.includes("sk-••••••••••••BCDE")));
  assert.ok(output.some((message) => message.includes("请粘贴或输入新的 DeepSeek API Key")));
  assert.ok(output.every((message) => !message.includes(NEW_KEY)));
});

test("拒绝覆盖时不读取、不保存新 Key", async () => {
  let readSecretCalled = false;
  let saved = false;
  const io: KeySetupIO = {
    write: () => {},
    confirm: async () => false,
    readSecret: async () => {
      readSecretCalled = true;
      return NEW_KEY;
    },
  };

  const result = await runDeepSeekKeySetup(io, {
    getStatus: () => ({ configured: true, masked: "sk-••••••••••••BCDE", source: "encrypted" }),
    setKey: () => {
      saved = true;
      return { ok: true, message: "unexpected" };
    },
  });

  assert.equal(result, "kept");
  assert.equal(readSecretCalled, false);
  assert.equal(saved, false);
});
