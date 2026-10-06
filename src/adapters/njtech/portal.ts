/**
 * 教务门户扩展查询：已选教学班
 *
 * 接口为实测验证（正方 zfsoft doType=query 模式）。
 * 另有 班级课表/学业情况/实验课表/培养方案/空闲教室 模块为学校侧停用
 * （返回「系统维护页面」），任何客户端均不可用。
 */

import { RaptorError } from "../../core/errors";
import { createClient, httpError } from "../../core/http";
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
  // 故障与「真实的空已选列表」必须可区分：静默返空会把故障伪装成「暂无已选」
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
