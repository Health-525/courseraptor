/**
 * 学期探测循环（与学校无关的那一半）
 *
 * 为什么单独一个文件：「不知道现在是哪个学期」这件事每所学校都会遇到——
 * 正方系教务系统都不提供「当前学期」查询接口，按日历日期硬推在学期交界期必然出错
 * （8 月下旬新学期课表已生成、1 月还在秋学期里）。解法是候选学期逐个试，
 * 取第一个真有数据的。这个循环本身跟学校无关，学校只提供两件事：
 * 每个学期怎么抓（适配器）、春夏学期占哪几个月（secondSemesterMonths）。
 *
 * 语义约定与 jwgl/academics.ts 完全一致，这点很重要：
 * - ok=false = 一个学期都没查通（断网/会话失效/接口改版），必须如实上报；
 * - ok=true 且列表为空 = 确实查到了但没排课（假期属正常）。
 * 混为一谈会让 agent 把「教务系统连不上」说成「你这学期没课」。
 */

import { type ExamResult, type ScheduleResult, termLabel } from "../jwgl/academics";
import type { FetchResult } from "../jwgl/http";
import type { ExamData } from "../jwgl/types";
import type { SchoolAdapter, SchoolSession } from "./types";

export interface ProbeOptions {
  /** 指定学年（如 2026 表示 2026-2027）与学期（3=秋冬，12=春夏）。都不传则自动探测 */
  year?: number;
  semester?: number;
  /** 会话失效时重建会话的回调（工具层传 getCookie(true)）。不传则不重试 */
  refresh?: () => Promise<SchoolSession>;
  now?: Date;
}

/**
 * 候选学期（新到旧）。
 *
 * 与 NJTECH 原 candidateXnxqList 的分支逐条对齐（南工大 months=[2,6] 时结果完全相同），
 * 差别只在春夏学期的月份区间换成学校自己的：
 * - m >= 9：秋学期进行中
 * - hi < m < 9：假期/交界（南工大 7-8 月，河农大 8 月），新学期课表通常已生成，先探秋
 * - m <= hi：春学期进行中（学年始于上一年）
 */
export function candidateTerms(
  months: readonly [number, number],
  now: Date = new Date(),
): Array<{ year: number; semester: number }> {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const [, hi] = months;
  if (m >= 9) {
    return [
      { year: y, semester: 3 },
      { year: y - 1, semester: 12 },
    ];
  }
  if (m > hi) {
    return [
      { year: y, semester: 3 },
      { year: y - 1, semester: 12 },
      { year: y - 1, semester: 3 },
    ];
  }
  return [
    { year: y - 1, semester: 12 },
    { year: y - 1, semester: 3 },
  ];
}

/** 会话失效的可读信号。各校文案不同，只能按关键词认 */
function looksLikeExpiredSession(error: string): boolean {
  return /会话|失效|登录页|重新登录/.test(error);
}

type Fetcher<T extends unknown[]> = (
  school: SchoolAdapter,
  session: SchoolSession,
  year: number,
  semester: number,
) => Promise<FetchResult<T>>;

/**
 * 候选学期通用探测：从新到旧取第一个「有数据」的学期。
 * 全部候选都失败才 ok=false；只要有一个学期查通且为空，就保持「空但不算失败」语义。
 */
async function probe<T extends unknown[]>(
  school: SchoolAdapter,
  session: SchoolSession,
  fetcher: Fetcher<T>,
  opts: ProbeOptions,
): Promise<{ term: { year: number; semester: number }; data: T } | { error: string }> {
  const specified =
    opts.year && opts.semester ? [{ year: opts.year, semester: opts.semester }] : undefined;
  const candidates = specified ?? candidateTerms(school.secondSemesterMonths, opts.now);
  let current = session;
  let refreshed = false;

  const failures: string[] = [];
  let emptyButOk: { term: { year: number; semester: number }; data: T } | null = null;

  for (const term of candidates) {
    let r = await fetcher(school, current, term.year, term.semester);
    // 会话中途过期：拿不到任何数据，重建一次会话再试同一学期
    if (!r.ok && !refreshed && opts.refresh && looksLikeExpiredSession(r.error)) {
      refreshed = true;
      current = await opts.refresh();
      r = await fetcher(school, current, term.year, term.semester);
    }
    if (!r.ok) {
      failures.push(`${termLabel(term.year, term.semester)}：${r.error}`);
      continue;
    }
    if (r.data.length > 0) return { term, data: r.data };
    emptyButOk ??= { term, data: r.data };
  }

  if (emptyButOk) return emptyButOk;
  return { error: failures.join("；") || "所有候选学期都查不到数据" };
}

export async function probeSchedule(
  school: SchoolAdapter,
  session: SchoolSession,
  opts: ProbeOptions = {},
): Promise<FetchResult<ScheduleResult>> {
  const r = await probe(school, session, (s, sesh, y, q) => s.fetchScheduleFor(sesh, y, q), opts);
  if ("error" in r) return { ok: false, error: `课表查询失败：${r.error}` };
  return {
    ok: true,
    data: { ...r.term, label: termLabel(r.term.year, r.term.semester), courses: r.data },
  };
}

export async function probeExams(
  school: SchoolAdapter,
  session: SchoolSession,
  opts: ProbeOptions = {},
): Promise<FetchResult<ExamResult>> {
  const r = await probe(school, session, (s, sesh, y, q) => s.fetchExamsFor(sesh, y, q), opts);
  if ("error" in r) return { ok: false, error: `考试查询失败：${r.error}` };
  return {
    ok: true,
    data: {
      ...r.term,
      label: termLabel(r.term.year, r.term.semester),
      exams: r.data as ExamData[],
    },
  };
}
