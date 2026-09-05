/**
 * Gitee 日历发布测试
 *
 * 全程离线：fetch 注入 stub。钉住的行为——
 * 1. 首次发布：404 建公开仓库（auto_init），订阅链接是 gitee raw 地址（国内直连）；
 * 2. 再次发布：PUT calendar.ics 带旧文件 sha 覆盖，默认分支按仓库实际值（master）；
 * 3. 令牌无效（401/403）：失败并带 needSetup；
 * 4. 同名仓库是私有的：如实报错；
 * 5. 令牌通过 URL 参数 access_token 传递（Gitee v5 的标准鉴权方式）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { publishCalendarToGitee, DEFAULT_CALENDAR_REPO } = await import("../src/gitee-publish");

interface Route {
  match: string;
  status: number;
  body?: unknown;
  method?: string;
}

function stubFetch(routes: Route[]) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    // 无 method 的路由只认 GET；contents 路由排在 repo 路由前避免前缀遮蔽
    const route = routes.find(
      (r) => u.includes(r.match) && (r.method ? r.method === method : method === "GET"),
    );
    if (!route) throw new Error(`未预置的请求：${method} ${u}`);
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      text: async () => (route.body === undefined ? "" : JSON.stringify(route.body)),
    };
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

test("首次发布：建公开仓库、上传日历，订阅链接是 gitee raw 地址", async () => {
  const { impl, calls } = stubFetch([
    { match: "gitee.com/api/v5/user", status: 200, body: { login: "jiangshu" } },
    { match: "/contents/calendar.ics", method: "GET", status: 404, body: { message: "Not Found" } },
    { match: "/contents/calendar.ics", method: "PUT", status: 201, body: { content: {} } },
    {
      match: `/repos/jiangshu/${DEFAULT_CALENDAR_REPO}`,
      method: "GET",
      status: 404,
      body: { message: "Not Found" },
    },
    {
      match: "gitee.com/api/v5/user/repos",
      method: "POST",
      status: 201,
      body: { full_name: "jiangshu/courseraptor-calendar" },
    },
  ]);

  const r = await publishCalendarToGitee({ token: "gitee_token", ics: ICS }, impl);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const d = r.data;
  assert.equal(d.owner, "jiangshu");
  assert.equal(d.created, true);
  // 新仓库默认分支是 master：raw 链接必须用实际分支
  assert.equal(
    d.subscribeUrl,
    `https://gitee.com/jiangshu/${DEFAULT_CALENDAR_REPO}/raw/master/calendar.ics`,
  );
  assert.equal(
    d.webcalUrl,
    `webcal://gitee.com/jiangshu/${DEFAULT_CALENDAR_REPO}/raw/master/calendar.ics`,
  );
  assert.equal(d.repoUrl, `https://gitee.com/jiangshu/${DEFAULT_CALENDAR_REPO}`);

  // 建仓参数：公开 + auto_init
  const create = calls.find((c) => c.url.includes("/user/repos") && c.method === "POST");
  assert.ok(create, "应有建仓请求");
  const createBody = create.body as Record<string, unknown>;
  assert.equal(createBody.private, false);
  assert.equal(createBody.auto_init, true);

  // 鉴权走 URL 参数 access_token（Gitee v5 标准）
  assert.ok(
    calls.every((c) => c.url.includes("access_token=gitee_token")),
    "所有请求都应带 access_token",
  );

  // 日历内容 base64 上传
  const putIcs = calls.find((c) => c.url.includes("/contents/calendar.ics") && c.method === "PUT");
  assert.ok(putIcs, "应有日历上传请求");
  assert.equal(
    (putIcs.body as Record<string, unknown>).content,
    Buffer.from(ICS, "utf8").toString("base64"),
  );
});

test("再次发布：PUT 带旧文件 sha 覆盖，分支取仓库实际值", async () => {
  const { impl, calls } = stubFetch([
    { match: "gitee.com/api/v5/user", status: 200, body: { login: "u1" } },
    { match: "/contents/calendar.ics", method: "GET", status: 200, body: { sha: "sha9" } },
    { match: "/contents/calendar.ics", method: "PUT", status: 200, body: { content: {} } },
    {
      match: `/repos/u1/${DEFAULT_CALENDAR_REPO}`,
      method: "GET",
      status: 200,
      body: { private: false, default_branch: "main" },
    },
  ]);

  const r = await publishCalendarToGitee({ token: "t", ics: ICS }, impl);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.created, false);
  assert.equal(
    r.data.subscribeUrl,
    `https://gitee.com/u1/${DEFAULT_CALENDAR_REPO}/raw/main/calendar.ics`,
  );

  const putIcs = calls.find((c) => c.url.includes("/contents/calendar.ics") && c.method === "PUT");
  assert.ok(putIcs, "应有日历覆盖请求");
  assert.equal((putIcs.body as Record<string, unknown>).sha, "sha9", "更新必须带旧文件 sha");
});

test("令牌无效（401/403）：失败并标记 needSetup", async () => {
  for (const status of [401, 403]) {
    const { impl } = stubFetch([
      { match: "gitee.com/api/v5/user", status, body: { message: "401" } },
    ]);
    const r = await publishCalendarToGitee({ token: "bad", ics: ICS }, impl);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /令牌无效/);
    assert.equal(r.needSetup, true);
  }
});

test("同名仓库是私有的：如实报错，不静默发布", async () => {
  const { impl } = stubFetch([
    { match: "gitee.com/api/v5/user", status: 200, body: { login: "u1" } },
    {
      match: `/repos/u1/${DEFAULT_CALENDAR_REPO}`,
      method: "GET",
      status: 200,
      body: { private: true, default_branch: "master" },
    },
  ]);
  const r = await publishCalendarToGitee({ token: "t", ics: ICS }, impl);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /私有/);
});
