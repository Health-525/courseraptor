/**
 * 河北农大 URP 教务接口层（http://urp.hebau.edu.cn:1009/jwapp/sys/...）
 *
 * 与 NJTECH 的 jwgl 同为正方系，但接口形态完全不同：
 * - NJTECH：`POST /kbcx/xskbcx_cxXsKb.html`，学期用 `xnm=2026&xqm=3` 两个数字字段
 * - 河北农大：`POST .../cxxszhxqkb.do`，学期用字符串 `XNXQDM=2026-2027-1`
 * 所以学期编码换算、响应结构摘取都关在本目录里，不外泄。
 *
 * 错误语义沿用 src/jwgl/http.ts 的 FetchResult：拿不到数据必须 ok=false，
 * 绝不能降级成「空列表」——那会被模型转述成「你这学期没课」。
 */

import type { FetchResult } from "../../jwgl/http";
import { CookieJar, type RawResponse, requestWithJar, URP_BASE, xhrHeaders } from "./http";

/** 课表 / 考试 / 成绩三个 XHR 端点 */
export const URP_ENDPOINTS = {
  schedule: "/jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do",
  exams: "/jwapp/sys/wdkwapp/api/wdks/queryMyExamArrangeMent.do",
  grades: "/jwapp/sys/cjcx/modules/cjcx/xscjcx.do",
} as const;

/** 各端点的合法 Referer（URP 校验来源，缺了会被打回首页） */
const REFERERS = {
  schedule: `${URP_BASE}/jwapp/sys/homeapp/home/index.html`,
  exams: `${URP_BASE}/jwapp/sys/wdkwapp/modules/wdks/cxwdksap.do`,
  grades: `${URP_BASE}/jwapp/sys/cjcx/*default/index.do`,
} as const;

/**
 * 内部学期约定沿用工具层的 year + semester（3=秋冬、12=春夏，与 NJTECH 的 xqm 一致），
 * 到这里换算成 URP 的 XNXQDM 字符串。
 */
export function xnxqdm(year: number, semester: number): string {
  return `${year}-${year + 1}-${semester === 12 ? 2 : 1}`;
}

/** 会话失效时 URP 不返回 401，而是 200 + 一坨登录页 HTML —— 必须显式识别 */
function classifyFailure(resp: RawResponse, action: string): string | null {
  if (resp.status === 0) return `${action}失败：无响应（连接中断）`;
  if (resp.status >= 500) return `${action}失败：服务端错误 HTTP ${resp.status}`;
  if (resp.status >= 300 && resp.status < 400) {
    return `${action}失败：被重定向到登录页（教务会话已失效，请重试一次）`;
  }
  if (resp.status !== 200) return `${action}失败，教务系统返回状态 ${resp.status}`;
  const body = (resp.body || "").trim();
  if (!body) return `${action}失败：教务系统返回空响应`;
  if (/<(?:!DOCTYPE|html|body)\b/i.test(body)) {
    const reauth = /authserver|cas\.hebau|统一认证|重新登录/i.test(body);
    return `${action}失败：教务系统返回了页面而非数据${reauth ? "（会话已失效，请重试一次）" : "（接口可能已改版）"}`;
  }
  return null;
}

/** POST 一个 URP XHR 接口并把响应解析成 JSON（失败一律 ok=false，带上可读成因） */
export async function urpPostJson(
  path: string,
  cookie: string,
  body: string,
  action: string,
  referer: string,
): Promise<FetchResult<unknown>> {
  const jar = CookieJar.fromHeader(cookie);
  let resp: RawResponse;
  try {
    resp = await requestWithJar(`${URP_BASE}${path}`, jar, {
      method: "POST",
      headers: xhrHeaders(referer),
      body,
    });
  } catch (e) {
    return { ok: false, error: `${action}失败：${(e as Error).message}` };
  }
  const failure = classifyFailure(resp, action);
  if (failure) return { ok: false, error: failure };
  try {
    return { ok: true, data: JSON.parse(resp.body) as unknown };
  } catch {
    return { ok: false, error: `${action}失败：响应不是有效 JSON（接口可能已改版）` };
  }
}

export function urpPostSchedule(cookie: string, body: string, action: string) {
  return urpPostJson(URP_ENDPOINTS.schedule, cookie, body, action, REFERERS.schedule);
}
export function urpPostExams(cookie: string, body: string, action: string) {
  return urpPostJson(URP_ENDPOINTS.exams, cookie, body, action, REFERERS.exams);
}
export function urpPostGrades(cookie: string, body: string, action: string) {
  return urpPostJson(URP_ENDPOINTS.grades, cookie, body, action, REFERERS.grades);
}

/** 按首个等号切 KV：值里带等号（Base64 票据常见）时不能被后面的等号切坏 */
function pickRows(container: unknown): Record<string, unknown>[] | null {
  if (!container || typeof container !== "object") return null;
  const rows = (container as Record<string, unknown>).rows;
  return Array.isArray(rows) ? rows.filter(isRow) : null;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 摘数据行。URP 各接口的包装层级不一样，实测出现过这三种形态：
 *   { datas: { <接口名>: { rows: [...] } } }   ← 课表/成绩
 *   { datas: { queryMyExamArrangeMent: { arranged: [...], notArranged: [...] } } }  ← 考试
 *   { rows: [...] } / [...]                    ← 兜底
 * 拿不到行返回 null（= 结构异常，调用方必须报错），空数组才是「确实没数据」。
 * 这个区分很重要：把结构改版当成「没课」，用户会以为这学期真的没排课。
 */
export function extractUrpRows(
  payload: unknown,
  datasKey?: string,
): Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRow);
  if (!payload || typeof payload !== "object") return null;

  const root = payload as Record<string, unknown>;
  const datas = asObject(root.datas);
  if (datas) {
    // 优先按接口名精确取；取不到就扫所有子对象，改版换了 key 也不至于全线失效
    const named = asObject(datasKey ? datas[datasKey] : undefined);
    const direct = named ? pickRows(named) : null;
    if (direct) return direct;
    for (const value of Object.values(datas)) {
      const rows = pickRows(value);
      if (rows) return rows;
      const buckets = multiBucketRows(value);
      if (buckets) return buckets;
    }
  }

  const data = asObject(root.data) ? asObject(root.data) : undefined;
  if (Array.isArray(root.data)) return (root.data as unknown[]).filter(isRow);
  if (data) {
    const rows = pickRows(data);
    if (rows) return rows;
    const buckets = multiBucketRows(data);
    if (buckets) return buckets;
  }
  if (Array.isArray(root.rows)) return (root.rows as unknown[]).filter(isRow);
  return null;
}

/** 考试接口把行拆成 arranged / notArranged 两个桶，合并成一份 */
function multiBucketRows(container: unknown): Record<string, unknown>[] | null {
  const obj = asObject(container);
  if (!obj) return null;
  const out: Record<string, unknown>[] = [];
  for (const key of ["arranged", "notArranged", "rows", "data"]) {
    const value = obj[key];
    if (Array.isArray(value)) out.push(...value.filter(isRow));
  }
  return out.length ? out : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** URP 字段大小写与别名混杂（KCMC/kcmc/XSKCM…），按候选顺序取第一个非空串 */
export function pickString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}
