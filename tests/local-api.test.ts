/**
 * 本地 API 令牌与 Obsidian 插件通道测试
 *
 * 钉住：令牌长期稳定且落盘、写请求「CSRF token 或 x-raptor-token 二选一」、
 * app://obsidian.md 的 Origin 与 CORS 预检放行（恶意网页的 Origin 依旧被
 * 拒）、GET /api/localapi 下发令牌，以及插件式请求（Obsidian origin + 令
 * 牌头）跑通 /api/chat SSE 全链路。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 数据目录指到临时目录：令牌文件与真实数据互不污染
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-localapi-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");

await import("../src/adapters");
const { setChatAgent, startChatWeb } = await import("../src/channels/web/chat-web");
const { localApiToken, OBSIDIAN_ORIGIN } = await import("../src/core/local-api");

/** 直接构造原始请求：Node fetch 会拦自定义 Origin，这里要模拟 Obsidian 客户端 */
function raw(
  url: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? "GET", headers: options.headers ?? {} },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Obsidian 插件式写请求：私有 origin + 本地 API 令牌 */
function obsidianPost(url: string, body: string, token: string) {
  return raw(url, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      origin: OBSIDIAN_ORIGIN,
      "x-raptor-token": token,
    },
  });
}

test("本地 API 令牌：进程内稳定、落盘持久、重新生成后格式合法", async () => {
  const first = localApiToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(localApiToken(), first, "同一进程内多次取值必须一致");

  const file = path.join(process.env.RAPTOR_DATA_DIR!, "local-api.json");
  const saved = (JSON.parse(fs.readFileSync(file, "utf8")) as { token: string }).token;
  assert.equal(saved, first, "令牌必须落盘：插件在服务重启后依然可用");
});

test("GET /api/localapi 下发令牌与实际端口（本机浏览器同源策略挡外站读）", async () => {
  const url = (await startChatWeb())!;
  const res = await raw(`${url}/api/localapi`);
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body) as { token: string; port: number };
  assert.equal(data.token, localApiToken());
  assert.ok(Number.isInteger(data.port) && data.port > 0);
  // 无 CORS 头：恶意网页发得出、读不到，与本地其他接口同防线
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("写请求三态：无令牌 403、错令牌 403、本地 API 令牌放行（原 CSRF 门不动）", async () => {
  const url = (await startChatWeb())!;
  const body = JSON.stringify({ message: "你好" });
  const none = await raw(`${url}/api/chat`, { method: "POST", body });
  assert.equal(none.status, 403, "不带任何令牌：维持原有拒绝行为");
  const wrong = await raw(`${url}/api/chat`, {
    method: "POST",
    body,
    headers: { "x-raptor-token": "0".repeat(64) },
  });
  assert.equal(wrong.status, 403, "错令牌必须拒绝");
  const right = await obsidianPost(`${url}/api/chat`, body, localApiToken());
  // 过了令牌门进入业务处理：此刻 agent 未注入，业务层给 503 而不是 403——
  // 状态码本身证明「正确令牌放行写请求」
  assert.equal(right.status, 503);
});

test("app://obsidian.md 的 OPTIONS 预检 204 且带 CORS 头；恶意网页 Origin 依旧 403", async () => {
  const url = (await startChatWeb())!;
  const preflight = await raw(`${url}/api/chat`, {
    method: "OPTIONS",
    headers: {
      origin: OBSIDIAN_ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type, x-raptor-token",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], OBSIDIAN_ORIGIN);
  assert.match(String(preflight.headers["access-control-allow-headers"]), /x-raptor-token/);

  const evil = await raw(`${url}/api/localapi`, { headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403, "外站 Origin 一律拒绝");
  assert.equal(evil.headers["access-control-allow-origin"], undefined, "不给外站任何 CORS 头");
});

test("端到端：Obsidian 式请求跑通 /api/chat SSE（text → end）", async () => {
  setChatAgent({
    stream() {
      async function* gen() {
        yield { type: "text-delta", text: "你好" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;
  const res = await obsidianPost(
    `${url}/api/chat`,
    JSON.stringify({ message: "你好" }),
    localApiToken(),
  );
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /text\/event-stream/);
  const events = res.body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  assert.deepEqual(
    events
      .filter((e) => e.t === "text")
      .map((e) => e.v)
      .join(""),
    "你好",
  );
  assert.ok(
    events.some((e) => e.t === "end"),
    "流必须以 end 收尾",
  );
});
