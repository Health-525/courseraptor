/**
 * 多用户网关的网页版管理后台（挂在网关的 /admin 路径，与同学入口同端口）。
 *
 * 启用方式：环境变量 GATEWAY_ADMIN_PASSWORD（至少 8 位）；未设置时 /admin
 * 显示「未启用」说明页，管理动作一律 404，只能继续用 admin.mjs 命令行。
 *
 * 鉴权：独立的管理会话 Cookie（raptor_admin，HMAC 签名与同学会话不同名
 * 不同签名域，互不通用）；登录失败同样 5 次锁 15 分钟。
 *
 * 前端：admin/ 目录的 React SPA（shadcn-admin 模板裁剪，Vite 构建），
 * 构建产物 admin/dist 提交进仓库，这里只做静态下发（服务器部署仍是
 * git pull + restart，无需在机上跑构建）。index.html 不缓存，assets/
 * 里的带哈希文件长缓存；非 API 的未知路径回落 index.html（前端路由）。
 *
 * 登录走 JSON 接口：POST /admin/api/login {password, code}（成功 200+Cookie，
 * 失败 401，锁定 429）；GET /admin/api/session 查询会话与是否需要动态码。
 *
 * 管理能力：总览 / 用户（增删改停踢）/ 邀请码（生成删）/ 重置审批 /
 * 站点设置 / 安全设置（TOTP）/ 版本发布 / 密钥管理 / 操作日志。
 * 全部变更动作写 admin-log.json（环形 500 条，经 bootstrap 带出）。
 *
 * 两步验证（TOTP）：在「安全设置」扫码绑定后登录需密码 + 6 位动态码；
 * 启用/关闭递增 sessionEpoch 令既有管理会话立即失效；手机与恢复码全丢
 * 时 SSH 上机执行 `admin.mjs totp off` 兜底。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import QRCode from "qrcode";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp.mjs";

const ADMIN_DIR = path.dirname(fileURLToPath(import.meta.url));
/** React 管理台的构建产物（admin/dist，随仓库分发，服务器无需构建） */
const DIST_DIR = path.resolve(ADMIN_DIR, "..", "..", "admin", "dist");

const ADMIN_COOKIE = "raptor_admin";
const ADMIN_TTL_MS = 12 * 3600_000;
const MAX_JSON_BODY = 16 * 1024;
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
const FAILURES_TO_LOCK = 5;
const LOCK_DURATION_MS = 15 * 60_000;
const FAILURE_IDLE_MS = 30 * 60_000;

/**
 * 站点设置展示用的厂商清单。网关是纯 mjs 跑（不 import TS），这里维护
 * 一份精简镜像；tests/gateway-admin.test.ts 钉住它与 src/core/providers.ts
 * 的 BUILTIN_PROVIDERS 一致——加厂商时两处同步改，测试红灯兜底。
 */
const SITE_PROVIDERS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyPattern: /^sk-[A-Za-z0-9]{16,}$/,
  },
  {
    id: "qwen",
    label: "通义千问（阿里百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  { id: "glm", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "kimi", label: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "doubao", label: "豆包（火山方舟）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  { id: "hunyuan", label: "腾讯混元", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1" },
  { id: "minimax", label: "MiniMax", baseUrl: "https://api.minimaxi.com/v1" },
  { id: "step", label: "阶跃星辰", baseUrl: "https://api.stepfun.com/v1" },
  { id: "ernie", label: "文心（百度千帆）", baseUrl: "https://qianfan.baidubce.com/v2" },
  { id: "spark", label: "讯飞星火", baseUrl: "https://spark-api-open.xf-yun.com/v1" },
  { id: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "zhenze", label: "移动云", baseUrl: "https://zhenze-huhehaote.cmecloud.cn/v1" },
];

/** 站点 Key 的形状校验：deepseek 严格 sk-（历史行为），其余宽松 */
function siteKeyLooksValid(providerId, key) {
  const def = SITE_PROVIDERS.find((p) => p.id === providerId);
  if (!def) return false;
  if (def.keyPattern) return def.keyPattern.test(key);
  return key.length >= 16 && key.length <= 200 && !/\s/.test(key);
}

function maskSiteKey(key) {
  return `${key.slice(0, 3)}${"•".repeat(8)}${key.slice(-4)}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY) {
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

const disabledHtml = () => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>未启用 · CourseRaptor 管理</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#f6f8fb;color:#1e293b;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;max-width:460px;margin:16px}
h2{margin:0 0 16px;font-size:20px;text-align:center}
.warn{background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:10px 12px;font-size:14px}
p{color:#64748b;font-size:14px;line-height:1.7}
code{background:#f1f5f9;border-radius:4px;padding:2px 6px;font-size:13px}
</style>
</head>
<body>
<div class="card">
  <h2>管理后台未启用</h2>
  <div class="warn">服务器未设置 <code>GATEWAY_ADMIN_PASSWORD</code></div>
  <p>在 <code>/etc/raptor-gateway.env</code> 加入该变量并
  <code>systemctl restart raptor-gateway</code> 即可开启；期间可继续用
  <code>admin.mjs</code> 命令行管理。</p>
</div>
</body>
</html>`;

/** 静态文件的 MIME（构建产物里出现的扩展名） */
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};

export function createAdminUi({
  registry,
  spawner,
  secret,
  password,
  capacity = 0,
  defaultDailyTurns = 100,
  updateServerUrl = "",
  updateAdminToken = "",
  version = "",
  envDeepseekKeySet = false,
  usersDir = "",
  localUsage = null,
}) {
  const enabled = typeof password === "string" && password.length >= 8;
  const failures = new Map();
  // 扫码绑定流程的中间态：只存内存，未走完「验证并启用」就丢弃（重启作废重来）
  let pendingSetup = null;
  const PENDING_SETUP_TTL_MS = 10 * 60_000;

  /** 管理动作落一笔日志：等落盘再响应（失败不影响主流程） */
  const audit = async (ip, text) => {
    try {
      await registry.appendAdminLog(text, ip);
    } catch {
      /* 日志失败不阻断管理动作 */
    }
  };

  /**
   * 代理访问同机部署的更新分发后台（update/update-server.mjs，回环端口）。
   * 未配置 / 连不上时返回 {unavailable}，管理台显示「未接入」而不是报错。
   */
  async function callUpdateApi(method, path, body) {
    if (!updateServerUrl || !updateAdminToken) {
      return {
        unavailable: true,
        error: "更新后台未接入（网关未配置 GATEWAY_UPDATE_URL / GATEWAY_UPDATE_TOKEN）",
      };
    }
    try {
      const res = await fetch(`${updateServerUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          "x-admin-token": updateAdminToken,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return { error: "更新后台拒绝了令牌（检查两边的 token 是否一致）" };
      if (!res.ok) return { error: data?.error ?? `更新后台返回 ${res.status}` };
      return { data };
    } catch (error) {
      return {
        unavailable: true,
        error: `更新后台不可达：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  function sign(expiresAt, epoch = 0) {
    return createHmac("sha256", secret).update(`admin.${epoch}.${expiresAt}`).digest("hex");
  }

  function sessionFrom(req, epoch = 0) {
    const raw = req.headers.cookie;
    if (typeof raw !== "string") return null;
    const match = /(?:^|;\s*)raptor_admin=([^;]+)/.exec(raw);
    if (!match) return null;
    const [expiresAt, mac] = match[1].split(".");
    if (!expiresAt || !mac) return null;
    const expected = sign(expiresAt, epoch);
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (Number(expiresAt) < Date.now()) return null;
    return Number(expiresAt);
  }

  function checkThrottle(ip) {
    const record = failures.get(ip);
    if (record?.lockedUntil && record.lockedUntil > Date.now()) {
      return Math.ceil((record.lockedUntil - Date.now()) / 1000);
    }
    return 0;
  }

  function passwordOk(candidate) {
    const a = Buffer.from(String(candidate ?? ""));
    const b = Buffer.from(password);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function recordFailure(ip) {
    const now = Date.now();
    // 过期条目清理：30 分钟无新失败即清零——否则几天前的 4 次 + 今天 1 次
    // 就把正常管理员锁在门外；也让 Map 不随历史 IP 无限膨胀
    for (const [key, rec] of failures) {
      if (rec.lockedUntil <= now && now - rec.lastAt > FAILURE_IDLE_MS) failures.delete(key);
    }
    // 兜底上限：海量伪造来源 IP 不该让 Map 无限增长（清理后仍超限则整体重置）
    if (failures.size > 1000) failures.clear();
    const record = failures.get(ip);
    const count = (record?.count ?? 0) + 1;
    const lockedUntil = count >= FAILURES_TO_LOCK ? now + LOCK_DURATION_MS : 0;
    failures.set(ip, { count, lockedUntil, lastAt: now });
  }

  /**
   * 高危动作（登录、关闭两步验证、重生成恢复码）的动态码校验：
   * TOTP 命中则推进防重放水位，未命中再试恢复码（命中即消耗一枚）。
   * 返回 { ok, replay?, doc }，doc 为校验副作用后的最新落盘文档。
   */
  async function verifyAdminCode(doc, candidate) {
    const verdict = verifyTotp(doc.secret, String(candidate ?? "").trim(), {
      lastUsedCounter: doc.lastUsedCounter ?? -1,
    });
    if (verdict.ok) {
      return {
        ok: true,
        recoveryUsed: false,
        doc: { ...doc, lastUsedCounter: Math.max(doc.lastUsedCounter ?? -1, verdict.counter) },
      };
    }
    const index = (doc.recovery ?? []).indexOf(hashRecoveryCode(String(candidate ?? "")));
    if (index >= 0) {
      const recovery = [...doc.recovery];
      recovery.splice(index, 1);
      return { ok: true, recoveryUsed: true, doc: { ...doc, recovery } };
    }
    return {
      ok: false,
      replay: Boolean(verdict.replay),
    };
  }

  function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
    res.end(body);
  }

  const sendJson = (res, status, data) =>
    send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

  /**
   * 下发 admin/dist 里的构建产物。/admin/xxx 映射 dist/xxx，路径先净化
   * （拒绝 ..、反斜杠、空段），解析后再确认仍落在 DIST_DIR 内（双保险）。
   * assets/ 下的文件名带内容哈希 → 一年不变缓存；其余（index.html 等）不缓存。
   * 文本产物按 Accept-Encoding 协商压缩（br 优先）——入口 JS 500KB+，不压的话
   * 跨公网每次打开管理台都要原样拉约 1MB。压缩结果按路径缓存（产物在部署
   * 周期内不可变，重启即随进程清空），整进程内存开销几百 KB。
   * 找不到文件返回 false（调用方决定 404 还是回落 index.html）。
   */
  const COMPRESSIBLE_EXTS = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".txt"]);
  const compressedCache = new Map();

  async function serveDistFile(req, res, rel) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(rel)) return false;
    const file = path.join(DIST_DIR, rel);
    if (file !== DIST_DIR && !file.startsWith(DIST_DIR + path.sep)) return false;
    let body;
    try {
      body = await fs.promises.readFile(file);
    } catch {
      return false;
    }
    const ext = path.extname(file).toLowerCase();
    const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const hashed = rel.startsWith("assets/");
    let encoding = "";
    if (COMPRESSIBLE_EXTS.has(ext)) {
      const accept = String(req?.headers?.["accept-encoding"] ?? "");
      if (accept.includes("br")) encoding = "br";
      else if (accept.includes("gzip")) encoding = "gzip";
    }
    let payload = body;
    if (encoding) {
      let cached = compressedCache.get(rel);
      if (!cached) {
        cached = { br: brotliCompressSync(body), gzip: gzipSync(body) };
        compressedCache.set(rel, cached);
      }
      payload = cached[encoding];
    }
    res.writeHead(200, {
      "content-type": type,
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-store",
      ...(encoding ? { "content-encoding": encoding, vary: "accept-encoding" } : {}),
      "content-length": payload.length,
    });
    res.end(payload);
    return true;
  }

  async function serveIndex(req, res) {
    if (await serveDistFile(req, res, "index.html")) return;
    // dist 缺失（一般是开发态没跑 admin 构建）：给出可操作的提示而不是白屏
    send(
      res,
      500,
      "管理台前端未构建：请在仓库 admin/ 目录执行 npm install && npm run build（产物 admin/dist 随仓库提交）",
    );
  }

  /** 返回 true 表示已处理该请求 */
  async function handle(req, res, pathname) {
    const ip = req.socket.remoteAddress || "unknown";

    if (!enabled) {
      if (req.method === "GET" && pathname === "/admin") {
        send(res, 200, disabledHtml());
        return true;
      }
      sendJson(res, 404, { error: "管理后台未启用" });
      return true;
    }

    // 两步验证状态每次请求现读：启用/关闭后无需重启即生效；
    // sessionEpoch 参与会话签名，状态一变所有旧管理会话立即失效
    const totpDoc = await registry.getAdminTotp();
    const epoch = totpDoc?.sessionEpoch ?? 0;
    const mfaOn = Boolean(totpDoc);

    // ── 前端 SPA：静态产物 + 前端路由回落 ─────────────────────
    if (req.method === "GET" && pathname === "/admin") {
      await serveIndex(req, res);
      return true;
    }
    if (req.method === "GET" && pathname.startsWith("/admin/")) {
      const rel = pathname.slice("/admin/".length);
      if (rel !== "api" && !rel.startsWith("api/")) {
        // assets/ 找不到就是 404（不回落 index.html，避免吞掉资源错误）
        if (rel.startsWith("assets/")) {
          if (await serveDistFile(req, res, rel)) return true;
          res.writeHead(404);
          res.end();
          return true;
        }
        // 其余未知路径交给前端路由（/admin/sign-in、/admin/users 等）
        if (!(await serveDistFile(req, res, rel))) await serveIndex(req, res);
        return true;
      }
      // /admin/api/* 的 GET 落到下面的 API 分支
    }

    // ── 会话探测：登录页据此决定是否显示动态码输入框 ──────────
    if (req.method === "GET" && pathname === "/admin/api/session") {
      sendJson(res, 200, {
        authed: Boolean(sessionFrom(req, epoch)),
        mfaRequired: mfaOn,
        version,
      });
      return true;
    }

    // ── 登录 / 退出（JSON）───────────────────────────────────
    if (req.method === "POST" && pathname === "/admin/api/login") {
      const lockSec = checkThrottle(ip);
      if (lockSec) {
        sendJson(res, 429, {
          error: `尝试次数过多，请 ${lockSec} 秒后再试`,
          retryAfterSec: lockSec,
        });
        return true;
      }
      const body = await readJsonBody(req);
      const pass = String(body.password ?? "");
      const fail = (message, status = 401) => {
        recordFailure(ip);
        const locked = Boolean(failures.get(ip)?.lockedUntil);
        sendJson(res, status, {
          error: locked
            ? `密码或动态码错误次数过多，已锁定 ${LOCK_DURATION_MS / 60000} 分钟`
            : message,
          locked,
        });
        return true;
      };
      if (!passwordOk(pass)) return fail("管理密码不正确");
      if (totpDoc) {
        const verdict = await verifyAdminCode(totpDoc, body.code);
        if (!verdict.ok) {
          return fail(
            verdict.replay
              ? "这枚动态码刚用过，请等验证器出下一枚（30 秒内）"
              : "动态码不正确或已过期",
          );
        }
        await registry.setAdminTotp(verdict.doc);
        if (verdict.recoveryUsed) {
          console.log(
            "[gw-admin] 管理台以恢复码登录（已消耗一枚，剩 %d 枚）",
            verdict.doc.recovery.length,
          );
        }
      }
      failures.delete(ip);
      await audit(ip, "登录管理台");
      const expiresAt = Date.now() + ADMIN_TTL_MS;
      send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8", {
        "set-cookie": `${ADMIN_COOKIE}=${expiresAt}.${sign(expiresAt, epoch)}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_TTL_MS / 1000}`,
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/admin/api/logout") {
      if (sessionFrom(req, epoch)) await audit(ip, "退出管理台");
      send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8", {
        "set-cookie": `${ADMIN_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
      return true;
    }

    if (pathname.startsWith("/admin/api/")) {
      if (!sessionFrom(req, epoch)) {
        sendJson(res, 401, { error: "未登录或会话过期" });
        return true;
      }
      if (pathname.startsWith("/admin/api/update/")) {
        return await handleUpdateApi(req, res, pathname, ip);
      }
      if (pathname === "/admin/api/site") {
        if (req.method === "GET") {
          sendJson(res, 200, await siteSnapshot());
          return true;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          // 新形状①：{defaultProvider, defaultModel} 站点默认模型（两者都空=清除）
          if (body.defaultProvider !== undefined || body.defaultModel !== undefined) {
            const provider = String(body.defaultProvider ?? "").trim();
            const model = String(body.defaultModel ?? "").trim();
            const def = SITE_PROVIDERS.find((p) => p.id === provider);
            if (provider && !def) {
              sendJson(res, 400, { error: "未知供应商（自定义端点没有站点默认模型）" });
              return true;
            }
            try {
              await registry.setSiteDefaultModel(provider, model);
            } catch (error) {
              sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
              return true;
            }
            const text = provider
              ? `站点默认模型 → ${def.label} / ${model}（同学自选优先，新拉起的实例生效）`
              : "站点默认模型已清除（回落系统默认 DeepSeek）";
            console.log(`[gw-admin] ${text}`);
            await audit(ip, text);
            sendJson(res, 200, { ok: true });
            return true;
          }
          // 新形状②：{provider, key} 按厂商保存/清除；旧形状 {deepseekKey} 兼容转发
          if (body.provider !== undefined) {
            const provider = String(body.provider ?? "");
            const key = String(body.key ?? "").trim();
            const def = SITE_PROVIDERS.find((p) => p.id === provider);
            if (!def) {
              sendJson(res, 400, { error: "未知供应商（自定义端点没有站点 Key）" });
              return true;
            }
            if (key && !siteKeyLooksValid(provider, key)) {
              sendJson(res, 400, {
                error: def.keyPattern
                  ? `${def.label} Key 应以 sk- 开头且长度足够`
                  : "Key 长度或字符不合常理，请检查是否复制完整",
              });
              return true;
            }
            await registry.setSiteProviderKey(provider, key);
            console.log(
              `[gw-admin] 站点 ${def.label} Key 已${key ? "更新" : "清空"}（新拉起的实例生效）`,
            );
            await audit(ip, `站点 ${def.label} Key ${key ? "更新" : "清空"}`);
            sendJson(res, 200, { ok: true });
            return true;
          }
          const key = String(body.deepseekKey ?? "").trim();
          if (
            body.deepseekKey !== undefined &&
            key !== "" &&
            (!key.startsWith("sk-") || key.length < 20)
          ) {
            sendJson(res, 400, { error: "DeepSeek Key 应以 sk- 开头且长度足够" });
            return true;
          }
          await registry.setSiteSettings({ deepseekKey: key });
          console.log(
            `[gw-admin] 站点 DeepSeek Key 已${key ? "更新" : "清空"}（新拉起的实例生效）`,
          );
          await audit(ip, `站点 DeepSeek Key ${key ? "更新" : "清空"}`);
          sendJson(res, 200, { ok: true });
          return true;
        }
      }

      // 站点默认模型的在线型号清单：网关拿该厂商的站点 Key 实时代理
      // GET {base}/models（管理台「站点默认模型」下拉用；拉不到就手输）。
      // 只用面板 Key——env 兜底 Key 不经手，避免把进程 env 里的值引进这条链路。
      if (req.method === "GET" && pathname === "/admin/api/site/models") {
        const url = new URL(req.url, "http://localhost");
        const providerId = (url.searchParams.get("provider") ?? "").trim();
        const def = SITE_PROVIDERS.find((p) => p.id === providerId);
        if (!def) {
          sendJson(res, 400, { error: "未知供应商" });
          return true;
        }
        const providerKeys = await registry.getSiteProviderKeys();
        const key = providerKeys[providerId] ?? "";
        if (!key) {
          sendJson(res, 200, {
            models: [],
            error: `尚未配置 ${def.label} 的站点 Key：请先在上方配 Key，或直接手动输入型号 ID`,
          });
          return true;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const resp = await fetch(`${def.baseUrl}/models`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: controller.signal,
          });
          if (!resp.ok) {
            sendJson(res, 200, {
              models: [],
              error: `${def.label} 返回 ${resp.status}：可手动输入型号 ID`,
            });
            return true;
          }
          const payload = await resp.json();
          const rows = Array.isArray(payload) ? payload : (payload?.data ?? []);
          const models = [
            ...new Set(
              (Array.isArray(rows) ? rows : [])
                .map((m) => (typeof m?.id === "string" ? m.id : ""))
                .filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(id)),
            ),
          ].sort();
          sendJson(res, 200, { models: models.slice(0, 200) });
        } catch {
          sendJson(res, 200, {
            models: [],
            error: `拉取 ${def.label} 型号清单失败（超时或网络不通）：可手动输入型号 ID`,
          });
        } finally {
          clearTimeout(timer);
        }
        return true;
      }

      return await handleApi(req, res, pathname, ip);
    }

    send(res, 404, "not found");
    return true;
  }

  /** 用户条目叠加在线状态与实例详情（在线时带启动/最近活跃/重启次数） */
  function decorateUser(userId) {
    const online = spawner.isRunning(userId);
    if (!online) return { online };
    const running =
      typeof spawner.listRunning === "function"
        ? (spawner.listRunning() ?? []).find((it) => it.userId === userId)
        : undefined;
    if (!running) return { online };
    return {
      online,
      startedAt: new Date(running.startedAt).toISOString(),
      lastRequestAt: new Date(running.lastRequestAt).toISOString(),
      restarts: running.restarts,
    };
  }

  async function ownOverview() {
    const users = await registry.listUsers();
    const today = new Date().toISOString().slice(0, 10);
    const invites = await registry.listInvites();
    const resets = await registry.listResetRequests();
    const usable = (i) =>
      (i.usedBy?.length ?? 0) < (i.maxUses ?? 1) &&
      !(i.expiresAt && new Date(i.expiresAt) < new Date());
    return {
      users: users.length,
      online: spawner.runningCount(),
      capacity,
      invitesLeft: invites.filter(usable).length,
      turnsToday: users.reduce((sum, u) => sum + (u.turns?.date === today ? u.turns.count : 0), 0),
      ownTurnsToday: users.reduce(
        (sum, u) => sum + (u.ownTurns?.date === today ? u.ownTurns.count : 0),
        0,
      ),
      pendingResets: resets.pending.length,
      uptimeSec: Math.round(process.uptime()),
      version,
    };
  }

  /**
   * 站点设置的公共快照：GET /admin/api/site 与 bootstrap 共用同一形状——
   * SPA 的数据源是 bootstrap（单请求模式），两处形状漂移会让站点设置页
   * 静默退回单行 DeepSeek 兜底（#183 的实际线上状态，修于此）。
   */
  async function siteSnapshot() {
    const site = await registry.getSiteSettings();
    const providerKeys = await registry.getSiteProviderKeys();
    return {
      deepseekKeySet: Boolean(site.deepseekKey),
      deepseekKeyMasked: site.deepseekKey ? maskSiteKey(site.deepseekKey) : "",
      envDeepseekKeySet,
      defaultDailyTurns: defaultDailyTurns,
      /* 站点默认模型（多厂商）：空串 = 未设置（同学未自选时用系统默认 DeepSeek） */
      defaultProvider: site.defaultProvider || "",
      defaultModel: site.defaultModel || "",
      /* 各厂商站点 Key 状态（多厂商）：keyMasked 为空即未设 */
      providers: SITE_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        keySet: Boolean(providerKeys[p.id]),
        keyMasked: providerKeys[p.id] ? maskSiteKey(providerKeys[p.id]) : "",
        /* deepseek 兜底链路提示：面板未设但 env 有 */
        envFallback: p.id === "deepseek" && !providerKeys[p.id] && envDeepseekKeySet,
      })),
    };
  }

  async function handleApi(req, res, pathname, ip = "unknown") {
    // ── 两步验证（TOTP）管理：绑定 / 启用 / 关闭 / 恢复码 ─────────
    // 高危动作（关闭、重生成）都要求再验一次动态码：即便会话 Cookie 被劫持，
    // 没有 Authenticator 也降不了安全等级、拿不到新恢复码。
    if (req.method === "POST" && pathname === "/admin/api/totp/setup") {
      if (await registry.getAdminTotp()) {
        sendJson(res, 400, { error: "两步验证已启用，无需重复绑定" });
        return true;
      }
      const secret = generateTotpSecret();
      pendingSetup = { secret, createdAt: Date.now() };
      const uri = otpauthUri({ secret });
      sendJson(res, 200, {
        secret,
        uri,
        qrSvg: await QRCode.toString(uri, { type: "svg", margin: 1 }),
      });
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/totp/enable") {
      if (await registry.getAdminTotp()) {
        sendJson(res, 400, { error: "两步验证已启用，无需重复绑定" });
        return true;
      }
      if (!pendingSetup || Date.now() - pendingSetup.createdAt > PENDING_SETUP_TTL_MS) {
        pendingSetup = null;
        sendJson(res, 400, { error: "绑定会话已过期，请重新生成二维码" });
        return true;
      }
      const body = await readJsonBody(req);
      const verdict = verifyTotp(pendingSetup.secret, String(body.code ?? "").trim());
      if (!verdict.ok) {
        sendJson(res, 400, {
          error: "动态码不正确，请确认验证器已添加 CourseRaptor 且手机时间正常",
        });
        return true;
      }
      const plainCodes = generateRecoveryCodes(10);
      await registry.setAdminTotp({
        secret: pendingSetup.secret,
        enabledAt: new Date().toISOString(),
        recovery: plainCodes.map(hashRecoveryCode),
        // 防重放水位从 -1 起：绑定用的这枚码在跳去登录时还能用（30 秒窗口），
        // 首次登录消耗后防重放才收紧——避免「刚启用就被拒」的困惑
        lastUsedCounter: -1,
        // 0 → 1：即刻注销启用前签发的所有管理会话（含当前这个）
        sessionEpoch: 1,
      });
      pendingSetup = null;
      console.log("[gw-admin] 管理台两步验证已启用（TOTP），恢复码已生成");
      await audit(ip, "启用两步验证（TOTP）");
      sendJson(res, 200, { ok: true, recoveryCodes: plainCodes });
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/totp/disable") {
      const doc = await registry.getAdminTotp();
      if (!doc) {
        sendJson(res, 400, { error: "两步验证未启用" });
        return true;
      }
      // 高危动作必须先查锁定：此前只 recordFailure 不 checkThrottle，
      // 会话被劫持的攻击者可以无限制爆破 6 位动态码来关闭两步验证
      const lockSec = checkThrottle(ip);
      if (lockSec > 0) {
        sendJson(res, 429, {
          error: `尝试次数过多，请 ${lockSec} 秒后再试`,
          retryAfterSec: lockSec,
        });
        return true;
      }
      const body = await readJsonBody(req);
      const verdict = await verifyAdminCode(doc, body.code);
      if (!verdict.ok) {
        recordFailure(ip);
        sendJson(res, 401, {
          error: verdict.replay
            ? "这枚动态码刚用过，请等验证器出下一枚（30 秒内）"
            : "动态码不正确或已过期",
        });
        return true;
      }
      await registry.clearAdminTotp();
      pendingSetup = null;
      console.log("[gw-admin] 管理台两步验证已关闭（恢复仅密码登录）");
      await audit(ip, "关闭两步验证");
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/totp/recovery") {
      const doc = await registry.getAdminTotp();
      if (!doc) {
        sendJson(res, 400, { error: "两步验证未启用" });
        return true;
      }
      // 同 /totp/disable：重生成恢复码也是高危动作，先查锁定再验码
      const lockSec = checkThrottle(ip);
      if (lockSec > 0) {
        sendJson(res, 429, {
          error: `尝试次数过多，请 ${lockSec} 秒后再试`,
          retryAfterSec: lockSec,
        });
        return true;
      }
      const body = await readJsonBody(req);
      const verdict = await verifyAdminCode(doc, body.code);
      if (!verdict.ok) {
        recordFailure(ip);
        sendJson(res, 401, {
          error: verdict.replay
            ? "这枚动态码刚用过，请等验证器出下一枚（30 秒内）"
            : "动态码不正确或已过期",
        });
        return true;
      }
      const plainCodes = generateRecoveryCodes(10);
      await registry.setAdminTotp({ ...verdict.doc, recovery: plainCodes.map(hashRecoveryCode) });
      console.log("[gw-admin] 管理台恢复码已重新生成（旧恢复码全部作废）");
      await audit(ip, "重新生成恢复码");
      sendJson(res, 200, { ok: true, recoveryCodes: plainCodes });
      return true;
    }

    // 一次往返带回全部面板数据：跨公网链路 RTT 大，串行请求是「卡」的主因
    if (req.method === "GET" && pathname === "/admin/api/bootstrap") {
      const [overview, users, invites, resets, totp, updOverview, updVersions, updKeys, log] =
        await Promise.all([
          ownOverview(),
          registry.listUsers(),
          registry.listInvites(),
          registry.listResetRequests(),
          registry.getAdminTotp(),
          callUpdateApi("GET", "/admin/api/overview"),
          callUpdateApi("GET", "/admin/api/versions"),
          callUpdateApi("GET", "/admin/api/keys"),
          registry.listAdminLog(),
        ]);
      sendJson(res, 200, {
        overview,
        users: users.map((u) => ({ ...u, ...decorateUser(u.id) })),
        invites,
        resets,
        security: {
          mfaEnabled: Boolean(totp),
          enabledAt: totp?.enabledAt ?? "",
          recoveryLeft: totp?.recovery?.length ?? 0,
        },
        site: await siteSnapshot(),
        update: { overview: updOverview, versions: updVersions, keys: updKeys },
        log,
      });
      return true;
    }

    // 密码重置审批：同意即生成一次性码——管理员只经手码，不知道新密码
    if (req.method === "POST" && pathname === "/admin/api/reset/approve") {
      const body = await readJsonBody(req);
      try {
        const result = await registry.approveResetRequest(String(body.id ?? ""));
        console.log(`[gw-admin] 同意 ${result.username} 的重置申请，一次性码已生成（24h 有效）`);
        await audit(ip, `同意 ${result.username} 的密码重置申请`);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/reset/reject") {
      const body = await readJsonBody(req);
      try {
        await registry.rejectResetRequest(String(body.id ?? ""));
        await audit(ip, `拒绝密码重置申请 ${String(body.id ?? "")}`);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/reset/revoke") {
      const body = await readJsonBody(req);
      try {
        const { username } = await registry.revokeResetCode(String(body.code ?? ""));
        console.log(`[gw-admin] 作废 ${username} 的重置码`);
        await audit(ip, `作废 ${username} 的重置码`);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/admin/api/overview") {
      sendJson(res, 200, await ownOverview());
      return true;
    }
    if (req.method === "GET" && pathname === "/admin/api/users") {
      const users = await registry.listUsers();
      sendJson(
        res,
        200,
        users.map((u) => ({ ...u, ...decorateUser(u.id) })),
      );
      return true;
    }
    if (req.method === "GET" && pathname === "/admin/api/invites") {
      sendJson(res, 200, await registry.listInvites());
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/invite") {
      const body = await readJsonBody(req);
      const created = await registry.createInvites({
        count: Math.max(1, Math.min(Number(body.count) || 1, 50)),
        note: String(body.note ?? "").slice(0, 100),
        expiresDays: Math.max(0, Math.min(Number(body.days) || 0, 365)),
      });
      console.log(
        `[gw-admin] 生成 ${created.length} 个邀请码${body.note ? `（${body.note}）` : ""}`,
      );
      await audit(ip, `生成 ${created.length} 个邀请码${body.note ? `（${body.note}）` : ""}`);
      sendJson(res, 200, { ok: true, created });
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/invite/delete") {
      const body = await readJsonBody(req);
      try {
        await registry.deleteInvite(String(body.code ?? ""));
        console.log(`[gw-admin] 删除邀请码 ${String(body.code ?? "")}`);
        await audit(ip, `删除邀请码 ${String(body.code ?? "")}`);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/user/create") {
      const body = await readJsonBody(req);
      try {
        const user = await registry.createUser({
          username: String(body.username ?? "").trim(),
          password: String(body.password ?? ""),
        });
        console.log(`[gw-admin] 新建用户 ${user.username}（${user.id}）`);
        await audit(ip, `新建用户 ${user.username}`);
        sendJson(res, 200, { ok: true, user });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname.startsWith("/admin/api/user/")) {
      const action = pathname.slice("/admin/api/user/".length);
      const body = await readJsonBody(req);
      const target = String(body.user ?? "");
      const user = (await registry.findUserById(target)) ?? (await registry.findUserByName(target));
      if (!user) {
        sendJson(res, 404, { error: "用户不存在" });
        return true;
      }
      if (action === "quota") {
        try {
          await registry.setDailyTurns(user.id, body.turns);
          console.log(`[gw-admin] ${user.username} 每日限额 → ${Number(body.turns) || 0}`);
          await audit(ip, `${user.username} 每日限额 → ${Number(body.turns) || 0}`);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return true;
        }
      } else if (action === "disable" || action === "enable") {
        await registry.setDisabled(user.id, action === "disable");
        console.log(`[gw-admin] ${action} ${user.username}`);
        await audit(ip, `${action === "disable" ? "停用" : "启用"} ${user.username}`);
      } else if (action === "kick") {
        spawner.kick(user.id);
        console.log(`[gw-admin] kick ${user.username}`);
        await audit(ip, `回收 ${user.username} 的实例`);
      } else if (action === "reset-pass") {
        try {
          await registry.setPassword(user.id, String(body.password ?? ""));
          console.log(`[gw-admin] reset-pass ${user.username}`);
          await audit(ip, `重置 ${user.username} 的密码`);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return true;
        }
      } else if (action === "delete") {
        // 顺序：先回收实例，再除名，最后清数据目录（含加密凭证）
        spawner.kick(user.id);
        try {
          await registry.deleteUser(user.id);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return true;
        }
        if (usersDir) {
          await rm(path.join(usersDir, user.id), { recursive: true, force: true }).catch(() => {});
        }
        console.log(`[gw-admin] 删除用户 ${user.username}（${user.id}）及其数据目录`);
        await audit(ip, `删除用户 ${user.username}（含数据目录）`);
      } else {
        sendJson(res, 404, { error: "未知操作" });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === "GET" && pathname === "/admin/api/log") {
      sendJson(res, 200, await registry.listAdminLog());
      return true;
    }
    // 本地版匿名使用统计（只读聚合；上报入口是公开端点 /api/local-usage）
    if (req.method === "GET" && pathname === "/admin/api/local-usage") {
      if (!localUsage) {
        sendJson(res, 503, { error: "本地版使用统计未启用" });
        return true;
      }
      sendJson(res, 200, await localUsage.stats());
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/log/clear") {
      // 先清后记：清空动作本身落进新日志，审计链不断头
      await registry.clearAdminLog();
      console.log("[gw-admin] 清空操作日志");
      await audit(ip, "清空操作日志");
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  /** 版本发布段：全部代理到更新后台，鉴权由网关管理会话承担 */
  async function handleUpdateApi(req, res, pathname, ip = "unknown") {
    if (req.method !== "GET" && req.method !== "POST") {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    if (pathname === "/admin/api/update/overview") {
      sendJson(res, 200, await callUpdateApi("GET", "/admin/api/overview"));
      return true;
    }
    if (pathname === "/admin/api/update/versions") {
      sendJson(res, 200, await callUpdateApi("GET", "/admin/api/versions"));
      return true;
    }
    // 上传发版：浏览器请求体原样流式转发到更新后台 /publish，不在网关落盘。
    // 200 MB 与更新后台 MAX_PACKAGE_BODY 一致；大包上传远超 callUpdateApi 的 5s 超时，单独放宽。
    if (req.method === "POST" && pathname === "/admin/api/update/publish") {
      const version = String(req.headers["x-version"] ?? "");
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        sendJson(res, 400, { error: "x-version 必须是 x.y.z" });
        return true;
      }
      if (!updateServerUrl || !updateAdminToken) {
        sendJson(res, 400, {
          error: "更新后台未接入（网关未配置 GATEWAY_UPDATE_URL / GATEWAY_UPDATE_TOKEN）",
        });
        return true;
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_PACKAGE_BYTES) {
        sendJson(res, 413, { error: "安装包超过 200 MB 上限" });
        return true;
      }
      try {
        const upstream = await fetch(`${updateServerUrl.replace(/\/$/, "")}/publish`, {
          method: "POST",
          headers: {
            "x-admin-token": updateAdminToken,
            "x-version": version,
            // 更新后台期望「URI 编码后的 x-notes」再自行解码；浏览器侧已编码，这里原样透传，不二次编码
            "x-notes": String(req.headers["x-notes"] ?? ""),
            "content-type": "application/zip",
          },
          body: req,
          duplex: "half",
          signal: AbortSignal.timeout(30 * 60_000),
        });
        const data = await upstream.json().catch(() => ({}));
        console.log(
          `[gw-admin] 发版 v${version}: ${upstream.ok ? "ok" : (data?.error ?? upstream.status)}`,
        );
        await audit(ip, `发版 v${version}${upstream.ok ? "" : "（失败）"}`);
        if (!upstream.ok) {
          sendJson(res, upstream.status === 401 ? 502 : upstream.status, {
            error: data?.error ?? `更新后台返回 ${upstream.status}`,
          });
          return true;
        }
        sendJson(res, 200, data);
      } catch (error) {
        // 浏览器中途取消时 req 流出错，同样落在这里；响应无人接收，安全
        sendJson(res, 502, {
          error: `更新后台不可达：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/update/rollback") {
      const body = await readJsonBody(req);
      const result = await callUpdateApi("POST", "/admin/api/rollback", {
        version: String(body.version ?? ""),
      });
      console.log(`[gw-admin] 版本回滚请求 v${body.version}: ${result.error ?? "ok"}`);
      await audit(ip, `版本回滚 → v${body.version}${result.error ? "（失败）" : ""}`);
      sendJson(res, result.error ? 400 : 200, result);
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/update/delete") {
      const body = await readJsonBody(req);
      const result = await callUpdateApi("POST", "/admin/api/delete", {
        version: String(body.version ?? ""),
      });
      console.log(`[gw-admin] 版本删除请求 v${body.version}: ${result.error ?? "ok"}`);
      await audit(ip, `删除版本 v${body.version}${result.error ? "（失败）" : ""}`);
      sendJson(res, result.error ? 400 : 200, result);
      return true;
    }
    // 密钥管理：同样全部代理到更新后台，明文令牌只在创建响应里出现一次
    if (pathname === "/admin/api/update/keys") {
      if (req.method === "GET") {
        sendJson(res, 200, await callUpdateApi("GET", "/admin/api/keys"));
        return true;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await callUpdateApi("POST", "/admin/api/keys", {
          name: String(body.name ?? ""),
        });
        console.log(
          `[gw-admin] 新建更新后台密钥「${result.data?.key?.name ?? ""}」: ${result.error ?? "ok"}`,
        );
        await audit(
          ip,
          `新建更新后台密钥「${result.data?.key?.name ?? ""}」${result.error ? "（失败）" : ""}`,
        );
        sendJson(res, result.error ? 400 : 200, result);
        return true;
      }
    }
    if (req.method === "POST" && pathname === "/admin/api/update/keys/delete") {
      const body = await readJsonBody(req);
      const result = await callUpdateApi("POST", "/admin/api/keys/delete", {
        id: String(body.id ?? ""),
      });
      console.log(`[gw-admin] 删除更新后台密钥 ${String(body.id ?? "")}: ${result.error ?? "ok"}`);
      await audit(ip, `删除更新后台密钥 ${String(body.id ?? "")}${result.error ? "（失败）" : ""}`);
      sendJson(res, result.error ? 400 : 200, result);
      return true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  return { handle };
}
