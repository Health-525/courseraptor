/**
 * GitHub 日历发布 — 手机可订阅的课表真值源
 *
 * 为什么走 GitHub：本机网页服务只绑 127.0.0.1，手机够不着；把 calendar.ics
 * 推到用户名下的公开仓库（GitHub Pages 托管），手机日历 App 订阅一个
 * https/webcal 链接即可——课表变化重新发布，订阅端自动刷新，不用来回传文件。
 *
 * 发布链路（全部 REST API，无 git 依赖）：
 * 1. GET /user 拿登录名（顺带验证 token）
 * 2. GET /repos/{owner}/{repo} 不存在则 POST /user/repos 建公开仓库
 * 3. PUT /contents/calendar.ics 覆盖上传（带 sha 才能更新）
 * 4. POST /pages 开 Pages；token 权限不够时退回 raw 链接（多数日历 App 也认）
 *
 * 隐私：公开 = 任何拿到链接的人都能看到课表/考试安排。工具层必须先向
 * 用户说明这一点并确认，本模块只管执行。
 */

export interface PublishResult {
  owner: string;
  repo: string;
  repoUrl: string;
  /** 手机日历订阅用（Pages 可用时为 Pages 地址，否则 raw 地址） */
  subscribeUrl: string;
  /** webcal scheme：iOS 点击可直接唤起订阅 */
  webcalUrl: string;
  rawUrl: string;
  /** Pages 是否启用成功（false = 订阅走 raw 链接） */
  pagesEnabled: boolean;
  /** 本次是否新建了仓库（首次发布） */
  created: boolean;
}

export type PublishOutcome =
  | { ok: true; data: PublishResult }
  | { ok: false; error: string /** token 没配/无效，提示用户去配置 */; needSetup?: boolean };

const API = "https://api.github.com";
const CALENDAR_PATH = "calendar.ics";

/** 默认仓库名：不含个人信息，固定名便于重复发布时定位 */
export const DEFAULT_CALENDAR_REPO = "courseraptor-calendar";

type FetchLike = typeof fetch;

interface GithubResp {
  status: number;
  body: unknown;
}

async function gh(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
  fetchImpl: FetchLike = fetch,
): Promise<GithubResp> {
  const resp = await fetchImpl(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "CourseRaptor",
      "x-github-api-version": "2022-11-28",
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: resp.status, body };
}

function messageOf(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  return typeof body === "string" && body ? body.slice(0, 120) : "GitHub 接口返回异常";
}

/**
 * 把 calendar.ics 发布到用户名下的公开仓库（不存在则创建）。
 * fetchImpl 可注入，测试离线跑。
 */
export async function publishCalendarToGithub(
  opts: {
    token: string;
    ics: string;
    repoName?: string;
    description?: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<PublishOutcome> {
  const { token, ics } = opts;
  const repo = opts.repoName?.trim() || DEFAULT_CALENDAR_REPO;
  const description = opts.description ?? "CourseRaptor 课表日历（agent 自动同步）";

  // 1. 验证 token 并拿登录名
  const me = await gh("/user", token, {}, fetchImpl);
  if (me.status === 401) {
    return {
      ok: false,
      error: "GitHub 令牌无效或已过期，请到 Settings → Developer settings 重新生成",
      needSetup: true,
    };
  }
  if (me.status !== 200) {
    return { ok: false, error: `GitHub 账号信息获取失败：${messageOf(me.body)}` };
  }
  const owner = (me.body as Record<string, unknown>)?.login;
  if (typeof owner !== "string" || !owner) {
    return { ok: false, error: "GitHub 接口没返回登录名（响应结构可能已改版）" };
  }

  // 2. 仓库存在性：404 才建，已存在直接复用（同名仓库可能是用户自建的）
  let branch = "main";
  let created = false;
  const repoResp = await gh(`/repos/${owner}/${repo}`, token, {}, fetchImpl);
  if (repoResp.status === 404) {
    const createResp = await gh(
      "/user/repos",
      token,
      { method: "POST", body: { name: repo, description, private: false, auto_init: true } },
      fetchImpl,
    );
    if (createResp.status !== 201) {
      return { ok: false, error: `公开仓库创建失败：${messageOf(createResp.body)}` };
    }
    created = true;
  } else if (repoResp.status === 200) {
    const rb = repoResp.body as Record<string, unknown>;
    const b = rb?.default_branch;
    if (typeof b === "string" && b) branch = b;
    if (rb?.private === true) {
      return {
        ok: false,
        error: `仓库 ${owner}/${repo} 已存在且是私有的——手机匿名订阅要求公开仓库。请到 GitHub 把它设为 Public 后重试，或换个仓库名。`,
      };
    }
  } else {
    return { ok: false, error: `仓库信息获取失败：${messageOf(repoResp.body)}` };
  }

  // 3. 覆盖上传 calendar.ics（更新必须带既有文件的 sha）
  const content = Buffer.from(ics, "utf8").toString("base64");
  const putError = await putFile(
    owner,
    repo,
    branch,
    CALENDAR_PATH,
    content,
    "CourseRaptor：更新课表日历",
    token,
    fetchImpl,
  );
  if (putError) return { ok: false, error: `课表日历上传失败：${putError}` };

  // .nojekyll：让 Pages 原样吐静态文件，不走 Jekyll 处理
  await putFile(
    owner,
    repo,
    branch,
    ".nojekyll",
    "",
    "CourseRaptor：启用静态托管",
    token,
    fetchImpl,
  );

  // 4. 开 Pages（409 = 已开过；403 = token 没有 Pages 权限，退回 raw 链接）
  let pagesEnabled = false;
  const pagesResp = await gh(
    `/repos/${owner}/${repo}/pages`,
    token,
    { method: "POST", body: { source: { branch, path: "/" } } },
    fetchImpl,
  );
  if (pagesResp.status === 201 || pagesResp.status === 409) {
    pagesEnabled = true;
  }

  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${CALENDAR_PATH}`;
  const pagesUrl = `https://${owner}.github.io/${repo}/${CALENDAR_PATH}`;
  const subscribeUrl = pagesEnabled ? pagesUrl : rawUrl;
  const host = pagesEnabled
    ? `${owner}.github.io/${repo}/${CALENDAR_PATH}`
    : `raw.githubusercontent.com/${owner}/${repo}/${branch}/${CALENDAR_PATH}`;

  return {
    ok: true,
    data: {
      owner,
      repo,
      repoUrl: `https://github.com/${owner}/${repo}`,
      subscribeUrl,
      webcalUrl: `webcal://${host}`,
      rawUrl,
      pagesEnabled,
      created,
    },
  };
}

/** PUT 单个文件；返回 null 表示成功，否则是错误消息 */
async function putFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  contentBase64: string,
  message: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<string | null> {
  const cur = await gh(
    `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
    token,
    {},
    fetchImpl,
  );
  let sha: string | undefined;
  if (cur.status === 200) {
    const s = (cur.body as Record<string, unknown>)?.sha;
    if (typeof s === "string") sha = s;
  }
  const put = await gh(
    `/repos/${owner}/${repo}/contents/${path}`,
    token,
    {
      method: "PUT",
      body: { message, content: contentBase64, branch, ...(sha ? { sha } : {}) },
    },
    fetchImpl,
  );
  if (put.status !== 200 && put.status !== 201) return messageOf(put.body);
  return null;
}
