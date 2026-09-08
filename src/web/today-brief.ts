/**
 * 「今日档案」数据组装 — 纯本地缓存，零登录零模型
 *
 * 独立日程页（GET /today）的数据源。路线图 P1 的验收口径：
 * - 不每次打开都调用模型/登录教务：只读 schedule-cache / exam-cache /
 *   term-holidays / term-dates 四个本地真值，页面每分钟自行刷新
 * - 断网显示旧数据时间：cachedAt 原样透传给前端标注
 * - 单双周、调休、跨午夜正确：周次过滤走 expandWeeks，调休日按 follows
 *   换课表，日期与状态每次请求按真实时钟重算（跨午夜自然翻转）
 */

import { loadExamCache } from "../exam-cache";
import {
  currentWeekOf,
  expandWeeks,
  NJTECH_PERIOD_TIMES,
  periodTimeRange,
  WEEKDAY_NAMES,
} from "../jwgl/academics";
import { resolveWeek1Monday } from "../jwgl/term-dates";
import { type SpecialDay, specialOnDate } from "../jwgl/term-holidays";
import type { CourseData } from "../jwgl/types";
import { loadScheduleCache } from "../schedule-cache";

export interface BriefCourse {
  title: string;
  /** "5-6节" */
  periods: string;
  /** "14:00-15:40"；节次不在作息表里时缺省 */
  time?: string;
  location?: string;
  teacher?: string;
  status: "done" | "current" | "upcoming";
}

export interface BriefExam {
  subject: string;
  date: string;
  time: string;
  location: string;
  seatNumber?: string;
  /** 距今天数：0=今天 */
  inDays: number;
  isToday: boolean;
}

export interface BriefDay {
  dateISO: string;
  weekday: number;
  /** "周一" */
  label: string;
  /** "9/8" */
  dateShort: string;
  isToday: boolean;
  /** "国庆节"（该日整天放假） */
  holiday?: string;
  /** 调休补课日 */
  makeup?: boolean;
  /** 该日实际要上的课（已按周次与调休换算），按开始节次排序；p 节次供周课表定位 */
  courses: Array<{
    title: string;
    time?: string;
    location?: string;
    teacher?: string;
    /** 原始周次规格（如 "1-16"、"1-16(单)"） */
    weeks?: string;
    /** 起止节次（如 5-6 节 → pStart 5 / pEnd 6），周课表格子定位用 */
    pStart?: number;
    pEnd?: number;
  }>;
}

export interface TodayBrief {
  /** 服务端算这份档案用的时刻（ISO），前端只做展示 */
  now: string;
  dateLabel: string;
  /** 节次时刻表（"5" -> "14:00-14:45"），周课表行标用 */
  periodTimes: Record<string, string>;
  term: {
    label: string;
    /** "第 2 周" / "假期（未在教学周内）" */
    weekLabel: string;
    /** 当前正在展示的教学周；无教学周时为 null */
    week: number | null;
    /** 可浏览的课表周范围 */
    maxWeek: number | null;
    weekSource?: "recorded" | "known" | "estimated";
    weekNote?: string;
  };
  schedule: {
    available: boolean;
    cachedAt: number | null;
    /** 超过 14 天没刷新过 */
    stale: boolean;
    /** 今天的放假/调休安排（null=普通日） */
    todaySpecial: SpecialDay | null;
    /** 今天的课（调休日已换成被补周几的课表），按开始时间排序 */
    courses: BriefCourse[];
    note?: string;
  };
  next: {
    dateISO: string;
    /** "今天" / "明天" / "9月12日 周六" */
    dateLabel: string;
    makeup?: boolean;
    course: BriefCourse;
    /** 距开课还有多少分钟 */
    startsInMin: number;
  } | null;
  week: {
    mondayISO: string;
    days: BriefDay[];
  } | null;
  exams: {
    available: boolean;
    cachedAt: number | null;
    /** 14 天内的考试，按日期升序，至多 4 场 */
    upcoming: BriefExam[];
    note?: string;
  };
}

const DAY_MS = 86400000;
/** 「下一节课」向前看的天数：覆盖到下周同日，足够回答「接下来什么时候有课」 */
const NEXT_LOOKAHEAD_DAYS = 14;
/** 考试卡的展示窗口 */
const EXAM_WINDOW_DAYS = 14;
const STALE_AFTER_MS = 14 * DAY_MS;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** JS 周日=0 -> 教学周 weekday（周一=1 … 周日=7） */
function weekdayOf(d: Date): number {
  return ((d.getDay() + 6) % 7) + 1;
}

function datePlus(base: Date, days: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

/** 某天在本学期的教学周号；开学前/无法归周返回 null */
function weekOfDate(iso: string, week1Monday: string): number | null {
  const diff = Math.floor(
    (new Date(`${iso}T00:00:00`).getTime() - new Date(`${week1Monday}T00:00:00`).getTime()) /
      DAY_MS,
  );
  return diff < 0 ? null : Math.floor(diff / 7) + 1;
}

/** 节次 -> 当天分钟数；作息表里没有该节次返回 null */
function periodStartMin(period: number): number | null {
  const t = NJTECH_PERIOD_TIMES[String(period)];
  if (!t) return null;
  const [h, m] = t.split("-")[0].split(":").map(Number);
  return h * 60 + m;
}

function periodEndMin(period: number): number | null {
  const t = NJTECH_PERIOD_TIMES[String(period)];
  if (!t) return null;
  const [h, m] = t.split("-")[1].split(":").map(Number);
  return h * 60 + m;
}

interface DayPlan {
  holiday?: string;
  makeup?: boolean;
  /** 该日按调休换算后要上的课 */
  courses: CourseData[];
}

/** 某天实际要上的课：放假日清空，调休日按被补周几的课表（都叠上周次过滤） */
function planForDate(courses: CourseData[], iso: string, week1Monday: string): DayPlan {
  const special = specialOnDate(iso);
  if (special?.type === "holiday") return { holiday: special.name ?? "放假", courses: [] };
  const weekday =
    special?.type === "makeup" && special.follows
      ? special.follows
      : weekdayOf(new Date(`${iso}T00:00:00`));
  const week = weekOfDate(iso, week1Monday);
  if (week == null) return { courses: [] };
  const effective = courses.filter(
    (c) => c.weekday === weekday && expandWeeks(c.weeks).includes(week),
  );
  effective.sort((a, b) => (a.periods[0] ?? 99) - (b.periods[0] ?? 99));
  return {
    ...(special?.type === "makeup" ? { makeup: true } : {}),
    courses: effective,
  };
}

function toBriefCourse(c: CourseData, nowMin: number): BriefCourse {
  const start = c.periods[0] != null ? periodStartMin(c.periods[0]) : null;
  const end =
    c.periods[c.periods.length - 1] != null ? periodEndMin(c.periods[c.periods.length - 1]) : null;
  let status: BriefCourse["status"] = "upcoming";
  if (start != null && end != null) {
    if (nowMin > end) status = "done";
    else if (nowMin >= start) status = "current";
  }
  return {
    title: c.title,
    periods: c.periods.length ? `${c.periods[0]}-${c.periods[c.periods.length - 1]}节` : "时间未定",
    ...(periodTimeRange(c.periods) ? { time: periodTimeRange(c.periods) } : {}),
    ...(c.location ? { location: c.location } : {}),
    ...(c.teacher ? { teacher: c.teacher } : {}),
    status,
  };
}

function relativeDateLabel(offset: number, date: Date): string {
  if (offset === 0) return "今天";
  if (offset === 1) return "明天";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY_NAMES[weekdayOf(date)] ?? ""}`.trim();
}

/** 从今天起向前找下一节课（含今天未开始的；跳过放假日） */
function findNextClass(
  courses: CourseData[],
  today: Date,
  week1Monday: string,
  nowMin: number,
): TodayBrief["next"] {
  for (let offset = 0; offset < NEXT_LOOKAHEAD_DAYS; offset++) {
    const date = datePlus(today, offset);
    const iso = isoOf(date);
    const plan = planForDate(courses, iso, week1Monday);
    if (plan.holiday) continue;
    for (const c of plan.courses) {
      const start = c.periods[0] != null ? periodStartMin(c.periods[0]) : null;
      if (start == null) continue; // 节次未知没法判「下一节」，交给今日列表展示
      const startsInMin = offset * 1440 + start - nowMin;
      if (startsInMin <= 0) continue;
      return {
        dateISO: iso,
        dateLabel: relativeDateLabel(offset, date),
        ...(plan.makeup ? { makeup: true } : {}),
        course: { ...toBriefCourse(c, nowMin), status: "upcoming" },
        startsInMin,
      };
    }
  }
  return null;
}

function buildWeekOverview(
  courses: CourseData[],
  week: number,
  week1Monday: string,
  today: Date,
): TodayBrief["week"] {
  const monday = new Date(`${week1Monday}T00:00:00`);
  const days: BriefDay[] = [];
  const todayIso = isoOf(today);
  for (let i = 0; i < 7; i++) {
    const date = datePlus(monday, (week - 1) * 7 + i);
    const iso = isoOf(date);
    const plan = planForDate(courses, iso, week1Monday);
    days.push({
      dateISO: iso,
      weekday: weekdayOf(date),
      label: WEEKDAY_NAMES[weekdayOf(date)] ?? `周${weekdayOf(date)}`,
      dateShort: `${date.getMonth() + 1}/${date.getDate()}`,
      isToday: iso === todayIso,
      ...(plan.holiday ? { holiday: plan.holiday } : {}),
      ...(plan.makeup ? { makeup: true } : {}),
      courses: plan.courses.map((c) => ({
        title: c.title,
        ...(periodTimeRange(c.periods) ? { time: periodTimeRange(c.periods) } : {}),
        ...(c.location ? { location: c.location } : {}),
        ...(c.teacher ? { teacher: c.teacher } : {}),
        ...(c.weeks ? { weeks: c.weeks } : {}),
        ...(c.periods.length
          ? { pStart: c.periods[0], pEnd: c.periods[c.periods.length - 1] }
          : {}),
      })),
    });
  }
  return { mondayISO: isoOf(datePlus(monday, (week - 1) * 7)), days };
}

/** 教务考试日期形如 "2026-06-28"（可能带时间尾巴），归一成 YYYY-MM-DD */
function examDateISO(raw: string): string | null {
  const m = raw.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
}

function buildExams(todayIso: string, scheduleTerm: { year: number; semester: number } | null) {
  const cached = loadExamCache();
  if (!cached) {
    return { available: false, cachedAt: null, upcoming: [], note: "还没有考试数据" };
  }
  // 考试缓存与课表缓存学期不一致（学期切换后只刷新了一边）时，
  // 不能把旧学期的考试当本学期临近考试讲
  if (
    scheduleTerm &&
    (cached.exams.year !== scheduleTerm.year || cached.exams.semester !== scheduleTerm.semester)
  ) {
    return { available: false, cachedAt: cached.savedAt, upcoming: [], note: "考试缓存是旧学期的" };
  }
  const today = new Date(`${todayIso}T00:00:00`).getTime();
  const upcoming: BriefExam[] = [];
  for (const e of cached.exams.exams) {
    const iso = examDateISO(e.date);
    if (!iso) continue;
    const inDays = Math.round((new Date(`${iso}T00:00:00`).getTime() - today) / DAY_MS);
    if (inDays < 0 || inDays > EXAM_WINDOW_DAYS) continue;
    upcoming.push({
      subject: e.subject,
      date: e.date,
      time: e.time,
      location: e.location,
      ...(e.seatNumber ? { seatNumber: e.seatNumber } : {}),
      inDays,
      isToday: inDays === 0,
    });
  }
  upcoming.sort((a, b) => a.inDays - b.inDays || a.subject.localeCompare(b.subject));
  return {
    available: true,
    cachedAt: cached.savedAt,
    upcoming: upcoming.slice(0, 4),
    ...(upcoming.length ? {} : { note: `${EXAM_WINDOW_DAYS} 天内没有考试安排` }),
  };
}

/** 组装今日档案。now 可注入（测试用），默认当前时刻 */
export function buildTodayBrief(now: Date = new Date(), requestedWeek?: number): TodayBrief {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayIso = isoOf(today);
  const dateLabel =
    `${today.getMonth() + 1}月${today.getDate()}日 ${WEEKDAY_NAMES[weekdayOf(today)] ?? ""}`.trim();

  const cachedSchedule = loadScheduleCache();
  const examsTerm = cachedSchedule
    ? { year: cachedSchedule.schedule.year, semester: cachedSchedule.schedule.semester }
    : null;
  const exams = buildExams(todayIso, examsTerm);

  if (!cachedSchedule) {
    return {
      now: now.toISOString(),
      dateLabel,
      periodTimes: NJTECH_PERIOD_TIMES,
      term: { label: "", weekLabel: "", week: null, maxWeek: null },
      schedule: {
        available: false,
        cachedAt: null,
        stale: false,
        todaySpecial: specialOnDate(todayIso),
        courses: [],
        note: "还没有课表数据",
      },
      next: null,
      week: null,
      exams,
    };
  }

  const schedule = cachedSchedule.schedule;
  const currentWeek = currentWeekOf(schedule.year, schedule.semester, now);
  const maxWeek = Math.max(1, ...schedule.courses.flatMap((course) => expandWeeks(course.weeks)));
  const selectedWeek =
    Number.isInteger(requestedWeek) && requestedWeek! >= 1 && requestedWeek! <= maxWeek
      ? requestedWeek!
      : currentWeek?.week;
  const week = selectedWeek && currentWeek ? { ...currentWeek, week: selectedWeek } : null;
  // 假期里 currentWeekOf 返回 null，但周次换算还得有基准（找下一节课要用）
  const week1Monday =
    currentWeek?.week1Monday ?? resolveWeek1Monday(schedule.year, schedule.semester).week1Monday;
  const todayPlan = planForDate(schedule.courses, todayIso, week1Monday);
  const courses = todayPlan.courses.map((c) => toBriefCourse(c, nowMin));

  let note: string | undefined;
  if (todayPlan.holiday) note = `今天放假${todayPlan.holiday ? `：${todayPlan.holiday}` : ""}`;
  else if (todayPlan.makeup) note = "今天是调休补课日，按被换周几的课表上课";
  else if (courses.length === 0)
    note = week ? `今天没有课（第 ${week.week} 周）` : "今天没有课（不在教学周内）";

  return {
    now: now.toISOString(),
    dateLabel,
    periodTimes: NJTECH_PERIOD_TIMES,
    term: {
      label: schedule.label,
      weekLabel: week ? `第 ${week.week} 周` : "假期 · 未在教学周内",
      week: week?.week ?? null,
      maxWeek,
      ...(week ? { weekSource: week.source } : {}),
      ...(week && week.source === "estimated"
        ? { weekNote: `开学日期是估算值（${week.evidence ?? "未见校历原文"}），以校历为准` }
        : {}),
    },
    schedule: {
      available: true,
      cachedAt: cachedSchedule.savedAt,
      stale: Date.now() - cachedSchedule.savedAt > STALE_AFTER_MS,
      todaySpecial: specialOnDate(todayIso),
      courses,
      ...(note ? { note } : {}),
    },
    next: findNextClass(schedule.courses, today, week1Monday, nowMin),
    week: week ? buildWeekOverview(schedule.courses, week.week, week1Monday, today) : null,
    exams,
  };
}
