/**
 * Gitee 日历发布 — 国内可直连的订阅源
 *
 * 为什么需要 Gitee：GitHub Pages / raw.githubusercontent.com 在国内
 * 大面积不可达，手机订阅后拉不到更新。Gitee（码云）API v5 与 GitHub
 * REST 几乎同构（建仓 / contents 覆盖 / raw 链接），raw 地址国内直连，
 * 手机日历订阅它就稳了。
 *
 * 流程骨架见 repo-publish.ts，本模块只保留 Gitee 特有部分：
 * 鉴权走 URL 参数 access_token（Gitee v5 的标准姿势）、不开 Pages
 * （需实名+手动部署）：订阅直接用 raw 链接。
 */

import {
  type ApiClient,
  ensurePublicRepo,
  type FetchLike,
  putFileWithSha,
  requestJson,
  resolveOwner,
} from "./repo-publish";

export interface GiteePublishResult {
  owner: string;
  repo: string;
  repoUrl: string;
  /** 手机订阅用：gitee raw 地址，国内直连 */
  subscribeUrl: string;
  webcalUrl: string;
  /** 本次是否新建了仓库（首次发布） */
  created: boolean;
}

export type GiteePublishOutcome =
  | { ok: true; data: GiteePublishResult }
  | { ok: false; error: string; needSetup?: boolean };

const API = "https://gitee.com/api/v5";
const CALENDAR_PATH = "calendar.ics";

/** 与 GitHub 共用同一个默认仓库名，两边一致方便对照 */
export const DEFAULT_CALENDAR_REPO = "courseraptor-calendar";

function gitee(fetchImpl: FetchLike, token: string): ApiClient {
  return (path, init) => {
    const sep = path.includes("?") ? "&" : "?";
    return requestJson(
      fetchImpl,
      `${API}${path}${sep}access_token=${encodeURIComponent(token)}`,
      init,
    );
  };
}

/**
 * 把 calendar.ics 发布到用户 Gitee 名下的公开仓库（不存在则创建）。
 * fetchImpl 可注入，测试离线跑。
 */
export async function publishCalendarToGitee(
  opts: { token: string; ics: string; repoName?: string },
  fetchImpl: FetchLike = fetch,
): Promise<GiteePublishOutcome> {
  const { token, ics } = opts;
  const repo = opts.repoName?.trim() || DEFAULT_CALENDAR_REPO;
  const api = gitee(fetchImpl, token);

  // 1. 验证令牌并拿登录名
  const me = await resolveOwner(api, "Gitee", {
    invalidToken: "Gitee 私人令牌无效或已过期，请到 Gitee → 设置 → 私人令牌重新生成",
    accountFailPrefix: "Gitee 账号信息获取失败",
  });
  if (!me.ok) return me;

  // 2. 仓库存在性：404 才建
  const ensured = await ensurePublicRepo(
    api,
    me.owner,
    repo,
    {
      createFailPrefix: "公开仓库创建失败",
      getFailPrefix: "仓库信息获取失败",
      privateRepo: `仓库 ${me.owner}/${repo} 已存在且是私有的——手机匿名订阅要求公开仓库。请到 Gitee 把它设为开源后重试，或换个仓库名。`,
    },
    {
      name: repo,
      description: "CourseRaptor 课表日历（agent 自动同步）",
      private: false,
      auto_init: true,
    },
    "master",
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

  const host = `gitee.com/${me.owner}/${repo}/raw/${branch}/${CALENDAR_PATH}`;
  return {
    ok: true,
    data: {
      owner: me.owner,
      repo,
      repoUrl: `https://gitee.com/${me.owner}/${repo}`,
      subscribeUrl: `https://${host}`,
      webcalUrl: `webcal://${host}`,
      created,
    },
  };
}
