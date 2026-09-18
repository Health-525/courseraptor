/**
 * 教务凭证引导（ensureCredentials）的可跳过性：
 * 不填也能跳过进入应用；验证连败不拦启动；填了并验证通过才正常保存。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CredentialSetupIO, ensureCredentials } from "../src/onboarding";

interface Script {
  ask?: string[];
  askSecret?: string[];
}

/** 按调用顺序吐出脚本化回答的假终端；ask 同时承担学号提问与 y/N 确认 */
function scriptedIO(script: Script): { io: CredentialSetupIO; output: string[] } {
  const asks = [...(script.ask ?? [])];
  const secrets = [...(script.askSecret ?? [])];
  const output: string[] = [];
  return {
    output,
    io: {
      write: (message) => output.push(message),
      ask: async () => asks.shift() ?? "",
      askSecret: async () => secrets.shift() ?? "",
    },
  };
}

function fakeServices(options: { loginError?: Error } = {}) {
  const saved: Array<{ username: string; password: string }> = [];
  return {
    saved,
    services: {
      isConfigured: () => false,
      login: async () => {
        if (options.loginError) throw options.loginError;
      },
      save: (username: string, password: string) => saved.push({ username, password }),
    },
  };
}

test("学号密码都留空时跳过配置，不保存、不拦截使用", async () => {
  const { io, output } = scriptedIO({ ask: [""], askSecret: [""] });
  const { saved, services } = fakeServices();
  const outcome = await ensureCredentials(io, services);
  assert.equal(outcome, "skipped");
  assert.equal(saved.length, 0);
  assert.ok(output.some((m) => m.includes("跳过")));
  assert.ok(output.some((m) => m.includes("设置")));
});

test("只填学号不填密码时提示一起填写，随后仍可跳过", async () => {
  const { io, output } = scriptedIO({ ask: ["20230001", ""], askSecret: [""] });
  const { saved, services } = fakeServices();
  const outcome = await ensureCredentials(io, services);
  assert.equal(outcome, "skipped");
  assert.equal(saved.length, 0);
  assert.ok(output.some((m) => m.includes("一起填写")));
});

test("验证通过后加密保存", async () => {
  const { io, output } = scriptedIO({ ask: ["20230001"], askSecret: ["pw123456"] });
  const { saved, services } = fakeServices();
  const outcome = await ensureCredentials(io, services);
  assert.equal(outcome, "configured");
  assert.deepEqual(saved, [{ username: "20230001", password: "pw123456" }]);
  assert.ok(output.some((m) => m.includes("验证通过")));
});

test("连续验证失败后确认保存：保存未验证账号并放行", async () => {
  const { io, output } = scriptedIO({
    ask: ["20230001", "20230001", "20230001", "20230001", "20230001", "y"],
    askSecret: ["bad", "bad", "bad", "bad", "bad"],
  });
  const { saved, services } = fakeServices({ loginError: new Error("学号或密码不正确") });
  const outcome = await ensureCredentials(io, services);
  assert.equal(outcome, "configured");
  assert.deepEqual(saved, [{ username: "20230001", password: "bad" }]);
  assert.ok(output.some((m) => m.includes("未验证")));
});

test("连续验证失败后拒绝保存：跳过并放行，不再抛错拦截启动", async () => {
  const { io, output } = scriptedIO({
    ask: ["20230001", "20230001", "20230001", "20230001", "20230001", ""],
    askSecret: ["bad", "bad", "bad", "bad", "bad"],
  });
  const { saved, services } = fakeServices({ loginError: new Error("学号或密码不正确") });
  const outcome = await ensureCredentials(io, services);
  assert.equal(outcome, "skipped");
  assert.equal(saved.length, 0);
  assert.ok(output.some((m) => m.includes("不影响进入应用")));
});

test("已有凭证时不进入引导", async () => {
  const { io } = scriptedIO({ ask: [""], askSecret: [""] });
  let loginCalled = false;
  const outcome = await ensureCredentials(io, {
    isConfigured: () => true,
    login: async () => {
      loginCalled = true;
    },
    save: () => {},
  });
  assert.equal(outcome, "configured");
  assert.equal(loginCalled, false);
});
