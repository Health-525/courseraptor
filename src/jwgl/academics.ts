/**
 * NJTECH 教务系统 - 课表/考试抓取
 * 移植自 ScholarFlow lib/schools/njtech/jwgl.ts（课表/考试部分）
 */

import type { CourseData, ExamData } from "./types";
import { createClientWithCookie } from "./http";
import { BASE } from "./auth";

// ── NJTECH 节次时间表 ──────────────────────────────────────────
// 南京工业大学标准作息时间（每节课45分钟，课间休息10分钟）
export const NJTECH_PERIOD_TIMES: Record<string, string> = {
  "1": "08:10-08:55",
  "2": "09:05-09:50",
  "3": "10:20-11:05",
  "4": "11:15-12:00",
  "5": "14:00-14:45",
  "6": "14:55-15:40",
  "7": "16:00-16:45",
  "8": "16:55-17:40",
  "9": "19:00-19:45",
  "10": "19:55-20:40",
};

/**
 * 学期参数与「当前学期」探测
 *
 * 正方不提供当前学期查询接口（无参数请求返回 0 条，页面接口无 HTML），
 * 按日历日期推断在学期交界期（如 8 月下旬新学期课表已生成）必然出错，
 * 因此改为候选学期探测：从最新可能学期开始逐个查询，取第一个有数据的。
 *
 * xnm = 学年起始年；第一学期(秋季) xqm=3，第二学期(春季) xqm=12
 */

export interface TermRef {
  year: number;
  semester: number; // 3=第一学期 12=第二学期
  label: string;
}

export function termLabel(year: number, semester: number): string {
  return `${year}-${year + 1}学年${semester === 3 ? "第一" : "第二"}学期`;
}

/** 候选学期列表（新到旧）。交界月（7-8 月）优先探测即将开始的秋学期 */
export function candidateXnxqList(): Array<{ year: number; semester: number }> {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (m >= 9) {
    // 秋学期进行中
    return [
      { year: y, semester: 3 },
      { year: y - 1, semester: 12 },
    ];
  }
  if (m >= 7) {
    // 暑假：新学期课表通常已生成，先探秋学期
    return [
      { year: y, semester: 3 },
      { year: y - 1, semester: 12 },
      { year: y - 1, semester: 3 },
    ];
  }
  // 1-6 月：春学期（学年始于上一年）
  return [
    { year: y - 1, semester: 12 },
    { year: y - 1, semester: 3 },
  ];
}

/** 解析用户/模型给定的学期串，如「2026-2027-1」「2025-2026第2学期」「2026-1」 */
export function parseSemesterString(
  s: string
): { year: number; semester: number } | null {
  let m = s.match(/(\d{4})\D+(\d{4})\D*(1|2|一|二)(?!\d)/);
  if (m) {
    return { year: parseInt(m[1], 10), semester: m[3] === "1" || m[3] === "一" ? 3 : 12 };
  }
  m = s.match(/(\d{4})\D(1|2|一|二)(?!\d)/);
  if (m) {
    return { year: parseInt(m[1], 10), semester: m[2] === "1" || m[2] === "一" ? 3 : 12 };
  }
  return null;
}

// ── 周次计算（移植自 ScholarFlow njtechAdapter.getCurrentSemester）──
// 正方不提供开学日期接口；已知学期记录实际值，未来学期按
// 「秋季 9 月第一个周一 / 春季 3 月第一个周一」估算，校历发布后校准。

const WEEK1_MONDAY: Record<string, string> = {
  "2025-1": "2025-09-01",
  "2025-2": "2026-03-02",
  // 2026 秋：尚未见校历原文（正式校历发布在 OA 系统，需 WebVPN 登录），
  // 按 9 月第一个周一估算，与 2026 选课通知日期交叉吻合：
  // 9/2 公布停开、9/10-13 第 1 周补退选、9/21-24 第 3 周课程补退选
  "2026-1": "2026-09-07",
};

function firstMondayOfMonth(year: number, month: number): string {
  const d = new Date(year, month - 1, 1);
  const offset = (8 - d.getDay()) % 7; // 到下一个周一的天数
  return `${year}-${String(month).padStart(2, "0")}-${String(1 + offset).padStart(2, "0")}`;
}

/** 学期开学日期（第 1 周的周一） */
export function week1MondayFor(
  year: number,
  semester: number
): { date: string; estimated: boolean } {
  const key = `${year}-${semester === 3 ? 1 : 2}`;
  if (WEEK1_MONDAY[key]) return { date: WEEK1_MONDAY[key], estimated: false };
  return {
    date: semester === 3 ? firstMondayOfMonth(year, 9) : firstMondayOfMonth(year + 1, 3),
    estimated: true,
  };
}

/** 当前教学周；未开学或超出 30 周时返回 null */
export function currentWeekOf(
  year: number,
  semester: number
): { week: number; week1Monday: string; estimated: boolean } | null {
  const { date, estimated } = week1MondayFor(year, semester);
  const start = new Date(`${date}T00:00:00`).getTime();
  const week = Math.floor((Date.now() - start) / (7 * 86400000)) + 1;
  if (week < 1 || week > 30) return null;
  return { week, week1Monday: date, estimated };
}

// ── 课表抓取 ────────────────────────────────────────────────

export async function fetchSchedule(
  cookie: string,
  xnm?: number,
  xqm?: number
): Promise<CourseData[]> {
  return (await fetchScheduleSmart(cookie, xnm, xqm)).courses;
}

/**
 * 智能课表抓取：未指定学期时按候选列表探测，返回第一个有数据的学期
 * （同时带上年份与学期标签，解决交界期「年+学期」双双推断错误的问题）
 */
export async function fetchScheduleSmart(
  cookie: string,
  xnm?: number,
  xqm?: number
): Promise<TermRef & { courses: CourseData[] }> {
  const candidates =
    xnm && xqm ? [{ year: xnm, semester: xqm }] : candidateXnxqList();

  for (const c of candidates) {
    const courses = await fetchScheduleFor(cookie, c.year, c.semester);
    if (courses.length > 0) {
      return { ...c, label: termLabel(c.year, c.semester), courses };
    }
  }

  // 全部候选都为空：返回首选学期（保持「假期空课表」语义）
  const first = candidates[0];
  return { ...first, label: termLabel(first.year, first.semester), courses: [] };
}

/** 抓取指定单个学期的课表（kbList 为空时回退用考试数据反推） */
async function fetchScheduleFor(
  cookie: string,
  year: number,
  semester: number
): Promise<CourseData[]> {
  const client = createClientWithCookie(BASE, cookie);

  const resp = await client.req("/kbcx/xskbcx_cxXsKb.html?gnmkdm=N253508", {
    method: "POST",
    body: `xnm=${year}&xqm=${semester}`,
  });

  if (!resp.body || resp.body.length < 10) {
    return [];
  }

  try {
    const data = JSON.parse(resp.body);
    const kbList = data?.kbList || [];

    if (kbList.length > 0) {
      return kbList.map((item: Record<string, unknown>) => ({
        title: (item.kcmc as string) || "",
        weekday: parseInt(item.xqj as string) || 0,
        periods: parsePeriods(item.jc as string),
        weeks: cleanWeekSpec((item.zcd as string) || ""),
        location: (item.cdmc as string) || (item.xqmc as string) || "",
        teacher: (item.xm as string) || "",
        ...item,
      }));
    }

    // JWGL 返回空课表（学期末常见）-> 从考试数据反向生成课表
    const examCourses = await buildScheduleFromExams(cookie, year, semester);
    return examCourses;
  } catch {
    return [];
  }
}

/**
 * 从考试数据的 sksj（上课时间）字段反向生成课表
 * sksj 格式: "星期一第5-6节{2-17周};星期四第5-6节{2-17周}"
 */
async function buildScheduleFromExams(
  cookie: string,
  year: number,
  semester: number
): Promise<CourseData[]> {
  const exams = await fetchExams(cookie, year, semester);
  if (!exams.length) return [];

  const courses: CourseData[] = [];
  const seen = new Set<string>();

  for (const exam of exams) {
    const title =
      exam.subject || (exam as Record<string, unknown>).kcmc as string || "";
    if (!title || seen.has(title)) continue;
    seen.add(title);

    const sksj = ((exam as Record<string, unknown>).sksj as string) || "";
    if (!sksj) continue;

    const segments = sksj.split(";").filter(Boolean);

    for (const seg of segments) {
      const weekdayMatch = seg.match(/星期([一二三四五六日天])/);
      const periodMatch = seg.match(/第(\d+)-?(\d+)?节/);
      const weeksMatch = seg.match(/\{(\d+)-(\d+)周\}/);

      if (!weekdayMatch) continue;

      const weekdayMap: Record<string, number> = {
        "一": 1, "二": 2, "三": 3, "四": 4,
        "五": 5, "六": 6, "日": 7, "天": 7,
      };
      const weekday = weekdayMap[weekdayMatch[1]] || 0;

      const startPeriod = periodMatch ? parseInt(periodMatch[1]) : 0;
      const endPeriod = periodMatch?.[2] ? parseInt(periodMatch[2]) : startPeriod;
      const periods: number[] = [];
      for (let i = startPeriod; i <= endPeriod; i++) periods.push(i);

      const weeks = weeksMatch ? `${weeksMatch[1]}-${weeksMatch[2]}` : "";

      const teacher = ((exam as Record<string, unknown>).jsxx as string) || "";
      const teacherName = teacher.split("/").pop() || teacher;
      const location = ((exam as Record<string, unknown>).cdmc as string) || "";

      courses.push({
        title,
        weekday,
        periods,
        weeks,
        location,
        teacher: teacherName,
      });
    }
  }

  return courses;
}

/**
 * 清理周次规格字符串 - 去掉"周"字后缀
 */
function cleanWeekSpec(spec: string): string {
  return spec.replace(/周/g, "").trim();
}

function parsePeriods(jc: string): number[] {
  const match = jc.match(/(\d+)-(\d+)/);
  if (match) {
    const start = parseInt(match[1]);
    const end = parseInt(match[2]);
    const periods: number[] = [];
    for (let i = start; i <= end; i++) periods.push(i);
    return periods;
  }
  const single = parseInt(jc);
  if (single > 0) return [single];
  return [];
}

// ── 考试抓取 ────────────────────────────────────────────────

export async function fetchExams(
  cookie: string,
  xnm?: number,
  xqm?: number
): Promise<ExamData[]> {
  return (await fetchExamsSmart(cookie, xnm, xqm)).exams;
}

/** 智能考试安排抓取：未指定学期时按候选列表探测（与课表同一套学期策略） */
export async function fetchExamsSmart(
  cookie: string,
  xnm?: number,
  xqm?: number
): Promise<TermRef & { exams: ExamData[] }> {
  const candidates =
    xnm && xqm ? [{ year: xnm, semester: xqm }] : candidateXnxqList();

  for (const c of candidates) {
    const exams = await fetchExamsFor(cookie, c.year, c.semester);
    if (exams.length > 0) {
      return { ...c, label: termLabel(c.year, c.semester), exams };
    }
  }

  const first = candidates[0];
  return { ...first, label: termLabel(first.year, first.semester), exams: [] };
}

/** 抓取指定单个学期的考试安排 */
async function fetchExamsFor(
  cookie: string,
  year: number,
  semester: number
): Promise<ExamData[]> {
  const client = createClientWithCookie(BASE, cookie);

  const resp = await client.req(
    "/kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358105",
    {
      method: "POST",
      body: `xnm=${year}&xqm=${semester}&_search=false&nd=${Date.now()}&queryModel.showCount=100&queryModel.currentPage=1`,
    }
  );

  try {
    const data = JSON.parse(resp.body);
    const items = data?.items || [];
    return items.map((item: Record<string, unknown>) => ({
      subject: (item.kcmc as string) || "",
      date: (item.ksrq as string) || "",
      time: (item.kssj as string) || "",
      location: (item.cdmc as string) || "",
      seatNumber: (item.zwh as string) || "",
      ...item,
    }));
  } catch {
    return [];
  }
}
