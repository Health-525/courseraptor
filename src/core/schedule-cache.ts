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
import type { ScheduleResult } from "./model";
import { registeredSchool } from "./school";

export interface CachedSchedule {
  /** 落盘时间戳（ms），仅调试用，不做过期判断 */
  savedAt: number;
  schedule: ScheduleResult;
  /**
   * 最初导入/在线拉取的课表快照：edit_schedule 首次修改前落下的
   * 「官方原件」，revert 靠它整体还原。在线刷新与重新导入走
   * saveScheduleCache 覆盖式写入、不保留 base——官方课表永远赢过本地手改。
   */
  base?: ScheduleResult;
  /** 落盘时的学校 id：真实学校之间切换后（如 hebau 切回 njtech）在线失败时，
   *  不得回退到别校导入的课表冒充「最后已知课表」。手动课表学校（custom）
   *  例外：读时放行别校标记的缓存（见 loadScheduleCache） */
  schoolId?: string;
}

function isScheduleResult(parsed: unknown): parsed is ScheduleResult {
  const s = parsed as ScheduleResult;
  return Boolean(s?.year) && Array.isArray(s.courses);
}

function isCachedSchedule(parsed: unknown): parsed is CachedSchedule {
  const c = parsed as CachedSchedule;
  if (!isScheduleResult(c?.schedule)) return false;
  return c.base === undefined || isScheduleResult(c.base);
}

/** 读缓存；没有、读坏了或不是当前学校的都返回 null，调用方自行回退到在线拉取 */
export function loadScheduleCache(): CachedSchedule | null {
  const cached = readJsonCache("schedule-cache.json", isCachedSchedule);
  // 旧缓存没有学校标记：视为当前学校写入（向后兼容，不破坏存量用户）；
  // 下一次保存会补上标记。未装配学校（纯工具层单测）时跳过分校判断。
  // 手动课表学校（custom）例外放行：它不指向任何学校、也没有在线链路，
  // 缓存就是唯一数据源，同一位用户的课表不因切到「无适配」而全体失明；
  // 真实学校之间的守卫不变，custom 导入的课表依旧不会被真实学校读走
  const current = registeredSchool();
  if (cached?.schoolId && current && cached.schoolId !== current.info.id && !current.info.manual) {
    return null;
  }
  return cached;
}

/** 保存失败只打日志不影响主流程：缓存挂了顶多下次启动多查一次 */
export function saveScheduleCache(schedule: ScheduleResult): void {
  const current = registeredSchool();
  writeJsonCache(
    "schedule-cache.json",
    { savedAt: Date.now(), schedule, ...(current ? { schoolId: current.info.id } : {}) },
    "schedule-cache",
  );
}

/**
 * 本地编辑后的缓存整体落盘（保留 base 快照字段）。edit_schedule 专用；
 * 在线拉取与网页导入走 saveScheduleCache 覆盖式写入、隐含清掉 base。
 */
export function saveScheduleEntry(entry: CachedSchedule): void {
  const current = registeredSchool();
  writeJsonCache(
    "schedule-cache.json",
    {
      savedAt: Date.now(),
      schedule: entry.schedule,
      ...(entry.base ? { base: entry.base } : {}),
      ...(current ? { schoolId: current.info.id } : {}),
    },
    "schedule-cache",
  );
}
