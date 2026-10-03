/**
 * 河北农大课表抓取与行归一
 *
 * URP 的 wdkb 接口按「上课周次」过滤返回（请求参数 SKZC）。这个参数的语义
 * 是本次接入里唯一没被离线测试覆盖的假设：ScholarFlow 侧写死 16，
 * 而 16 周之外的课程有可能被过滤掉（河农大校历不止 16 个教学周）。
 * 这里的策略是不赌语义：先不带 SKZC 按全学期取，拿到 0 行再补一轮 SKZC=20。
 * 真实账号端到端时仍要对比「不传 / 16 / 20」三种取值的课程条数，确认后钉死。
 */

import { RaptorError } from "../../core/errors";
import type { CourseData } from "../../core/model";
import { extractUrpRows, pickString, urpPostSchedule, xnxqdm } from "./urp";

/**
 * 周次规格归一。URP 的 SKZC 实测有两种形态：
 * - 位串 "0000000001111110000"（每教学周一位，1=该周有课）——真实数据的主力形态，
 *   下游 expandWeeks 只认范围式，必须转换，否则周次解析全错
 * - 范围式 "1-20" / "2-6,8-12" / "(单)(双)" —— 原样保留（去「周」字与空白）
 */
export function normalizeWeekSpec(spec: string): string {
  const s = String(spec || "").trim();
  if (/^[01]{10,30}$/.test(s)) {
    const weeks: number[] = [];
    for (let i = 0; i < s.length; i++) if (s[i] === "1") weeks.push(i + 1);
    if (!weeks.length) return "";
    const ranges: string[] = [];
    let start = weeks[0];
    let prev = weeks[0];
    for (let i = 1; i <= weeks.length; i++) {
      if (weeks[i] === prev + 1) {
        prev = weeks[i];
        continue;
      }
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = weeks[i];
      prev = weeks[i];
    }
    return ranges.join(",");
  }
  return s
    .replace(/[,，]?\s*全\s*周/g, "")
    .replace(/周/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * 节次展开。SKJC=开始节，JSJC=结束节（多数 URP 接口只给这两个，不给 KSJC），
 * 再退化到 SKCD（连堂节数）。
 * 只给 SKJC 而没有长度时按 1 节算——ScholarFlow 兜底成 2 节，
 * 会把单节课画成两节连堂，宁少不多。
 */
export function parsePeriodRange(row: Record<string, unknown>): number[] {
  const start = intOf(pickString(row, ["SKJC", "skjc", "KSJC", "ksjc"]));
  if (start <= 0) return [];
  const jsjc = intOf(pickString(row, ["JSJC", "jsjc"]));
  const len = intOf(pickString(row, ["SKCD", "skcd"]));
  let end = start;
  if (jsjc > 0 && jsjc >= start) end = jsjc;
  else if (len > 1) end = start + len - 1;
  const out: number[] = [];
  for (let p = start; p <= end; p++) out.push(p);
  return out;
}

function intOf(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/** 单行 -> CourseData。课程名为空的行（场地备注、教师备注）一律丢弃 */
export function toCourseRow(row: Record<string, unknown>): CourseData | null {
  const title = pickString(row, ["KCMC", "kcmc", "XSKCM", "xskcm", "KCM", "kcm"]);
  if (!title) return null;
  const weekday = intOf(pickString(row, ["XQJ", "xqj", "SKXQ", "skxq", "XQSJC", "xqsjc"]));
  return {
    title,
    weekday,
    periods: parsePeriodRange(row),
    weeks: normalizeWeekSpec(pickString(row, ["SKZC", "skzc", "ZCMC", "zcmc", "ZC", "zc"])),
    location: pickString(row, [
      "JASMC",
      "jasmc",
      "CDMC",
      "cdmc",
      "JSMC",
      "jsmc",
      "JXLDM_DISPLAY",
      "jxldm_display",
      "XQMC",
      "xqmc",
    ]),
    teacher: pickString(row, ["SKJS", "skjs", "JSXM", "jsxm", "JS", "js"]),
    ...row,
  };
}

/** 抓单个学期课表。会话失效等错误以 RaptorError 抛出，调用方（Smart 层）归类处理 */
export async function fetchHebauSchedule(
  cookie: string,
  year: number,
  semester: number,
): Promise<CourseData[]> {
  const xnxqdmValue = xnxqdm(year, semester);
  const action = `获取${xnxqdmValue}课表`;
  /** 第一轮不带 SKZC（按全学期取）；仍为空时补一轮 SKZC=20 兜底 */
  const attempts: Array<number | undefined> = [undefined, 20];

  for (const skzc of attempts) {
    const params = new URLSearchParams({ XNXQDM: xnxqdmValue });
    if (skzc !== undefined) params.set("SKZC", String(skzc));
    const data = await urpPostSchedule(cookie, params.toString(), action);
    const rows = extractUrpRows(data, "cxxszhxqkb");
    if (!rows) {
      throw new RaptorError("PARSE", `${action}失败：教务系统响应结构异常（找不到课表数据行）`);
    }
    const courses = rows
      .map(toCourseRow)
      .filter((c): c is CourseData => c !== null)
      .filter((c) => c.weekday >= 1 && c.weekday <= 7);
    if (courses.length) return courses;
  }

  // 两轮都拿到 0 行且没有报错：确实是空课表（假期/未排课），不是失败
  return [];
}
