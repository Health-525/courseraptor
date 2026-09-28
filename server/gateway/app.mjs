/**
 * 多用户网关主服务：登录注册（邀请码）+ 会话 Cookie + 按用户反向代理。
 *
 * 浏览器只与本服务对话；登录后所有请求按 Cookie 找到用户专属实例
 * （spawner 按需拉起，独立回环端口），转发时改写 Host、剥掉 Origin——
 * 后端 chat-web 现有的「Host / Origin / CSRF」三道本机防线原样通过，
 * 跨站防护由本网关的会话边界（HttpOnly + SameSite=Lax）承担。
 *
 * 可注入 registry / spawner 以便测试（同 server/app.mjs 的 createUpdateServer 风格）。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createAdminUi } from "./admin-ui.mjs";
import { ownDeepseekKeyActive } from "./credentials-peek.mjs";

const COOKIE_NAME = "raptor_sess";
const SESSION_TTL_MS = 7 * 24 * 3600_000;
const MAX_FORM_BODY = 16 * 1024;
const FAILURES_TO_LOCK = 5;
const LOCK_DURATION_MS = 15 * 60_000;
const FAILURE_IDLE_MS = 30 * 60_000;

/** 登录/注册失败按 IP 计数：连续 5 次锁 15 分钟（同 update-server 的防爆破策略） */
function createLoginThrottle() {
  const failures = new Map();
  return {
    check(ip, now = Date.now()) {
      const record = failures.get(ip);
      if (record?.lockedUntil && record.lockedUntil > now) {
        return Math.ceil((record.lockedUntil - now) / 1000);
      }
      return 0;
    },
    fail(ip, now = Date.now()) {
      if (failures.size > 500) {
        for (const [k, v] of failures) {
          if (now - v.lastAt > FAILURE_IDLE_MS) failures.delete(k);
        }
      }
      const record = failures.get(ip);
      const count = (record?.count ?? 0) + 1;
      const lockedUntil = count >= FAILURES_TO_LOCK ? now + LOCK_DURATION_MS : 0;
      failures.set(ip, { count, lockedUntil, lastAt: now });
      return lockedUntil ? Math.ceil(LOCK_DURATION_MS / 1000) : 0;
    },
    reset(ip) {
      failures.delete(ip);
    },
  };
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  const out = {};
  if (typeof raw === "string") {
    for (const part of raw.split(";")) {
      const index = part.indexOf("=");
      if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
  }
  return out;
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const out = {};
      for (const [key, value] of params) out[key] = value;
      resolve(out);
    });
    req.on("error", reject);
  });
}

function readJsonBody(req, limit = MAX_FORM_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function createGatewayServer({
  registry,
  spawner,
  secret,
  dailyTurns = 100,
  projectRoot = "",
  adminPassword = "",
  maxConcurrent = 0,
  updateServerUrl = "",
  updateAdminToken = "",
  usersDir = "",
} = {}) {
  if (!registry) throw new Error("createGatewayServer 需要 registry");
  if (!spawner) throw new Error("createGatewayServer 需要 spawner");
  if (!secret || secret.length < 16) throw new Error("GATEWAY_SECRET 至少 16 位");

  const throttle = createLoginThrottle();

  // 网页版管理后台（GATEWAY_ADMIN_PASSWORD 未设置时显示「未启用」）
  const adminUi = createAdminUi({
    registry,
    spawner,
    secret,
    password: adminPassword,
    capacity: maxConcurrent,
    defaultDailyTurns: dailyTurns,
    updateServerUrl,
    updateAdminToken,
  });

  function signSession(userId, expiresAt) {
    const mac = createHmac("sha256", secret).update(`${userId}.${expiresAt}`).digest("hex");
    return `${userId}.${expiresAt}.${mac}`;
  }

  function sessionFrom(req) {
    const value = parseCookies(req)[COOKIE_NAME];
    if (!value) return null;
    const [userId, expiresAt, mac] = value.split(".");
    if (!userId || !expiresAt || !mac) return null;
    const expected = createHmac("sha256", secret)
      .update(`${userId}.${expiresAt}`)
      .digest("hex");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (Number(expiresAt) < Date.now()) return null;
    return { userId, expiresAt: Number(expiresAt) };
  }

  function sessionCookie(userId, expiresAt) {
    const flags = [
      `${COOKIE_NAME}=${signSession(userId, expiresAt)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
    ];
    return flags.join("; ");
  }

  function clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  // ── 页面（红头档案风：与正式网页版同一套设计令牌，见 chat-page.ts）──

  const layout = (title, body, error = "") => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/logo.png">
<title>${escapeHtml(title)} · CourseRaptor</title><style>
:root{color-scheme:light;
--paper:#F6F4ED;--paper-deep:#F0EDE4;--card:#FCFBF7;--shade:#ECE8DD;
--ink:#25221C;--ink-2:#5A554A;--ink-3:#6E6656;
--rule:#E1DCCF;--rule-2:#C9C1AF;
--accent:#AD392C;--accent-deep:#852B22;--accent-soft:#F3E3DE;--accent-line:#E4C4BB;
--shadow-sm:0 8px 24px rgba(50,42,31,.055);
--serif:Georgia,"Times New Roman","Songti SC",SimSun,serif;
--kai:"KaiTi","STKaiti","Kaiti SC",var(--serif);
--sans:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
--mono:ui-monospace,"Cascadia Mono",Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}
::selection{background:var(--accent-soft)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;
padding:34px 18px;background:var(--paper);color:var(--ink);
font-family:var(--sans);font-size:16px;line-height:1.7;
-webkit-font-smoothing:antialiased}
.sheet{width:min(400px,100%)}
/* 报头：印章 logo + 双色字标 + 楷体标语；底下压一条朱砂细线 + 灰线（文件头） */
.mast{text-align:center;padding-bottom:20px;position:relative;
border-bottom:1px solid var(--rule-2)}
.mast::after{content:"";position:absolute;left:12%;right:12%;bottom:3px;height:2px;background:var(--accent)}
.mast img{width:76px;height:76px;object-fit:contain;display:block;margin:0 auto 10px}
.wordmark{margin:0;font-size:24px;line-height:1.2;letter-spacing:-.035em;font-weight:500}
.wordmark .course{color:var(--ink-2)}
.wordmark .raptor{color:var(--accent);font-weight:750}
.tagline{margin:6px 0 0;font-family:var(--kai);font-size:14.5px;color:var(--ink-3);letter-spacing:.06em}
/* 纸卡 */
.card{margin-top:26px;background:var(--card);border:1px solid var(--rule);
border-radius:3px;box-shadow:var(--shadow-sm);padding:24px 26px 22px}
.card h2{display:flex;justify-content:space-between;align-items:baseline;
margin:0 0 18px;padding-bottom:9px;font-family:var(--mono);font-size:12.5px;
font-weight:600;letter-spacing:.18em;color:var(--ink-2);border-bottom:1px solid var(--rule)}
.card h2 .en{font-weight:400;font-size:11px;letter-spacing:.08em;color:var(--ink-3)}
label{display:block;margin:14px 0 6px;font-family:var(--mono);font-size:11px;
font-weight:600;letter-spacing:.12em;color:var(--ink-3)}
input{width:100%;padding:10px 12px;background:var(--card);
border:1px solid var(--rule-2);border-radius:2px;font-family:var(--sans);
font-size:15px;color:var(--ink);transition:border-color .15s ease,box-shadow .15s ease}
input:hover{border-color:var(--ink-3)}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input:-webkit-autofill{-webkit-box-shadow:0 0 0 40px var(--card) inset;-webkit-text-fill-color:var(--ink)}
.pw{position:relative}
.pw input{padding-right:64px}
.pw .peek{position:absolute;right:1px;top:1px;bottom:1px;border:0;
background:var(--paper-deep);border-left:1px solid var(--rule-2);
border-radius:0 2px 2px 0;padding:0 13px;font-family:var(--mono);font-size:11px;
letter-spacing:.08em;color:var(--ink-2);cursor:pointer;
transition:background .15s ease,color .15s ease}
.pw .peek:hover{color:var(--accent-deep);background:var(--accent-soft);
border-left-color:var(--accent-line)}
button.primary{display:block;width:100%;margin-top:22px;padding:12px;
background:var(--accent);color:var(--card);border:1px solid var(--accent);
border-radius:2px;font-family:var(--sans);font-size:15px;font-weight:600;
letter-spacing:.14em;cursor:pointer;transition:background .15s ease}
button.primary:hover{background:var(--accent-deep);border-color:var(--accent-deep);color:#fff}
button.primary:active{transform:translateY(1px)}
button.primary:disabled{opacity:.65;cursor:default}
/* 红头提示条 */
.notice{margin:0 0 4px;padding:9px 12px;background:var(--accent-soft);
border:1px solid var(--accent-line);border-radius:2px;color:var(--accent-deep);font-size:13.5px;line-height:1.6}
.alt{margin-top:16px;text-align:center;font-size:13.5px;color:var(--ink-3)}
.alt a{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent-line);
padding-bottom:1px}
.alt a:hover{border-bottom-color:var(--accent)}
p.lead{margin:4px 0 6px;font-size:15px;color:var(--ink-2)}
.ghost{display:inline-block;margin-top:16px;padding:9px 22px;background:none;
border:1px solid var(--rule-2);border-radius:2px;color:var(--ink-2);
font-size:13.5px;letter-spacing:.1em;text-decoration:none;cursor:pointer;
font-family:var(--sans)}
.ghost:hover{border-color:var(--accent);color:var(--accent)}
/* 版权栏：两行小字告知（风险词朱砂强调） */
.colophon{margin-top:22px;padding-top:12px;border-top:1px solid var(--rule-2);
font-family:var(--mono);font-size:11.5px;line-height:1.9;color:var(--ink-2);text-align:center}
.colophon b{color:var(--accent-deep);font-weight:600}
@media (max-width:420px){.mast img{width:64px;height:64px}.card{padding:20px 18px 18px}}
</style></head><body>
<main class="sheet">
<header class="mast">
<img src="/logo.png" alt="CourseRaptor 印章">
<h1 class="wordmark"><span class="course">Course</span><span class="raptor">Raptor</span></h1>
<p class="tagline">课表 · 成绩 · 考试 · 通知，一句话搞定</p>
</header>
<section class="card">
${body}
</section>
<footer class="colophon">班级互助自建服务 · 当前为 <b>HTTP 明文</b>，请勿在<b>公共 WiFi</b> 使用<br>
托管凭证由服务器加密保存（站长技术上可解密），知情使用</footer>
</main>
<script>
(function () {
"use strict";
var forms = document.querySelectorAll("form");
for (var i = 0; i < forms.length; i++) {
forms[i].addEventListener("submit", function (e) {
var btn = e.currentTarget.querySelector("button.primary");
if (btn && !btn.disabled) { btn.disabled = true; btn.textContent = "正在验证 ···"; }
});
}
var peeks = document.querySelectorAll(".peek");
for (var j = 0; j < peeks.length; j++) {
peeks[j].addEventListener("click", function () {
var input = this.parentNode.querySelector("input");
if (input.type === "password") { input.type = "text"; this.textContent = "隐藏"; }
else { input.type = "password"; this.textContent = "显示"; }
});
}
})();
</script>
</body></html>`;

  const errorNotice = (error) => (error ? `<div class="notice">${escapeHtml(error)}</div>` : "");

  const loginPage = (error = "") =>
    layout(
      "登录",
      `${errorNotice(error)}<form method="post" action="/login">
<h2>登 录<span class="en">SIGN IN</span></h2>
<label>用户名 USERNAME</label><input name="username" autocomplete="username" required autofocus placeholder="学号或用户名">
<label>密码 PASSWORD</label>
<div class="pw"><input name="password" type="password" autocomplete="current-password" required placeholder="登录密码">
<button type="button" class="peek">显示</button></div>
<button type="submit" class="primary">登 录</button>
</form>
<div class="alt">还没有账号？<a href="/register">凭邀请码注册</a></div>`,
      "",
    );

  const registerPage = (error = "") =>
    layout(
      "注册",
      `${errorNotice(error)}<form method="post" action="/register">
<h2>注 册<span class="en">SIGN UP</span></h2>
<label>邀请码 INVITE CODE</label><input name="invite" required autocomplete="off" autofocus placeholder="向管理员索取">
<label>用户名 USERNAME（字母 / 数字 / _ / -，2-32 位）</label><input name="username" autocomplete="username" required placeholder="注册后用于登录">
<label>密码 PASSWORD（至少 8 位）</label>
<div class="pw"><input name="password" type="password" autocomplete="new-password" required placeholder="至少 8 位">
<button type="button" class="peek">显示</button></div>
<label>确认密码 CONFIRM</label>
<div class="pw"><input name="password2" type="password" autocomplete="new-password" required placeholder="再输入一次">
<button type="button" class="peek">显示</button></div>
<button type="submit" class="primary">注册并进入</button>
</form>
<div class="alt">已有账号？<a href="/login">去登录</a></div>`,
      "",
    );

  const messagePage = (title, text) =>
    layout(
      title,
      `<h2>${escapeHtml(title)}<span class="en">NOTICE</span></h2>
<p class="lead">${escapeHtml(text)}</p>
<a class="ghost" href="/login">返回登录</a>`,
    );

  const busyPage = () =>
    layout(
      "稍后再试",
      `<h2>稍后再试<span class="en">BUSY</span></h2>
<p class="lead">现在在线的同学比较多，服务器暂时满载了 🦖</p>
<p class="lead">请过几分钟回来刷新重试；着急用的同学可以先用本地版（GitHub Releases 下载安装包）。</p>
<a class="ghost" href="/">刷新重试</a>`,
    );

  function sendHtml(res, status, html, extraHeaders = {}) {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    });
    res.end(html);
  }

  function sendJson(res, status, data) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  }

  // ── 反向代理 ─────────────────────────────────────────────

  // 已登录会话的续期簿记（userId → { expiresAt }），签发时写入
  const sessions = new Map();

  function proxyTo(req, res, userId, port) {
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    // 后端 Origin 门只对本机放行：经网关转发时由网关会话承担跨站防护
    delete headers.origin;
    const upstream = http.request(
      { host: "127.0.0.1", port, method: req.method, path: req.url, headers },
      (ur) => {
        const outHeaders = { ...ur.headers };
        // 会话滑动续期：剩不到 1 天时趁响应顺手续 7 天
        const session = sessions.get(userId);
        if (session && session.expiresAt - Date.now() < 24 * 3600_000) {
          session.expiresAt = Date.now() + SESSION_TTL_MS;
          outHeaders["set-cookie"] = sessionCookie(userId, session.expiresAt);
        }
        if (outHeaders["transfer-encoding"]) delete outHeaders["transfer-encoding"];
        if (outHeaders["content-length"]) delete outHeaders["content-length"];
        res.writeHead(ur.statusCode ?? 502, outHeaders);
        ur.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      console.error(`[gw] 上游错误 user=${userId}: ${error.message}`);
      if (res.headersSent) {
        res.destroy();
      } else if (req.url.startsWith("/api/")) {
        sendJson(res, 502, { error: "服务实例暂时不可用，请刷新重试" });
      } else {
        sendHtml(res, 502, messagePage("实例开小差了", "服务实例暂时不可用，请刷新重试。"));
      }
    });
    req.pipe(upstream);
    // 客户端半途断开时中止上游（注意不能用 req 的 close：请求体收完它就触发，
    // 会把正常请求的上游连接掐掉；res.close 且响应未写完才是真断开）
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
  }

  function issueSession(userId) {
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(userId, { expiresAt });
    return sessionCookie(userId, expiresAt);
  }

  // ── 主处理器 ─────────────────────────────────────────────

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const ip = req.socket.remoteAddress || "unknown";

    const finish = (status) => {
      if (pathname !== "/health") {
        console.log(`[gw] ${req.method} ${pathname} ${ip} ${status} ${Date.now() - startedAt}ms`);
      }
    };

    try {
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true, running: spawner.runningCount() });
        return;
      }

      // ── 管理后台（/admin 页面与 /admin/api/*，独立管理会话）──
      if (pathname === "/admin" || pathname.startsWith("/admin/")) {
        await adminUi.handle(req, res, pathname);
        return;
      }

      // 报头印章（登录/注册页用；登录后的同名路径由后端实例提供）
      if (req.method === "GET" && pathname === "/logo.png") {
        if (!projectRoot) {
          res.writeHead(404);
          res.end();
          return;
        }
        try {
          const logo = await readFile(path.join(projectRoot, "docs", "courseraptor-logo.png"));
          res.writeHead(200, {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
            "content-length": logo.length,
          });
          res.end(logo);
        } catch {
          res.writeHead(404);
          res.end();
        }
        return;
      }

      if (req.method === "GET" && pathname === "/login") {
        sendHtml(res, 200, loginPage());
        return;
      }

      if (req.method === "GET" && pathname === "/") {
        // 有会话则落到下方代理区打开对话页；没有则去登录
        if (!sessionFrom(req)) {
          res.writeHead(303, { location: "/login", "cache-control": "no-store" });
          res.end();
          finish(303);
          return;
        }
      } else if (req.method === "GET" && pathname === "/register") {
        sendHtml(res, 200, registerPage());
        return;
      }

      if (req.method === "POST" && pathname === "/login") {
        const lockSec = throttle.check(ip);
        if (lockSec) {
          sendHtml(res, 429, loginPage(`尝试次数过多，请 ${lockSec} 秒后再试`));
          finish(429);
          return;
        }
        const form = await readForm(req);
        const result = await registry.authenticate(form.username, form.password);
        if (!result || result.disabled) {
          const lockSec = throttle.fail(ip);
          const reason = result?.disabled ? "该账号已被停用" : "用户名或密码不正确";
          sendHtml(
            res,
            401,
            loginPage(lockSec ? `${reason}。连续失败过多，已锁定 ${lockSec} 秒` : reason),
          );
          finish(401);
          return;
        }
        throttle.reset(ip);
        sendHtml(res, 303, "", {
          location: "/",
          "set-cookie": issueSession(result.user.id),
        });
        finish(303);
        return;
      }

      if (req.method === "POST" && pathname === "/register") {
        const lockSec = throttle.check(ip);
        if (lockSec) {
          sendHtml(res, 429, registerPage(`尝试次数过多，请 ${lockSec} 秒后再试`));
          finish(429);
          return;
        }
        const form = await readForm(req);
        const problems = [];
        if (!form.invite) problems.push("请填写邀请码");
        if (form.password && form.password2 && form.password !== form.password2) {
          problems.push("两次输入的密码不一致");
        }
        if (problems.length === 0 && !(await registry.consumeInvite(form.invite))) {
          problems.push("邀请码无效或已被使用");
        }
        let user = null;
        if (problems.length === 0) {
          try {
            user = await registry.createUser({ username: form.username, password: form.password });
          } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (problems.length > 0 || !user) {
          throttle.fail(ip);
          sendHtml(res, 400, registerPage(problems.join("；")));
          finish(400);
          return;
        }
        await registry.markInviteUsed(form.invite, user.username);
        throttle.reset(ip);
        console.log(`[gw] 新用户注册 ${user.username} (${user.id})`);
        sendHtml(res, 303, "", { location: "/", "set-cookie": issueSession(user.id) });
        finish(303);
        return;
      }

      if (req.method === "POST" && pathname === "/logout") {
        const session = sessionFrom(req);
        if (session) sessions.delete(session.userId);
        sendHtml(res, 303, "", { location: "/login", "set-cookie": clearCookie() });
        finish(303);
        return;
      }

      // 网关内部管理端点（密钥可达）：踢下线指定用户的实例，下次请求重新拉起
      if (req.method === "POST" && pathname === "/internal/kick") {
        const provided = req.headers["x-gateway-secret"];
        const expected = Buffer.from(String(secret));
        const actual = Buffer.from(String(provided ?? ""));
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          sendJson(res, 401, { error: "密钥无效" });
          finish(401);
          return;
        }
        const body = await readJsonBody(req);
        const target = String(body.user ?? "");
        const byId = await registry.findUserById(target);
        const byName = byId ?? (await registry.findUserByName(target));
        if (!byName) {
          sendJson(res, 404, { error: "用户不存在" });
          finish(404);
          return;
        }
        spawner.kick(byName.id);
        sendJson(res, 200, { ok: true, kicked: byName.username });
        finish(200);
        return;
      }

      // ── 会话保护区：其余全部代理到用户专属实例 ──
      const session = sessionFrom(req);
      const respond401 = () => {
        if (pathname.startsWith("/api/")) {
          sendJson(res, 401, { error: "登录已过期，请刷新页面重新登录" });
          finish(401);
        } else {
          res.writeHead(303, { location: "/login", "cache-control": "no-store" });
          res.end();
          finish(303);
        }
      };
      if (!session) {
        respond401();
        return;
      }
      const user = await registry.findUserById(session.userId);
      if (!user || user.disabled) {
        sessions.delete(session.userId);
        respond401();
        return;
      }

      // 同学端额度查询：设置弹窗「账号与模型」里展示剩余免费对话次数
      if (req.method === "GET" && pathname === "/api/quota") {
        const limit = user.dailyTurns > 0 ? user.dailyTurns : dailyTurns;
        const used = await registry.turnsToday(user.id);
        const ownKeyActive = usersDir
          ? await ownDeepseekKeyActive(usersDir, user.id)
          : false;
        sendJson(res, 200, {
          used,
          limit,
          remaining: Math.max(0, limit - used),
          ownKeyActive,
          source: user.dailyTurns > 0 ? "personal" : "site",
        });
        finish(200);
        return;
      }

      // 统一 Key 的费用护栏：每日对话轮数（按人限额优先，未设用站点默认）；
      // 已保存自己 DeepSeek Key 的同学不占站点免费额度，仅计数用于展示
      if (req.method === "POST" && pathname === "/api/chat") {
        const ownKeyActive = usersDir
          ? await ownDeepseekKeyActive(usersDir, user.id)
          : false;
        if (!ownKeyActive) {
          const limit = user.dailyTurns > 0 ? user.dailyTurns : dailyTurns;
          const used = await registry.turnsToday(user.id);
          if (used >= limit) {
            sendJson(res, 429, {
              error: `今日 ${limit} 轮免费对话已用完，明天再来；或到「设置 → 账号与模型」填自己的 DeepSeek Key（不占站点额度）`,
            });
            finish(429);
            return;
          }
        }
        await registry.addTurns(user.id, 1);
      }

      spawner.noteActivity(user.id);
      let port;
      try {
        port = await spawner.acquire(user.id);
      } catch (error) {
        if (error.code === "ECONCURRENCY") {
          if (pathname.startsWith("/api/")) {
            sendJson(res, 503, { error: error.message });
          } else {
            sendHtml(res, 503, busyPage());
          }
          finish(503);
          return;
        }
        throw error;
      }
      proxyTo(req, res, user.id, port);
      res.on("close", () => finish(res.statusCode ?? 0));
    } catch (error) {
      console.error("[gw] 处理出错:", error);
      if (!res.headersSent) {
        sendHtml(res, 500, messagePage("服务器开小差了", "网关内部错误，请稍后重试。"));
      } else {
        res.destroy();
      }
      finish(500);
    }
  });

  return server;
}
