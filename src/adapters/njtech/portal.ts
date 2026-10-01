/**
 * 教务门户扩展查询：学籍个人信息 / 可重修课程 / 已选教学班 / 实验成绩
 *
 * 接口均为实测验证（正方 zfsoft doType=query 模式或 HTML 解析）。
 * 另有 班级课表/学业情况/实验课表/培养方案/空闲教室 模块为学校侧停用
 * （返回「系统维护页面」），任何客户端均不可用。
 */

import { RaptorError } from "../../core/errors";
import { createClient, httpError } from "../../core/http";
import { candidateXnxqList, termLabel } from "./academics";
import { BASE } from "./auth";
import { isSessionExpired } from "./xk";

function queryBody(extra: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    _search: "false",
    nd: String(Date.now()),
    "queryModel.showCount": "500",
    "queryModel.currentPage": "1",
    ...extra,
  };
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

// ── 学籍个人信息（HTML 页面解析）──────────────────────────────

// 注意：菜单接口里存的 URL 是 cxXsGrxx（错误大小写，会报「方法未定义」），
// 实际可用的方法名为 cxXsgrxx（小写 g），实测验证
const PROFILE_URL = "/xsxxxggl/xsgrxxwh_cxXsgrxx.html";

/** 解析「个人信息」页的 label/value 表单组 */
export async function fetchProfile(cookie: string): Promise<Record<string, string>> {
  const client = createClient(BASE, cookie);
  const r = await client.req(PROFILE_URL, { method: "GET" });
  const failure = httpError(r);
  if (failure) throw failure;
  const html = r.body ?? "";
  // 会话失效时拿到的是登录页而非档案页，解析出来会是「空档案」——必须显式失败
  if (isSessionExpired(html)) {
    throw new RaptorError("SESSION_EXPIRED", "教务会话已失效（可能被服务端提前下线）");
  }
  const out: Record<string, string> = {};
  // class="form-group" 与 "form-group xxx" 两种写法，且引号后可能带空格
  for (const block of html.match(/<div class="form-group[^"]*"\s*>[\s\S]*?<\/div>/g) ?? []) {
    const label = block
      .match(/<label[^>]*>([^<]+)<\/label>/)?.[1]
      ?.replace(/[：:]\s*$/, "")
      .trim();
    const pContent = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1];
    const value = pContent
      ? pContent.replace(/<[^>]+>/g, "").trim()
      : (block.match(/value="([^"]*)"/)?.[1]?.trim() ?? "");
    if (label && value && !out[label]) out[label] = value;
  }
  return out;
}

// ── 可重修课程 ────────────────────────────────────────────────

export interface RetakeCourse {
  courseCode: string;
  courseName: string;
  semester: string;
  department: string;
  credit: string;
}

export async function fetchRetakeCourses(cookie: string): Promise<RetakeCourse[]> {
  const client = createClient(BASE, cookie);
  const r = await client.req("/cxkccx/cxkccx_cxCxkccxIndex.html?doType=query", {
    method: "POST",
    body: queryBody(),
  });
  // 断网/会话失效/改版曾被 catch 吞成「没有可重修课程」——故障必须如实上报，
  // 「空列表」只留给真实的空结果（news.ts 的阶梯降级是本文件范本）
  const failure = httpError(r);
  if (failure) throw failure;
  if (isSessionExpired(r.body ?? "")) {
    throw new RaptorError("SESSION_EXPIRED", "教务会话已失效（可能被服务端提前下线）");
  }
  try {
    const items = JSON.parse(r.body ?? "{}").items ?? [];
    return items.map(
      (i: Record<string, unknown>): RetakeCourse => ({
        courseCode: String(i.kch ?? ""),
        courseName: String(i.kcmc ?? ""),
        semester: `${i.cxxnmc ?? ""}${i.cxxqmc ?? ""}`,
        department: String(i.kkbmmc ?? ""),
        credit: String(i.xf ?? ""),
      }),
    );
  } catch {
    throw new RaptorError("PARSE", "可重修课程接口响应无法解析（页面结构可能已改版）");
  }
}

// ── 已选课程教学班（选课名单的教学班维度）─────────────────────

export interface EnrolledClass {
  courseName: string;
  className: string;
  courseCode: string;
  teacher: string;
  time: string;
  place: string;
  credit: string;
  nature: string;
  category: string;
}

/**
 * 查询本学期已选的教学班列表。
 * 数据源为「选课名单查询」，但仅取教学班维度字段
 * （返回行含同学个人证件/联系方式，一律不导出）。
 */
export async function fetchEnrolledClasses(cookie: string): Promise<EnrolledClass[]> {
  const client = createClient(BASE, cookie);
  const r = await client.req("/xkcx/xkmdcx_cxXkmdcxIndex.html?doType=query", {
    method: "POST",
    body: queryBody(),
  });
  // 同 fetchRetakeCourses：故障与「真实的空已选列表」必须可区分
  const failure = httpError(r);
  if (failure) throw failure;
  if (isSessionExpired(r.body ?? "")) {
    throw new RaptorError("SESSION_EXPIRED", "教务会话已失效（可能被服务端提前下线）");
  }
  try {
    const items = JSON.parse(r.body ?? "{}").items ?? [];
    const seen = new Set<string>();
    const out: EnrolledClass[] = [];
    for (const i of items as Array<Record<string, unknown>>) {
      const key = String(i.jxb_id ?? i.jxbmc ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        courseName: String(i.kcmc ?? ""),
        className: String(i.jxbmc ?? ""),
        courseCode: String(i.kch ?? ""),
        teacher: String(i.jsmc ?? ""),
        time: String(i.sksj ?? ""),
        place: String(i.jxdd ?? ""),
        credit: String(i.xf ?? ""),
        nature: String(i.kcxzmc ?? ""),
        category: String(i.kclbmc ?? ""),
      });
    }
    return out;
  } catch {
    throw new RaptorError("PARSE", "已选教学班接口响应无法解析（页面结构可能已改版）");
  }
}

// ── 实验成绩 ──────────────────────────────────────────────────

/** 实验成绩（按学期；未指定时按候选学期探测） */
export async function fetchLabGradesSmart(
  cookie: string,
  xnm?: number,
  xqm?: number,
): Promise<{
  year: number;
  semester: number;
  label: string;
  items: Array<Record<string, unknown>>;
}> {
  const client = createClient(BASE, cookie);
  const candidates = xnm && xqm ? [{ year: xnm, semester: xqm }] : candidateXnxqList();

  // 候选学期探测与故障上报并行：逐个候选「成功但空」继续往前试（合法的空学期）；
  // 但要区分「探测到学期、确实没有实验成绩」与「一个学期都没查通」——后者是故障
  let lastFailure: string | null = null;
  let anySucceeded = false;

  for (const c of candidates) {
    const r = await client.req("/xssygl/sycjcx_cxSycjcxIndex.html?doType=query", {
      method: "POST",
      body: queryBody({ xnm: String(c.year), xqm: String(c.semester) }),
    });
    const failure = httpError(r);
    if (failure) {
      lastFailure = `${termLabel(c.year, c.semester)}：${failure.message}`;
      continue;
    }
    if (isSessionExpired(r.body ?? "")) {
      throw new RaptorError("SESSION_EXPIRED", "教务会话已失效（可能被服务端提前下线）");
    }
    try {
      const items = JSON.parse(r.body ?? "{}").items ?? [];
      anySucceeded = true;
      if (items.length > 0) {
        return { ...c, label: termLabel(c.year, c.semester), items };
      }
    } catch {
      lastFailure = `${termLabel(c.year, c.semester)}：响应无法解析`;
      /* 试下一个候选学期 */
    }
  }

  if (!anySucceeded && lastFailure) {
    throw new RaptorError(
      "UPSTREAM",
      `实验成绩查询失败：${lastFailure}（不是「暂无实验成绩」，是没查到）`,
    );
  }

  const first = candidates[0];
  return { ...first, label: termLabel(first.year, first.semester), items: [] };
}
