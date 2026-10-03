/**
 * 河北农大学期开学日期 — 单一真值源（与 njtech/term-dates.ts 同一套约定）
 *
 * 两校的校历绝不能共用一份真值：文件按学校分开（term-dates-hebau.json）、
 * 种子按学校分开。如果共用，南工大的「2026 秋 = 08-31」会被当成河北农大的
 * 开学日，整个学期的周次系统性错一周——而且错得很像对的，用户不会发现。
 *
 * 种子来源：ScholarFlow 侧人工整理的河北农大校历。其中 2026 秋做了周一归一化：
 * 原记录「09-01 开学」，但 2026-09-01 是周二，教学周按包含开课日的周一起算
 * 即 08-31（与南工大同日纯属巧合，两份真值各自独立维护）。待校历原文复核。
 */

import fs from "node:fs";
import path from "node:path";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "../../core/atomic-write";
import type { TermDateSource, TermStartDate } from "../../core/model";
import { dataDir } from "../../core/paths";

function storePath(): string {
  return path.join(dataDir(), "term-dates-hebau.json");
}

/** 存量学期播种值。source 标 "known"：有确定依据，但没有可追溯的通知解析链路。 */
const HEBAU_SEED: Record<string, TermStartDate> = {
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
    week1Monday: "2026-08-31",
    source: "known",
    evidence:
      "河北农大校历：2026-09-01（周二）起上课，第 1 教学周按含开课日的周一起算（原记录 09-01 开学已做周一归一化，待校历原文复核）",
  },
  "2026-2": {
    week1Monday: "2027-03-01",
    source: "known",
    evidence: "河北农大校历（ScholarFlow 整理）",
  },
};

/** 学期 key：`${学年起始年}-${1|2}` */
export function termKey(year: number, semester: number): string {
  return `${year}-${semester === 3 ? 1 : 2}`;
}

// ── 读写 ──────────────────────────────────────────────────────

let cache: Record<string, TermStartDate> | null = null;

export function loadStore(): Record<string, TermStartDate> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Record<string, TermStartDate>;
  } catch {
    // 首次运行：用存量值播种并落盘，之后就以文件为准。
    // 文件写坏了（半截 JSON）先留副本，别让已经记录过的真值无声消失。
    quarantineCorruptFileSync(storePath());
    cache = structuredClone(HEBAU_SEED);
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

/**
 * 记录一个学期的开学日期。
 * "recorded"（人工确认过的校历原文）优先级最高，可以覆盖 "known"；
 * 反之不允许，避免估算值把实测值冲掉。
 */
export function recordWeek1Monday(
  year: number,
  semester: number,
  week1Monday: string,
  source: TermDateSource,
  evidence?: string,
): TermStartDate {
  const store = loadStore();
  const key = termKey(year, semester);
  const prev = store[key];

  const rank: Record<TermDateSource, number> = { estimated: 0, known: 1, recorded: 2 };
  if (prev && rank[prev.source] > rank[source]) return prev;

  const entry: TermStartDate = {
    week1Monday,
    source,
    evidence,
    recordedAt: new Date().toISOString(),
  };
  store[key] = entry;
  persist(store);
  return entry;
}

// ── 对外查询 ──────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 9 月第一个周一（秋冬）/ 3 月第一个周一（春夏） */
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
  const hit = loadStore()[termKey(year, semester)];
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

/** 当前教学周；未开学或超出 30 周返回 null。now 可注入（测试需要） */
export function currentWeekOf(
  year: number,
  semester: number,
  now: Date = new Date(),
): { week: number; week1Monday: string; source: TermDateSource; evidence?: string } | null {
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
