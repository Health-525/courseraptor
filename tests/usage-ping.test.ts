/**
 * 匿名使用上报客户端（src/core/usage-ping.ts）：
 * 地址未配置/关闭开关 no-op、24h 节流、设备号稳定、失败静默。
 * 注意：模块在 import 时定死缓存路径，RAPTOR_DATA_DIR 必须先于 import 设置。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-usage-ping-"));
// 缓存路径在模块加载时解析，RAPTOR_DATA_DIR 必须先于 import 就位
process.env.RAPTOR_DATA_DIR = dataDir;

test.beforeEach(() => {
  delete process.env.RAPTOR_TELEMETRY_URL;
  delete process.env.RAPTOR_NO_TELEMETRY;
});
test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const { pingUsage, getTelemetryUrl } = await import("../src/core/usage-ping");

const CACHE_FILE = path.join(dataDir, "usage-ping.json");

type FetchCall = { url: string; init: RequestInit };
function stubFetch(result: "ok" | "fail") {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    if (result === "fail") throw new Error("network down");
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function resetCache(entry?: { id: string; lastPing: number }) {
  if (entry) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry));
  } else {
    fs.rmSync(CACHE_FILE, { force: true });
  }
}

test("getTelemetryUrl：源码占位符未替换时为空；env 可覆盖", () => {
  assert.equal(getTelemetryUrl(), "");
  process.env.RAPTOR_TELEMETRY_URL = "http://example.com/ping/";
  assert.equal(getTelemetryUrl(), "http://example.com/ping", "尾斜杠应剥掉");
});

test("未配置上报地址：整体 no-op，不产生任何网络请求", async (t) => {
  resetCache();
  const fetchStub = stubFetch("ok");
  t.after(fetchStub.restore);
  await pingUsage();
  assert.equal(fetchStub.calls.length, 0);
  assert.equal(fs.existsSync(CACHE_FILE), false, "no-op 时不应写状态文件");
});

test("RAPTOR_NO_TELEMETRY=1：即使配了地址也不上报", async (t) => {
  process.env.RAPTOR_TELEMETRY_URL = "http://example.com/ping";
  process.env.RAPTOR_NO_TELEMETRY = "1";
  resetCache();
  const fetchStub = stubFetch("ok");
  t.after(fetchStub.restore);
  await pingUsage();
  assert.equal(fetchStub.calls.length, 0);
});

test("首次上报：生成随机设备号并发出预期载荷；设备号随后保持稳定", async (t) => {
  process.env.RAPTOR_TELEMETRY_URL = "http://example.com/ping";
  resetCache();
  const fetchStub = stubFetch("ok");
  t.after(fetchStub.restore);

  await pingUsage("tui");
  assert.equal(fetchStub.calls.length, 1);
  const body = JSON.parse(String(fetchStub.calls[0].init.body)) as Record<string, string>;
  assert.match(body.id, /^[0-9a-f-]{36}$/, "设备号应是随机 UUID");
  assert.equal(typeof body.version, "string");
  assert.equal(body.channel, "tui");
  assert.equal(body.platform, process.platform);

  // 24h 节流：同一天内第二次启动不再发
  await pingUsage("tui");
  assert.equal(fetchStub.calls.length, 1);

  // 设备号写进了缓存且稳定
  const state = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as { id: string };
  assert.equal(state.id, body.id);
});

test("24h 节流：缓存里 lastPing 刚刚记过则直接跳过", async (t) => {
  process.env.RAPTOR_TELEMETRY_URL = "http://example.com/ping";
  resetCache({ id: "01234567-89ab-cdef-0123-456789abcdef", lastPing: Date.now() - 60_000 });
  const fetchStub = stubFetch("ok");
  t.after(fetchStub.restore);
  await pingUsage();
  assert.equal(fetchStub.calls.length, 0);
});

test("网络失败：静默不抛错，且不记 24h 节流（下次启动重试）", async (t) => {
  process.env.RAPTOR_TELEMETRY_URL = "http://example.com/ping";
  resetCache({ id: "01234567-89ab-cdef-0123-456789abcdef", lastPing: 0 });
  const fetchStub = stubFetch("fail");
  t.after(fetchStub.restore);
  await pingUsage(); // 不应 reject
  assert.equal(fetchStub.calls.length, 1);
  const state = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as { lastPing: number };
  assert.equal(state.lastPing, 0, "失败不更新节流时间戳");
});
