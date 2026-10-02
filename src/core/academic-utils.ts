/**
 * 跨校通用的学期 / 周次 / 课表分组工具
 *
 * 从 njtech/academics.ts 抽出的学校无关部分（「其他学校手动课表」适配器
 * 也要用同一套）：周次表达式展开、学期编码与候选探测、按周分组与假期
 * 叠加。节次作息表是学校规则，不在这里——各适配器给出后经 timeRange
 * 参数注入。njtech/academics.ts 对本文件做薄封装再导出，旧调用点不动。
 */

import { specialDaysOfWeek, type WeekSpecialDay } from "./calendar/holidays";
import type { CourseData, SkwjSegment, TermCandidate, WeekGroup } from "./model";

export const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 中文星期 → 数字（1=周一…7=周日） */
export const WEEKDAY_CN: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

/** 学期展示名：semester 取学校侧编码（正方系 3=秋、12=春，国内教务通行约定） */
export function termLabel(year: number, semester: number): string {
  return `${year}-${year + 1}学年${semester === 3 ? "第一" : "第二"}学期`;
}

/** 候选学期列表（新到旧）。交界月（7-8 月）优先探测即将开始的秋学期。now 可注入 */
export function candidateTerms(now: Date = new Date()): TermCandidate[] {
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
export function parseSemesterString(s: string): TermCandidate | null {
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

/**
 * 展开周次规格为周号数组。
 * 教务给的 zcd 形如 "2-13"、"2-6,8-12"、"14-17"，还可能带单双周 "(单)"/"(双)"。
 * 收归工具层，模型只负责语义判断（用户说的「第一周」指哪周）。
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

/** 节次号 -> 上课时间段（按学校作息表），如 [7,8] -> "16:10-17:50"；表里没有该节次时 undefined */
export function periodTimeRangeOf(
  times: Record<string, string>,
  periods: number[],
): string | undefined {
  if (!periods.length) return undefined;
  const first = times[String(periods[0])];
  const last = times[String(periods[periods.length - 1])];
  if (!first || !last) return undefined;
  return `${first.split("-")[0]}-${last.split("-")[1]}`;
}

/** 两个时段是否在节次和周次上有交集（视为时间冲突） */
export function segmentsOverlap(a: SkwjSegment, b: SkwjSegment): boolean {
  if (a.weekday !== b.weekday) return false;
  const periodSet = new Set(a.periods);
  if (!b.periods.some((p) => periodSet.has(p))) return false;
  // 周次交集：任一周号共有即冲突
  const aWeeks = new Set(a.expandedWeeks);
  return b.expandedWeeks.some((w) => aWeeks.has(w));
}

/** 课程行去掉星期后的主体（节次 · 时间 · 课程 · 地点 · 教师），供周分组与调休覆盖行复用 */
export function courseLineBody(
  c: CourseData,
  timeRange: (periods: number[]) => string | undefined,
): string {
  return [
    c.periods.length ? `${c.periods[0]}-${c.periods[c.periods.length - 1]}节` : "",
    timeRange(c.periods),
    c.title,
    c.location,
    c.teacher,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 按周预分组课表：week -> 该周实际要上的课。
 * 只含有课的周；周次解析在工具层完成，模型查表即可。
 */
export function buildWeekIndex(
  courses: CourseData[],
  timeRange: (periods: number[]) => string | undefined,
): WeekGroup[] {
  const byWeek = new Map<number, string[]>();
  for (const c of courses) {
    const line = `${WEEKDAY_NAMES[c.weekday] ?? `周${c.weekday}`} · ${courseLineBody(c, timeRange)}`;
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
            run[run.length - 1].date,
          )}（${WEEKDAY_NAMES[run[run.length - 1].weekday]}）`;
    runs.push(`${label}放假${names.length ? `：${names.join("、")}` : ""}`);
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
  groups: WeekGroup[],
  timeRange: (periods: number[]) => string | undefined,
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
            courseLineBody(c, timeRange),
          ]
            .filter(Boolean)
            .join(" · "),
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
