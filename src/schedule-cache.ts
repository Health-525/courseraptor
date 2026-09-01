/**
 * 课表本地缓存 — 免登录直读
 *
 * 之前 TUI 每次启动都要登录教务系统拉一遍课表才能渲染「今日课表」，
 * 断网/教务维护时首屏直接降级。课表一学期基本不变，没必要每次都拉：
 *
 * - get_schedule 查通一次就落盘（data/schedule-cache.json）
 * - 之后启动面板直接读缓存，完全不登录、不请求教务系统
 * - 缓存是「最后已知课表」：学期切换后由用户问一次课表自然刷新，
 *   读坏了按 .corrupt-<时间戳> 备份后当无缓存处理
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "./atomic-write";
import type { ScheduleResult } from "./jwgl/academics";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 数据目录（测试可用 RAPTOR_DATA_DIR 指到临时目录） */
function dataDir(): string {
  return process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data");
}

function cachePath(): string {
  return path.join(dataDir(), "schedule-cache.json");
}

export interface CachedSchedule {
  /** 落盘时间戳（ms），仅调试用，不做过期判断 */
  savedAt: number;
  schedule: ScheduleResult;
}

/** 读缓存；没有或读坏了都返回 null，调用方自行回退到在线拉取 */
export function loadScheduleCache(): CachedSchedule | null {
  let parsed: CachedSchedule;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
  } catch {
    // 文件在却读不出来 = 写坏了。留个 .corrupt 副本再当无缓存处理，
    // 免得下次 saveScheduleCache 以空为基回写，用户连救回来的机会都没有
    quarantineCorruptFileSync(cachePath());
    return null;
  }
  if (!parsed?.schedule?.year || !Array.isArray(parsed.schedule.courses)) {
    quarantineCorruptFileSync(cachePath());
    return null;
  }
  return parsed;
}

/** 保存失败只打日志不影响主流程：缓存挂了顶多下次启动多查一次 */
export function saveScheduleCache(schedule: ScheduleResult): void {
  const payload: CachedSchedule = { savedAt: Date.now(), schedule };
  try {
    writeFileAtomicSync(cachePath(), JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error("[schedule-cache] 保存失败:", e);
  }
}
