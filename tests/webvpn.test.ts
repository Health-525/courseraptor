/**
 * WebVPN 降级通道测试（njtech/webvpn + news 阶梯）
 *
 * 背景：2026-09 起教务处官网限制仅校内 IP，校外直连只剩「本网站只能被
 * 校内IP地址访问」拦截页。这里钉住三件事：
 * 1. 统一认证密码加密与真实浏览器密文逐字节一致（自登录页 bundle 逆向）；
 * 2. 直连被拦时自动降级 WebVPN，通知列表照常解析、链接映射回公网地址；
 * 3. WebVPN 也失败时回退落盘缓存快照，并把 staleAt 如实上报。
 * 直连替身走 global fetch（news 直连统一用 core/http 的 fetchUrlText），
 * WebVPN 登录链替身仍是 https.request。全程进程内替身，不联网、不跑真 OCR。
 */

// 配置在模块加载期就读环境变量（config 是 import 时求值的单例），
// 必须先设好再动态导入应用模块；node 内置模块不受影响
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-webvpn-"));
process.env.CAS_PASSWORD = "cas-pass-123";
process.env.JWGL_USERNAME = "202321144057";
process.env.JWGL_PASSWORD = "jwgl-pass";

const { fetchJwcNews, fetchJwcNewsDetailed } = await import("../src/adapters/njtech/news");
const {
  _setCaptchaSolverForTest,
  encryptCasPassword,
  invalidateWebvpnSession,
  jwcUrlToPath,
  webvpnUrlToPublic,
} = await import("../src/adapters/njtech/webvpn");
const { writeJsonCache } = await import("../src/core/json-cache");

/** 会话与通知缓存都落在测试数据目录，逐例清理避免互相串扰 */
function resetSessionState(): void {
  invalidateWebvpnSession();
  fs.rmSync(path.join(process.env.RAPTOR_DATA_DIR!, "webvpn-session.json"), { force: true });
  fs.rmSync(path.join(process.env.RAPTOR_DATA_DIR!, "jwc-news-cache.json"), { force: true });
}

// ── 纯函数 ───────────────────────────────────────────────────

test("统一认证密码加密与真实浏览器密文一致（2026-09-24 抓包钉住）", () => {
  // croypto=wZKr1gt/Dcg= + 密码 @Jiangshu.6 → 浏览器 crypto-js 发出的密文
  assert.equal(encryptCasPassword("wZKr1gt/Dcg=", "@Jiangshu.6"), "UAoqdnMEiYp+bty0G78tVg==");
});

test("WebVPN 改写 URL 与公网 URL 互相映射", () => {
  const rewritten =
    "https://vpn.njtech.edu.cn/http/webvpna1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90/info/1157/6912.htm";
  assert.equal(webvpnUrlToPublic(rewritten), "https://jwc.njtech.edu.cn/info/1157/6912.htm");
  // 非改写链接原样返回
  assert.equal(
    webvpnUrlToPublic("https://jwc.njtech.edu.cn/index/ggtz.htm"),
    "https://jwc.njtech.edu.cn/index/ggtz.htm",
  );

  assert.equal(jwcUrlToPath("https://jwc.njtech.edu.cn/info/1157/6912.htm"), "/info/1157/6912.htm");
  assert.equal(
    jwcUrlToPath("https://jwc.njtech.edu.cn/article.jsp?urltype=news.NewsContentUrl&wbnewsid=1"),
    "/article.jsp?urltype=news.NewsContentUrl&wbnewsid=1",
  );
  assert.equal(jwcUrlToPath("https://other.njtech.edu.cn/x"), null);
});

// ── 网络替身 ─────────────────────────────────────────────────

const BLOCK_PAGE = "<html><body>本网站只能被校内IP地址访问，校外地址无法访问该网站</body></html>";

const LIST_HTML = `<ul class="my-list">
<li><a href="../info/1157/6912.htm">关于2026年下半年全国大学英语四、六级考试报名的通知</a><span class="date">2026-09-16</span></li>
<li><a href="/article.jsp?urltype=news.NewsContentUrl&wbtreeid=1157&wbnewsid=6928">关于期中考试安排的通知</a><span class="date">2026-09-15</span></li>
</ul>`;

const ENTRY_HASH = "4316d2d55d852ac02ab0be466491f53c053d9b57bc3717b945dd117252d5fc5d";
const JWC_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
// base64("abcd1234")：解码正好 8 字节，是合法 DES 盐
const CRYPTO_SALT = "YWJjZDEyMzQ=";

const httpsMod = https as unknown as { get: unknown; request: unknown };
const originalGet = httpsMod.get;
const originalRequest = httpsMod.request;

function restoreHttp(): void {
  httpsMod.get = originalGet;
  httpsMod.request = originalRequest;
  restoreDirectFetch();
}

const originalFetch = globalThis.fetch;

function restoreDirectFetch(): void {
  globalThis.fetch = originalFetch;
}

/** 直连（global fetch）一律返回校外拦截页（HTTP 200 + 页面签名） */
function installDirectBlocked(): void {
  globalThis.fetch = (async () => ({
    status: 200,
    ok: true,
    text: async () => BLOCK_PAGE,
  })) as unknown as typeof fetch;
}

/** 直连（global fetch）正常返回给定页面 */
function installDirectOk(body: string): void {
  globalThis.fetch = (async () => ({
    status: 200,
    ok: true,
    text: async () => body,
  })) as unknown as typeof fetch;
}

interface ScriptedResp {
  status?: number;
  location?: string;
  setCookie?: string[];
  body?: string;
}

/**
 * https.request 替身：按 method/url/cookie 路由脚本化响应，
 * 串起完整 WebVPN 登录链（入口→CAS→验证码→POST→回调→门户→代理抓取）。
 */
function installWebvpnScript(
  script: (method: string, url: string, cookie: string) => ScriptedResp,
): void {
  httpsMod.request = ((
    opts: { method?: string; hostname?: string; path?: string; headers?: Record<string, string> },
    cb: (res: EventEmitter) => void,
  ) => {
    const method = opts.method ?? "GET";
    const url = `https://${opts.hostname}${opts.path}`;
    const cookie = opts.headers?.Cookie ?? "";
    const spec = script(method, url, cookie);
    const res = new EventEmitter();
    Object.assign(res, {
      statusCode: spec.status ?? 200,
      headers: {
        ...(spec.location ? { location: spec.location } : {}),
        ...(spec.setCookie ? { "set-cookie": spec.setCookie } : {}),
      },
    });
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: () => void;
      write: () => void;
      end: () => void;
    };
    req.setTimeout = () => {};
    req.write = () => {};
    req.end = () => {};
    queueMicrotask(() => {
      cb(res);
      res.emit("data", Buffer.from(spec.body ?? "", "utf8"));
      res.emit("end");
    });
    return req;
  }) as unknown;
}

/** 脚本：一次成功的 WebVPN 登录 + jwc 前缀发现 + 代理页面（按 cookie 区分登录前后） */
function happyPathScript(method: string, url: string, cookie: string): ScriptedResp {
  if (url.startsWith("https://www.njtech.edu.cn/")) {
    return { body: `<a href="https://vpn.njtech.edu.cn/http/webvpn${ENTRY_HASH}/oa/">OA</a>` };
  }
  if (url.includes(`/http/webvpn${ENTRY_HASH}/oa`)) {
    // 已持有 TWFID 说明登录完成，直接给内容页；否则跳去 CAS
    return cookie.includes("TWFID")
      ? { body: "<html>OA 首页</html>" }
      : { status: 302, location: "https://sfgl.njtech.edu.cn/cas/login?service=oauth" };
  }
  if (url.startsWith("https://sfgl.njtech.edu.cn/cas/login")) {
    if (method === "POST") {
      return {
        status: 302,
        location: "https://vpn.njtech.edu.cn/enclient/api/users/auth/oauth/callback?code=x",
      };
    }
    return {
      body: `<p id="login-croypto">${CRYPTO_SALT}</p><p id="login-page-flowkey">flow-key-1</p><p id="captcha-url"></p>`,
    };
  }
  if (url.includes("/cas/api/captcha/generate/DEFAULT")) {
    return { body: "fake-png-bytes" };
  }
  if (url.includes("/enclient/api/users/auth/oauth/callback")) {
    return {
      status: 302,
      location: `https://vpn.njtech.edu.cn/http/webvpn${ENTRY_HASH}/oa/`,
      setCookie: ["TWFID=abc"],
    };
  }
  if (url === "https://vpn.njtech.edu.cn/" || url.includes("/enclient/")) {
    return { body: `<a href="/http/webvpn${JWC_HASH}/index/">教务处</a>` };
  }
  if (url.includes(`/http/webvpn${JWC_HASH}/`)) {
    return { body: LIST_HTML };
  }
  return { status: 404, body: "" };
}

// ── 集成：直连被拦 → WebVPN 降级 ─────────────────────────────

test("校外直连被拦截页命中时，经 WebVPN 抓取列表并映射回公网链接", async () => {
  resetSessionState();
  _setCaptchaSolverForTest(async () => "ab31");
  installDirectBlocked();
  installWebvpnScript(happyPathScript);
  try {
    const result = await fetchJwcNewsDetailed([], 30);
    assert.equal(result.via, "webvpn", "应当标记为 webvpn 通道");
    assert.ok(result.items.length >= 2, `应解析出条目，实际 ${result.items.length}`);
    for (const item of result.items) {
      assert.match(item.url, /^https:\/\/jwc\.njtech\.edu\.cn\//, "对外链接必须是公网地址");
    }
    const restricted = result.items.find((i) => i.url.includes("article.jsp"));
    assert.equal(restricted?.restricted, true, "article.jsp 条目仍要标 restricted");
    // 成功后应落缓存，供下次失败兜底
    assert.ok(
      fs.existsSync(path.join(process.env.RAPTOR_DATA_DIR!, "jwc-news-cache.json")),
      "成功抓取后应写缓存",
    );
  } finally {
    restoreHttp();
    resetSessionState();
  }
});

test("WebVPN 登录密码错误时抛出可操作的 CAS_PASSWORD 指引", async () => {
  resetSessionState();
  _setCaptchaSolverForTest(async () => "ab31");
  installDirectBlocked();
  installWebvpnScript((method, url, cookie) => {
    if (url.startsWith("https://sfgl.njtech.edu.cn/cas/login") && method === "POST") {
      return { status: 200, body: "密码错误，请确认后重新输入" };
    }
    return happyPathScript(method, url, cookie);
  });
  try {
    await assert.rejects(fetchJwcNewsDetailed([], 30), /CAS_PASSWORD|统一身份认证密码/);
  } finally {
    restoreHttp();
    resetSessionState();
  }
});

test("直连与 WebVPN 双失败时回退缓存快照并带 staleAt", async () => {
  resetSessionState();
  writeJsonCache(
    "jwc-news-cache.json",
    {
      tag: "jwc-news",
      items: [
        {
          title: "缓存的旧通知标题",
          url: "https://jwc.njtech.edu.cn/info/1/1.htm",
          date: "2026-09-01",
        },
      ],
      fetchedAt: Date.now() - 3600_000,
    },
    "test",
  );
  installDirectBlocked();
  installWebvpnScript(() => ({ status: 500, body: "" }));
  try {
    const result = await fetchJwcNewsDetailed([], 30);
    assert.ok(result.staleAt, "必须带 staleAt 标记缓存快照身份");
    assert.equal(result.items[0].title, "缓存的旧通知标题");
    // 兼容契约：fetchJwcNews 失败也不抛错
    const items = await fetchJwcNews([], 30);
    assert.equal(items[0].title, "缓存的旧通知标题");
  } finally {
    restoreHttp();
    resetSessionState();
  }
});

test("直连可用时优先直连，不触发 WebVPN 登录", async () => {
  resetSessionState();
  let webvpnTouched = false;
  installDirectOk(LIST_HTML);
  installWebvpnScript(() => {
    webvpnTouched = true;
    return { status: 500, body: "" };
  });
  try {
    const result = await fetchJwcNewsDetailed([], 30);
    assert.equal(result.via, "direct");
    assert.equal(webvpnTouched, false, "直连成功时不应碰 WebVPN");
  } finally {
    restoreHttp();
    resetSessionState();
  }
});
