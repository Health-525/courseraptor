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
 * 学年/学期参数推断
 * xnm = 学年起始年；第一学期(秋季) xqm=3，第二学期(春季) xqm=12
 */
export function currentXnxq(
  xnm?: number,
  xqm?: number
): { year: number; semester: number } {
  const now = new Date();
  const month = now.getMonth(); // 0-based: Jan=0, Jun=5, Sep=8
  const isFirstSemester = month >= 8 || month <= 1; // Sep-Jan
  const year =
    xnm ??
    (isFirstSemester
      ? month >= 8
        ? now.getFullYear()
        : now.getFullYear() - 1
      : now.getFullYear() - 1);
  const semester = xqm ?? (isFirstSemester ? 3 : 12);
  return { year, semester };
}

// ── 课表抓取 ────────────────────────────────────────────────

export async function fetchSchedule(
  cookie: string,
  xnm?: number,
  xqm?: number
): Promise<CourseData[]> {
  const client = createClientWithCookie(BASE, cookie);
  const { year, semester } = currentXnxq(xnm, xqm);

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
  const client = createClientWithCookie(BASE, cookie);
  const { year, semester } = currentXnxq(xnm, xqm);

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
