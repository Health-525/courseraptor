/**
 * 日历发布公共骨架 — github-publish / gitee-publish 共用的三步流程
 *
 * 两个平台的 REST API 几乎同构（验证令牌 → 建公开仓 → 带 sha 覆盖上传），
 * 骨架只管流程与「错误如实上浮」的约定；平台差异（鉴权姿势、报错话术、
 * Pages/raw 订阅地址）留在各自的 publish 模块里，经参数注入。
 */

export type FetchLike = typeof fetch;

export interface ApiResp {
  status: number;
  body: unknown;
}

export type ApiClient = (
  path: string,
  init: { method?: string; body?: unknown },
) => Promise<ApiResp>;

/** 发请求并把响应体宽容解析（JSON 优先，退化保留原文） */
export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<ApiResp> {
  const resp = await fetchImpl(url, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "user-agent": "CourseRaptor", ...init.headers },
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

/** 平台错误消息提取；提取不到就用兜底话术 */
export function messageOf(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const o = body as Record<string, unknown>;
    const m = o.message ?? o.error;
    if (typeof m === "string") return m;
  }
  return typeof body === "string" && body ? body.slice(0, 120) : fallback;
}

export type OwnerResolved =
  | { ok: true; owner: string }
  | { ok: false; error: string; needSetup?: boolean };

/** 第 1 步：验证令牌并拿登录名（401/403 标 needSetup，提示用户去配置） */
export async function resolveOwner(
  api: ApiClient,
  platform: string,
  msgs: { invalidToken: string; accountFailPrefix: string },
): Promise<OwnerResolved> {
  const me = await api("/user", {});
  if (me.status === 401 || me.status === 403) {
    return { ok: false, error: msgs.invalidToken, needSetup: true };
  }
  if (me.status !== 200) {
    return {
      ok: false,
      error: `${msgs.accountFailPrefix}：${messageOf(me.body, `${platform} 接口返回异常`)}`,
    };
  }
  const owner = (me.body as Record<string, unknown>)?.login;
  if (typeof owner !== "string" || !owner) {
    return { ok: false, error: `${platform} 接口没返回登录名（响应结构可能已改版）` };
  }
  return { ok: true, owner };
}

export type RepoEnsured =
  | { ok: true; branch: string; created: boolean }
  | { ok: false; error: string };

/** 第 2 步：仓库存在性——404 才建公开仓，已存在读默认分支且必须公开 */
export async function ensurePublicRepo(
  api: ApiClient,
  owner: string,
  repo: string,
  msgs: { createFailPrefix: string; getFailPrefix: string; privateRepo: string },
  createBody: unknown,
  fallbackBranch: string,
): Promise<RepoEnsured> {
  let branch = fallbackBranch;
  let created = false;
  const repoResp = await api(`/repos/${owner}/${repo}`, {});
  if (repoResp.status === 404) {
    const createResp = await api("/user/repos", { method: "POST", body: createBody });
    if (createResp.status !== 201 && createResp.status !== 200) {
      return {
        ok: false,
        error: `${msgs.createFailPrefix}：${messageOf(createResp.body, "接口返回异常")}`,
      };
    }
    created = true;
  } else if (repoResp.status === 200) {
    const rb = repoResp.body as Record<string, unknown>;
    const b = rb?.default_branch;
    if (typeof b === "string" && b) branch = b;
    if (rb?.private === true) {
      return { ok: false, error: msgs.privateRepo };
    }
  } else {
    return {
      ok: false,
      error: `${msgs.getFailPrefix}：${messageOf(repoResp.body, "接口返回异常")}`,
    };
  }
  return { ok: true, branch, created };
}

/** 第 3 步：PUT 单个文件；返回 null 表示成功，否则是错误消息（更新必须带既有 sha） */
export async function putFileWithSha(
  api: ApiClient,
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  contentBase64: string,
  message: string,
): Promise<string | null> {
  const cur = await api(`/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, {});
  let sha: string | undefined;
  if (cur.status === 200) {
    const s = (cur.body as Record<string, unknown>)?.sha;
    if (typeof s === "string") sha = s;
  }
  const put = await api(`/repos/${owner}/${repo}/contents/${filePath}`, {
    method: "PUT",
    body: { message, content: contentBase64, branch, ...(sha ? { sha } : {}) },
  });
  if (put.status !== 200 && put.status !== 201) return messageOf(put.body, "接口返回异常");
  return null;
}
