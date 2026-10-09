/**
 * 教务 HTTP 客户端的地址解析与传输协议
 *
 * 两处都是为「正方部署在子路径 + 只开 HTTP」的学校（如南京邮电大学通达学院
 * http://jwxt.nytdc.edu.cn/jwglxt）修的真实缺陷，且必须不改变 NJTECH/HEBAU
 * 这类「无子路径、HTTPS」部署的行为：
 *
 * 1. base 自带上下文路径时，以 / 开头的请求路径曾把上下文整个丢掉
 *    （new URL("/xtgl/x", ".../jwglxt") → 站点根 /xtgl/x，实测 404 空响应）
 * 2. base 自带上下文路径时，302 Location 曾按字符串拼接 → /jwglxt/jwglxt/...
 *
 * 全部离线：用本机 http.createServer 起临时站点，不打真实教务系统。
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

const { createClient } = await import("../src/core/http");

/** 起一个记录请求路径的临时站点；returns 端口与收到的路径列表 */
async function startSite(handler: (path: string, res: http.ServerResponse) => void) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    handler(req.url ?? "", res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("子路径部署：请求路径接在上下文之后，不被丢到站点根", async () => {
  const site = await startSite((_path, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  try {
    const client = createClient(`http://127.0.0.1:${site.port}/jwglxt`);
    const r = await client.req("/xtgl/login_slogin.html");
    assert.equal(r.status, 200);
    assert.equal(r.body, "ok");
    assert.deepEqual(site.seen, ["/jwglxt/xtgl/login_slogin.html"]);
  } finally {
    await site.close();
  }
});

test("无子路径部署：行为与从前一致（不带前缀）", async () => {
  const site = await startSite((_path, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  try {
    const client = createClient(`http://127.0.0.1:${site.port}`);
    await client.req("/xtgl/login_slogin.html");
    assert.deepEqual(site.seen, ["/xtgl/login_slogin.html"]);
  } finally {
    await site.close();
  }
});

test("明文 HTTP 可用（正方有只开 HTTP 的部署，客户端曾写死 https）", async () => {
  const site = await startSite((_path, res) => {
    res.writeHead(200);
    res.end("plain-http-ok");
  });
  try {
    const client = createClient(`http://127.0.0.1:${site.port}`);
    const r = await client.req("/ping");
    assert.equal(r.error, undefined);
    assert.equal(r.body, "plain-http-ok");
  } finally {
    await site.close();
  }
});

test("子路径部署：302 Location 按站点根解析，不拼出双前缀", async () => {
  const site = await startSite((path, res) => {
    if (path === "/jwglxt/start") {
      res.writeHead(302, { Location: "/jwglxt/next" });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end(path);
  });
  try {
    const client = createClient(`http://127.0.0.1:${site.port}/jwglxt`);
    const r = await client.req("/start");
    assert.equal(r.status, 200);
    assert.equal(r.body, "/jwglxt/next");
    assert.deepEqual(site.seen, ["/jwglxt/start", "/jwglxt/next"]);
  } finally {
    await site.close();
  }
});

test("302 相对 Location 按 base 目录解析", async () => {
  const site = await startSite((path, res) => {
    if (path === "/jwglxt/a/start") {
      res.writeHead(302, { Location: "next.jsp" });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end(path);
  });
  try {
    const client = createClient(`http://127.0.0.1:${site.port}/jwglxt/a`);
    const r = await client.req("/start");
    assert.equal(r.body, "/jwglxt/a/next.jsp");
  } finally {
    await site.close();
  }
});
