/**
 * 课表本地缓存 — 免登录直读
 *
 * 之前 TUI 每次启动都要登录教务系统拉一遍课表才能渲染「今日课表」，
 * 断网/教务维护时首屏直接降级。课表一学期基本不变，没必要每次都拉：
 *
 * - get_schedule 查通一次就落盘（data/schedule-cache.json）
 * - 之后启动面板直接读缓存，完全不登录、不请求教务系统
 * - 缓存是「最后已知课表」：学期切换后由用户问一次课表自然刷新，
 *   读写与坏文件隔离的公共约定见 json-cache.ts
 */

import { readJsonCache, writeJsonCache } from "./json-cache";
import type { ScheduleResult } from "./jwgl/academics";

export interface CachedSchedule {
  /** 落盘时间戳（ms），仅调试用，不做过期判断 */
  savedAt: number;
  schedule: ScheduleResult;
}

function isCachedSchedule(parsed: unknown): parsed is CachedSchedule {
  const c = parsed as CachedSchedule;
  return Boolean(c?.schedule?.year) && Array.isArray(c.schedule.courses);
}

/** 读缓存；没有或读坏了都返回 null，调用方自行回退到在线拉取 */
export function loadScheduleCache(): CachedSchedule | null {
  return readJsonCache("schedule-cache.json", isCachedSchedule);
}

/** 保存失败只打日志不影响主流程：缓存挂了顶多下次启动多查一次 */
export function saveScheduleCache(schedule: ScheduleResult): void {
  writeJsonCache("schedule-cache.json", { savedAt: Date.now(), schedule }, "schedule-cache");
}
