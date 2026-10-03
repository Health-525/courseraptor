/**
 * 河北农大 CAS 登录与二次认证的离线用例（传输层注入假响应，不碰真实教务系统）
 *
 * 这里要钉住的都是「错了就伤到用户」的路径：
 * - 密码错误不能被当成「需要验证码」，更不能反复发码；
 * - 待验证会话必须按「学校+学号」隔离，别人拿不到我的登录态；
 * - 会话 10 分钟过期、用完即删；
 * - AUTH_CHALLENGE 错误不可重试（重试等于给用户手机灌验证码）；
 * - onboarding 首次引导遇到二次认证能当场收码续完登录。
 *
 * src 模块都在 import 时定型、运行期才读 RAPTOR_DATA_DIR，所以顶层设 env 即可隔离。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 隔离：待验证会话与凭证都指到临时目录
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-hebau-mfa-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");

import { completeSecondFactor, loginHebau } from "../src/adapters/hebau/cas";
import { type RawResponse, setTransportForTest } from "../src/adapters/hebau/http";
import * as hebauSession from "../src/adapters/hebau/session";
import { config } from "../src/core/config";
import { isRaptorError } from "../src/core/errors";
import { type CredentialSetupIO, ensureCredentials } from "../src/core/onboarding";
import { registerSchoolOption, school, selectSchool } from "../src/core/school";
import {
  clearAllSecondFactors,
  findSecondFactor,
  readSecondFactor,
  SecondFactorRequiredError,
} from "../src/core/school-mfa";

const LOGIN_PAGE =
  '<form><input name="execution" value="EX1"/><input id="pwdEncryptSalt" value="0123456789abcdef"/></form>';
const REAUTH_PAGE = '{"reAuthType":"3","isMultifactor":"true"} <input value="手机(138****1234)"/>';

interface Script {
  reauth?: boolean;
  reAuthType?: string;
  wrongPassword?: boolean;
  sendFail?: boolean;
  submitFail?: boolean;
  noSession?: boolean;
}

const calls: string[] = [];

function installCas(script: Script): void {
  calls.length = 0;
  let loginPageServed = 0;
  setTransportForTest(async (url, opts): Promise<RawResponse> => {
    calls.push(`${opts.method ?? "GET"} ${url}`);
    const cookie = (name: string) => ({ "set-cookie": [`${name}=v1; Path=/`] });
    if (url.includes("/dynamicCode/getDynamicCodeByReauth")) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: script.sendFail
          ? '{"res":"fail","returnMessage":"发送过于频繁"}'
          : '{"res":"success"}',
      };
    }
    if (url.includes("/reAuthCheck/reAuthSubmit")) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: script.submitFail
          ? '{"code":"reAuth_error","msg":"验证码不正确"}'
          : '{"code":"reAuth_success"}',
      };
    }
    if (url.includes("/reAuthCheck/")) {
      return {
        status: 200,
        headers: {},
        body: REAUTH_PAGE.replace('"reAuthType":"3"', `"reAuthType":"${script.reAuthType ?? "3"}"`),
      };
    }
    if (url.includes("/authserver/login")) {
      if ((opts.method ?? "GET") !== "GET") {
        if (script.wrongPassword) return { status: 200, headers: {}, body: LOGIN_PAGE };
        if (script.reauth) {
          return {
            status: 302,
            headers: {
              location: "/authserver/reAuthCheck/reAuthLoginView.do?isMultifactor=true",
              ...cookie("CASTGT"),
            },
            body: "",
          };
        }
        return {
          status: 302,
          headers: {
            location: "http://urp.hebau.edu.cn:1009/jwapp/sys/homeapp/index.do",
            ...cookie("CASTGT"),
          },
          body: "",
        };
      }
      // 第一次是取登录页（要 execution / pwdEncryptSalt），之后回访才是取教务会话
      if (loginPageServed === 0) {
        loginPageServed++;
        return { status: 200, headers: {}, body: LOGIN_PAGE };
      }
      return {
        status: 200,
        headers: script.noSession ? {} : cookie("GS_SESSIONID"),
        body: "<html>ok</html>",
      };
    }
    return { status: 200, headers: {}, body: "<html>home</html>" };
  });
}

test("账密直接通过：拿到含 GS_SESSIONID 的会话", async () => {
  installCas({});
  clearAllSecondFactors();
  const session = await loginHebau({ username: "2021010101", password: "pw" });
  assert.match(session.cookie, /GS_SESSIONID=/);
  assert.equal(session.username, "2021010101");
  assert.equal(findSecondFactor("hebau", "2021010101"), null);
});

test("密码错误：直说密码错误，不发验证码、不建待验证会话", async () => {
  installCas({ wrongPassword: true });
  clearAllSecondFactors();
  await assert.rejects(
    () => loginHebau({ username: "2021010101", password: "bad" }),
    /学号或密码不正确/,
  );
  assert.equal(calls.filter((c) => c.includes("getDynamicCodeByReauth")).length, 0);
  assert.equal(findSecondFactor("hebau", "2021010101"), null);
});

test("触发二次认证：抛 AUTH_CHALLENGE 信号（不可重试），会话按学校+学号可查回", async () => {
  installCas({ reauth: true });
  clearAllSecondFactors();
  const err = await loginHebau({ username: "2021010101", password: "pw" }).catch((e) => e);
  assert.ok(err instanceof SecondFactorRequiredError, "应抛出让对话层索要验证码的信号");
  assert.match(err.message, /submit_auth_code/);
  assert.match(err.message, /138\*\*\*\*1234/);
  // 必须是不可重试的 RaptorError：重试等于反复给用户手机发码
  assert.ok(isRaptorError(err, "AUTH_CHALLENGE"));
  assert.equal(err.retryable, false);
  const pending = findSecondFactor("hebau", "2021010101");
  assert.ok(pending);
  assert.equal(pending.reAuthType, "3");
  // 别的学号不能借这条会话续登录
  assert.equal(findSecondFactor("hebau", "2021090909"), null);
  assert.equal(typeof readSecondFactor(err.challengeId, "hebau", "2021010101"), "object");
  assert.equal(typeof readSecondFactor(err.challengeId, "njtech", "2021010101"), "string");
});

test("验证码正确即完成登录并清除会话；验证码错误保留会话可重试", async () => {
  const script: Script = { reauth: true, submitFail: true };
  installCas(script);
  clearAllSecondFactors();
  const err: SecondFactorRequiredError = await loginHebau({
    username: "2021010101",
    password: "pw",
  }).catch((e) => e);

  await assert.rejects(
    () => completeSecondFactor(err.challengeId, "000000", "2021010101"),
    /验证码不正确/,
  );
  assert.ok(findSecondFactor("hebau", "2021010101"), "码错时保留会话，用户可直接重发一次");

  script.submitFail = false;
  const session = await completeSecondFactor(err.challengeId, "483920", "2021010101");
  assert.match(session.cookie, /GS_SESSIONID=/);
  assert.equal(findSecondFactor("hebau", "2021010101"), null, "用完即删");
});

test("发送验证码失败：如实报错，不留半个待验证会话", async () => {
  installCas({ reauth: true, sendFail: true });
  clearAllSecondFactors();
  await assert.rejects(
    () => loginHebau({ username: "2021010101", password: "pw" }),
    /发送过于频繁/,
  );
  assert.equal(findSecondFactor("hebau", "2021010101"), null);
});

test("未登记的认证方式：说清不支持，不发码", async () => {
  installCas({ reauth: true, reAuthType: "99" });
  clearAllSecondFactors();
  const err = await loginHebau({ username: "2021010101", password: "pw" }).catch((e) => e);
  assert.ok(!(err instanceof SecondFactorRequiredError));
  assert.match((err as Error).message, /暂不支持/);
  assert.equal(calls.filter((c) => c.includes("getDynamicCodeByReauth")).length, 0);
});

test("认证成功但拿不到教务会话时报错，不带空 Cookie 去抓数据", async () => {
  installCas({ noSession: true });
  await assert.rejects(
    () => loginHebau({ username: "2021010101", password: "pw" }),
    /未拿到教务系统会话/,
  );
});

test("待验证会话超过 10 分钟即失效", async () => {
  installCas({ reauth: true });
  clearAllSecondFactors();
  const err: SecondFactorRequiredError = await loginHebau({
    username: "2021010101",
    password: "pw",
  }).catch((e) => e);
  const file = path.join(process.env.RAPTOR_DATA_DIR ?? "", "school-mfa.json");
  const store = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { createdAt: number }>;
  store[err.challengeId].createdAt -= 11 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify(store));
  assert.equal(findSecondFactor("hebau", "2021010101"), null);
  assert.equal(typeof readSecondFactor(err.challengeId, "hebau", "2021010101"), "string");
});

test("session.submitSecondFactor：不传 challengeId 时按本校+学号定位待验证会话", async () => {
  installCas({ reauth: true });
  clearAllSecondFactors();
  const originalUser = config.jwglUsername;
  const originalPass = config.jwglPassword;
  config.jwglUsername = "2021010101";
  config.jwglPassword = "pw";
  try {
    const err: SecondFactorRequiredError = await loginHebau({
      username: "2021010101",
      password: "pw",
    }).catch((e) => e);
    // 用户只回验证码原文：按账号定位 challenge 并续完登录
    await hebauSession.submitSecondFactor({ code: "483920" });
    assert.equal(findSecondFactor("hebau", "2021010101"), null, "用完即删");
    // 续登成功后会话缓存就位：getCookie 直接命中缓存，不再触发登录
    assert.match(await hebauSession.getCookie(), /GS_SESSIONID=/);
  } finally {
    config.jwglUsername = originalUser;
    config.jwglPassword = originalPass;
    setTransportForTest(null);
  }
});

// ── onboarding 首次引导的当场收码 ────────────────────────────

/** 最小可用的假学校适配器（带 submitSecondFactor），不碰任何真实适配器 */
function fakeSchoolWithMfa(
  id: string,
  login: () => Promise<void>,
  submitSecondFactor?: (input: { code: string; challengeId?: string }) => Promise<void>,
) {
  return {
    info: {
      id,
      name: `假学校${id}`,
      shortName: id.toUpperCase(),
      city: "",
      timezone: "Asia/Shanghai",
    },
    capabilities: [],
    terms: {
      label: () => "",
      candidates: () => [],
      parseSemesterString: () => null,
      weekOf: () => null,
      week1MondayOf: () => ({ week1Monday: "2026-08-31", source: "estimated" as const }),
      recordedTerms: () => ({}),
      expandWeeks: () => [],
      periodTimeRange: () => undefined,
      periodTime: () => undefined,
      periodTimes: () => ({}),
      weekdayName: (w: number) => `周${w}`,
    },
    auth: {
      login,
      getCookie: async () => "x=1",
      ...(submitSecondFactor ? { submitSecondFactor } : {}),
    },
    tools: {},
    promptSections: () => ({ tools: "", background: "" }),
  };
}

test("onboarding 首次引导遇到二次认证：当场收码续完登录并保存凭证", async () => {
  const challenge = new SecondFactorRequiredError("hebau-test-challenge", "138****1234");
  const submitted: Array<{ code: string; challengeId?: string }> = [];
  registerSchoolOption(
    fakeSchoolWithMfa(
      "fake-mfa",
      async () => {
        throw challenge;
      },
      async (input) => {
        submitted.push(input);
      },
    ),
  );
  selectSchool("fake-mfa");
  assert.equal(school().info.id, "fake-mfa");

  const lines: string[] = [];
  const io: CredentialSetupIO = {
    write: (m) => lines.push(m),
    ask: async (prompt) => (prompt.startsWith("请输入验证码") ? "483920" : "2021010101"),
    askSecret: async () => "pw",
    close: () => {},
  };
  const saved: Array<[string, string]> = [];
  const outcome = await ensureCredentials(io, {
    isConfigured: () => false,
    login: async () => {
      throw challenge;
    },
    save: (u, p) => saved.push([u, p]),
  });
  assert.equal(outcome, "configured");
  assert.deepEqual(submitted, [{ code: "483920", challengeId: "hebau-test-challenge" }]);
  assert.deepEqual(saved, [["2021010101", "pw"]]);
  assert.ok(lines.some((l) => l.includes("验证通过")));
  selectSchool("njtech");
});

test("onboarding 收码被跳过（回车）：走通用失败路径，不保存", async () => {
  const challenge = new SecondFactorRequiredError("hebau-skip-challenge", "138****1234");
  registerSchoolOption(
    fakeSchoolWithMfa(
      "fake-mfa2",
      async () => {
        throw challenge;
      },
      async () => {
        throw new Error("不该走到这里");
      },
    ),
  );
  selectSchool("fake-mfa2");

  let step = 0;
  const io: CredentialSetupIO = {
    write: () => {},
    // 第 1 轮给学号/密码，验证码提示回车跳过；第 2 轮学号密码都留空 → 跳过配置。
    // 注意 askSecret 必须跟着学号一起置空：引导循环对「只填了一边」没有次数上限
    // （交互上等人改主意），假 IO 永远只回密码会造出无限循环。
    ask: async (prompt) => {
      if (prompt.startsWith("学号")) {
        step++;
        return step === 1 ? "2021010101" : "";
      }
      if (prompt.startsWith("请输入验证码")) return "";
      if (prompt.includes("仍要保存")) return "n";
      return "";
    },
    askSecret: async () => (step === 1 ? "pw" : ""),
    close: () => {},
  };
  const saved: Array<[string, string]> = [];
  const outcome = await ensureCredentials(io, {
    isConfigured: () => false,
    login: async () => {
      throw challenge;
    },
    save: (u, p) => saved.push([u, p]),
  });
  assert.equal(outcome, "skipped");
  assert.equal(saved.length, 0);
  selectSchool("njtech");
});

test("saveStoredCredentials 按学校入槽：盖章 + 槽位留底，切校不丢", async () => {
  const { saveStoredCredentials, loadCredentialsStore } = await import("../src/core/credentials");
  const { selectSchool } = await import("../src/core/school");
  registerSchoolOption(
    fakeSchoolWithMfa("fake-stamp", async () => {
      throw new Error("不会被调用");
    }),
  );
  selectSchool("fake-stamp");
  saveStoredCredentials("2023010101", "pw");
  const store = loadCredentialsStore();
  assert.equal(store?.jwglSchoolId, "fake-stamp");
  assert.equal(store?.jwglAccounts?.["fake-stamp"]?.username, "2023010101");
  assert.equal(store?.username, "2023010101", "username 镜像当前学校账号");
  selectSchool("njtech");
});
