/**
 * NYTDC 教务系统 - 登录
 *
 * 正方新版标准流程（与 NJTECH 同源，差异只在 BASE）：
 *   1. GET  /xtgl/login_slogin.html        取 CSRF token
 *   2. GET  /xtgl/login_getPublicKey.html  取 RSA 公钥
 *   3. POST /xtgl/login_slogin.html        提交 csrftoken + 学号 + 加密密码
 *
 * 与 NJTECH 的两处实际差异（实机验证）：
 * - 部署在子路径 /jwglxt 下，且本机只有 HTTP（HTTPS 握手失败），BASE 必须带路径
 * - 登录成功返回 302 跳回登录页并携带 JSESSIONID；失败的判定条件与 NJTECH 一致
 */

import { RaptorError } from "../../core/errors";
import { createClient } from "../../core/http";
import { encryptJwglPassword } from "./crypto";

/** 教务系统根地址（含部署上下文路径 /jwglxt） */
export const BASE = "http://jwxt.nytdc.edu.cn/jwglxt";

export interface JwglSession {
  cookie: string;
  username: string;
}

/**
 * 登录教务系统，返回 session（含 cookie）
 *
 * 登录失败时正方仍返回 200，靠响应体里的文案判定；这里按错误类型抛
 * RaptorError，让上层决定重试还是引导用户改配置。
 */
export async function loginJwgl(username: string, password: string): Promise<JwglSession> {
  const client = createClient(BASE);

  // Step 1: 获取登录页面 -> 提取 CSRF token
  const pg = await client.req("/xtgl/login_slogin.html");
  const csrfMatch = pg.body.match(/id="csrftoken"[^>]*value="([^"]+)"/);
  const csrf = csrfMatch ? csrfMatch[1].split(",")[0] : "";
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

  const body = loginResp.body || "";

  // 选课季学校可能临时开启登录验证码：单列出来，别让同学以为密码错了
  if (body.includes("验证码错误")) {
    throw new RaptorError(
      "AUTH_INVALID",
      "教务开启了登录验证码，暂无法自动登录，请稍后再试或到教务网页直接操作",
    );
  }
  if (body.includes("用户名或密码不正确") || body.includes("密码错误")) {
    throw new RaptorError("AUTH_INVALID", "学号或密码不正确");
  }

  // 响应体里仍是登录表单说明没有真正登录成功
  if (body.includes("csrftoken") && body.length > 500) {
    throw new RaptorError("AUTH_INVALID", "登录失败，请检查学号和密码");
  }

  // 登录成功的标志：拿到 JSESSIONID
  const cookie = client.getCookie();
  if (!cookie?.includes("JSESSIONID")) {
    throw new RaptorError("UPSTREAM", "登录失败：未获取到有效会话");
  }

  return { cookie, username };
}
