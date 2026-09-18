/**
 * GitHub 日历发布 — 手机可订阅的课表真值源
 *
 * 为什么走 GitHub：本机网页服务只绑 127.0.0.1，手机够不着；把 calendar.ics
 * 推到用户名下的公开仓库（GitHub Pages 托管），手机日历 App 订阅一个
 * https/webcal 链接即可——课表变化重新发布，订阅端自动刷新，不用来回传文件。
 *
 * 流程骨架见 repo-publish.ts，本模块只保留 GitHub 特有部分：
 * 鉴权走 Bearer 头、上传后补 .nojekyll、开 Pages（无权限退回 raw 链接）。
 *
 * 隐私：公开 = 任何拿到链接的人都能看到课表/考试安排。工具层必须先向
 * 用户说明这一点并确认，本模块只管执行。
 */

import {
  ensurePublicRepo,
  putFileWithSha,
  requestJson,
  resolveOwner,
  type ApiClient,
  type FetchLike,
} from "./repo-publish";

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

/** 默认仓库名：不含个人信息，固定名便于重复发布时定位（与 Gitee 共用） */
export const DEFAULT_CALENDAR_REPO = "courseraptor-calendar";

function gh(fetchImpl: FetchLike, token: string): ApiClient {
  return (path, init) =>
    requestJson(fetchImpl, `${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
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
  const api = gh(fetchImpl, token);

  // 1. 验证 token 并拿登录名
  const me = await resolveOwner(api, "GitHub", {
    invalidToken: "GitHub 令牌无效或已过期，请到 Settings → Developer settings 重新生成",
    accountFailPrefix: "GitHub 账号信息获取失败",
  });
  if (!me.ok) return me;

  // 2. 仓库存在性：404 才建，已存在直接复用（同名仓库可能是用户自建的）
  const ensured = await ensurePublicRepo(
    api,
    me.owner,
    repo,
    {
      createFailPrefix: "公开仓库创建失败",
      getFailPrefix: "仓库信息获取失败",
      privateRepo: `仓库 ${me.owner}/${repo} 已存在且是私有的——手机匿名订阅要求公开仓库。请到 GitHub 把它设为 Public 后重试，或换个仓库名。`,
    },
    { name: repo, description, private: false, auto_init: true },
    "main",
  );
  if (!ensured.ok) return ensured;
  const { branch, created } = ensured;

  // 3. 覆盖上传 calendar.ics（更新必须带既有文件的 sha）
  const content = Buffer.from(ics, "utf8").toString("base64");
  const putError = await putFileWithSha(
    api,
    me.owner,
    repo,
    branch,
    CALENDAR_PATH,
    content,
    "CourseRaptor：更新课表日历",
  );
  if (putError) return { ok: false, error: `课表日历上传失败：${putError}` };

  // .nojekyll：让 Pages 原样吐静态文件，不走 Jekyll 处理
  await putFileWithSha(api, me.owner, repo, branch, ".nojekyll", "", "CourseRaptor：启用静态托管");

  // 4. 开 Pages（409 = 已开过；403 = token 没有 Pages 权限，退回 raw 链接）
  let pagesEnabled = false;
  const pagesResp = await api(`/repos/${me.owner}/${repo}/pages`, {
    method: "POST",
    body: { source: { branch, path: "/" } },
  });
  if (pagesResp.status === 201 || pagesResp.status === 409) {
    pagesEnabled = true;
  }

  const rawUrl = `https://raw.githubusercontent.com/${me.owner}/${repo}/${branch}/${CALENDAR_PATH}`;
  const pagesUrl = `https://${me.owner}.github.io/${repo}/${CALENDAR_PATH}`;
  const subscribeUrl = pagesEnabled ? pagesUrl : rawUrl;
  const host = pagesEnabled
    ? `${me.owner}.github.io/${repo}/${CALENDAR_PATH}`
    : `raw.githubusercontent.com/${me.owner}/${repo}/${branch}/${CALENDAR_PATH}`;

  return {
    ok: true,
    data: {
      owner: me.owner,
      repo,
      repoUrl: `https://github.com/${me.owner}/${repo}`,
      subscribeUrl,
      webcalUrl: `webcal://${host}`,
      rawUrl,
      pagesEnabled,
      created,
    },
  };
}
