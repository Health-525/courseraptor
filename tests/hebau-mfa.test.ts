/**
 * 河北农大 CAS 登录与二次认证的离线用例（传输层注入假响应，不碰真实教务系统）
 *
 * 这里要钉住的都是「错了就伤到用户」的路径：
 * - 密码错误不能被当成「需要验证码」，更不能反复发码；
 * - 待验证会话必须按「学校+学号」隔离，别人拿不到我的登录态；
 * - 会话 10 分钟过期、用完即删；
 * - 换学校后旧凭证不予采用（凭证串校是安全事故，不是小瑕疵）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";

import { completeSecondFactor, loginHebau } from "../src/schools/hebau/cas";
import {
  type RawResponse,
  type RequestOptions,
  setTransportForTest,
} from "../src/schools/hebau/http";
import {
  clearAllSecondFactors,
  findSecondFactor,
  readSecondFactor,
  SecondFactorRequiredError,
} from "../src/schools/mfa";

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
  setTransportForTest(async (url, opts: RequestOptions): Promise<RawResponse> => {
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

before(() => {
  process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-mfa-"));
});

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

test("触发二次认证：抛出可用信息，会话按学校+学号可查回", async () => {
  installCas({ reauth: true });
  clearAllSecondFactors();
  const err = await loginHebau({ username: "2021010101", password: "pw" }).catch((e) => e);
  assert.ok(err instanceof SecondFactorRequiredError, "应抛出让对话层索要验证码的信号");
  assert.match(err.message, /submit_auth_code/);
  assert.match(err.message, /138\*\*\*\*1234/);
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
