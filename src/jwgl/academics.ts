/**
 * NJTECH 教务系统 - 课表/考试抓取
 * 移植自 ScholarFlow lib/schools/njtech/jwgl.ts（课表/考试部分）
 */

import type { CourseData, ExamData } from "./types";
import { createClient, httpFailure, type FetchResult } from "./http";
import { BASE } from "./auth";
import { currentWeekOf as resolveCurrentWeek } from "./term-dates";

export {
  parseTermStartDate,
  parseTermRef,
  recordWeek1Monday,
  resolveWeek1Monday,
  type TermDateSource,
} from "./term-dates";

/**
 * 当前教学周。真值来自 term-dates 单一数据源；
 * 返回值带 source —— 估算出来的必须如实标注，不能当既定事实讲。
 */
export function currentWeekOf(year: number, semester: number) {
  return resolveCurrentWeek(year, semester);
}

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

export const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 节次号 -> 上课时间段，如 [7,8] -> "16:00-17:40" */
export function periodTimeRange(periods: number[]): string | undefined {
  if (!periods.length) return undefined;
  const first = NJTECH_PERIOD_TIMES[String(periods[0])];
  const last = NJTECH_PERIOD_TIMES[String(periods[periods.length - 1])];
  if (!first || !last) return undefined;
  return `${first.split("-")[0]}-${last.split("-")[1]}`;
}

/**
 * 展开周次规格为周号数组。
 * 教务给的 zcd 形如 "2-13"、"2-6,8-12"、"14-17"，还可能带单双周 "(单)"/"(双)"。
 * 过去这份解析是丢给模型做的——每轮都要重算，且表达式解析有误判风险，
 * 现在收归工具层，模型只负责语义判断（用户说的「第一周」指哪周）。
 */
export function expandWeeks(spec: string): number[] {
  if (!spec) return [];
  const oddOnly = /[（(]单[)）]/.test(spec);
  const evenOnly = /[（(]双[)）]/.test(spec);
  const out = new Set<number>();
  for (const seg of spec.split(",")) {
    const m = seg.match(/(\d+)\s*[-~]\s*(\d+)|(\d+)/);
    if (!m) continue;
    const start = parseInt(m[1] ?? m[3], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (let w = Math.min(start, end); w <= Math.max(start, end); w++) {
      if (oddOnly && w % 2 === 0) continue;
      if (evenOnly && w % 2 === 1) continue;
      out.add(w);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export interface WeekGroup {
  week: number;
  count: number;
  /** 预格式化为可直接引用的文本行，避免模型再拼字段 */
  lines: string[];
}

/**
 * 按周预分组课表：week -> 该周实际要上的课。
 * 只含有课的周；周次解析在工具层完成，模型查表即可。
 */
export function buildWeekIndex(courses: CourseData[]): WeekGroup[] {
  const byWeek = new Map<number, string[]>();
  for (const c of courses) {
    const time = periodTimeRange(c.periods);
    const line = [
      WEEKDAY_NAMES[c.weekday] ?? `周${c.weekday}`,
      c.periods.length ? `${c.periods[0]}-${c.periods[c.periods.length - 1]}节` : "",
      time,
      c.title,
      c.location,
      c.teacher,
    ]
      .filter(Boolean)
      .join(" · ");
    for (const w of expandWeeks(c.weeks)) {
      const list = byWeek.get(w) ?? [];
      list.push(line);
      byWeek.set(w, list);
    }
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, lines]) => ({ week, count: lines.length, lines }));
}

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

// ── 课表抓取 ────────────────────────────────────────────────

export type ScheduleResult = TermRef & { courses: CourseData[] };

/**
 * 智能课表抓取：未指定学期时按候选列表探测，返回第一个有数据的学期
 * （同时带上年份与学期标签，解决交界期「年+学期」双双推断错误的问题）
 *
 * 语义约定（重要）：
 * - ok=false：全部候选学期都没拿到数据（断网/会话失效/接口改版），
 *   调用方必须如实上报 error，不许降级成「课表为空」。
 * - ok=true 且 courses 为空：确实查到了、但就是没排课（假期属正常）。
 */
export async function fetchScheduleSmart(
  cookie: string,
  xnm?: number,
  xqm?: number
): Promise<FetchResult<ScheduleResult>> {
  const candidates =
    xnm && xqm ? [{ year: xnm, semester: xqm }] : candidateXnxqList();

  const failures: string[] = [];

  for (const c of candidates) {
    const r = await fetchScheduleFor(cookie, c.year, c.semester);
    if (!r.ok) {
      failures.push(`${termLabel(c.year, c.semester)}：${r.error}`);
      continue;
    }
    if (r.data.length > 0) {
      return { ok: true, data: { ...c, label: termLabel(c.year, c.semester), courses: r.data } };
    }
  }

  if (failures.length === candidates.length) {
    return { ok: false, error: `课表查询失败：${failures.join("；")}` };
  }

  // 至少有一个学期查通了但没排课：保持「假期空课表」语义
  const first = candidates[0];
  return { ok: true, data: { ...first, label: termLabel(first.year, first.semester), courses: [] } };
}

/** 抓取指定单个学期的课表（kbList 为空时回退用考试数据反推） */
async function fetchScheduleFor(
  cookie: string,
  year: number,
  semester: number
): Promise<FetchResult<CourseData[]>> {
  const client = createClient(BASE, cookie);

  const resp = await client.req("/kbcx/xskbcx_cxXsKb.html?gnmkdm=N253508", {
    method: "POST",
    body: `xnm=${year}&xqm=${semester}`,
  });

  const failure = httpFailure(resp);
  if (failure) return { ok: false, error: failure };
  if (!resp.body || resp.body.length < 10) {
    return { ok: false, error: `课表接口返回空响应（HTTP ${resp.status}）` };
  }

  let data: { kbList?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(resp.body) as { kbList?: Array<Record<string, unknown>> };
  } catch {
    return { ok: false, error: "课表接口响应非 JSON（页面结构可能已改版）" };
  }

  const kbList = data?.kbList || [];
  if (kbList.length > 0) {
    return {
      ok: true,
      data: kbList.map((item: Record<string, unknown>) => ({
        title: (item.kcmc as string) || "",
        weekday: parseInt(item.xqj as string) || 0,
        periods: parsePeriods(item.jc as string),
        weeks: cleanWeekSpec((item.zcd as string) || ""),
        location: (item.cdmc as string) || (item.xqmc as string) || "",
        teacher: (item.xm as string) || "",
        ...item,
      })),
    };
  }

  // JWGL 返回空课表（学期末常见）-> 从考试数据反向生成课表
  return { ok: true, data: await buildScheduleFromExams(cookie, year, semester) };
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
  // 回退路径只作补充：拿不到就算了，不把错误冒泡成「课表查询失败」
  const r = await fetchExamsFor(cookie, year, semester);
  if (!r.ok) return [];
  const exams = r.data;
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

export type ExamResult = TermRef & { exams: ExamData[] };

/** 智能考试安排抓取：未指定学期时按候选列表探测（与课表同一套学期策略） */
export async function fetchExamsSmart(
  cookie: string,
  xnm?: number,
  xqm?: number
): Promise<FetchResult<ExamResult>> {
  const candidates =
    xnm && xqm ? [{ year: xnm, semester: xqm }] : candidateXnxqList();

  const failures: string[] = [];

  for (const c of candidates) {
    const r = await fetchExamsFor(cookie, c.year, c.semester);
    if (!r.ok) {
      failures.push(`${termLabel(c.year, c.semester)}：${r.error}`);
      continue;
    }
    if (r.data.length > 0) {
      return { ok: true, data: { ...c, label: termLabel(c.year, c.semester), exams: r.data } };
    }
  }

  if (failures.length === candidates.length) {
    return { ok: false, error: `考试查询失败：${failures.join("；")}` };
  }

  const first = candidates[0];
  return { ok: true, data: { ...first, label: termLabel(first.year, first.semester), exams: [] } };
}

/** 抓取指定单个学期的考试安排 */
async function fetchExamsFor(
  cookie: string,
  year: number,
  semester: number
): Promise<FetchResult<ExamData[]>> {
  const client = createClient(BASE, cookie);

  const resp = await client.req(
    "/kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358105",
    {
      method: "POST",
      body: `xnm=${year}&xqm=${semester}&_search=false&nd=${Date.now()}&queryModel.showCount=100&queryModel.currentPage=1`,
    }
  );

  const failure = httpFailure(resp);
  if (failure) return { ok: false, error: failure };

  try {
    const data = JSON.parse(resp.body) as { items?: Array<Record<string, unknown>> };
    const items = data?.items || [];
    return {
      ok: true,
      data: items.map((item: Record<string, unknown>) => ({
        subject: (item.kcmc as string) || "",
        date: (item.ksrq as string) || "",
        time: (item.kssj as string) || "",
        location: (item.cdmc as string) || "",
        seatNumber: (item.zwh as string) || "",
        ...item,
      })),
    };
  } catch {
    return { ok: false, error: "考试接口响应非 JSON（页面结构可能已改版）" };
  }
}
