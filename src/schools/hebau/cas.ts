/**
 * 河北农大 CAS 统一认证（cas.hebau.edu.cn/authserver）
 *
 * 登录链（每一步都是 ScholarFlow 在生产里踩出来的，顺序不能调）：
 *   1. GET  登录页 → 取 execution 与 pwdEncryptSalt
 *   2. POST 登录   → 密码按站点 encrypt.js 的口径做 AES-CBC（64 位随机前缀 + 明文）
 *   3. 可能命中 /reAuthCheck/ → 发动态码，存待验证会话，抛 SecondFactorRequiredError
 *   4. 拿 Cookie 回访 CAS → 302 链落到 URP，取出 GS_SESSIONID
 *
 * 为什么手写而不是 fetch：跨主机 302 链上要一路攒 Cookie（CAS 的 TGT 与 URP 的
 * GS_SESSIONID 不同主机），fetch 的自动重定向会把 Set-Cookie 吞在内部拿不到。
 */

import crypto from "node:crypto";
import {
  beginSecondFactor,
  clearSecondFactor,
  readSecondFactor,
  SecondFactorRequiredError,
} from "../mfa";
import type { SchoolLoginInput, SchoolSession } from "../types";
import { CAS_BASE, CookieJar, type RawResponse, requestWithJar, URP_HOME } from "./http";

/** 站点 encrypt.js 的随机串字符集（去掉了 0/O/1/l 等易混字符） */
const AES_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";

function randStr(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += AES_CHARS[Math.floor(Math.random() * AES_CHARS.length)];
  return s;
}

/**
 * 复刻官网 encrypt.js：明文 = 64 位随机前缀 + 原密码，key = salt 的 UTF-8 字节，
 * iv = 16 位随机字节的 UTF-8，输出只有密文 base64（iv 不随密文一起送）。
 *
 * 密钥长度决定 AES 位数（CryptoJS 按字节数自选 128/192/256）。长度不是这三种时
 * 直接失败——宁可报「登录参数异常」，也不能悄悄用错的 key 加密出去，
 * 那会被 CAS 判成密码错误，用户只会以为自己的密码不对。
 */
export function encryptPassword(password: string, salt: string): string {
  const plain = `${randStr(64)}${password}`;
  const key = Buffer.from(salt.trim(), "utf8");
  const iv = Buffer.from(randStr(16), "utf8");
  const algorithm: Record<number, string> = {
    16: "aes-128-cbc",
    24: "aes-192-cbc",
    32: "aes-256-cbc",
  };
  const cipherName = algorithm[key.length];
  if (!cipherName) {
    throw new Error(
      `河北农大登录加密参数异常（pwdEncryptSalt 长度 ${key.length} 字节），未提交登录`,
    );
  }
  const cipher = crypto.createCipheriv(cipherName, key, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}

/** reAuthType → 发码接口要的字段名。映射表外的一律视为不支持，不猜 */
const REAUTH_TYPE_TO_CODE_FIELD: Record<string, string> = {
  "3": "reAuthDynamicCodeType",
  "4": "reAuthWChatDynamicCodeType",
  "5": "reAuthCpdailyDynamicCodeType",
  "11": "reAuthEmailDynamicCodeType",
  "12": "reAuthDingTalkDynamicCodeType",
  "13": "reAuthWeLinkDynamicCodeType",
};

const REAUTH_TYPE_LABEL: Record<string, string> = {
  "3": "手机短信",
  "4": "微信",
  "5": "企业微信",
  "11": "邮箱",
  "12": "钉钉",
  "13": "WeLink",
};

function extractJsonString(html: string, key: string): string {
  return html.match(new RegExp(`"${key}":"([^"]*)"`, "i"))?.[1] ?? "";
}

/** 页面里的投递目标是「138****1234」这种带括号的脱敏串 */
function extractMaskedTarget(html: string): string {
  return html.match(/value="[^"]*\(([^)]+)\)"/)?.[1] ?? "";
}

function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/** 登录成功判据：URP 的 GS_SESSIONID。拿不到就如实报，不要带着空 Cookie 去请求数据接口 */
async function finalizeUrpSession(jar: CookieJar): Promise<string> {
  await requestWithJar(`${CAS_BASE}/authserver/login?service=${encodeURIComponent(URP_HOME)}`, jar);
  const session = jar.get("GS_SESSIONID") ?? "";
  if (!session)
    throw new Error("河北农大认证已通过，但未拿到教务系统会话（GS_SESSIONID），请稍后重试");
  return jar.header();
}

export async function loginHebau(input: SchoolLoginInput): Promise<SchoolSession> {
  const username = (input.username ?? "").trim();
  const password = input.password ?? "";
  if (!username || !password) throw new Error("请输入学号和密码");

  if (input.challengeId && input.dynamicCode) {
    return completeSecondFactor(input.challengeId, input.dynamicCode, username);
  }

  const jar = new CookieJar();
  const loginUrl = `${CAS_BASE}/authserver/login?service=${encodeURIComponent(URP_HOME)}`;
  const page = await requestWithJar(loginUrl, jar);
  const execution = page.body.match(/name="execution"\s+value="([^"]*)"/)?.[1] ?? "";
  const salt = page.body.match(/id="pwdEncryptSalt"\s+value="([^"]*)"/)?.[1] ?? "";
  if (!execution) throw new Error("无法获取河北农大统一认证登录参数（execution 缺失）");

  const body = new URLSearchParams({
    username,
    passwordText: password,
    password: salt ? encryptPassword(password, salt) : password,
    execution,
    _eventId: "submit",
    lt: "",
    cllt: "userNameLogin",
    dllt: "generalLogin",
    rememberMe: "true",
    service: URP_HOME,
  }).toString();

  // 这一步必须禁止自动重定向：Location 指向 reAuthCheck 还是 URP，决定了后面走哪条路
  const loginResp = await requestWithJar(loginUrl, jar, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    followRedirects: false,
  });

  // 认证失败时 CAS 原样回吐登录页（页面里必然有 pwdEncryptSalt）
  if (loginResp.body.includes("pwdEncryptSalt")) {
    throw new Error("学号或密码不正确");
  }

  const location = typeof loginResp.headers.location === "string" ? loginResp.headers.location : "";
  if (location.includes("/reAuthCheck/")) {
    throw await beginDynamicCodeChallenge(location, jar, username, loginResp);
  }

  // 认证成功：先把 CAS→URP 这一段跳转跟完（票据在这一跳落地），再取 GS_SESSIONID
  if (location) {
    await requestWithJar(new URL(location, CAS_BASE).toString(), jar);
  }

  const cookie = await finalizeUrpSession(jar);
  return { cookie, username };
}

/** 触发二次认证：发码 → 落盘待验证会话 → 抛出让对话层去要验证码 */
async function beginDynamicCodeChallenge(
  reAuthUrl: string,
  jar: CookieJar,
  username: string,
  loginResp: RawResponse,
): Promise<Error> {
  const target = new URL(reAuthUrl, CAS_BASE).toString();
  const check = await requestWithJar(target, jar);
  const html = check.body || loginResp.body;
  const reAuthType = extractJsonString(html, "reAuthType");
  const isMultifactor = extractJsonString(html, "isMultifactor") || "true";
  const maskedTarget = extractMaskedTarget(html);
  const authCodeTypeName = REAUTH_TYPE_TO_CODE_FIELD[reAuthType];
  if (!authCodeTypeName) {
    return new Error(
      `河北农大要求暂不支持的二次认证方式（reAuthType=${reAuthType || "未知"}），请到统一认证平台手动完成一次登录后再试`,
    );
  }

  const send = await requestWithJar(
    `${CAS_BASE}/authserver/dynamicCode/getDynamicCodeByReauth.do`,
    jar,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: target,
      },
      body: new URLSearchParams({ userName: username, authCodeTypeName }).toString(),
    },
  );
  const sent = parseJson<{ res?: string; returnMessage?: string }>(send.body);
  const ok = ["success", "wechat_success", "cpdaily_success"].includes(sent?.res ?? "");
  if (!ok) {
    return new Error(
      `河北农大验证码发送失败：${sent?.returnMessage || send.body.slice(0, 80) || "接口无响应"}`,
    );
  }

  const challengeId = beginSecondFactor({
    schoolId: "hebau",
    username,
    reAuthType,
    isMultifactor,
    maskedTarget: `${maskedTarget ? `${maskedTarget}（${REAUTH_TYPE_LABEL[reAuthType]}）` : REAUTH_TYPE_LABEL[reAuthType]}`,
    cookies: jar.entries(),
    serviceUrl: URP_HOME,
  });
  return new SecondFactorRequiredError(
    challengeId,
    maskedTarget
      ? `${maskedTarget}（${REAUTH_TYPE_LABEL[reAuthType]}）`
      : REAUTH_TYPE_LABEL[reAuthType],
  );
}

/** 用验证码续完登录 */
export async function completeSecondFactor(
  challengeId: string,
  dynamicCode: string,
  username: string,
): Promise<SchoolSession> {
  const pending = readSecondFactor(challengeId, "hebau", username);
  if (typeof pending === "string") throw new Error(pending);

  const jar = new CookieJar(pending.cookies);
  const submit = await requestWithJar(`${CAS_BASE}/authserver/reAuthCheck/reAuthSubmit.do`, jar, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${CAS_BASE}/authserver/reAuthCheck/reAuthLoginView.do?isMultifactor=true&service=${encodeURIComponent(pending.serviceUrl)}`,
    },
    body: new URLSearchParams({
      service: pending.serviceUrl,
      reAuthType: pending.reAuthType,
      isMultifactor: pending.isMultifactor,
      dynamicCode,
      skipTmpReAuth: "false",
    }).toString(),
  });
  const result = parseJson<{ code?: string; msg?: string }>(submit.body);
  if (result?.code !== "reAuth_success") {
    // 码错但会话还新：留着，用户重发一次对话就能再试，不必重新走一遍登录
    throw new Error(
      `验证码校验失败：${result?.msg || "未知原因"}。验证码会话仍在有效期内，可再试一次；连续错三次请重新查询以获取新验证码`,
    );
  }
  const cookie = await finalizeUrpSession(jar);
  clearSecondFactor(challengeId);
  return { cookie, username: pending.username };
}
