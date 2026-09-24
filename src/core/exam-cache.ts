/**
 * 考试安排本地缓存 — 与 schedule-cache 同一套约定
 *
 * 「今日档案」页要展示最近的考试，但考试数据只在对话里查过才有。
 * 断网/教务维护时页面不能空着，所以 get_exams 自动探测学期查通一次就
 * 落盘（data/exam-cache.json），日程页之后纯读缓存，不登录不请求教务。
 * 考试安排一学期变动很少，缓存由用户在对话里问考试安排自然刷新。
 */

import { readJsonCache, writeJsonCache } from "./json-cache";
import type { ExamResult } from "./model";

export interface CachedExams {
  /** 落盘时间戳（ms），仅展示用，不做过期判断 */
  savedAt: number;
  exams: ExamResult;
}

function isCachedExams(parsed: unknown): parsed is CachedExams {
  const c = parsed as CachedExams;
  return Boolean(c?.exams?.year) && Array.isArray(c.exams.exams);
}

/** 读缓存；没有或读坏了都返回 null，调用方自行回退到在线拉取 */
export function loadExamCache(): CachedExams | null {
  return readJsonCache("exam-cache.json", isCachedExams);
}

/** 保存失败只打日志不影响主流程：缓存挂了顶多下次查询多登录一次 */
export function saveExamCache(exams: ExamResult): void {
  writeJsonCache("exam-cache.json", { savedAt: Date.now(), exams }, "exam-cache");
}
