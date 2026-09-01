/**
 * NJTECH 教务系统 - 登录
 * 移植自 ScholarFlow lib/schools/njtech/jwgl.ts（登录部分）
 */

import { encryptJwglPassword } from "./crypto";
import { createClient } from "./http";

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
  if (!csrf) throw new Error("无法提取 CSRF token");

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
    throw new Error("学号或密码不正确");
  }

  // 如果响应体仍然包含登录表单的 CSRF token，说明没有成功跳转
  if (body.includes("csrftoken") && body.length > 500) {
    throw new Error("登录失败，请检查学号和密码");
  }

  // 检查 cookie 是否包含 JSESSIONID - 登录成功的标志
  const cookie = client.getCookie();
  if (!cookie?.includes("JSESSIONID")) {
    throw new Error("登录失败：未获取到有效会话");
  }

  return {
    cookie,
    username,
  };
}
