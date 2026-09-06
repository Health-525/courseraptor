/**
 * 河北农大成绩与 GPA（5.0 满绩制）
 *
 * 与 ScholarFlow 侧那套的两处口径差异，都是刻意改的：
 * 1. 「合格/通过/免修/免考」在这里是 **null（不参与 GPA）**，ScholarFlow 记 3.5 计入分母。
 *    军训、劳动、毕业实习这类课只给「合格」，按 3.5 计入会把 GPA 往上抬；
 *    按 0 计入又会往下拽。唯一正确的处理是整体移出分子分母，另记 passFailCredits。
 * 2. 缓考/缺考/空值也返回 null，而不是 ScholarFlow 那样的 0——
 *    把「还没考」当成「考了 0 分」是实打实的数据错误。
 *
 * 抓取侧沿用 courseraptor 的硬约定：单学期查询失败要重试，重试仍失败要进 failedTerms
 * 报给模型（静默丢一学期会让「你没有挂科」这类结论整个失效）。
 */

import type { GradeCourse, GradeResult } from "../../jwgl/types";
import { extractUrpRows, pickString, urpPostGrades } from "./urp";

/** 通过型成绩：有学分、不计绩点 */
export function isHebauPassFail(score: string): boolean {
  const t = String(score || "").trim();
  return ["合格", "通过", "免修", "免考"].includes(t);
}

const GRADE_POINTS: Record<string, number> = {
  优秀: 4.5,
  良好: 3.5,
  中等: 2.5,
  及格: 1.5,
  不及格: 0,
  不合格: 0,
  未通过: 0,
  不通过: 0,
};

/**
 * 河北农大绩点：百分制 = 分数/10 - 5（60 分 → 1.0，100 分 → 5.0）。
 * 返回 null 表示该成绩不参与 GPA（通过型/缓考/缺考/空），与 0（参与、绩点为 0）是两回事。
 */
export function hebauGradeToGP(score: string): number | null {
  const raw = String(score ?? "").trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (n > 100) return null;
    return n < 60 ? 0 : Math.round((n / 10 - 5) * 10) / 10;
  }
  if (raw in GRADE_POINTS) return GRADE_POINTS[raw];
  if (isHebauPassFail(raw)) return null;
  // 缓考/缺考/取消成绩等标记：不猜，移出计算，让上层如实报「待确认」
  return null;
}

/** 必修判定。URP 的 KCXZDM 给代码（001），也有直接给中文名的形态 */
export function isHebauRequired(type: string): boolean {
  const t = String(type || "").trim();
  return t === "001" || t === "必修" || t.includes("必修");
}

/** 课程性质代码 → 可读文本（001 必修 / 002 选修 这类，未知代码原样返回） */
export function normalizeCourseType(row: Record<string, unknown>): string {
  const display = pickString(row, ["KCXZDM_DISPLAY", "kcxzdm_display", "KCXZMC", "kcxzmc"]);
  if (display) return display;
  const code = pickString(row, ["KCXZDM", "kcxzdm", "KCXZ", "kcxz"]);
  const known: Record<string, string> = {
    "001": "必修",
    "002": "选修",
    "003": "选修",
    "004": "选修",
  };
  return known[code] ?? (code || "选修");
}

/** 从学号前四位推入学年份；不规范时往前多查几年（漏学期比多几个空学期严重） */
export function enrollYearFromStudentId(username: string, now = new Date().getFullYear()): number {
  const y = Number.parseInt((username || "").slice(0, 4), 10);
  if (Number.isFinite(y) && y >= 2000 && y <= now) return y;
  return now - 5;
}

/** 单行成绩 → GradeCourse。课程名为空的行（统计行、合计行）丢弃 */
export function toGradeRow(row: Record<string, unknown>, semester: string): GradeCourse | null {
  const course = pickString(row, ["KCMC", "kcmc", "XSKCM", "xskcm", "KCM", "kcm"]);
  if (!course) return null;
  return {
    course,
    courseCode: pickString(row, ["KCH", "kch", "KCDM", "kcdm"]),
    score: pickString(row, ["ZCJ", "zcj", "CJ", "cj", "BFZCJ", "bfzcj"]) || "0",
    credit: pickString(row, ["XF", "xf", "JXZHXF", "jxzhxf"]) || "0",
    type: normalizeCourseType(row),
    semester: pickString(row, ["XNXQDM", "xnxqdm"]) || semester,
  };
}

/** 重修去重：键 = 课程号 + 课程性质。只按课程名去重会吞掉跨学期同名课的学分 */
export function dedupeGrades(courses: GradeCourse[]): GradeCourse[] {
  const best = new Map<string, GradeCourse>();
  for (const course of courses) {
    const key = `${course.courseCode || course.course}|${course.type || ""}`;
    const prev = best.get(key);
    if (!prev || numericScore(course.score) > numericScore(prev.score)) best.set(key, course);
  }
  return [...best.values()];
}

/** 仅用于重修比较的数值化：等级制折算成分段，未知标记排在所有有效成绩之后 */
function numericScore(score: string): number {
  const raw = String(score || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const map: Record<string, number> = {
    优秀: 90,
    良好: 80,
    中等: 70,
    及格: 60,
    合格: 60,
    通过: 60,
  };
  return map[raw] ?? -1;
}

function querySetting(semesterCode: string): string {
  return JSON.stringify([
    { name: "XNXQDM", value: semesterCode, linkOpt: "and", builder: "m_value_equal" },
    {
      name: "SFYX",
      caption: "是否有效",
      linkOpt: "AND",
      builder: "m_value_equal",
      value: "1",
      value_display: "是",
    },
    {
      name: "SHOWMAXCJ",
      caption: "显示最高成绩",
      linkOpt: "AND",
      builder: "m_value_equal",
      value: "0",
      value_display: "否",
    },
  ]);
}

/** 抓一个学期的全部成绩（分页拿全，单学期失败重试 3 次后报 failedTerms） */
async function fetchTermGrades(
  cookie: string,
  semesterCode: string,
): Promise<GradeCourse[] | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await fetchGradePage(cookie, semesterCode, 1);
    if (!page.ok) {
      if (attempt === 3) return null;
      await new Promise((r) => setTimeout(r, attempt * 1500));
      continue;
    }
    const rows = page.rows
      .map((row) => toGradeRow(row, semesterCode))
      .filter((g): g is GradeCourse => g !== null);
    // 正方用 limit 分页：返回条数等于页大小就说明后面还有
    if (rows.length < page.pageSize) return rows;
    const rest: GradeCourse[] = rows;
    let pageNumber = 2;
    while (pageNumber <= 20) {
      const next = await fetchGradePage(cookie, semesterCode, pageNumber);
      if (!next.ok) break;
      const more = next.rows
        .map((row) => toGradeRow(row, semesterCode))
        .filter((g): g is GradeCourse => g !== null);
      rest.push(...more);
      if (more.length < next.pageSize) break;
      pageNumber++;
    }
    return rest;
  }
  return null;
}

async function fetchGradePage(
  cookie: string,
  semesterCode: string,
  pageNumber: number,
): Promise<
  { ok: true; rows: Record<string, unknown>[]; pageSize: number } | { ok: false; error: string }
> {
  const pageSize = 100;
  const body = `querySetting=${encodeURIComponent(querySetting(semesterCode))}&*order=-XNXQDM,-KCH,-KXH&pageSize=${pageSize}&pageNumber=${pageNumber}&pageNum=${pageSize}&isAjax=true&sort=`;
  const resp = await urpPostGrades(cookie, body, `获取${semesterCode}成绩`);
  if (!resp.ok) return { ok: false, error: resp.error };
  const rows = extractUrpRows(resp.data, "xscjcx");
  if (!rows) return { ok: false, error: `获取${semesterCode}成绩失败：教务系统响应结构异常` };
  return { ok: true, rows, pageSize };
}

/** 抓全部学期成绩并算 GPA（5.0 制，仅必修计入） */
export async function fetchHebauGrades(cookie: string, username: string): Promise<GradeResult> {
  const all: GradeCourse[] = [];
  const failedTerms: string[] = [];
  const nowYear = new Date().getFullYear();
  const fromYear = enrollYearFromStudentId(username, nowYear);

  for (let y = Math.max(2000, fromYear); y <= nowYear; y++) {
    for (const term of ["1", "2"] as const) {
      const code = `${y}-${y + 1}-${term}`;
      const rows = await fetchTermGrades(cookie, code);
      if (rows) all.push(...rows);
      else failedTerms.push(`${code}：查询失败（已重试 3 次）`);
    }
  }

  const deduped = dedupeGrades(all);
  const required = deduped.filter((g) => isHebauRequired(g.type) && Number(g.credit) > 0);
  const scored = required.filter((g) => hebauGradeToGP(g.score) !== null);
  const excluded = required.length - scored.length;

  let gpSum = 0;
  let creditSum = 0;
  for (const g of scored) {
    const credit = Number(g.credit) || 0;
    gpSum += (hebauGradeToGP(g.score) as number) * credit;
    creditSum += credit;
  }

  return {
    gpa: creditSum > 0 ? (gpSum / creditSum).toFixed(2) : "0.00",
    requiredCredits: Math.round(creditSum * 100) / 100,
    requiredCourses: required.length,
    gpaBasis:
      `河北农大 5.0 满绩制（百分制折算：分数/10-5；优秀 4.5、良好 3.5、中等 2.5、及格 1.5）；` +
      `仅必修课计入，已排除 ${excluded} 门通过型/无绩点课程（合格、免修、缓考等不计 GPA）`,
    passFailCredits:
      Math.round(
        required
          .filter((g) => isHebauPassFail(g.score))
          .reduce((sum, g) => sum + (Number(g.credit) || 0), 0) * 100,
      ) / 100,
    allCourses: deduped,
    failedTerms,
  };
}
