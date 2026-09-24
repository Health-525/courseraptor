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

import { writeFileAtomicSync } from "../atomic-write";
import { dataDir } from "../paths";

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
  source?: string,
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

function _weekdayOf(date: string): number {
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
      d.getDate(),
    ).padStart(2, "0")}`;
    const hit = loadHolidayStore().days[iso];
    if (hit) out.push({ date: iso, weekday: i + 1, ...hit });
  }
  return out;
}
