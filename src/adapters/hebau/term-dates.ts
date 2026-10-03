/**
 * 河北农大开学日期（第 1 周周一）真值层
 *
 * 真值层级沿用 core 约定：recorded（通知实测）> known（人工校准）> estimated（估算）。
 * 与 njtech 的关键差异：**存储文件带学校前缀**（term-dates-hebau.json）。
 * 两个学校共用一个文件的话，南工大的「2026 秋 = 08-31」会被当成河北农大的
 * 开学日（河农大是 09-01），整个学期的周次系统性错一周——而且错得很像对的。
 *
 * hebau 暂无教务通知能力（学校没开放接口），所以没有 recordWeek1Monday 的
 * 通知解析链路；人工校准直接编辑 data/term-dates-hebau.json 即可。
 */

import fs from "node:fs";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "../../core/atomic-write";
import type { TermStartDate } from "../../core/model";
import { dataDir } from "../../core/paths";

/**
 * 播种表：沿用 ScholarFlow 侧人工整理的河北农大校历。
 * source 标 "known" 而非 "recorded"：有确定依据，但没有可追溯的通知解析链路。
 */
const HEBAU_TERM_SEED: Record<string, TermStartDate> = {
  "2025-1": {
    week1Monday: "2025-09-01",
    source: "known",
    evidence: "河北农大校历（ScholarFlow 整理）",
  },
  "2025-2": {
    week1Monday: "2026-03-02",
    source: "known",
    evidence: "河北农大校历（ScholarFlow 整理）",
  },
  "2026-1": {
    week1Monday: "2026-09-01",
    source: "known",
    evidence: "河北农大校历（ScholarFlow 整理）",
  },
  "2026-2": {
    week1Monday: "2027-03-01",
    source: "known",
    evidence: "河北农大校历（ScholarFlow 整理）",
  },
};

/** 学期 key：`${学年起始年}-${1|2}`（3=秋冬学期 → 1，12=春夏学期 → 2），与 core 约定一致 */
export function termKey(year: number, semester: number): string {
  return `${year}-${semester === 3 ? 1 : 2}`;
}

function storePath(): string {
  return `${dataDir()}/term-dates-hebau.json`;
}

let cache: Record<string, TermStartDate> | null = null;

/** 已落盘的开学日期快照（首次运行用种子播种并落盘，之后以文件为准） */
export function loadStore(): Record<string, TermStartDate> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Record<string, TermStartDate>;
  } catch {
    // 文件在却解析不出来：留副本再播种，别让半截 JSON 把实测值无声吞掉
    quarantineCorruptFileSync(storePath());
    cache = structuredClone(HEBAU_TERM_SEED);
    persist(cache);
  }
  return cache;
}

function persist(store: Record<string, TermStartDate>): void {
  try {
    writeFileAtomicSync(storePath(), JSON.stringify(store, null, 2));
  } catch {
    // 只读环境（如打包后）下退化为内存存储，不影响主流程
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 9 月第一个周一（秋冬学期）/ 3 月第一个周一（春夏学期） */
function estimatedWeek1(year: number, semester: number): string {
  const month = semester === 3 ? 9 : 3;
  const y = semester === 3 ? year : year + 1;
  const first = new Date(y, month - 1, 1);
  const offset = (8 - first.getDay()) % 7;
  return `${y}-${pad(month)}-${pad(1 + offset)}`;
}

/**
 * 取某学期的开学日期。查不到就估算，并明确标注 estimated——
 * 调用方必须把这个标记透传出去，不能当成既定事实讲给用户。
 */
export function resolveWeek1Monday(year: number, semester: number): TermStartDate {
  const store = loadStore();
  const hit = store[termKey(year, semester)];
  if (hit) return hit;

  return {
    week1Monday: estimatedWeek1(year, semester),
    source: "estimated",
    evidence:
      semester === 3
        ? "未见校历原文，按 9 月第一个周一估算"
        : "未见校历原文，按 3 月第一个周一估算",
  };
}

/** 当前教学周；未开学或超出 30 周返回 null。now 可注入（时间工具/测试需要） */
export function currentWeekOf(
  year: number,
  semester: number,
  now: Date = new Date(),
): {
  week: number;
  week1Monday: string;
  source: TermStartDate["source"];
  evidence?: string;
} | null {
  const info = resolveWeek1Monday(year, semester);
  const start = new Date(`${info.week1Monday}T00:00:00`).getTime();
  const week = Math.floor((now.getTime() - start) / (7 * 86400000)) + 1;
  if (week < 1 || week > 30) return null;
  return {
    week,
    week1Monday: info.week1Monday,
    source: info.source,
    evidence: info.evidence,
  };
}
