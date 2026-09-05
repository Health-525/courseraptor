/**
 * NJTECH 全部成绩 + GPA 计算
 * 搬自 timetable/scripts/fetch_grades_all.js，改为 TypeScript 函数化
 *
 * 四条正确性约定（每条都对应一个真实翻车场景）：
 * 1. 入学年份从学号前四位推——硬编码作者自己的年级，别人克隆就漏数据。
 * 2. 去重键 = 课程号 + 课程性质。只按课程名去重会把多学期同名课
 *    （大学体育 1/2/3、大学英语 1/2/3）合并成一条，学分直接吞掉。
 * 3. 通过型成绩（合格/通过/免修）整体排除出 GPA——记 0 绩点会让军训、
 *    毕业实习这类必修课拉低整个 GPA，语义完全不对。
 * 4. 拿不到的学期要报告，不能静默变成「没有这门课的成绩」。
 */

import { BASE } from "./auth";

import { createClient, httpFailure } from "./http";
import type { GradeCourse, GradeResult } from "./types";

// ── GPA 计算 ────────────────────────────────────────────────

/**
 * 南工大绩点规则。
 * 返回 null 表示该成绩**不参与** GPA 计算（通过型/未知型），
 * 与 0 分（参与计算、绩点为 0）是两回事。
 */
export function toGP(score: string): number | null {
  // 数字制
  const normalized = String(score || "").trim();
  const s = /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
  if (Number.isFinite(s) && s <= 100) {
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
  // 等级制。注意顺序：「不合格」包含「合格」，必须先判。
  const t = String(score || "").trim();
  if (!t) return null;
  if (["不及格", "不合格", "未通过", "不通过"].includes(t)) return 0;
  if (t === "优秀") return 4.0;
  if (t === "良好") return 3.0;
  if (t === "中等") return 2.0;
  if (t === "及格") return 1.0;
  // 通过型：有学分、无绩点。军训/毕业实习/部分实验课记「合格」，
  // 算 0 绩点会错误拉低 GPA，正确做法是整体移出计算。
  if (isPassFailGrade(t)) return null;
  // 缓考/缺考/未知标记：不猜，移出计算
  return null;
}

/** 是否通过型成绩（有学分但不计绩点） */
export function isPassFailGrade(score: string): boolean {
  const t = String(score || "").trim();
  return ["合格", "通过", "免修", "免考"].includes(t);
}

/**
 * 判断是否必修课
 */
function isRequired(type: string): boolean {
  const t = (type || "").trim();
  return t === "必修" || t.startsWith("必修") || (t.includes("必") && !t.includes("选修"));
}

// ── 全部成绩抓取 ────────────────────────────────────────────

/** 从学号推入学年份（南工大学号前四位 = 入学年），失败时放宽范围兜底 */
export function enrollYearFromStudentId(username: string): number {
  const y = parseInt((username || "").slice(0, 4), 10);
  const now = new Date().getFullYear();
  if (!Number.isNaN(y) && y >= 2000 && y <= now) return y;
  // 学号不规范：往前多查几年，宁可多几次空学期请求也不漏数据
  return now - 5;
}

/**
 * 抓取全部成绩并计算 GPA
 * @param cookie - 登录后的 cookie
 * @param username - 学号（前四位用于推入学年份）
 */
export async function fetchAllGrades(cookie: string, username: string): Promise<GradeResult> {
  const client = createClient(BASE, cookie);

  const all: GradeCourse[] = [];
  const failedTerms: string[] = [];
  const endYear = new Date().getFullYear();
  const startYear = enrollYearFromStudentId(username);

  // 单学期查询带重试（线路抖动会导致整个学期数据静默丢失）
  const fetchTerm = async (y: number, q: number): Promise<GradeCourse[] | null> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await client.req("/cjcx/cjcx_cxDgXscj.html?doType=query&gnmkdm=N305005", {
          method: "POST",
          body: `xnm=${y}&xqm=${q}&_search=false&nd=${Date.now()}&queryModel.showCount=200&queryModel.currentPage=1`,
        });
        // 传输层失败要进入重试，而不是被 JSON.parse 吞成「空学期」
        const failure = httpFailure(resp);
        if (failure) throw new Error(failure);

        const data = JSON.parse(resp.body) as { items?: Array<Record<string, unknown>> };
        return (data.items ?? []).map(
          (g: Record<string, unknown>): GradeCourse => ({
            course: String(g.kcmc || ""),
            courseCode: String(g.kch || ""),
            score: String(g.cj === 0 ? 0 : g.cj || g.bfzcj || ""),
            credit: String(g.xf || ""),
            type: String(g.kcxzmc || ""),
            semester: String(g.xnmmc ?? "") + String(g.xqmmc ?? ""),
            category: String(g.kcgsmc || ""),
            courseClass: String(g.kclbmc || ""),
          }),
        );
      } catch (e) {
        if (attempt === 3) {
          failedTerms.push(`${y}-${q === 3 ? 1 : 2}：${(e as Error).message.slice(0, 80)}`);
          return null;
        }
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    return null;
  };

  // 遍历所有学年学期
  for (let y = startYear; y <= endYear; y++) {
    for (const q of [3, 12]) {
      const term = await fetchTerm(y, q);
      if (term) all.push(...term);
    }
  }

  // 去重取最高分。键 = 课程号 + 课程性质：
  // 重修同课程号取最高分是本意；多学期同名课（体育/大学英语）课程号不同，
  // 按「课程名」去重会把它们合并、学分凭空消失。
  const deduped = deduplicateGrades(all);

  // GPA 计算（只计必修课；通过型/未知型成绩移出分母）
  const required = deduped.filter((g) => isRequired(g.type) && parseFloat(g.credit) > 0);
  const gpaCourses = required.filter((g) => toGP(g.score) !== null);
  const excludedPassFail = required.length - gpaCourses.length;

  let tg = 0;
  let tc = 0;
  for (const g of gpaCourses) {
    tg += (toGP(g.score) as number) * (parseFloat(g.credit) || 0);
    tc += parseFloat(g.credit) || 0;
  }
  const gpa = tc > 0 ? (tg / tc).toFixed(2) : "0.00";

  return {
    gpa,
    /** 注意语义：这是「计入 GPA 的必修课学分和」，不是总修学分 */
    requiredCredits: tc,
    requiredCourses: required.length,
    gpaBasis: `仅必修课；已排除 ${excludedPassFail} 门通过型/无绩点课程（合格、免修等不计 GPA）`,
    passFailCredits: deduped
      .filter((g) => isRequired(g.type) && isPassFailGrade(g.score))
      .reduce((sum, g) => sum + (parseFloat(g.credit) || 0), 0),
    allCourses: deduped,
    failedTerms,
  };
}

/** 重修先保留已通过记录，再比较分数；未知状态不能覆盖有效成绩。 */
export function deduplicateGrades(courses: GradeCourse[]): GradeCourse[] {
  const best = new Map<string, GradeCourse>();
  for (const course of courses) {
    const key = `${course.courseCode || course.course}|${course.type || ""}`;
    const previous = best.get(key);
    if (!previous || numScore(course.score) > numScore(previous.score)) best.set(key, course);
  }
  return [...best.values()];
}

/** 等级制转换仅用于重修优先级，不替代 toGP 的绩点规则。 */
function numScore(score: string): number {
  const t = score.trim();
  const gp = toGP(t);
  if (gp === null) return isPassFailGrade(t) ? 60 : -1;
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return ({ 优秀: 90, 良好: 80, 中等: 70, 及格: 60 } as Record<string, number>)[t] ?? 0;
}
