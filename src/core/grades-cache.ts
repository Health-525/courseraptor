/**
 * 成绩本地缓存 — 与 schedule-cache / exam-cache 同一套约定
 *
 * 成绩面板要与课表/考试一样「纯读缓存，零登录零模型」：对话里
 * get_grades 查通一次就落盘（data/grades-cache.json），面板与
 * GET /api/grades 只读缓存。成绩只增不改（重复课取最高分口径
 * 已在查询层处理），缓存由用户在对话里问成绩自然刷新。
 */

import { readJsonCache, writeJsonCache } from "./json-cache";
import type { GradeCourse } from "./model";
import { registeredSchool } from "./school";

export interface CachedGradeCourse {
  course: string;
  /** 教务原始口径：分数或等级制字符串（优/良/通过……） */
  score: number | string;
  credit: number | string;
  type?: string;
  semester: string;
}

export interface CachedGrades {
  /** 落盘时间戳（ms），仅展示用，不做过期判断 */
  savedAt: number;
  /** 写入时的学校 id：切换学校后不得拿别校成绩冒充缓存（与 schedule-cache 同约定） */
  schoolId?: string;
  /** 两位小数字符串（查询层 toFixed 口径） */
  gpa: number | string;
  gpaBasis?: string;
  /** 计入 GPA 的必修课学分和（不是总修学分） */
  requiredCredits: number;
  courseCount: number;
  /** 最近学期（按学期号排序最大者）的课程，成绩面板速览用 */
  recentSemester?: string;
  recentCourses: CachedGradeCourse[];
  /**
   * 全部学期的课程明细（GradeCourse 完整结构，含 courseCode/category/courseClass）。
   * 引入目的：get_grades 走缓存模式时也能返回完整明细与派生量
   * （academicSummary/generalElectives/failedTerms），不必再登录教务。
   * 老缓存没有此字段：调用方降级为只返回摘要 + staleHint 提示 refresh=true。
   */
  allCourses?: GradeCourse[];
  /** 计入 GPA 的必修课门数（GradeResult.requiredCourses） */
  requiredCourses?: number;
  /** 通过型（合格/免修）必修课学分：有学分、不计 GPA */
  passFailCredits?: number;
  /** 彻底拿不到数据的学期；空数组才代表完整 */
  failedTerms?: string[];
}

function isCachedGrades(parsed: unknown): parsed is CachedGrades {
  const c = parsed as CachedGrades;
  return c?.gpa != null && Array.isArray(c.recentCourses);
}

/** 读缓存；没有、读坏了或不是当前学校的都返回 null，调用方自行提示去对话里查 */
export function loadGradesCache(): CachedGrades | null {
  const cached = readJsonCache("grades-cache.json", isCachedGrades);
  // 旧缓存没有学校标记：视为当前学校写入（向后兼容）；与 schedule-cache 同款守卫
  const current = registeredSchool();
  if (cached?.schoolId && current && cached.schoolId !== current.info.id) return null;
  return cached;
}

/** 保存失败只打日志不影响主流程：缓存挂了顶多面板显示「还没有数据」 */
export function saveGradesCache(payload: Omit<CachedGrades, "savedAt" | "schoolId">): void {
  const current = registeredSchool();
  writeJsonCache(
    "grades-cache.json",
    { savedAt: Date.now(), ...(current ? { schoolId: current.info.id } : {}), ...payload },
    "grades-cache",
  );
}
