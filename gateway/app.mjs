/**
 * 多用户网关主服务：登录注册（邀请码）+ 会话 Cookie + 按用户反向代理。
 *
 * 浏览器只与本服务对话；登录后所有请求按 Cookie 找到用户专属实例
 * （spawner 按需拉起，独立回环端口），转发时改写 Host、剥掉 Origin——
 * 后端 chat-web 现有的「Host / Origin / CSRF」三道本机防线原样通过，
 * 跨站防护由本网关的会话边界（HttpOnly + SameSite=Lax）承担。
 *
 * 可注入 registry / spawner 以便测试（同 update/app.mjs 的 createUpdateServer 风格）。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { ownDeepseekKeyActive } from "./admin/credentials-peek.mjs";
import { createAdminUi } from "./admin/ui.mjs";

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

/** 本地版使用上报按 IP 滑窗限流：60 次/分钟（正常客户端 24h 才报一次） */
function createPingThrottle({ limit = 60, windowMs = 60_000 } = {}) {
  const hits = new Map();
  return {
    check(ip, now = Date.now()) {
      const stamps = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
      hits.set(ip, stamps);
      if (hits.size > 5000) hits.clear(); // 兜底防内存被伪造 IP 撑爆
      return stamps.length >= limit ? Math.ceil((windowMs - (now - stamps[0])) / 1000) : 0;
    },
    note(ip, now = Date.now()) {
      const stamps = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
      stamps.push(now);
      hits.set(ip, stamps);
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
  appVersion = "",
  envDeepseekKeySet = false,
  localUsage = null,
} = {}) {
  if (!registry) throw new Error("createGatewayServer 需要 registry");
  if (!spawner) throw new Error("createGatewayServer 需要 spawner");
  if (!secret || secret.length < 16) throw new Error("GATEWAY_SECRET 至少 16 位");

  const throttle = createLoginThrottle();
  const pingThrottle = createPingThrottle();

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
    version: appVersion,
    envDeepseekKeySet,
    usersDir,
    localUsage,
  });

  function signSession(userId, expiresAt) {
    const mac = createHmac("sha256", secret).update(`${userId}.${expiresAt}`).digest("hex");
    return `${userId}.${expiresAt}.${mac}`;
  }

  // 报头印章只读一次进内存（失败缓存住 rejection：文件缺失是持久态，
  // 不会因为反复重试而自愈，404 语义不变）
  let logoPromise = null;
  const logoBuffer = () =>
    (logoPromise ??= readFile(path.join(projectRoot, "docs", "courseraptor-logo.png")));

  function sessionFrom(req) {
    const value = parseCookies(req)[COOKIE_NAME];
    if (!value) return null;
    const [userId, expiresAt, mac] = value.split(".");
    if (!userId || !expiresAt || !mac) return null;
    const expected = createHmac("sha256", secret).update(`${userId}.${expiresAt}`).digest("hex");
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

  const layout = (title, body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#F6F4ED">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="CourseRaptor">
<link rel="icon" href="/logo.png">
<link rel="apple-touch-icon" href="/logo.png">
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
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
::selection{background:var(--accent-soft)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* 触屏：按钮双击不缩放、长按不弹选中（与对话页同一套手感规则） */
button,.peek{touch-action:manipulation;-webkit-user-select:none;user-select:none}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;
/* safe center：小屏（SE）或键盘弹出时内容比视口高，普通 center 会把
   顶部裁进不可滚出的负溢出区；不认 safe 的浏览器整行回落到上一条 */
place-items:safe center;
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
/* 触屏：输入框提到 16px，防 iOS Safari 聚焦时整页放大（基础值 15px 会触发） */
@media (hover:none){input{font-size:16px}}
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
<label>用户名 USERNAME</label><input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus placeholder="学号或用户名">
<label>密码 PASSWORD</label>
<div class="pw"><input name="password" type="password" autocomplete="current-password" required placeholder="登录密码">
<button type="button" class="peek">显示</button></div>
<button type="submit" class="primary">登 录</button>
</form>
<div class="alt">还没有账号？<a href="/register">凭邀请码注册</a> · <a href="/forgot">忘记密码</a></div>`,
      "",
    );

  const forgotPage = (error = "", notice = "") =>
    layout(
      "找回密码",
      `${notice ? `<div class="notice" style="background:var(--accent-soft)">${escapeHtml(notice)}</div>` : ""}${errorNotice(error)}
<h2>申请重置<span class="en">REQUEST</span></h2>
<form method="post" action="/forgot">
<label>用户名 USERNAME</label><input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required placeholder="你的登录用户名">
<button type="submit" class="primary">提交申请</button>
</form>
<p class="lead" style="margin:10px 2px 0">提交后请到班级群联系管理员；管理员同意后会给你一个一次性重置码。</p>
<h2>用重置码设新密码<span class="en">RESET</span></h2>
<form method="post" action="/reset-password">
<label>用户名 USERNAME</label><input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
<label>重置码 CODE</label><input name="code" required autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="管理员发给你的一串码">
<label>新密码 PASSWORD（至少 8 位）</label>
<div class="pw"><input name="next" type="password" autocomplete="new-password" required placeholder="自己设一个，别告诉任何人">
<button type="button" class="peek">显示</button></div>
<label>确认新密码 CONFIRM</label>
<div class="pw"><input name="next2" type="password" autocomplete="new-password" required>
<button type="button" class="peek">显示</button></div>
<button type="submit" class="primary">重置密码</button>
</form>
<div class="alt"><a href="/login">返回登录</a></div>`,
      "",
    );

  const registerPage = (error = "") =>
    layout(
      "注册",
      `${errorNotice(error)}<form method="post" action="/register">
<h2>注 册<span class="en">SIGN UP</span></h2>
<label>邀请码 INVITE CODE</label><input name="invite" required autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" autofocus placeholder="向管理员索取">
<label>用户名 USERNAME（字母 / 数字 / _ / -，2-32 位）</label><input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required placeholder="注册后用于登录">
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

      // ── 本地版匿名使用上报（公开端点：安装包里的客户端没有账号概念）──
      // 限流刻意放宽（60 次/分/IP）：校园网大量同学共享同一出口 IP，正常
      // 上报远到不了这个量；真正要防的是脚本刷量撑爆 local-usage.json。
      if (req.method === "POST" && pathname === "/api/local-usage") {
        if (!localUsage) {
          sendJson(res, 501, { error: "not enabled" });
          finish(501);
          return;
        }
        const lockSec = pingThrottle.check(ip);
        if (lockSec) {
          sendJson(res, 429, { error: "too many requests", retryAfterSec: lockSec });
          finish(429);
          return;
        }
        pingThrottle.note(ip);
        const body = await readJsonBody(req, 4096);
        const ok = await localUsage.record(body);
        sendJson(res, ok ? 204 : 400, ok ? undefined : { error: "bad payload" });
        finish(ok ? 204 : 400);
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
          // 读一次进内存：登录页轮询/多同学并发打开时不再每请求读盘
          const logo = await logoBuffer();
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
        const resetDone = url.searchParams.get("reset") === "1";
        sendHtml(res, 200, loginPage("", resetDone ? "密码已重置，请用新密码登录" : ""));
        return;
      }

      // 找回密码：申请（免登录）与用一次性码自设新密码
      if (req.method === "GET" && pathname === "/forgot") {
        sendHtml(res, 200, forgotPage());
        return;
      }
      if (req.method === "POST" && pathname === "/forgot") {
        // 防刷：提交本身也进防爆破计数——否则可对全部用户名各造一条 pending，
        // 把管理台审批列表刷成垃圾墙掩护真实申请（正常同学一次就够）
        const lockSec = throttle.check(ip);
        if (lockSec) {
          sendHtml(res, 429, forgotPage(`提交次数过多，请 ${lockSec} 秒后再试`));
          finish(429);
          return;
        }
        throttle.fail(ip);
        const form = await readForm(req);
        const user = await registry.findUserByName(String(form.username ?? ""));
        if (user && !user.disabled) {
          await registry.createResetRequest(user.id, user.username);
          console.log(`[gw] ${user.username} 提交了密码重置申请`);
        }
        // 无论用户名是否存在都回同一句话，避免探测已注册用户名
        sendHtml(
          res,
          200,
          forgotPage("", "申请已提交。请到班级群联系管理员，同意后会收到一个一次性重置码。"),
        );
        return;
      }
      if (req.method === "POST" && pathname === "/reset-password") {
        // 重置码是可暴力尝试的凭据：兑换失败与登录失败同一套防爆破锁
        const lockSec = throttle.check(ip);
        if (lockSec) {
          sendHtml(res, 429, forgotPage(`尝试次数过多，请 ${lockSec} 秒后再试`));
          finish(429);
          return;
        }
        const form = await readForm(req);
        const username = String(form.username ?? "");
        const next = String(form.next ?? "");
        if (next !== String(form.next2 ?? "")) {
          sendHtml(res, 400, forgotPage("两次输入的新密码不一致"));
          return;
        }
        const userId = await registry.redeemResetCode(username, String(form.code ?? ""));
        if (!userId) {
          const lockSec = throttle.fail(ip);
          sendHtml(
            res,
            401,
            forgotPage(
              lockSec
                ? `重置码无效或已过期。连续失败过多，已锁定 ${lockSec} 秒`
                : "重置码无效或已过期；请向管理员确认",
            ),
          );
          finish(401);
          return;
        }
        throttle.reset(ip);
        try {
          await registry.setPassword(userId, next);
        } catch (error) {
          sendHtml(res, 400, forgotPage(error instanceof Error ? error.message : String(error)));
          return;
        }
        console.log(`[gw] ${username} 已用重置码自设新密码`);
        sendHtml(res, 303, "", { location: "/login?reset=1" });
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
            // 建号失败就退回邀请码，同学改完表单还能用同一个码
            await registry.releaseInvite(form.invite);
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

      // Key 来源模式切换：own = 跟随（有自己 Key 就用自己的）；site = 钉在站点免费额度。
      // 只改模式不删 Key——切回 own 随时可用；踢掉实例让新模式立刻生效。
      if (req.method === "POST" && pathname === "/api/ds-mode") {
        const body = await readJsonBody(req);
        const mode = body.mode === "site" ? "site" : "";
        await registry.setDsMode(user.id, mode);
        spawner.kick(user.id);
        console.log(
          `[gw] ${user.username} Key 模式 → ${mode === "site" ? "站点免费额度" : "跟随（有自己的 Key 即用）"}`,
        );
        sendJson(res, 200, { ok: true });
        finish(200);
        return;
      }

      // 模型供应商切换（多厂商）：选择存网关（users.json），踢实例让新供应商
      // 立刻生效（站点 Key 注入与 Key 判定都按它走）。custom 一律拒绝；
      // 钉在站点免费额度的同学只能切到站点配了 Key 的厂商（否则实例拿不到
      // 任何 Key，对话直接报错）。
      if (req.method === "POST" && pathname === "/api/provider") {
        const body = await readJsonBody(req);
        const raw = typeof body.providerId === "string" ? body.providerId.trim() : "";
        // 空值 = 回落 deepseek；非空必须形状合法（脏值是客户端 bug 信号，明拒）
        const normalized = raw === "" ? "deepseek" : raw;
        if (normalized === "custom") {
          sendJson(res, 400, { error: "托管环境不支持自定义端点" });
          finish(400);
          return;
        }
        if (!/^[a-z][a-z0-9-]{0,20}$/.test(normalized)) {
          sendJson(res, 400, { error: "供应商标识不合法" });
          finish(400);
          return;
        }
        if (user.dsMode === "site" && normalized !== "deepseek") {
          const siteKeys = await registry.getSiteProviderKeys();
          if (!siteKeys[normalized]) {
            sendJson(res, 400, {
              error:
                "站点免费额度暂未提供该供应商：请先切到「我自己的 API Key」，或填入该供应商自己的 Key",
            });
            finish(400);
            return;
          }
        }
        try {
          await registry.setProviderId(user.id, normalized);
        } catch (error) {
          sendJson(res, 400, {
            error: error instanceof Error ? error.message : "供应商切换失败",
          });
          finish(400);
          return;
        }
        spawner.kick(user.id);
        console.log(`[gw] ${user.username} 模型供应商 → ${normalized}`);
        sendJson(res, 200, { ok: true });
        finish(200);
        return;
      }

      // 同学端额度查询：设置弹窗「账号与模型」里展示剩余免费对话次数
      if (req.method === "GET" && pathname === "/api/quota") {
        const limit = user.dailyTurns > 0 ? user.dailyTurns : dailyTurns;
        const providerId = user.providerId || "deepseek";
        const hasOwnKey = usersDir
          ? await ownDeepseekKeyActive(usersDir, user.id, providerId)
          : false;
        // 实际生效：有自己的 Key 且未被钉在站点模式
        const ownKeyActive = hasOwnKey && user.dsMode !== "site";
        const used = await registry.turnsToday(user.id);
        const ownUsed = await registry.ownTurnsToday(user.id);
        // 站点配了 Key 的厂商（前端「站点免费额度」模式下供应商下拉据此过滤；
        // env GATEWAY_DEEPSEEK_KEY 兜底也算 deepseek 可用）
        const siteKeys = await registry.getSiteProviderKeys();
        const siteProviders = Object.keys(siteKeys);
        if (!siteKeys.deepseek && envDeepseekKeySet) siteProviders.push("deepseek");
        sendJson(res, 200, {
          username: user.username,
          used,
          limit,
          remaining: Math.max(0, limit - used),
          ownUsed,
          hasOwnKey,
          ownKeyActive,
          /* 当前供应商（前端 Key 提示与站点模式的供应商过滤都用它） */
          providerId,
          /* 站点免费额度可用的供应商清单 */
          siteProviders,
          /* 同学选的来源（dsMode=site 钉在站点；空串=跟随，没存 Key 时实际仍
             走站点额度）。前端开关按「选择」渲染而不是按 ownKeyActive「实际
             生效」渲染——否则没存 Key 的同学点「自己的 Key」会被立刻刷回
             站点，连填 Key 的入口都看不到 */
          dsMode: user.dsMode === "site" ? "site" : "own",
          source: user.dailyTurns > 0 ? "personal" : "site",
        });
        finish(200);
        return;
      }

      // 同学自助改本站登录密码：先验当前密码，再落新密码
      if (req.method === "POST" && pathname === "/api/password") {
        const body = await readJsonBody(req);
        const current = String(body.current ?? "");
        const next = String(body.next ?? "");
        const check = await registry.authenticate(user.username, current);
        if (!check || check.disabled || !check.user) {
          sendJson(res, 401, { error: "当前密码不正确" });
          finish(401);
          return;
        }
        try {
          await registry.setPassword(user.id, next);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          finish(400);
          return;
        }
        console.log(`[gw] ${user.username} 自助修改了登录密码`);
        sendJson(res, 200, { ok: true });
        finish(200);
        return;
      }

      // 统一 Key 的费用护栏：每日对话轮数（按人限额优先，未设用站点默认）；
      // 已保存自己 Key（当前供应商）的同学不占站点免费额度，仅计数用于展示。
      // 记账放在 acquire 成功之后：满载 503 / 拉起失败被拒的轮次没有真正
      // 发给模型，不该烧同学的当日额度
      let chatTurnLedger = null;
      if (req.method === "POST" && pathname === "/api/chat") {
        const hasOwnKey = usersDir
          ? await ownDeepseekKeyActive(usersDir, user.id, user.providerId || "deepseek")
          : false;
        const ownKeyActive = hasOwnKey && user.dsMode !== "site";
        if (!ownKeyActive) {
          const limit = user.dailyTurns > 0 ? user.dailyTurns : dailyTurns;
          const used = await registry.turnsToday(user.id);
          if (used >= limit) {
            sendJson(res, 429, {
              error: `今日 ${limit} 轮免费对话已用完，明天再来；或到「设置 → AI 模型」填自己的 API Key（不占站点额度）`,
            });
            finish(429);
            return;
          }
        }
        chatTurnLedger = ownKeyActive ? "own" : "site";
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
      if (chatTurnLedger) await registry.addTurns(user.id, 1, chatTurnLedger);
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
