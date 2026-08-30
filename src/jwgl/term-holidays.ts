/**
 * 放假/调休日历 — 单一真值源（data/term-holidays.json）
 *
 * 为什么独立成文件：校历（term-dates）只给学期框架（第 1 周从哪天开始），
 * 具体哪天放假、哪个周末调休补课，教务处每学期临近才发通知。
 * 通知是自然语言、每年措辞不一，正则解析必然漏——所以解析交给 agent
 * （read_notice 读正文 → 逐日整理 → set_holidays 落盘），本模块只负责：
 * 存取真值 + 把假期/调休叠到课表的周分组上。
 *
 * 两种覆盖：
 * - holiday：该日放假，当天不按课表上课（get_schedule 里整周标注，课表作废）
 * - makeup：调休补课日（通常是周末），按 follows 指定的周几课表上课
 *
 * 与 term-dates 同一套规则：运行时可写（agent 落盘）、原子写、坏文件隔离。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { quarantineCorruptFileSync, writeFileAtomicSync } from "../atomic-write";
import {
  courseLineBody,
  expandWeeks,
  WEEKDAY_NAMES,
  type WeekGroup,
} from "./academics";
import type { CourseData } from "./types";

export type SpecialDayType = "holiday" | "makeup";

export interface SpecialDay {
  type: SpecialDayType;
  /** holiday：节日名（如「国庆节」），多个节日合并放假时用「、」连接 */
  name?: string;
  /** makeup 必填：该天按周几（1-7 = 周一～周日）的课表上课 */
  follows?: number;
}

/** 带日期的完整记录（date: YYYY-MM-DD） */
export interface SpecialDayRecord extends SpecialDay {
  date: string;
}

/** 落在某个教学周里的记录，补算出星期几 */
export interface WeekSpecialDay extends SpecialDayRecord {
  /** 1-7，该日期对应的星期几 */
  weekday: number;
}

interface HolidayStore {
  days: Record<string, SpecialDay>;
  /** 依据：通知标题/文号 */
  source?: string;
  recordedAt?: string;
}

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

function dataDir(): string {
  return process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data");
}

function storePath(): string {
  return path.join(dataDir(), "term-holidays.json");
}

// ── 存取 ──────────────────────────────────────────────────────

let cache: HolidayStore | null = null;

export function loadHolidayStore(): HolidayStore {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as HolidayStore;
    cache = { days: parsed.days ?? {}, source: parsed.source, recordedAt: parsed.recordedAt };
  } catch {
    // 与 term-dates 不同：这里没有存量种子，空表就是合法初始态
    //（放假通知每学期才来几条，首次运行必然还没有）。
    cache = { days: {} };
  }
  return cache;
}

function persist(store: HolidayStore): void {
  try {
    writeFileAtomicSync(storePath(), JSON.stringify(store, null, 2));
  } catch {
    // 只读环境下退化为内存存储，课表叠加照样生效
  }
}

/** 记录日期是否合法（YYYY-MM-DD 且能还原成真实日期） */
function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = new Date(`${date}T00:00:00`);
  return !Number.isNaN(t.getTime()) && t.getDate() === parseInt(date.slice(8), 10);
}

/**
 * 合并写入一批特殊日（upsert：同日期以新记录为准）。
 * 返回实际写入的天数；非法日期直接拒绝——放假安排落错一天，
 * 用户就会按错课表出门，宁可在工具层报错让模型重试。
 */
export function recordSpecialDays(
  entries: SpecialDayRecord[],
  source?: string
): { recorded: number; rejected: string[] } {
  const store = loadHolidayStore();
  const rejected: string[] = [];
  let recorded = 0;

  for (const e of entries) {
    if (!isValidDate(e.date) || (e.type === "makeup" && !e.follows)) {
      rejected.push(e.date);
      continue;
    }
    const { date, type, name, follows } = e;
    store.days[date] = { type, ...(name ? { name } : {}), ...(follows ? { follows } : {}) };
    recorded++;
  }

  if (recorded > 0) {
    if (source) store.source = source;
    store.recordedAt = new Date().toISOString();
    persist(store);
  }
  return { recorded, rejected };
}

/** 撤掉某些日期的记录（通知更正/撤回时用）；返回实际删除数 */
export function removeSpecialDays(dates: string[]): number {
  const store = loadHolidayStore();
  let removed = 0;
  for (const d of dates) {
    if (store.days[d]) {
      delete store.days[d];
      removed++;
    }
  }
  if (removed > 0) persist(store);
  return removed;
}

/** 全量列出，按日期升序 */
export function listSpecialDays(): SpecialDayRecord[] {
  const store = loadHolidayStore();
  return Object.entries(store.days)
    .map(([date, day]) => ({ date, ...day }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 某天的安排；没有返回 null */
export function specialOnDate(date: string): SpecialDay | null {
  return loadHolidayStore().days[date] ?? null;
}

function weekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00`).getDay();
  return day === 0 ? 7 : day;
}

/**
 * 第 week 教学周（week1Monday 起，每 7 天一周）内的特殊日。
 * 假期/调休都是按「日期」通知的，叠到周分组前先把日期归周。
 */
export function specialDaysOfWeek(week1Monday: string, week: number): WeekSpecialDay[] {
  const start = new Date(`${week1Monday}T00:00:00`).getTime() + (week - 1) * 7 * 86400000;
  const out: WeekSpecialDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start + i * 86400000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
    const hit = loadHolidayStore().days[iso];
    if (hit) out.push({ date: iso, weekday: i + 1, ...hit });
  }
  return out;
}

// ── 叠加到课表周分组 ─────────────────────────────────────────

export interface AnnotatedWeekGroup extends WeekGroup {
  /**
   * 该周放假安排（连续日期已合并成一段，如「10-01（周四）～10-03（周六）放假：国庆节」）。
   * 存在即表示这些天不按普通课表上课——模型必须以此覆盖 lines。
   */
  holiday?: string[];
  /**
   * 调休补课行（如「10-10（周六）调休·按周四课表 · 1-2节 · 高等数学 @教学楼」）。
   * 普通周末在 lines 里没有课，这些行是按 follows 周几补出来的。
   */
  makeup?: string[];
}

/** MM-DD 短日期 */
function shortDate(iso: string): string {
  return iso.slice(5).replace("-", "-");
}

/** 同一周内连续的假期日合并成一段描述 */
function mergeHolidayRuns(days: WeekSpecialDay[]): string[] {
  const runs: string[] = [];
  let run: WeekSpecialDay[] = [];

  const flush = () => {
    if (!run.length) return;
    const names = [...new Set(run.map((d) => d.name).filter(Boolean))] as string[];
    const label =
      run.length === 1
        ? `${shortDate(run[0].date)}（${WEEKDAY_NAMES[run[0].weekday]}）`
        : `${shortDate(run[0].date)}（${WEEKDAY_NAMES[run[0].weekday]}）～${shortDate(
            run[run.length - 1].date
          )}（${WEEKDAY_NAMES[run[run.length - 1].weekday]}）`;
    runs.push(`${label}放假${names.length ? "：" + names.join("、") : ""}`);
    run = [];
  };

  for (const d of days) {
    const prev = run[run.length - 1];
    const consecutive =
      prev &&
      new Date(`${d.date}T00:00:00`).getTime() - new Date(`${prev.date}T00:00:00`).getTime() ===
        86400000;
    if (consecutive) run.push(d);
    else {
      flush();
      run = [d];
    }
  }
  flush();
  return runs;
}

/**
 * 把假期/调休叠加到 buildWeekIndex 的周分组上。
 * 返回新数组（不改入参）；没有特殊日的周与原分组完全一致。
 */
export function annotateWeekGroups(
  courses: CourseData[],
  week1Monday: string,
  groups: WeekGroup[]
): AnnotatedWeekGroup[] {
  return groups.map((g) => {
    const specials = specialDaysOfWeek(week1Monday, g.week);
    if (!specials.length) return { ...g };

    const holiday = mergeHolidayRuns(specials.filter((d) => d.type === "holiday"));
    const makeup: string[] = [];
    for (const d of specials) {
      if (d.type !== "makeup" || !d.follows) continue;
      const followsLabel = WEEKDAY_NAMES[d.follows] ?? `周${d.follows}`;
      for (const c of courses) {
        if (c.weekday !== d.follows) continue;
        if (!expandWeeks(c.weeks).includes(g.week)) continue;
        makeup.push(
          [
            `${shortDate(d.date)}（${WEEKDAY_NAMES[d.weekday]}）调休·按${followsLabel}课表`,
            courseLineBody(c),
          ]
            .filter(Boolean)
            .join(" · ")
        );
      }
    }

    return {
      ...g,
      ...(holiday.length ? { holiday } : {}),
      ...(makeup.length ? { makeup } : {}),
    };
  });
}
