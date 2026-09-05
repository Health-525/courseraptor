/**
 * Gitee 日历发布 — 国内可直连的订阅源
 *
 * 为什么需要 Gitee：GitHub Pages / raw.githubusercontent.com 在国内
 * 大面积不可达，手机订阅后拉不到更新。Gitee（码云）API v5 与 GitHub
 * REST 几乎同构（建仓 / contents 覆盖 / raw 链接），raw 地址国内直连，
 * 手机日历订阅它就稳了。
 *
 * 与 github-publish 的差异：
 * - 鉴权走 URL 参数 access_token（Gitee v5 的标准姿势）
 * - 不开 Pages（需实名+手动部署）：订阅直接用 raw 链接
 * - 默认分支是 master 而非 main，以 GET /repos 返回的 default_branch 为准
 */

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

type FetchLike = typeof fetch;

interface GiteeResp {
  status: number;
  body: unknown;
}

async function gitee(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
  fetchImpl: FetchLike = fetch,
): Promise<GiteeResp> {
  const sep = path.includes("?") ? "&" : "?";
  const resp = await fetchImpl(`${API}${path}${sep}access_token=${encodeURIComponent(token)}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "user-agent": "CourseRaptor" },
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
    const o = body as Record<string, unknown>;
    const m = o.message ?? o.error;
    if (typeof m === "string") return m;
  }
  return typeof body === "string" && body ? body.slice(0, 120) : "Gitee 接口返回异常";
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

  // 1. 验证令牌并拿登录名
  const me = await gitee("/user", token, {}, fetchImpl);
  if (me.status === 401 || me.status === 403) {
    return {
      ok: false,
      error: "Gitee 私人令牌无效或已过期，请到 Gitee → 设置 → 私人令牌重新生成",
      needSetup: true,
    };
  }
  if (me.status !== 200) {
    return { ok: false, error: `Gitee 账号信息获取失败：${messageOf(me.body)}` };
  }
  const owner = (me.body as Record<string, unknown>)?.login;
  if (typeof owner !== "string" || !owner) {
    return { ok: false, error: "Gitee 接口没返回登录名（响应结构可能已改版）" };
  }

  // 2. 仓库存在性：404 才建
  let branch = "master";
  let created = false;
  const repoResp = await gitee(`/repos/${owner}/${repo}`, token, {}, fetchImpl);
  if (repoResp.status === 404) {
    const createResp = await gitee(
      "/user/repos",
      token,
      {
        method: "POST",
        body: {
          name: repo,
          description: "CourseRaptor 课表日历（agent 自动同步）",
          private: false,
          auto_init: true,
        },
      },
      fetchImpl,
    );
    if (createResp.status !== 201 && createResp.status !== 200) {
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
        error: `仓库 ${owner}/${repo} 已存在且是私有的——手机匿名订阅要求公开仓库。请到 Gitee 把它设为开源后重试，或换个仓库名。`,
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

  const host = `gitee.com/${owner}/${repo}/raw/${branch}/${CALENDAR_PATH}`;
  return {
    ok: true,
    data: {
      owner,
      repo,
      repoUrl: `https://gitee.com/${owner}/${repo}`,
      subscribeUrl: `https://${host}`,
      webcalUrl: `webcal://${host}`,
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
  const cur = await gitee(
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
  const put = await gitee(
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
