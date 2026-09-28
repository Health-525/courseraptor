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
import http from "node:http";

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

export function createGatewayServer({ registry, spawner, secret, dailyTurns = 100 } = {}) {
  if (!registry) throw new Error("createGatewayServer 需要 registry");
  if (!spawner) throw new Error("createGatewayServer 需要 spawner");
  if (!secret || secret.length < 16) throw new Error("GATEWAY_SECRET 至少 16 位");

  const throttle = createLoginThrottle();

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

  // ── 页面（风格对齐 update-server 落地页：system-ui + 🦖 绿）─────────

  const layout = (title, body, error = "") => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · CourseRaptor</title><style>
body{font-family:system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 20px;line-height:1.7;color:#1f2937}
h1{font-size:22px}a{color:#15803d}
.card{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:24px 28px}
label{display:block;margin:14px 0 4px;font-size:14px;color:#374151}
input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px}
button{margin-top:20px;width:100%;padding:11px;background:#16a34a;color:#fff;border:0;border-radius:8px;font-size:15px;cursor:pointer}
button:hover{background:#15803d}
.err{margin-top:14px;padding:10px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#b91c1c;font-size:14px}
.tip{margin-top:18px;font-size:12.5px;color:#6b7280;line-height:1.6}
.switch{margin-top:14px;font-size:14px;text-align:center}
</style></head><body>
<div class="card">
<h1>🦖 CourseRaptor</h1>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
${body}
<div class="tip">课表 · 成绩 · 考试 · 通知，一句话搞定。<br>
本站当前为班级互助自建服务：登录与教务账号请勿在公共 WiFi 等不可信网络使用（HTTP 明文传输）；
托管凭证由站长服务器加密保存，站长技术上可解密，请知悉后使用。</div>
</div></body></html>`;

  const loginPage = (error = "") =>
    layout(
      "登录",
      `<form method="post" action="/login">
<label>用户名</label><input name="username" autocomplete="username" required>
<label>密码</label><input name="password" type="password" autocomplete="current-password" required>
<button type="submit">登录</button>
</form>
<div class="switch">还没有账号？<a href="/register">凭邀请码注册</a></div>`,
      error,
    );

  const registerPage = (error = "") =>
    layout(
      "注册",
      `<form method="post" action="/register">
<label>邀请码</label><input name="invite" required autocomplete="off">
<label>用户名（字母 / 数字 / _ / -，2-32 位）</label><input name="username" autocomplete="username" required>
<label>密码（至少 8 位）</label><input name="password" type="password" autocomplete="new-password" required>
<label>确认密码</label><input name="password2" type="password" autocomplete="new-password" required>
<button type="submit">注册并进入</button>
</form>
<div class="switch">已有账号？<a href="/login">去登录</a></div>`,
      error,
    );

  const messagePage = (title, text) =>
    layout(
      title,
      `<p>${escapeHtml(text)}</p><div class="switch"><a href="/login">返回登录</a></div>`,
    );

  const busyPage = () =>
    layout(
      "稍后再试",
      `<p>现在在线的同学比较多，服务器暂时满载了 🦖</p>
<p>请过几分钟回来刷新重试；着急用的同学可以先用本地版（GitHub Releases 下载安装包）。</p>`,
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

      // 统一 Key 的费用护栏：每日对话轮数（自带 Key 的同学同样计数，规则透明）
      if (req.method === "POST" && pathname === "/api/chat") {
        const used = await registry.turnsToday(user.id);
        if (used >= dailyTurns) {
          sendJson(res, 429, {
            error: `今日 ${dailyTurns} 轮对话额度已用完，明天再来；或到「设置」换用自己的 DeepSeek Key`,
          });
          finish(429);
          return;
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
