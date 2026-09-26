/**
 * NJTECH 教务系统 - 登录
 * 移植自 ScholarFlow lib/schools/njtech/jwgl.ts（登录部分）
 */

import { RaptorError } from "../../core/errors";
import { createClient } from "../../core/http";
import { encryptJwglPassword } from "./crypto";

export const BASE = "https://jwgl.njtech.edu.cn";

export interface JwglSession {
  cookie: string;
  username: string;
}

/**
 * 登录教务系统，返回 session（含 cookie）
 */
export async function loginJwgl(username: string, password: string): Promise<JwglSession> {
  const client = createClient(BASE);

  // Step 1: 获取登录页面 -> 提取 CSRF token
  const pg = await client.req("/xtgl/login_slogin.html");
  const csrfMatch = pg.body.match(/id="csrftoken"[^>]*value="([^"]+)"/);
  const csrf = csrfMatch ? csrfMatch[1].split(",")[0] : "";
  // 线路抖动也可能短暂返回残缺页（此时重试有效），结构真变了重试无意义——
  // 归 PARSE 但保留可重试，与旧子串分类时代的行为一致
  if (!csrf) throw new RaptorError("PARSE", "无法提取 CSRF token", { retryable: true });

  // Step 2: 获取 RSA 公钥
  const keyResp = await client.req(`/xtgl/login_getPublicKey.html?time=${Date.now()}`);
  const keyData = JSON.parse(keyResp.body);
  const { modulus, exponent } = keyData;

  // Step 3: RSA 加密密码
  const ep = encryptJwglPassword(password, modulus, exponent);

  // Step 4: 登录
  const loginResp = await client.req("/xtgl/login_slogin.html", {
    method: "POST",
    body: `csrftoken=${encodeURIComponent(csrf)}&yhm=${username}&mm=${encodeURIComponent(ep)}&language=zh_CN`,
  });

  // 正方教务系统登录失败时仍返回 200，但响应体包含错误信息
  const body = loginResp.body || "";

  if (
    body.includes("用户名或密码不正确") ||
    body.includes("密码错误") ||
    body.includes("验证码错误")
  ) {
    throw new RaptorError("AUTH_INVALID", "学号或密码不正确");
  }

  // 如果响应体仍然包含登录表单的 CSRF token，说明没有成功跳转
  if (body.includes("csrftoken") && body.length > 500) {
    throw new RaptorError("AUTH_INVALID", "登录失败，请检查学号和密码");
  }

  // 检查 cookie 是否包含 JSESSIONID - 登录成功的标志
  const cookie = client.getCookie();
  if (!cookie?.includes("JSESSIONID")) {
    throw new RaptorError("UPSTREAM", "登录失败：未获取到有效会话");
  }

  return {
    cookie,
    username,
  };
}
