/**
 * 成绩本地缓存 — 与 schedule-cache / exam-cache 同一套约定
 *
 * 成绩面板要与课表/考试一样「纯读缓存，零登录零模型」：对话里
 * get_grades 查通一次就落盘（data/grades-cache.json），面板与
 * GET /api/grades 只读缓存。成绩只增不改（重复课取最高分口径
 * 已在查询层处理），缓存由用户在对话里问成绩自然刷新。
 */

import { readJsonCache, writeJsonCache } from "./json-cache";

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
  /** 两位小数字符串（查询层 toFixed 口径） */
  gpa: number | string;
  gpaBasis?: string;
  /** 计入 GPA 的必修课学分和（不是总修学分） */
  requiredCredits: number;
  courseCount: number;
  /** 最近学期（按学期号排序最大者）的课程，成绩面板速览用 */
  recentSemester?: string;
  recentCourses: CachedGradeCourse[];
}

function isCachedGrades(parsed: unknown): parsed is CachedGrades {
  const c = parsed as CachedGrades;
  return c?.gpa != null && Array.isArray(c.recentCourses);
}

/** 读缓存；没有或读坏了都返回 null，调用方自行提示去对话里查 */
export function loadGradesCache(): CachedGrades | null {
  return readJsonCache("grades-cache.json", isCachedGrades);
}

/** 保存失败只打日志不影响主流程：缓存挂了顶多面板显示「还没有数据」 */
export function saveGradesCache(payload: Omit<CachedGrades, "savedAt">): void {
  writeJsonCache("grades-cache.json", { savedAt: Date.now(), ...payload }, "grades-cache");
}
