/**
 * GitHub 日历发布测试
 *
 * 全程离线：fetch 注入 stub，按 URL 前缀路由。钉住的行为——
 * 1. 首次发布：404 才建公开仓库（private:false + auto_init），开 Pages，订阅链接是 Pages 地址；
 * 2. 再次发布：复用既有仓库，PUT calendar.ics 带旧文件 sha 才能覆盖更新；
 * 3. Pages 没权限（403）：退回 raw 订阅链接，不失败；
 * 4. token 无效（401）：失败并带 needSetup，不猜结果；
 * 5. 同名仓库是私有的：如实报错，不悄悄发布到私有仓库（手机订阅不了）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { publishCalendarToGithub, DEFAULT_CALENDAR_REPO } = await import("../src/github-publish");

interface Route {
  match: string;
  status: number;
  body?: unknown;
  method?: string;
}

/** 假 fetch：按 method+URL 前缀路由，未预置的请求直接炸（测试不允许意外外网） */
function stubFetch(routes: Route[]) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    // 无 method 的路由只认 GET：否则「GET /user」会把「POST /user/repos」也吃掉
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

test("首次发布：建公开仓库、上传日历、开 Pages，订阅链接指向 Pages", async () => {
  const { impl, calls } = stubFetch([
    { match: "api.github.com/user", status: 200, body: { login: "jiangshu" } },
    { match: "/contents/calendar.ics", method: "GET", status: 404, body: { message: "Not Found" } },
    { match: "/contents/calendar.ics", method: "PUT", status: 201, body: { content: {} } },
    { match: "/contents/.nojekyll", method: "GET", status: 404, body: { message: "Not Found" } },
    { match: "/contents/.nojekyll", method: "PUT", status: 201, body: { content: {} } },
    {
      match: `/repos/jiangshu/${DEFAULT_CALENDAR_REPO}`,
      method: "GET",
      status: 404,
      body: { message: "Not Found" },
    },
    {
      match: "api.github.com/user/repos",
      method: "POST",
      status: 201,
      body: { full_name: "jiangshu/courseraptor-calendar" },
    },
    {
      match: "/pages",
      method: "POST",
      status: 201,
      body: { html_url: "https://jiangshu.github.io/courseraptor-calendar/" },
    },
  ]);

  const r = await publishCalendarToGithub({ token: "ghp_test", ics: ICS }, impl);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const d = r.data;
  assert.equal(d.owner, "jiangshu");
  assert.equal(d.repo, DEFAULT_CALENDAR_REPO);
  assert.equal(d.created, true);
  assert.equal(d.pagesEnabled, true);
  assert.equal(d.subscribeUrl, "https://jiangshu.github.io/courseraptor-calendar/calendar.ics");
  assert.equal(d.webcalUrl, "webcal://jiangshu.github.io/courseraptor-calendar/calendar.ics");
  assert.match(d.rawUrl, /raw\.githubusercontent\.com/);

  // 建仓参数：公开 + auto_init（Pages 需要至少一次提交）
  const create = calls.find((c) => c.url.endsWith("/user/repos") && c.method === "POST");
  assert.ok(create, "应有建仓请求");
  const createBody = create.body as Record<string, unknown>;
  assert.equal(createBody.private, false);
  assert.equal(createBody.auto_init, true);
  // 日历内容 base64 编码后上传
  const putIcs = calls.find((c) => c.url.includes("/contents/calendar.ics") && c.method === "PUT");
  assert.ok(putIcs, "应有日历上传请求");
  assert.equal(
    (putIcs.body as Record<string, unknown>).content,
    Buffer.from(ICS, "utf8").toString("base64"),
  );
});

test("再次发布：复用仓库，PUT 带旧文件 sha 覆盖更新", async () => {
  // 路由按顺序匹配（URL 包含即可）：contents 必须排在 repo 之前，
  // 否则「GET /repos/u/r/contents/x」会先命中「GET /repos/u/r」那条
  const { impl, calls } = stubFetch([
    { match: "api.github.com/user", status: 200, body: { login: "jiangshu" } },
    { match: "/contents/calendar.ics", method: "GET", status: 200, body: { sha: "abc123" } },
    { match: "/contents/calendar.ics", method: "PUT", status: 200, body: { content: {} } },
    { match: "/contents/.nojekyll", method: "GET", status: 200, body: { sha: "nj1" } },
    { match: "/contents/.nojekyll", method: "PUT", status: 200, body: { content: {} } },
    {
      match: `/repos/jiangshu/${DEFAULT_CALENDAR_REPO}`,
      method: "GET",
      status: 200,
      body: { private: false, default_branch: "main" },
    },
    { match: "/pages", method: "POST", status: 409, body: { message: "already enabled" } }, // 409=已开过
  ]);

  const r = await publishCalendarToGithub({ token: "ghp_test", ics: ICS }, impl);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.created, false);
  assert.equal(r.data.pagesEnabled, true, "409（已开 Pages）也按成功处理");

  const putIcs = calls.find((c) => c.url.includes("/contents/calendar.ics") && c.method === "PUT");
  assert.ok(putIcs, "应有日历覆盖请求");
  assert.equal((putIcs.body as Record<string, unknown>).sha, "abc123", "更新必须带旧文件 sha");
});

test("Pages 没权限（403）：退回 raw 订阅链接而不是失败", async () => {
  const { impl } = stubFetch([
    { match: "api.github.com/user", status: 200, body: { login: "u1" } },
    { match: "/contents/calendar.ics", method: "GET", status: 200, body: { sha: "s" } },
    { match: "/contents/calendar.ics", method: "PUT", status: 200, body: { content: {} } },
    { match: "/contents/.nojekyll", method: "GET", status: 404, body: { message: "Not Found" } },
    { match: "/contents/.nojekyll", method: "PUT", status: 201, body: { content: {} } },
    {
      match: `/repos/u1/${DEFAULT_CALENDAR_REPO}`,
      method: "GET",
      status: 200,
      body: { private: false, default_branch: "main" },
    },
    { match: "/pages", method: "POST", status: 403, body: { message: "Forbidden" } },
  ]);

  const r = await publishCalendarToGithub({ token: "ghp_test", ics: ICS }, impl);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.pagesEnabled, false);
  assert.equal(
    r.data.subscribeUrl,
    `https://raw.githubusercontent.com/u1/${DEFAULT_CALENDAR_REPO}/main/calendar.ics`,
  );
});

test("token 无效（401）：失败并标记 needSetup", async () => {
  const { impl } = stubFetch([
    { match: "api.github.com/user", status: 401, body: { message: "Bad credentials" } },
  ]);
  const r = await publishCalendarToGithub({ token: "ghp_bad", ics: ICS }, impl);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /令牌无效/);
  assert.equal(r.needSetup, true);
});

test("同名仓库是私有的：如实报错，不静默发布", async () => {
  const { impl } = stubFetch([
    { match: "api.github.com/user", status: 200, body: { login: "u1" } },
    {
      match: `/repos/u1/${DEFAULT_CALENDAR_REPO}`,
      method: "GET",
      status: 200,
      body: { private: true, default_branch: "main" },
    },
  ]);
  const r = await publishCalendarToGithub({ token: "ghp_test", ics: ICS }, impl);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /私有/);
});

test("建仓失败透传 GitHub 的错误消息", async () => {
  const { impl } = stubFetch([
    { match: "api.github.com/user", status: 200, body: { login: "u1" } },
    {
      match: `/repos/u1/${DEFAULT_CALENDAR_REPO}`,
      method: "GET",
      status: 404,
      body: { message: "Not Found" },
    },
    {
      match: "api.github.com/user/repos",
      method: "POST",
      status: 422,
      body: { message: "name already exists on this account" },
    },
  ]);
  const r = await publishCalendarToGithub({ token: "ghp_test", ics: ICS }, impl);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /创建失败：name already exists/);
});
