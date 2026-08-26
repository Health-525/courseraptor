/**
 * NJTECH 全部成绩 + GPA 计算
 * 搬自 timetable/scripts/fetch_grades_all.js，改为 TypeScript 函数化
 */

import type { GradeResult, GradeCourse } from "./types";

import { createClientWithCookie } from "./http";
import { BASE } from "./auth";


// ── GPA 计算 ────────────────────────────────────────────────

/**
 * 南工大绩点规则
 */
function toGP(score: string): number {
  const s = parseFloat(score);
  if (!isNaN(s)) {
    if (s >= 90) return 4.0;
    if (s >= 86) return 3.7;
    if (s >= 82) return 3.3;
    if (s >= 79) return 3.0;
    if (s >= 75) return 2.7;
    if (s >= 71) return 2.3;
    if (s >= 68) return 2.0;
    if (s >= 64) return 1.7;
    if (s >= 60) return 1.3;
    return 0;
  }
  // 等级制
  const t = String(score || "").trim();
  if (t.includes("优秀")) return 4.0;
  if (t.includes("良好")) return 3.0;
  if (t.includes("中等")) return 2.0;
  if (t.includes("及格")) return 1.0;
  return 0;
}

/**
 * 判断是否必修课
 */
function isRequired(type: string): boolean {
  const t = (type || "").trim();
  return t === "必修" || t.startsWith("必修") || (t.includes("必") && !t.includes("选修"));
}

// ── 全部成绩抓取 ────────────────────────────────────────────

/**
 * 抓取全部成绩并计算 GPA
 * @param cookie - 登录后的 cookie
 * @param username - 学号（用于标识）
 */
export async function fetchAllGrades(
  cookie: string,
  _username: string
): Promise<GradeResult> {
  const client = createClientWithCookie(BASE, cookie);

  const all: GradeCourse[] = [];
  const endYear = new Date().getFullYear();

  // 单学期查询带重试（线路抖动会导致整个学期数据静默丢失）
  const fetchTerm = async (y: number, q: number): Promise<GradeCourse[]> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await client.req(
          "/cjcx/cjcx_cxDgXscj.html?doType=query&gnmkdm=N305005",
          {
            method: "POST",
            body: `xnm=${y}&xqm=${q}&_search=false&nd=${Date.now()}&queryModel.showCount=200&queryModel.currentPage=1`,
          }
        );
        const data = JSON.parse(resp.body);
        return (data.items ?? []).map(
          (g: Record<string, unknown>): GradeCourse => ({
            course: String(g.kcmc || g.kch || ""),
            score: String(g.cj || g.bfzcj || ""),
            credit: String(g.xf || ""),
            type: String(g.kcxzmc || ""),
            semester: String(g.xnmmc ?? "") + String(g.xqmmc ?? ""),
            category: String(g.kcgsmc || ""),
            courseClass: String(g.kclbmc || ""),
          })
        );
      } catch {
        if (attempt === 3) return []; // 彻底失败才放弃该学期
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    return [];
  };

  // 遍历所有学年学期
  for (let y = 2023; y <= endYear; y++) {
    for (const q of [3, 12]) {
      all.push(...(await fetchTerm(y, q)));
    }
  }

  // 去重取最高分
  const best: Record<string, GradeCourse> = {};
  for (const g of all) {
    const k = g.course;
    if (!best[k] || parseFloat(g.score) > parseFloat(best[k].score)) {
      best[k] = g;
    }
  }
  const deduped = Object.values(best);

  // GPA 计算（只计必修课）
  const required = deduped.filter(
    (g) => isRequired(g.type) && parseFloat(g.credit) > 0
  );
  let tg = 0;
  let tc = 0;
  for (const g of required) {
    const gp = toGP(g.score);
    const cr = parseFloat(g.credit) || 0;
    tg += gp * cr;
    tc += cr;
  }
  const gpa = tc > 0 ? (tg / tc).toFixed(2) : "0.00";

  return {
    gpa,
    totalCredits: tc,
    requiredCourses: required.length,
    allCourses: deduped,
  };
}


