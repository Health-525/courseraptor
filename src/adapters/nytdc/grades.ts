/**
 * NYTDC 全部成绩 + 平均学分绩点
 *
 * 绩点规则**与南京工业大学完全不同**，按《南京邮电大学通达学院学生学籍管理办法》
 * 第十条实现（原文可在学院官网 dqgcxy 栏目检索）：
 *
 *   课程学分绩点 = 课程学分 × 绩点系数
 *   平均学分绩点 = ∑所修课程学分绩点 / ∑所修课程的学分数    （注：任选课不计）
 *
 *   百分制   90-100   80-89    70-79    60-69    0-59
 *   绩点系数 4.5-5.0  4.0-4.45 3.5-3.95 3.0-3.45 0
 *   五级制   优秀 良好 中等 及格 不及格
 *   绩点系数 4.75 4.25 3.75 3.25 0
 *
 * 百分制各档区间与「分数 ÷ 20」逐点吻合（90→4.5、100→5.0、69→3.45），
 * 因此按 score/20 计算；实机抓取 29 条成绩与教务系统自己下发的 jd 字段
 * 逐条比对，29/29 一致。系统给了 jd 时以 jd 为准（补考/重修等特殊记法
 * 以教务系统的判定为准），只在缺失时回落到按分数推算。
 *
 * 两条与 NJTECH 不同的正确性约定：
 * 1. 学号前 2 位是入学年（25120914 → 2025 级），不是前 4 位
 * 2. 五级制的「及格」有绩点（3.25），**不能**当通过型成绩移出 GPA——
 *    南工大把「合格」移出计算是对的做法，照搬到这里会漏算整门课的学分
 */

import { RaptorError } from "../../core/errors";
import { createClient, httpError, withRetry } from "../../core/http";
import type { GradeCourse, GradeResult } from "../../core/model";
import { BASE } from "./auth";
import { isSessionExpired } from "./session";

// ── 绩点系数 ────────────────────────────────────────────────

/** 五级制成绩 → 绩点系数（学籍管理办法原文给的定值） */
const FIVE_LEVEL_GP: Record<string, number> = {
  优秀: 4.75,
  良好: 4.25,
  中等: 3.75,
  及格: 3.25,
  不及格: 0,
};

/**
 * 成绩 → 绩点系数。返回 null 表示**不参与**绩点计算（通过型/未知型），
 * 与 0（参与计算、不及格）是两回事。
 */
export function toGP(score: string): number | null {
  const t = String(score ?? "").trim();
  if (!t) return null;

  // 百分制：绩点系数 = 分数 / 20（60 分以下记 0）
  if (/^\d+(?:\.\d+)?$/.test(t)) {
    const s = Number(t);
    if (!Number.isFinite(s) || s > 100) return null;
    if (s < 60) return 0;
    return Math.round((s / 20) * 100) / 100;
  }

  if (t in FIVE_LEVEL_GP) return FIVE_LEVEL_GP[t];

  // 通过型（有学分、无绩点）：军训/免修等记「合格」「通过」时不计入 GPA
  if (isPassFailGrade(t)) return null;

  // 缓考/缺考/违纪等未知标记：不猜，移出计算
  return null;
}

/** 是否通过型成绩（有学分但不计绩点） */
export function isPassFailGrade(score: string): boolean {
  const t = String(score ?? "").trim();
  return ["合格", "通过", "免修", "免考"].includes(t);
}

/**
 * 是否任选课（不计入平均学分绩点）。
 * 依据：《学籍管理办法》第十条注「任选课不计」；选课通知说明全校性任选课
 * 课程号以 00X / 0X 开头。这里按课程性质判定（正方字段 kcxzmc = 任选），
 * 性质缺失时不臆断，仍计入 GPA。
 */
export function isOptionalCourse(type: string): boolean {
  const t = String(type ?? "").trim();
  return t.includes("任选") || t.includes("公选");
}

/** 从成绩记录取成绩文本：优先 cj，回落到 bfzcj（正方两列都存百分制/五级制） */
function scoreOf(item: Record<string, unknown>): string {
  const cj = item.cj;
  if (cj !== undefined && cj !== null && String(cj).trim() !== "") return String(cj).trim();
  const bfzcj = item.bfzcj;
  if (bfzcj !== undefined && bfzcj !== null && String(bfzcj).trim() !== "")
    return String(bfzcj).trim();
  return "";
}

/** 取该条成绩的绩点系数：教务系统下发的 jd 优先，缺失时按分数推算 */
export function gpaPointOf(item: Record<string, unknown>): number | null {
  const raw = String(item.jd ?? "").trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return toGP(scoreOf(item));
}

/** 从学号推入学年份：通达学号 8 位，前 2 位 = 入学年后两位 */
export function enrollYearFromStudentId(username: string): number {
  const t = String(username ?? "").trim();
  const now = new Date().getFullYear();
  const m = t.match(/^(\d{2})\d{4,}$/);
  if (m) {
    const y = 2000 + parseInt(m[1], 10);
    if (y >= 2000 && y <= now) return y;
  }
  // 兼容 4 位年份起头的学号（部分学校学号即 2021xxxx）
  const y4 = parseInt(t.slice(0, 4), 10);
  if (!Number.isNaN(y4) && y4 >= 2000 && y4 <= now) return y4;
  // 学号不规范：往前多查几年，宁可多几次空学期请求也不漏数据
  return now - 5;
}

// ── 抓取 ────────────────────────────────────────────────────

interface RawGrade {
  course: GradeCourse;
  gpaPoint: number | null;
}

/** 进程内短 TTL 快照：一轮要串行打 (学年数×2) 个学期接口，别重复打 */
const GRADES_MEMO_TTL_MS = 10 * 60_000;
let gradesMemo: { result: GradeResult; at: number } | null = null;

/** 测试用：清掉进程内成绩快照 */
export function clearGradesMemo(): void {
  gradesMemo = null;
}

export async function fetchAllGrades(cookie: string, username: string): Promise<GradeResult> {
  if (gradesMemo && Date.now() - gradesMemo.at < GRADES_MEMO_TTL_MS) {
    return gradesMemo.result;
  }
  const client = createClient(BASE, cookie);

  const all: RawGrade[] = [];
  const failedTerms: string[] = [];
  const endYear = new Date().getFullYear();
  const startYear = enrollYearFromStudentId(username);

  // 单学期查询带重试；失败学期如实进 failedTerms，不静默变成「没有这门课」
  const fetchTerm = async (y: number, q: number): Promise<RawGrade[] | null> => {
    try {
      return await withRetry(
        async () => {
          const resp = await client.req("/cjcx/cjcx_cxDgXscj.html?doType=query&gnmkdm=N305005", {
            method: "POST",
            body: `xnm=${y}&xqm=${q}&_search=false&nd=${Date.now()}&queryModel.showCount=200&queryModel.currentPage=1`,
          });
          const failure = httpError(resp);
          if (failure) throw failure;
          if (isSessionExpired(resp.body)) {
            throw new RaptorError("SESSION_EXPIRED", "教务会话已失效（可能被服务端提前下线）", {
              retryable: false,
            });
          }

          const data = JSON.parse(resp.body) as { items?: Array<Record<string, unknown>> };
          return (data.items ?? []).map((g: Record<string, unknown>): RawGrade => {
            const score = scoreOf(g);
            return {
              course: {
                course: String(g.kcmc || ""),
                courseCode: String(g.kch || ""),
                score,
                credit: String(g.xf ?? ""),
                type: String(g.kcxzmc || ""),
                semester: `${String(g.xnmmc ?? "")}${String(g.xqmmc ?? "")}`,
                category: String(g.kcgsmc || ""),
                courseClass: String(g.kclbmc || ""),
              },
              gpaPoint: gpaPointOf(g),
            };
          });
        },
        { attempts: 3, baseDelayMs: 1500, backoff: "linear" },
      );
    } catch (e) {
      failedTerms.push(`${y}-${q === 3 ? 1 : 2}：${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  };

  const attempted = (endYear - startYear + 1) * 2;
  for (let y = startYear; y <= endYear; y++) {
    for (const q of [3, 12]) {
      const term = await fetchTerm(y, q);
      if (term) all.push(...term);
    }
  }

  // 全部学期都失败：不能把「GPA 0.00 + 零课程」当成功结果交出去
  if (attempted > 0 && failedTerms.length >= attempted) {
    throw new RaptorError(
      "UPSTREAM",
      `全部 ${attempted} 个学期的成绩查询均失败（${failedTerms[0]}）；已放弃，未污染本地成绩缓存`,
    );
  }

  const deduped = deduplicateRawGrades(all);

  // 平均学分绩点：任选课不计；0 学分课程不改变分母，直接排除
  const scored = deduped.filter(
    (r) =>
      !isOptionalCourse(r.course.type) &&
      r.gpaPoint !== null &&
      (parseFloat(r.course.credit) || 0) > 0,
  );
  const counted = deduped.filter((r) => !isOptionalCourse(r.course.type));
  const optionalCredits = deduped
    .filter((r) => isOptionalCourse(r.course.type))
    .reduce((sum, r) => sum + (parseFloat(r.course.credit) || 0), 0);

  let tg = 0;
  let tc = 0;
  for (const r of scored) {
    const credit = parseFloat(r.course.credit) || 0;
    tg += (r.gpaPoint as number) * credit;
    tc += credit;
  }
  const gpa = tc > 0 ? (tg / tc).toFixed(2) : "0.00";

  const passFailCredits = counted
    .filter((r) => isPassFailGrade(r.course.score))
    .reduce((sum, r) => sum + (parseFloat(r.course.credit) || 0), 0);

  const result: GradeResult = {
    gpa,
    /** 语义：计入平均学分绩点的课程学分和（不含任选课），不是总修学分 */
    requiredCredits: Math.round(tc * 100) / 100,
    requiredCourses: scored.length,
    gpaBasis:
      `平均学分绩点口径（学籍管理办法第十条）：∑(学分×绩点系数)÷∑学分，任选课不计——` +
      `本次排除任选课 ${deduped.filter((r) => isOptionalCourse(r.course.type)).length} 门 / ${Math.round(optionalCredits * 100) / 100} 学分；` +
      `绩点系数取自教务系统下发值（百分制 = 分数÷20，五级制 优秀4.75/良好4.25/中等3.75/及格3.25）`,
    passFailCredits: passFailCredits > 0 ? Math.round(passFailCredits * 100) / 100 : undefined,
    allCourses: deduped.map((r) => r.course),
    failedTerms,
  };

  // 残缺结果不进快照：挂了学期的「半份成绩」被缓存 10 分钟会让用户看到同一份残缺数据
  if (failedTerms.length === 0) {
    gradesMemo = { result, at: Date.now() };
  }
  return result;
}

/**
 * 重修取最高分。键 = 课程号 + 课程性质（沿用 NJTECH 的教训：只按课程名去重
 * 会把多学期同名课合并、学分凭空消失）；任选课同一课程号历年来只记一次学分。
 */
export function deduplicateRawGrades(records: RawGrade[]): RawGrade[] {
  const best = new Map<string, RawGrade>();
  for (const r of records) {
    const key = `${r.course.courseCode || r.course.course}|${r.course.type || ""}`;
    const prev = best.get(key);
    if (!prev || compareScore(r) > compareScore(prev)) best.set(key, r);
  }
  return [...best.values()];
}

/** 排序用的成绩数值：绩点、五级制折算、未知给 -1（不能覆盖有效成绩） */
function compareScore(r: RawGrade): number {
  const t = String(r.course.score ?? "").trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if (r.gpaPoint !== null) return r.gpaPoint * 20;
  return -1;
}
