/**
 * 教务系统 HTTP 客户端 — 带 Cookie 管理
 * 搬自 timetable/scripts/lib/jwgl-http.js，改为 TypeScript
 */

import https from "https";

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface HttpClient {
  req(urlPath: string, opts?: HttpOptions): Promise<HttpResponse>;
  getCookie(): string;
}

export interface HttpOptions {
  method?: string;
  body?: string;
}

/**
 * 创建带 Cookie 管理的 HTTP 客户端
 * @param baseURL - 教务系统基础 URL (e.g. "https://jwgl.njtech.edu.cn")
 */
export function createClient(baseURL: string): HttpClient {
  const cookieMap = new Map<string, string>();

  function buildCookie(): string {
    return [...cookieMap.values()].join("; ");
  }

  async function req(
    urlPath: string,
    opts: HttpOptions = {}
  ): Promise<HttpResponse> {
    const u = new URL(urlPath, baseURL);

    return new Promise((resolve) => {
      const q = https.request(
        {
          method: opts.method || "GET",
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Cookie: buildCookie(),
            Referer: baseURL,
            ...(opts.body
              ? { "Content-Type": "application/x-www-form-urlencoded" }
              : {}),
          },
        },
        (r) => {
          // Collect cookies from response
          const sc = r.headers["set-cookie"];
          if (sc) {
            sc.forEach((c: string) => {
              const kv = c.split(";")[0];
              const eq = kv.indexOf("=");
              if (eq > 0) {
                cookieMap.set(kv.slice(0, eq).trim(), kv.trim());
              }
            });
          }

          let b = "";
          r.on("data", (c: Buffer) => (b += c.toString()));
          r.on("end", () => {
            // Handle redirects
            if ((r.statusCode ?? 0) >= 300 && (r.statusCode ?? 0) < 400) {
              const l = r.headers.location;
              if (l) {
                const redirectUrl = l.startsWith("http")
                  ? l
                  : baseURL + l;
                return req(redirectUrl, { method: "GET" }).then(resolve);
              }
            }
            resolve({
              status: r.statusCode ?? 0,
              body: b,
              headers: r.headers as Record<string, string | string[] | undefined>,
            });
          });
        }
      );

      q.on("error", (_e: Error) =>
        resolve({ status: 0, body: "", headers: {} })
      );
      q.setTimeout(30000, () => q.destroy());

      if (opts.body) q.write(opts.body);
      q.end();
    });
  }

  return { req, getCookie: buildCookie };
}

/**
 * 创建带预设 Cookie 的 HTTP 客户端
 * @param baseURL - 教务系统基础 URL
 * @param initialCookie - 登录后的 cookie 字符串
 */
export function createClientWithCookie(baseURL: string, initialCookie: string): HttpClient {
  const cookieMap = new Map<string, string>();
  // Parse initial cookie string into map
  initialCookie.split(";").forEach((part) => {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      cookieMap.set(trimmed.slice(0, eq).trim(), trimmed.trim());
    }
  });

  function buildCookie(): string {
    return [...cookieMap.values()].join("; ");
  }

  async function req(
    urlPath: string,
    opts: HttpOptions = {}
  ): Promise<HttpResponse> {
    const u = new URL(urlPath, baseURL);

    return new Promise((resolve) => {
      const q = https.request(
        {
          method: opts.method || "GET",
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Cookie: buildCookie(),
            Referer: baseURL,
            ...(opts.body
              ? { "Content-Type": "application/x-www-form-urlencoded" }
              : {}),
          },
        },
        (r) => {
          const sc = r.headers["set-cookie"];
          if (sc) {
            sc.forEach((c: string) => {
              const kv = c.split(";")[0];
              const eq = kv.indexOf("=");
              if (eq > 0) {
                cookieMap.set(kv.slice(0, eq).trim(), kv.trim());
              }
            });
          }

          let b = "";
          r.on("data", (c: Buffer) => (b += c.toString()));
          r.on("end", () => {
            if ((r.statusCode ?? 0) >= 300 && (r.statusCode ?? 0) < 400) {
              const l = r.headers.location;
              if (l) {
                const redirectUrl = l.startsWith("http")
                  ? l
                  : baseURL + l;
                return req(redirectUrl, { method: "GET" }).then(resolve);
              }
            }
            resolve({
              status: r.statusCode ?? 0,
              body: b,
              headers: r.headers as Record<string, string | string[] | undefined>,
            });
          });
        }
      );

      q.on("error", () =>
        resolve({ status: 0, body: "", headers: {} })
      );
      q.setTimeout(30000, () => q.destroy());

      if (opts.body) q.write(opts.body);
      q.end();
    });
  }

  return { req, getCookie: buildCookie };
}
