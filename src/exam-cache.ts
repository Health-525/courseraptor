/**
 * 考试安排本地缓存 — 与 schedule-cache 同一套约定
 *
 * 「今日档案」页要展示最近的考试，但考试数据只在对话里查过才有。
 * 断网/教务维护时页面不能空着，所以 get_exams 自动探测学期查通一次就
 * 落盘（data/exam-cache.json），日程页之后纯读缓存，不登录不请求教务。
 * 考试安排一学期变动很少，缓存由用户在对话里问考试安排自然刷新。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "./atomic-write";
import type { ExamResult } from "./jwgl/academics";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 数据目录（测试可用 RAPTOR_DATA_DIR 指到临时目录） */
function dataDir(): string {
  return process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data");
}

function cachePath(): string {
  return path.join(dataDir(), "exam-cache.json");
}

export interface CachedExams {
  /** 落盘时间戳（ms），仅展示用，不做过期判断 */
  savedAt: number;
  exams: ExamResult;
}

/** 读缓存；没有或读坏了都返回 null，调用方自行回退到在线拉取 */
export function loadExamCache(): CachedExams | null {
  let parsed: CachedExams;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
  } catch {
    quarantineCorruptFileSync(cachePath());
    return null;
  }
  if (!parsed?.exams?.year || !Array.isArray(parsed.exams.exams)) {
    quarantineCorruptFileSync(cachePath());
    return null;
  }
  return parsed;
}

/** 保存失败只打日志不影响主流程：缓存挂了顶多下次查询多登录一次 */
export function saveExamCache(exams: ExamResult): void {
  const payload: CachedExams = { savedAt: Date.now(), exams };
  try {
    writeFileAtomicSync(cachePath(), JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error("[exam-cache] 保存失败:", e);
  }
}
