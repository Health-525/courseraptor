/**
 * 时间查询 — 模型的「时钟」
 *
 * 为什么需要这个模块：
 * 模型没有可靠的当前时间感——训练有截止日期，运行时的「今天」只能凭
 * 内部印象推断，一错就是系统性错：明天几号、第几周、通知过没过期、
 * 距离截止还有几天，整条推理链全跟着错。这里给出唯一真值：
 * - 时钟读数取本机系统时间（now 可注入，测试离线且确定性）
 * - 教学周复用 term-dates 单一真值源，不另立周次标准
 * - 时区换算用 Intl（IANA 名），学校口径固定北京时间
 */

import { candidateXnxqList, termLabel } from "./jwgl/academics";
import { currentWeekOf, resolveWeek1Monday, type TermDateSource } from "./jwgl/term-dates";

/** 学校所在时区：教务日历、周次口径全部按北京时间 */
export const SCHOOL_TIMEZONE = "Asia/Shanghai";

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export interface TermNow {
  label: string;
  /** 第几教学周；所有候选学期都不在学期内（假期）为 null */
  week: number | null;
  /** 第 1 周周一，YYYY-MM-DD */
  week1Monday: string;
  /** 本教学周的周一~周日（ YYYY-MM-DD ~ YYYY-MM-DD ），week 为 null 时省略 */
  weekRange?: string;
  /** 距下一个候选学期开学还有几天（week 为 null 时才有） */
  daysUntilStart?: number;
  source: TermDateSource;
  evidence?: string;
}

export interface TimeReport {
  timezone: string;
  /** 2026-09-05（周六）14:30:45，可直接引用的完整读数 */
  datetime: string;
  date: string;
  time: string;
  weekday: string;
  /** 带时区偏移的 ISO 8601 */
  iso: string;
  epochMs: number;
  utcOffset: string;
  /** 北京时间读数（学校口径，无论查哪个时区都带上） */
  beijingNow: string;
  /** 本学期教学周（按北京时间口径） */
  term: TermNow;
}

export type TimeResult = { ok: true; data: TimeReport } | { ok: false; error: string };

/** 目标时区的日历字段。en-CA + h23 保证 YYYY-MM-DD 与 00~23 小时，不受本机时区影响 */
function calendarParts(timezone: string, now: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    fmt
      .formatToParts(now)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
}

/** 时区偏移（如 +08:00）。longOffset 形如 "GMT+08:00"，GMT 本尊表示 +00:00 */
function utcOffsetOf(timezone: string, now: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  });
  const name = fmt.formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name === "GMT" ? "+00:00" : name.replace("GMT", "");
}

/** 纯日历日期平移 N 天（按 UTC 解析，不受本机时区影响） */
function shiftDate(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 日历日期是周几（按 UTC 解析纯日期，不受本机时区影响） */
function weekdayOf(ymd: string): string {
  return WEEKDAY_NAMES[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
}

/**
 * 学期周次快照：按候选学期（新到旧）找第一个还在学期内的；
 * 周次公式与真值都在 term-dates，这里只做选择与包装。
 */
function termNow(now: Date): TermNow {
  for (const c of candidateXnxqList(now)) {
    const w = currentWeekOf(c.year, c.semester, now);
    if (w) {
      const monday = shiftDate(w.week1Monday, (w.week - 1) * 7);
      return {
        label: termLabel(c.year, c.semester),
        week: w.week,
        week1Monday: w.week1Monday,
        weekRange: `${monday} ~ ${shiftDate(monday, 6)}`,
        source: w.source,
        evidence: w.evidence,
      };
    }
  }
  // 候选学期都不在学期内（长假/交界期）：给最近的候选学期与倒计时
  const first = candidateXnxqList(now)[0];
  const info = resolveWeek1Monday(first.year, first.semester);
  const beijingDate = calendarParts(SCHOOL_TIMEZONE, now);
  const today = `${beijingDate.year}-${beijingDate.month}-${beijingDate.day}`;
  return {
    label: termLabel(first.year, first.semester),
    week: null,
    week1Monday: info.week1Monday,
    daysUntilStart: Math.ceil(
      (new Date(`${info.week1Monday}T00:00:00Z`).getTime() -
        new Date(`${today}T00:00:00Z`).getTime()) /
        86400000,
    ),
    source: info.source,
    evidence: info.evidence,
  };
}

/**
 * 取当前时间快照。timezone 非法时返回失败——
 * 与课表/天气同一套契约：查不到 ≠ 猜一个，让模型如实转告。
 */
export function getTimeReport(timezone = SCHOOL_TIMEZONE, now: Date = new Date()): TimeResult {
  let p: Record<string, string>;
  try {
    p = calendarParts(timezone, now);
  } catch {
    return {
      ok: false,
      error: `无法识别的时区「${timezone}」：请用 IANA 时区名，如 Asia/Shanghai、America/New_York、UTC`,
    };
  }

  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}:${p.second}`;
  const offset = utcOffsetOf(timezone, now);

  const bj = calendarParts(SCHOOL_TIMEZONE, now);
  const bjDate = `${bj.year}-${bj.month}-${bj.day}`;

  return {
    ok: true,
    data: {
      timezone,
      datetime: `${date}（${weekdayOf(date)}）${time}`,
      date,
      time,
      weekday: weekdayOf(date),
      iso: `${date}T${time}${offset}`,
      epochMs: now.getTime(),
      utcOffset: offset,
      beijingNow: `${bjDate}（${weekdayOf(bjDate)}）${bj.hour}:${bj.minute}:${bj.second}`,
      term: termNow(now),
    },
  };
}
