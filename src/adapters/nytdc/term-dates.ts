/**
 * NYTDC 开学日期（第 1 周周一）真值层
 *
 * 真值层级沿用 core 约定：recorded（通知实测）> known（人工/校历校准）> estimated（估算）。
 * 存储文件带学校前缀（term-dates-nytdc.json）——与 NJTECH/HEBAU 共用一个文件
 * 会让别校的开学日冒充本校，整个学期的周次系统性偏一周。
 *
 * 播种依据（实机查证，2026-10）：
 * - 2025-2026 学年第一学期校历（基础教学部发布）：2025-09-08 ~ 2026-01-23，第 1 周周一起 09-08
 * - 2025-2026 学年第二学期校历：2026-03-02 ~ 2026-07-05，第 1 周周一起 03-02
 * - 2026-2027 学年第一学期：学生 08-30 报到、08-31 正常上课（08-31 为周一）
 *
 * 开学日期没有从通知正文解析的先例可用（通知能力未接入），因此一律标 known
 * 而非 recorded：有确定依据，但没有可追溯的解析链路。
 */

import fs from "node:fs";
import path from "node:path";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "../../core/atomic-write";
import type { TermDateSource, TermStartDate } from "../../core/model";
import { dataDir } from "../../core/paths";

export type { TermDateSource, TermStartDate } from "../../core/model";

function storePath(): string {
  return path.join(dataDir(), "term-dates-nytdc.json");
}

/** 存量学期播种值。新增学期：先查教务处校历，查不到就让 resolveWeek1Monday 估算并标注 */
const LEGACY_SEED: Record<string, TermStartDate> = {
  "2025-1": {
    week1Monday: "2025-09-08",
    source: "known",
    evidence: "2025-2026学年第一学期校历：2025年9月8日至2026年1月23日",
  },
  "2025-2": {
    week1Monday: "2026-03-02",
    source: "known",
    evidence: "2025-2026学年第二学期校历：2026年3月2日至2026年7月5日",
  },
  "2026-1": {
    week1Monday: "2026-08-31",
    source: "known",
    evidence: "2026-2027学年第一学期：学生8月30日报到，8月31日正常上课",
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
    // 首次运行：用存量值播种并落盘；文件写坏了先留副本，别让实测值无声消失
    quarantineCorruptFileSync(storePath());
    cache = structuredClone(LEGACY_SEED);
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
 * "recorded" 优先级最高，可以覆盖 "known"；反之不允许，避免估算值冲掉实测值。
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

// ── 解析 ──────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 取某个日期所在周的周一 */
export function mondayOf(y: number, m: number, d: number): string {
  const date = new Date(y, m - 1, d);
  const back = (date.getDay() + 6) % 7; // 周一=0
  date.setDate(date.getDate() - back);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 9 月第一个周一（秋季）/ 3 月第一个周一（春季） */
function estimatedWeek1(year: number, semester: number): string {
  const month = semester === 3 ? 9 : 3;
  const y = semester === 3 ? year : year + 1;
  const first = new Date(y, month - 1, 1);
  const offset = (8 - first.getDay()) % 7;
  return `${y}-${pad(month)}-${pad(1 + offset)}`;
}

/**
 * 从通知正文里解析开学日期（备用：通知能力接入后即可落 recorded 真值）
 * 命中即返回该周的周一，并附上原始句子作为证据。
 */
export function parseTermStartDate(text: string): { week1Monday: string; evidence: string } | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ");
  const ctxYear = new Date().getFullYear();

  const candidates: Array<{ y: number; m: number; d: number; evidence: string; score: number }> =
    [];

  const push = (y: number, m: number, d: number, sentence: string, score: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    candidates.push({ y, m, d, evidence: sentence.trim().slice(0, 120), score });
  };

  const sentences = flat.split(/[。；\n]/);

  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;

    const hasStartWord = /第一周|开学|正式上课|开始上课|报到|注册/.test(s);
    const hasTermWord = /第一周从|第1周从/.test(s);

    // ① 强信号：「第一周从 2026-08-31（周一）开始」
    const m1 = s.match(/第[一1]周从\s*(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/);
    if (m1) {
      push(+m1[1], +m1[2], +m1[3], s, 100);
      continue;
    }

    // ② 「2025年9月8日（星期一）正式上课」/「8月31日开学」
    const m2 = s.match(
      /(?:(\d{4})\s*[-/年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?\s*[（(]?\s*周[一二三四五六日天]\s*[)）]?\s*[^，。]{0,6}?(正式上课|开始上课|开学)/,
    );
    if (m2) {
      push(m2[1] ? +m2[1] : ctxYear, +m2[2], +m2[3], s, hasTermWord ? 95 : 80);
      continue;
    }

    // ③ 「8月31日起开始上课」「于8月31日开学」
    const m3 = s.match(
      /(?:(\d{4})\s*[-/年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?[^。]{0,8}?(正式上课|开始上课|开学)/,
    );
    if (m3 && hasStartWord) {
      push(m3[1] ? +m3[1] : ctxYear, +m3[2], +m3[3], s, 60);
      continue;
    }

    // ④ 「开学时间：2026-08-31」（日期在语义词之后）
    const m4 = s.match(
      /(开学|正式上课|开始上课|第一周)[^0-9]{0,8}(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/,
    );
    if (m4) {
      push(+m4[2], +m4[3], +m4[4], s, hasTermWord ? 90 : 50);
    }
  }

  if (!candidates.length) return null;

  candidates.sort(
    (a, b) => b.score - a.score || a.y * 400 + a.m * 32 + a.d - (b.y * 400 + b.m * 32 + b.d),
  );
  const best = candidates[0];
  return { week1Monday: mondayOf(best.y, best.m, best.d), evidence: best.evidence };
}

/** 解析学期归属：从正文里找「2026-2027学年第一学期」这类表述 */
export function parseTermRef(text: string): { year: number; semester: number } | null {
  const m = text.match(/(\d{4})\s*[-–—~]\s*(\d{4})\s*学年\s*第?\s*([一1二2])\s*学期/);
  if (m) return { year: parseInt(m[1], 10), semester: m[3] === "1" || m[3] === "一" ? 3 : 12 };

  const m2 = text.match(/(\d{4})\s*[-–—~]\s*(\d{4})\s*[-–—~]?\s*([12])/);
  if (m2) return { year: parseInt(m2[1], 10), semester: m2[3] === "1" ? 3 : 12 };

  return null;
}

// ── 对外查询 ──────────────────────────────────────────────────

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
