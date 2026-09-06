/**
 * 河北农大 HTTP 传输层（CAS 与 URP 共用）
 *
 * 为什么不复用 src/jwgl/http.ts 的 createClient：
 * 那个客户端写死 https、写死正方 jwgl 的 Cookie/Referer 语义，而河北农大是
 * 「http://urp.hebau.edu.cn:1009 + https://cas.hebau.edu.cn」两段式跨主机跳转，
 * 重定向链上必须一路攒 Cookie（CAS 的 TGT、URP 的 GS_SESSIONID 分属不同主机）。
 * 硬塞进单主机客户端会把两边的语义都改脏，所以单独一个薄客户端。
 *
 * 唯一必须共享的是节流令牌桶：礼貌边界和防 WAF 是进程级的，
 * 多开一个客户端不该多出一倍速率，所以从 jwgl/http 借用同一个桶。
 */

import http from "node:http";
import https from "node:https";
import { acquireRequestToken } from "../../jwgl/http";

export const CAS_BASE = "https://cas.hebau.edu.cn";
export const URP_BASE = "http://urp.hebau.edu.cn:1009";
export const URP_HOME = `${URP_BASE}/jwapp/sys/homeapp/index.do`;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 8;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** 传输函数。单测靠它注入假响应，不去打真实教务系统 */
export type Transport = (url: string, opts: RequestOptions) => Promise<RawResponse>;

let transport: Transport = nodeTransport;

/** 仅供测试注入。传 null 恢复真实实现 */
export function setTransportForTest(fn: Transport | null): void {
  transport = fn ?? nodeTransport;
}

function nodeTransport(url: string, opts: RequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method ?? "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/json,text/javascript,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          ...opts.headers,
        },
      },
      (res) => {
        // 逐块 toString 会切断跨块的 UTF-8 中文（课程名/教师名全中文），先攒 Buffer
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", (e) => reject(new Error(`网络错误：${e.message}`)));
    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      req.destroy(new Error(`请求超时（${REQUEST_TIMEOUT_MS}ms）`)),
    );
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Cookie jar ────────────────────────────────────────────────

export class CookieJar {
  private map = new Map<string, string>();

  constructor(initial?: [string, string][]) {
    if (initial) this.map = new Map(initial);
  }

  /** 从 "k=v; k2=v2" 形式的 Cookie 头还原（登录产出的会话串走这条路径回装） */
  static fromHeader(cookie: string): CookieJar {
    const jar = new CookieJar();
    for (const part of (cookie || "").split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    return jar;
  }

  /** 从 Set-Cookie 头吸收（只取 name=value，丢掉 Path/Expires 等属性） */
  absorb(header: string | string[] | undefined): void {
    if (!header) return;
    for (const line of Array.isArray(header) ? header : [header]) {
      const kv = line.split(";")[0];
      const eq = kv.indexOf("=");
      if (eq > 0) this.map.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }

  set(name: string, value: string): void {
    this.map.set(name, value);
  }

  get(name: string): string | undefined {
    return this.map.get(name);
  }

  entries(): [string, string][] {
    return [...this.map.entries()];
  }

  header(): string {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get isEmpty(): boolean {
    return this.map.size === 0;
  }
}

// ── 带 Cookie 与手动重定向的请求 ──────────────────────────────

export interface SessionRequestOptions extends RequestOptions {
  /** 默认跟随重定向（CAS 登录链全靠 302 串起来） */
  followRedirects?: boolean;
}

/**
 * 发一次请求：自动带 jar 里的 Cookie、自动攒 Set-Cookie、手动跟随重定向（有跳数上限）。
 * 重定向时清空自定义 Cookie 头之外的 Host 相关头由调用方自理（这里保留 UA/Accept 等通用头）。
 */
export async function requestWithJar(
  url: string,
  jar: CookieJar,
  opts: SessionRequestOptions = {},
): Promise<RawResponse> {
  await acquireRequestToken();
  const { followRedirects = true, headers = {}, ...rest } = opts;

  const merged: Record<string, string> = { ...headers };
  if (!jar.isEmpty && !merged.Cookie) merged.Cookie = jar.header();

  const resp = await transport(url, { ...rest, headers: merged });
  jar.absorb(resp.headers["set-cookie"]);

  if (!followRedirects) return resp;

  let current = resp;
  let hops = 0;
  let currentUrl = url;
  // Referer 是「发出这次跳转的那个地址」，不是跳转目的地自己
  let referer = url;
  while (current.status >= 300 && current.status < 400 && hops < MAX_REDIRECTS) {
    const loc = current.headers.location;
    const target = Array.isArray(loc) ? loc[0] : loc;
    if (!target) break;
    referer = currentUrl;
    currentUrl = new URL(target, currentUrl).toString();
    hops++;
    await acquireRequestToken();
    // 跨主机跳转不能把上一跳的 Cookie 头硬带过去：Cookie 由 jar 重算，
    // Referer 用发出跳转的地址，其余头保留
    current = await transport(currentUrl, {
      method: "GET",
      headers: { Referer: referer, Cookie: jar.header() },
    });
    jar.absorb(current.headers["set-cookie"]);
  }
  return current;
}

/** 表单 POST 的公共头（正方/URP 的 XHR 接口都要求这一组；Cookie 由 jar 统一提供） */
export function xhrHeaders(referer: string): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: referer,
  };
}
