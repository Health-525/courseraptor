/**
 * 教务协议层 HTTP 客户端测试（jwgl/http）
 *
 * 这层是全部教务查询的地基：错误契约（「失败必须可见」）、Cookie 吸收、
 * 重定向上限、跨 chunk 中文合并、全局令牌桶节流。此前零测试——上面任何
 * 一条失灵，都会被上游解析层吞成「课表为空」式误报（本文件头注释里
 * http.ts 自述踩过的坑）。https.request 用进程内 mock 替身，不联网。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HttpResponse } from "../src/core/http";
import { createClient, fetchJson, httpFailure, setRateLimit } from "../src/core/http";

// ── mock：一次 req() 对应一次 respond()，记录请求头供断言 ─────────

interface MockSpec {
  status: number;
  headers?: Record<string, string | string[] | undefined>;
  chunks?: Buffer[];
  networkError?: string;
}

const httpsMod = https as unknown as { request: unknown };

function installMock(respond: () => MockSpec) {
  const original = httpsMod.request;
  const seen: Array<{ method?: string; path?: string; headers?: Record<string, unknown> }> = [];
  httpsMod.request = ((opts: Record<string, unknown>, cb: (res: EventEmitter) => void) => {
    seen.push({
      method: opts.method as string,
      path: opts.path as string,
      headers: opts.headers as Record<string, unknown>,
    });
    const spec = respond();
    const res = new EventEmitter();
    Object.assign(res, {
      statusCode: spec.status,
      headers: spec.headers ?? {},
    });
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: (ms: number, fn: () => void) => void;
      write: (b: string) => void;
      end: () => void;
    };
    req.setTimeout = () => {};
    req.write = () => {};
    req.end = () => {
      queueMicrotask(() => {
        if (spec.networkError) {
          req.emit("error", new Error(spec.networkError));
          return;
        }
        for (const c of spec.chunks ?? [Buffer.from("")]) res.emit("data", c);
        res.emit("end");
      });
    };
    cb(res);
    return req;
  }) as unknown;
  return {
    restore: () => {
      httpsMod.request = original;
    },
    seen,
  };
}

// 节流是进程级共享状态：每个用例前后都把桶恢复到宽裕档，避免互相污染
const looseRate = () => setRateLimit(10_000, 10_000);

test("初始 Cookie 原样保留（含 path 等属性段）", () => {
  looseRate();
  const c = createClient("https://jwgl.example.edu.cn", "a=1; path=/; b=2");
  assert.equal(c.getCookie(), "a=1; path=/; b=2");
});

test("Set-Cookie 被吸收进后续请求，同名键覆盖、异名键并存", async () => {
  looseRate();
  let call = 0;
  const mock = installMock(() => {
    call++;
    if (call === 1) {
      return {
        status: 200,
        headers: {
          "set-cookie": ["JSESSIONID=xyz; Path=/; HttpOnly", "TICKET=t1; Path=/"],
        },
      };
    }
    return { status: 200 };
  });
  try {
    const c = createClient("https://jwgl.example.edu.cn");
    await c.req("/a");
    await c.req("/b");
    const cookie2 = mock.seen[1]?.headers?.Cookie as string;
    assert.ok(cookie2.includes("JSESSIONID=xyz"), "新 cookie 必须随后续请求带回去");
    assert.ok(cookie2.includes("TICKET=t1"), "多个 Set-Cookie 都要吸收");
    assert.equal(c.getCookie().includes("JSESSIONID=xyz"), true);
  } finally {
    mock.restore();
  }
});

test("跨 chunk 边界的中文合并成完整字符串，不出现替换符", async () => {
  looseRate();
  // "中文" 的 UTF-8 六个字节硬拆三块，模拟网络分片
  const mid = {
    status: 200,
    chunks: [Buffer.from([0xe4, 0xb8]), Buffer.from([0xad, 0xe6, 0x96]), Buffer.from([0x87])],
  };
  const mock = installMock(() => mid);
  try {
    const c = createClient("https://jwgl.example.edu.cn");
    const r = await c.req("/x");
    assert.equal(r.body, "中文");
    assert.equal(r.body.includes("\uFFFD"), false);
  } finally {
    mock.restore();
  }
});

test("错误契约：302 缺 Location / 重定向超上限 / 5xx / 网络错误都写进 error", async () => {
  looseRate();
  // 302 缺 Location：正方会话失效的典型形状
  const mock301 = installMock(() => ({ status: 302, headers: {} }));
  let r: HttpResponse;
  const c = createClient("https://jwgl.example.edu.cn");
  try {
    r = await c.req("/expire");
  } finally {
    mock301.restore();
  }
  assert.ok(r.error?.includes("缺少 Location"), r.error ?? "");
  assert.ok(httpFailure(r), "缺 Location 必须判为失败");

  // 302 带 Location 无限重定向：必须在上限处停
  const mockLoop = installMock(() => ({
    status: 302,
    headers: { location: "/again" },
  }));
  try {
    r = await c.req("/loop");
  } finally {
    mockLoop.restore();
  }
  assert.ok(r.error?.includes("上限"), r.error ?? "");
  assert.equal(mockLoop.seen.length, 6, "1 次原始请求 + 最多 5 次跟随");

  // 5xx：传输层没报错也要在 req 层标失败
  const mock5xx = installMock(() => ({ status: 502 }));
  try {
    r = await c.req("/down");
  } finally {
    mock5xx.restore();
  }
  assert.equal(r.error, "服务端错误 HTTP 502");

  // 网络错误：status 为 0 且带原因，绝不伪装成「拿到了空响应」
  const mockErr = installMock(() => ({ status: 0, networkError: "connect ECONNREFUSED" }));
  try {
    r = await c.req("/net");
  } finally {
    mockErr.restore();
  }
  assert.equal(r.status, 0);
  assert.ok(r.error?.includes("网络错误"), r.error ?? "");
});

test("302 跟随：相对 Location 拼上 baseURL，方法降回 GET", async () => {
  looseRate();
  let call = 0;
  const mock = installMock(() => {
    call++;
    if (call === 1) return { status: 302, headers: { location: "/home" } };
    return { status: 200, chunks: [Buffer.from("ok")] };
  });
  try {
    const c = createClient("https://jwgl.example.edu.cn");
    const r = await c.req("/start", { method: "POST", body: "a=1" });
    assert.equal(r.body, "ok");
    assert.equal(r.status, 200);
    assert.equal(mock.seen[1]?.method, "GET", "重定向跟随按浏览器行为降为 GET");
    assert.equal(mock.seen[1]?.path, "/home", "相对地址要拼上 baseURL");
  } finally {
    mock.restore();
  }
});

test("令牌桶：burst 耗尽后请求被排队限速，不会瞬间打满", { timeout: 10_000 }, async () => {
  // rps=5、burst=1：第 1 个立即走，第 2/3 个各需等约 200ms
  setRateLimit(5, 1);
  const mock = installMock(() => ({ status: 200 }));
  try {
    const c = createClient("https://jwgl.example.edu.cn");
    const t0 = Date.now();
    await Promise.all([c.req("/a"), c.req("/b"), c.req("/c")]);
    const dt = Date.now() - t0;
    // 三个请求但桶里只有 1 个令牌：靠 5/s 的产速补 2 个 ≈ 400ms
    // 下界钉住「确实限速」，上界挡住测试环境抖动造成的误报
    assert.ok(dt >= 300, `应当被限速排队，实际 ${dt}ms`);
    assert.ok(dt < 5000, `不该等太久，实际 ${dt}ms`);
    assert.equal(mock.seen.length, 3);
  } finally {
    mock.restore();
    looseRate();
  }
});

test("httpFailure：error 优先 > 无响应 > 5xx，成功路径返回 null", () => {
  assert.equal(
    httpFailure({ status: 200, body: "", headers: {}, error: "任何人不得覆盖" }),
    "任何人不得覆盖",
  );
  assert.equal(httpFailure({ status: 0, body: "", headers: {} }), "无响应（连接中断）");
  assert.equal(httpFailure({ status: 503, body: "", headers: {} }), "服务端错误 HTTP 503");
  assert.equal(httpFailure({ status: 200, body: "[]", headers: {} }), null);
});

test("fetchJson：传输失败短路解析，解析失败带上下文，成功带数据", async () => {
  // 传输失败：parse 根本不该被调用
  let parsed = 0;
  const fail = await fetchJson(
    async () => ({ status: 0, body: "", headers: {}, error: "网络错误：boom" }),
    () => {
      parsed++;
      return 1;
    },
  );
  assert.equal(fail.ok, false);
  assert.ok((fail as { error: string }).error.includes("网络错误"));
  assert.equal(parsed, 0, "失败必须短路，不许碰解析器");

  // 传输成功但解析失败：错误消息带 HTTP 状态与响应体量
  const bad = await fetchJson(
    async () => ({ status: 200, body: "not-json", headers: {} }),
    (b) => JSON.parse(b) as unknown,
  );
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /响应解析失败.*HTTP 200，响应 8 字节/);

  // 成功路径
  const good = await fetchJson(
    async () => ({ status: 200, body: "[1,2]", headers: {} }),
    (b) => JSON.parse(b) as number[],
  );
  assert.equal(good.ok, true);
  assert.deepEqual((good as { data: number[] }).data, [1, 2]);
});

// 数据目录无关紧要，但保持与其他测试一致的隔离姿势
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-jwgl-http-"));
