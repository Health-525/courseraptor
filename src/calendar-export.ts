/**
 * 整学期 .ics 日历导出
 *
 * 参考了 ScholarFlow 的 lib/ics.ts（单周导出、浏览器 Blob 下载），但这里
 * 面向 CLI/QQ 渠道做了完整版：整学期周次展开、放假跳过、调休补课、考试
 * 事件（带提前提醒）。全部真值复用既有单一数据源——周次表达式 expandWeeks、
 * 节次时刻 periodTimeRange、放假调休 term-holidays，本模块只做拼装：
 * - 日期用纯日历字符串按 UTC 平移，不受本机时区影响
 * - 时间带 TZID=Asia/Shanghai（附 VTIMEZONE），手机在境外也能落对时刻
 * - 行折叠按 UTF-8 字节数（RFC 5545 的 75 octet 上限），中文标题不超宽
 * - UID 由日期+时刻+标题哈希构成，重复导出再导入是覆盖而非重复建事件
 */

import { expandWeeks, periodTimeRange, WEEKDAY_NAMES } from "./jwgl/academics";
import { listSpecialDays, specialOnDate } from "./jwgl/term-holidays";
import type { CourseData, ExamData } from "./jwgl/types";

export interface CalendarExportCounts {
  /** 普通教学周课程事件数 */
  courseEvents: number;
  /** 调休补课日补出的事件数 */
  makeupEvents: number;
  /** 放假日吞掉的课程事件数（当天课不上） */
  holidaySkipped: number;
  /** 放假日全天使事件数（如「国庆节放假」） */
  holidayEvents: number;
  /** 考试事件数（带提前 30 分钟提醒） */
  examEvents: number;
  /** 节次缺失无法定时而跳过的课程数 */
  noTimeSkipped: number;
}

export interface CalendarExportResult extends CalendarExportCounts {
  ics: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 日期数字部分：2026-09-02 -> 20260902 */
function icsDate(ymd: string): string {
  return ymd.replace(/-/g, "");
}

/** 时间字符串 HH:MM -> HHMM */
function icsTime(hm: string): string {
  return hm.replace(":", "");
}

/** 纯日历日期按 UTC 平移 N 天，返回 YYYY-MM-DD */
function shiftDate(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 第 week 教学周的第 weekday 天（1-7 = 周一～周日）的日期 */
function dateOfWeek(week1Monday: string, week: number, weekday: number): string {
  return shiftDate(week1Monday, (week - 1) * 7 + (weekday - 1));
}

/** 两个日历日期间隔的天数（to - from） */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000,
  );
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** djb2：稳定哈希，UID 跨多次导出保持一致（重复导入=更新，不是新建） */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** RFC 5545 行折叠：按 UTF-8 字节数截到 75，续行以空格开头；不切开多字节字符 */
function fold(line: string): string {
  const MAX = 75;
  if (Buffer.byteLength(line, "utf8") <= MAX) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = MAX;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
      limit = MAX - 1; // 续行以空格开头，内容上限少一字节
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

interface EventDraft {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM；缺省 = 全天事件 */
  startHm?: string;
  endHm?: string;
  summary: string;
  location?: string;
  description?: string;
  alarmMinutesBefore?: number;
}

/** 解析「14:00-16:00」这类时间段；不认识的格式返回 null（退化为全天事件） */
function parseTimeRange(text: string): { startHm: string; endHm: string } | null {
  const m = text.match(/(\d{1,2}):(\d{2})\s*[-~]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return {
    startHm: `${pad2(Number(m[1]))}:${m[2]}`,
    endHm: `${pad2(Number(m[3]))}:${m[4]}`,
  };
}

/**
 * 组装整学期 ICS。courses/exams 为正方原始数据；week1Monday 是第 1 周周一；
 * now 只影响 DTSTAMP（注入让测试可复现）。
 */
export function buildTermICS(opts: {
  courses: CourseData[];
  exams: ExamData[];
  week1Monday: string;
  termLabel: string;
  now?: Date;
}): CalendarExportResult {
  const { courses, exams, week1Monday, termLabel } = opts;
  const now = opts.now ?? new Date();
  const stamp = `${icsDate(now.toISOString().slice(0, 10))}T${now
    .toISOString()
    .slice(11, 16)
    .replace(":", "")}00Z`;

  const counts: CalendarExportCounts = {
    courseEvents: 0,
    makeupEvents: 0,
    holidaySkipped: 0,
    holidayEvents: 0,
    examEvents: 0,
    noTimeSkipped: 0,
  };

  const drafts: EventDraft[] = [];
  const seenHolidays = new Set<string>();

  // ── 课程：逐周展开成具体日期，再按假期/调休覆盖 ──────────────
  for (const c of courses) {
    const range = periodTimeRange(c.periods);
    const time = range ? parseTimeRange(range) : null;
    if (!time) {
      counts.noTimeSkipped++;
      continue;
    }

    for (const week of expandWeeks(c.weeks)) {
      const date = dateOfWeek(week1Monday, week, c.weekday);
      const special = specialOnDate(date);

      if (special?.type === "holiday") {
        counts.holidaySkipped++;
        if (!seenHolidays.has(date)) {
          seenHolidays.add(date);
          drafts.push({
            date,
            summary: `放假：${special.name ?? "休"}`,
            description: "教务处放假安排，当天课表作废",
          });
          counts.holidayEvents++;
        }
        continue;
      }

      if (special?.type === "makeup") {
        // 调休补课日全天执行 follows 周几的课表：自然落在该天的课不上，
        // follows 的课在下方补课 pass 里按「补课日 × 被换周几」生成
        continue;
      }

      drafts.push({
        date,
        ...time,
        summary: c.title,
        location: c.location || undefined,
        description: [c.teacher ? `教师：${c.teacher}` : "", `第 ${week} 周`]
          .filter(Boolean)
          .join("\n"),
      });
      counts.courseEvents++;
    }
  }

  // ── 特殊日全量 pass：补课事件 + 没排课也该可见的放假日 ──────
  // 补课不能靠「课程自然日期」走到：周三的课永远落在周三，落不到补课的
  // 周六——必须按「补课日 × 被换周几的课」反着生成。
  const termEnd = shiftDate(week1Monday, 30 * 7);
  for (const d of listSpecialDays()) {
    if (d.date < week1Monday || d.date > termEnd) continue;

    if (d.type === "holiday") {
      if (seenHolidays.has(d.date)) continue;
      seenHolidays.add(d.date);
      drafts.push({
        date: d.date,
        summary: `放假：${d.name ?? "休"}`,
        description: "教务处放假安排，当天课表作废",
      });
      counts.holidayEvents++;
      continue;
    }

    if (d.type === "makeup" && d.follows) {
      const week = Math.floor(daysBetween(week1Monday, d.date) / 7) + 1;
      for (const c of courses) {
        if (c.weekday !== d.follows) continue;
        if (!expandWeeks(c.weeks).includes(week)) continue;
        const range = periodTimeRange(c.periods);
        const time = range ? parseTimeRange(range) : null;
        if (!time) continue;
        drafts.push({
          date: d.date,
          ...time,
          summary: c.title,
          location: c.location || undefined,
          description: [
            c.teacher ? `教师：${c.teacher}` : "",
            `第 ${week} 周 · 调休补课（按${WEEKDAY_NAMES[d.follows] ?? `周${d.follows}`}课表）`,
          ]
            .filter(Boolean)
            .join("\n"),
        });
        counts.makeupEvents++;
      }
    }
  }

  // ── 考试：具体时刻 + 提前 30 分钟提醒 ────────────────────────
  for (const e of exams) {
    if (!e.date || !e.subject) continue;
    const time = e.time ? parseTimeRange(e.time) : null;
    drafts.push({
      date: e.date,
      ...(time ?? {}),
      summary: `考试：${e.subject}`,
      location: e.location || undefined,
      description:
        [e.time || undefined, e.seatNumber ? `座位：${e.seatNumber}` : undefined]
          .filter(Boolean)
          .join("\n") || undefined,
      alarmMinutesBefore: 30,
    });
    counts.examEvents++;
  }

  // ── 拼装 ICS 文本 ───────────────────────────────────────────
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CourseRaptor//Calendar//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(termLabel)}`,
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "TZNAME:CST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  for (const ev of drafts) {
    const uidKey = `${ev.date}T${ev.startHm ?? "allday"}-${ev.summary}`;
    lines.push("BEGIN:VEVENT");
    lines.push(
      `UID:${icsDate(ev.date)}T${ev.startHm ? icsTime(ev.startHm) : "0000"}-${hash(uidKey)}@courseraptor`,
    );
    lines.push(`DTSTAMP:${stamp}`);
    if (ev.startHm && ev.endHm) {
      lines.push(`DTSTART;TZID=Asia/Shanghai:${icsDate(ev.date)}T${icsTime(ev.startHm)}00`);
      lines.push(`DTEND;TZID=Asia/Shanghai:${icsDate(ev.date)}T${icsTime(ev.endHm)}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(ev.date)}`);
    }
    lines.push(`SUMMARY:${esc(ev.summary)}`);
    if (ev.location) lines.push(`LOCATION:${esc(ev.location)}`);
    if (ev.description) lines.push(`DESCRIPTION:${esc(ev.description)}`);
    if (ev.alarmMinutesBefore) {
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push(`TRIGGER:-PT${ev.alarmMinutesBefore}M`);
      lines.push(`DESCRIPTION:${esc(ev.summary)}`);
      lines.push("END:VALARM");
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return { ics: lines.map(fold).join("\r\n"), ...counts };
}
