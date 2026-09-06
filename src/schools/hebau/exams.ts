/**
 * 河北农大考试安排
 *
 * URP 的 wdks 接口把已排考场与未排考场分在 arranged / notArranged 两个桶里，
 * 两个桶都是「本人的考试」，只是前者有教室时间、后者还没排。
 * 合并返回，未排的行保留空 location/time —— 模型据此能说「还没排考场」，
 * 而不是把没排的那几门直接漏掉（漏了就是「你只有 3 门考试」这种错话）。
 */

import type { FetchResult } from "../../jwgl/http";
import type { ExamData } from "../../jwgl/types";
import { extractUrpRows, pickString, urpPostExams, xnxqdm } from "./urp";

/** KSSJ 常见形态：「上午 08:00-10:00」「08:00-10:00」「第1-2节」；Display 字段里再抠时间 */
export function parseExamTime(row: Record<string, unknown>): string {
  const direct = pickString(row, ["KSSJ", "kssj", "SJKSSJ", "sjkssj"]);
  // 日期与时间同串（「2026-06-20 08:00-10:00」）时只取时间部分：日期已由
  // parseExamDate 拆给 date，整串塞进 time 会让模型把日期当时间播报。
  const clock = direct.match(/\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?/);
  if (clock) return clock[0].replace(/\s*-\s*/g, "-");
  if (direct && !/^\d{4}[-/]/.test(direct)) return direct;
  const display = pickString(row, [
    "KSSJ_DISPLAY",
    "kssj_display",
    "SJKSSJ_DISPLAY",
    "sjkssj_display",
  ]);
  const matched = display.match(/\d{2}:\d{2}(?:-\d{2}:\d{2})?/);
  if (matched) return matched[0];
  return direct || "";
}

/** 考试日期。有些接口把日期与时间塞在同一个 KSSJ 里（「2026-06-15 08:00-10:00」） */
export function parseExamDate(row: Record<string, unknown>): string {
  const date = pickString(row, ["KSRQ", "ksrq", "SJKSRQ", "sjksrq"]);
  // 统一成 YYYY-MM-DD：URP 有以斜杠分隔的形态，留着斜杠下游按日期排序会比较错
  if (date) return date.split(/\s+/)[0].replace(/\//g, "-");
  const merged = pickString(row, [
    "KSSJ",
    "kssj",
    "SJKSSJ",
    "sjkssj",
    "KSSJ_DISPLAY",
    "kssj_display",
  ]);
  return merged.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/)?.[0]?.replace(/\//g, "-") ?? "";
}

export function toExamRow(row: Record<string, unknown>): ExamData | null {
  const subject = pickString(row, ["KCMC", "kcmc", "KCM", "kcm", "XSKCM", "xskcm"]);
  const date = parseExamDate(row);
  // 科目与日期两者都缺就无法定位到一场考试（纯备注行），丢；
  // 只缺 date 的行是「已报名未排期」，保留，交给工具层如实说明
  if (!subject || (!date && !pickString(row, ["KSJC", "ksjc"]))) return null;
  const notes = pickString(row, [
    "KSDM_DISPLAY",
    "ksdm_display",
    "PKSM",
    "pksm",
    "KSSM",
    "kssm",
    "BZ",
    "bz",
  ]);
  return {
    subject,
    date,
    time: parseExamTime(row) || pickString(row, ["KSJC", "ksjc", "KSSJC", "kssjc"]),
    location: pickString(row, [
      "CDMC",
      "cdmc",
      "JASMC",
      "jasmc",
      "JSMC",
      "jsmc",
      "CDMC_DISPLAY",
      "cdmc_display",
      "JASDM_DISPLAY",
      "jasdm_display",
      "JXLDM_DISPLAY",
      "jxldm_display",
    ]),
    seatNumber: pickString(row, ["ZWH", "zwh", "KSWHH", "kswih"]),
    ...(notes ? { notes } : {}),
  };
}

/** 去重：同一门课在 arranged/notArranged 或分页里重复出现时只留信息更全的那条 */
export function dedupeExams(rows: ExamData[]): ExamData[] {
  const best = new Map<string, ExamData>();
  for (const row of rows) {
    const key = `${row.subject}|${row.date}|${row.time}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, row);
      continue;
    }
    const score = (e: ExamData) => (e.location ? 2 : 0) + (e.seatNumber ? 1 : 0);
    if (score(row) > score(prev)) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
}

export async function fetchHebauExams(
  cookie: string,
  year: number,
  semester: number,
): Promise<FetchResult<ExamData[]>> {
  const xnxqdmValue = xnxqdm(year, semester);
  const action = `获取${xnxqdmValue}考试安排`;
  const resp = await urpPostExams(
    cookie,
    new URLSearchParams({ XNXQDM: xnxqdmValue }).toString(),
    action,
  );
  if (!resp.ok) return resp;

  const rows = extractUrpRows(resp.data, "queryMyExamArrangeMent");
  if (!rows) {
    return { ok: false, error: `${action}失败：教务系统响应结构异常（找不到考试数据行）` };
  }
  const exams = rows.map(toExamRow).filter((e): e is ExamData => e !== null);
  return { ok: true, data: dedupeExams(exams) };
}
