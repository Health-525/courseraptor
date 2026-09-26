/**
 * NJTECH WebVPN 会话（深信服 SSL VPN + 金智统一身份认证）
 *
 * 2026-09 起学校把部门网站（含教务处官网 jwc.njtech.edu.cn）限制为仅校内
 * IP 访问，校外一律落到「本网站只能被校内IP地址访问」拦截页。校外访问这些
 * 站点的正规通道是 WebVPN（vpn.njtech.edu.cn）：它把统一身份认证
 * （sfgl.njtech.edu.cn）当 OAuth 登录源，登录后以 /http/webvpn<hash>/ 前缀
 * 代理任意校内站点。本模块负责维持这条会话，供 news.ts 等在直连被拦时降级使用。
 *
 * 登录协议（自前端 bundle 逆向并实测比对，密文逐字节一致）：
 * - GET /cas/login?service=… → 提取 login-croypto（DES 盐）与 login-page-flowkey（execution）
 * - password = base64(DES-ECB-PKCS7(密码, key=base64decode(croypto)))
 *   Node 的 OpenSSL 禁用了单 DES，用「同一 8 字节密钥重复三次的 3DES-EDE」退化实现
 * - 图形验证码经 tesseract OCR（复用附件下载的常驻 worker，可用
 *   RAPTOR_DISABLE_CAPTCHA_OCR=1 整体停用），识别错自动换码重试
 * - 统一身份认证密码常与教务系统密码不同：.env 的 CAS_PASSWORD 单独指定，
 *   未配置时回退 JWGL_PASSWORD
 */

import crypto from "node:crypto";
import https from "node:https";
import { ocrCaptcha } from "../../core/attachments";
import { config } from "../../core/config";
import { createClient, httpFailure } from "../../core/http";
import { readJsonCache, writeJsonCache } from "../../core/json-cache";

const VPN_BASE = "https://vpn.njtech.edu.cn";
const WWW_BASE = "https://www.njtech.edu.cn";

/**
 * 登录链入口：学校主站首页公开挂着 WebVPN 改写过的 OA 链接，任意一条都能
 * 触发完整的 OAuth 登录链。这里写死一条兜底，运行时优先从主站首页重新提取
 * （学校换 OA 系统时前缀会变，跟着主站走最稳）。
 */
const FALLBACK_ENTRY_PATH =
  "/http/webvpn4316d2d55d852ac02ab0be466491f53c053d9b57bc3717b945dd117252d5fc5d/oa/";

const SESSION_FILE = "webvpn-session.json";
/** 深信服会话有效期不定（数十分钟到数小时），取保守值，过期按需重登 */
const SESSION_TTL_MS = 90 * 60 * 1000;
/** 验证码识别错误自动重试的轮数上限 */
const LOGIN_MAX_ATTEMPTS = 4;

interface VpnSession {
  cookie: string;
  /** jwc 站的 WebVPN 改写前缀，形如 /http/webvpn<64位hex> */
  jwcPrefix: string;
  createdAt: number;
}

let cachedSession: VpnSession | null = null;
let sessionInflight: Promise<VpnSession> | null = null;

// ── 密码加密 ─────────────────────────────────────────────────

/** 统一认证密码加密：DES-ECB-PKCS7，密钥为页面 login-croypto 的 base64 解码 */
export function encryptCasPassword(saltBase64: string, password: string): string {
  const key = Buffer.from(saltBase64, "base64");
  if (key.length !== 8) throw new Error(`croypto 盐长度异常（${key.length} 字节）`);
  // OpenSSL 3 移除了单 DES：三段同密钥的 3DES-EDE 在数学上退化为单 DES，
  // PKCS7 填充与 crypto-js 的 DES.encrypt(..., {mode: ECB, padding: Pkcs7}) 一致
  const cipher = crypto.createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null);
  return Buffer.concat([cipher.update(password, "utf8"), cipher.final()]).toString("base64");
}

// ── 底层请求（登录链专用：跨域重定向要逐步跟、要看每一跳）──────

interface RawResp {
  status: number;
  location?: string;
  buf: Buffer;
  body: string;
}

const jar = new Map<string, string>();

function rawRequest(
  url: string,
  opts: { method?: string; body?: string; referer?: string } = {},
): Promise<RawResp> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Cookie: [...jar.values()].join("; "),
    };
    if (opts.referer) headers.Referer = opts.referer;
    if (opts.body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers.Origin = `${u.protocol}//${u.host}`;
    }
    const req = https.request(
      { method: opts.method ?? "GET", hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        for (const c of res.headers["set-cookie"] ?? []) {
          const kv = c.split(";")[0];
          const eq = kv.indexOf("=");
          if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.trim());
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            buf,
            body: buf.toString("utf8"),
          });
        });
      },
    );
    req.setTimeout(20_000, () => req.destroy(new Error(`WebVPN 请求超时：${url.slice(0, 80)}`)));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** 手动跟重定向（登录链有跨域跳板，得让 cookie 逐跳累积） */
async function followRedirects(
  url: string,
  maxHops = 15,
): Promise<{ resp: RawResp; lastUrl: string }> {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const resp = await rawRequest(current);
    if (resp.status >= 300 && resp.status < 400 && resp.location) {
      current = new URL(resp.location, current).href;
      continue;
    }
    return { resp, lastUrl: current };
  }
  throw new Error("WebVPN 登录链重定向超过上限");
}

// ── 登录 ─────────────────────────────────────────────────────

/** 从主站首页提取 WebVPN 改写入口（完整改写路径，含站点子路径），失败回落写死的兜底值 */
async function resolveEntryPath(): Promise<string> {
  try {
    const home = await rawRequest(`${WWW_BASE}/`);
    const m = home.body.match(/vpn\.njtech\.edu\.cn(\/http\/webvpn[0-9a-f]+\/[^"'\s]*)/);
    if (m) return m[1];
  } catch {
    /* 主站不可达时用兜底 */
  }
  return FALLBACK_ENTRY_PATH;
}

function casPassword(): string {
  // 统一身份认证（信息门户/WebVPN）密码与正方教务系统密码可能不同：
  // CAS_PASSWORD 显式指定，缺省尝试教务密码
  return config.casPassword || config.jwglPassword;
}

/** 验证码识别函数（默认走 tesseract 常驻 worker；测试注入替身用） */
let captchaSolver: (buf: Buffer) => Promise<string> = ocrCaptcha;

/** @internal 仅为测试注入替身使用 */
export function _setCaptchaSolverForTest(solver: (buf: Buffer) => Promise<string>): void {
  captchaSolver = solver;
}

/**
 * 登录统一身份认证并走完 OAuth 回调，落得 WebVPN 会话 cookie。
 * 验证码识别错误自动换码重试；密码错误抛出可操作的配置指引。
 */
async function loginWebvpn(username: string, password: string): Promise<void> {
  const entry = await resolveEntryPath();
  const { resp: loginPage, lastUrl: casUrl } = await followRedirects(`${VPN_BASE}${entry}`);

  const croypto = loginPage.body.match(/id="login-croypto"[^>]*>([^<]*)</)?.[1]?.trim() ?? "";
  const flowkey = loginPage.body.match(/id="login-page-flowkey"[^>]*>([^<]*)</)?.[1]?.trim() ?? "";
  if (!croypto || !flowkey) {
    throw new Error("统一身份认证登录页结构变化：未找到 croypto/flowkey");
  }

  let lastError = "未能登录统一身份认证";
  for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt++) {
    // 验证码图与登录页必须同一会话（cookie 里绑定了答案）
    const captchaUrl = `${new URL(casUrl).origin}/cas/api/captcha/generate/DEFAULT`;
    const code = await captchaSolver((await rawRequest(captchaUrl, { referer: casUrl })).buf);
    if (!code) {
      lastError = "验证码识别失败";
      continue;
    }

    const form = new URLSearchParams({
      username,
      type: "UsernamePassword",
      _eventId: "submit",
      geolocation: "",
      execution: flowkey,
      // 页面里可见输入框与隐藏 input 同名，浏览器提交两份，照抄
      captcha_code: code,
      croypto,
      password: encryptCasPassword(croypto, password),
    });
    form.append("captcha_code", code);
    const post = await rawRequest(casUrl, {
      method: "POST",
      body: form.toString(),
      referer: casUrl,
    });

    if (post.status >= 300 && post.status < 400 && post.location) {
      const { lastUrl } = await followRedirects(new URL(post.location, casUrl).href);
      if (new URL(lastUrl).hostname === "vpn.njtech.edu.cn") return;
      lastError = "登录后未回到 WebVPN（回调链意外中断）";
      continue;
    }

    // 200 = 登录被拒，页面上有原因（可见错误会渲染在响应里）
    const page = post.body;
    if (/密码错误|账号或密码|用户名或密码/.test(page)) {
      throw new Error(
        "统一身份认证密码不正确：WebVPN 需要信息门户密码，与教务系统密码可能不同。" +
          "请在 .env 里配置 CAS_PASSWORD 后重试。",
      );
    }
    if (/锁定/.test(page)) {
      throw new Error("统一身份认证账号已被锁定，请稍后再试或到信息门户解锁");
    }
    lastError = /验证码/.test(page) ? "验证码识别错误" : `登录被拒（HTTP ${post.status}）`;
  }
  throw new Error(`WebVPN 登录失败：${lastError}（已重试 ${LOGIN_MAX_ATTEMPTS} 次）`);
}

// ── jwc 前缀发现 ─────────────────────────────────────────────

/** 在 WebVPN 门户里定位教务处站的改写前缀；找不到给出手动配置指引 */
async function discoverJwcPrefix(): Promise<string> {
  const manual = process.env.WEBVPN_JWC_PREFIX?.trim();
  if (manual) return manual.startsWith("/") ? manual : `/${manual}`;

  const candidates = [`${VPN_BASE}/`, `${VPN_BASE}/enclient/`];
  for (const url of candidates) {
    try {
      const page = await rawRequest(url);
      // 应用卡片形如 <a href="/http/webvpn<hash>/…">教务处…</a>，
      // 或链接文本/图标名里带 jwc；扫全部改写链接挑出 jwc 相关的那条
      for (const m of page.body.matchAll(
        /(\/http\/webvpn[0-9a-f]+)\/[^"'>]*["'][^>]*>([^<]{0,60})/g,
      )) {
        if (/jwc|教务处/i.test(m[2])) return m[1];
      }
      const any = page.body.match(/(\/http\/webvpn[0-9a-f]+)\/[^"'>]*jwc[^"'>]*/i);
      if (any) return any[1];
    } catch {
      /* 试下一个入口 */
    }
  }
  throw new Error(
    "未能在 WebVPN 门户定位教务处站点入口，可设置环境变量 WEBVPN_JWC_PREFIX" +
      "（形如 /http/webvpn<64位hex>）手动指定",
  );
}

// ── 会话管理 ─────────────────────────────────────────────────

function sessionValid(s: unknown): s is VpnSession {
  const v = s as VpnSession | null;
  return (
    !!v &&
    typeof v.cookie === "string" &&
    v.cookie.length > 0 &&
    typeof v.jwcPrefix === "string" &&
    /^\/http\/webvpn[0-9a-f]+$/.test(v.jwcPrefix) &&
    typeof v.createdAt === "number" &&
    Date.now() - v.createdAt < SESSION_TTL_MS
  );
}

async function establishSession(): Promise<VpnSession> {
  if (!config.jwglUsername) {
    throw new Error("尚未配置学号（JWGL_USERNAME），无法登录 WebVPN");
  }
  jar.clear();
  await loginWebvpn(config.jwglUsername, casPassword());
  const session: VpnSession = {
    cookie: [...jar.values()].join("; "),
    jwcPrefix: await discoverJwcPrefix(),
    createdAt: Date.now(),
  };
  writeJsonCache(SESSION_FILE, session, "webvpn");
  return session;
}

/** 取 WebVPN 会话（进程内缓存 → 磁盘缓存 → 登录） */
export async function getWebvpnSession(force = false): Promise<VpnSession> {
  if (force) {
    cachedSession = null;
    sessionInflight = null;
  }
  if (cachedSession) return cachedSession;
  const stored = readJsonCache(SESSION_FILE, sessionValid);
  if (stored) {
    cachedSession = stored;
    return stored;
  }
  if (!sessionInflight) {
    sessionInflight = establishSession()
      .then((s) => {
        cachedSession = s;
        return s;
      })
      .finally(() => {
        sessionInflight = null;
      });
  }
  return sessionInflight;
}

/** 丢弃会话（会话被服务端判定失效时调用，下次访问重新登录） */
export function invalidateWebvpnSession(): void {
  cachedSession = null;
}

// ── 代理抓取 ─────────────────────────────────────────────────

/** 判断响应是否是「被踢回登录」的会话失效形态 */
function looksLikeLoginPage(body: string): boolean {
  return body.includes('id="login-croypto"') || body.includes("统一身份认证平台");
}

/**
 * 经 WebVPN 抓取 jwc 站点路径（如 /index/ggtz.htm）。
 * 会话失效时自动重登一次；二次失败如实抛错。
 */
export async function webvpnFetchJwc(path: string): Promise<string> {
  const fetchWith = async (session: VpnSession): Promise<string> => {
    // 走 core/http 的客户端：享受全局限速，避免和教务请求互相挤压
    const client = createClient(VPN_BASE, session.cookie);
    const resp = await client.req(`${session.jwcPrefix}${path}`);
    const body = resp.body ?? "";
    // 会话过期会被 302 踢回统一认证登录页（或跟不完那条跳板链）——
    // 两种形态都按「会话失效」处理，触发重登
    const failure = httpFailure(resp);
    if (failure && !/重定向次数超过上限/.test(failure)) {
      throw new Error(`WebVPN 抓取失败：${failure}`);
    }
    if (looksLikeLoginPage(body)) throw new Error("WebVPN 会话已失效");
    return body;
  };

  try {
    return await fetchWith(await getWebvpnSession());
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("会话已失效")) throw e;
    invalidateWebvpnSession();
    return fetchWith(await getWebvpnSession(true));
  }
}

// ── URL 映射 ─────────────────────────────────────────────────

/** 公网 jwc URL → 站内路径（供代理抓取用）；非 jwc 域返回 null */
export function jwcUrlToPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "jwc.njtech.edu.cn") return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

/** WebVPN 改写 URL → 公网 jwc URL；非改写链接原样返回 */
export function webvpnUrlToPublic(url: string): string {
  const m = url.match(/^https:\/\/vpn\.njtech\.edu\.cn(\/http\/webvpn[0-9a-f]+)(\/.*)$/);
  if (!m) return url;
  return `https://jwc.njtech.edu.cn${m[2]}`;
}
