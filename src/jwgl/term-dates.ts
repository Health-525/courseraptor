/**
 * 学期开学日期 — 单一真值源
 *
 * 为什么需要这个文件：
 * 之前「当前第几周」的依据是 academics.ts 里的一个硬编码 map，而同一个事实
 * 在对话里被修正过一次（2026 秋从「9-07 估算」改成「8-31，南工教〔2026〕91号」）
 * 却没人回头改代码——结论写进了长期记忆，代码里的真值没同步，两份真相开始漂移，
 * 于是整个学期 currentWeekOf() 系统性少报一周。
 *
 * 规则：
 * - 真值只有一个：data/term-dates.json（运行时可写，读通知落盘）
 * - 代码里的 LEGACY_SEED 只在首次运行时给存量学期播种，source 标 "known"
 * - 任何查不到的学期才用「9 月/3 月第一个周一」估算，且必须标 "estimated"
 * - 调用方拿到的一定带 source，工具层据此如实告诉用户「实测」还是「估算」
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 来源可信度：recorded > known > estimated，只有前两者能当真值用 */
export type TermDateSource = "recorded" | "known" | "estimated";

export interface TermStartDate {
  /** 第 1 周的周一，YYYY-MM-DD */
  week1Monday: string;
  source: TermDateSource;
  /** 依据：通知文号/标题片段；estimated 时写估算规则 */
  evidence?: string;
  recordedAt?: string;
}

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

/** 数据目录（测试可用 RAPTOR_DATA_DIR 指到临时目录） */
function dataDir(): string {
  return process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data");
}

function storePath(): string {
  return path.join(dataDir(), "term-dates.json");
}

/**
 * 存量学期播种值。
 * 来源说明：2025 两个学期为人工按校历校准；2026 秋依据南工教〔2026〕91号
 * 《报到注册通知》——报到 8-29～8-30、注册 8-31～9-30，第一周从 2026-08-31（周一）开始。
 * 注意这里刻意标 "known" 而非 "recorded"：有确定依据，但没有可追溯的解析链路。
 */
const LEGACY_SEED: Record<string, TermStartDate> = {
  "2025-1": { week1Monday: "2025-09-01", source: "known", evidence: "人工按校历校准" },
  "2025-2": { week1Monday: "2026-03-02", source: "known", evidence: "人工按校历校准" },
  "2026-1": {
    week1Monday: "2026-08-31",
    source: "known",
    evidence: "南工教〔2026〕91号：报到 8-29～8-30、注册 8-31～9-30（修正此前 9-07 的估算）",
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
    cache = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Record<
      string,
      TermStartDate
    >;
  } catch {
    // 首次运行：用存量值播种并落盘，之后就以文件为准
    cache = structuredClone(LEGACY_SEED);
    persist(cache);
  }
  return cache;
}

function persist(store: Record<string, TermStartDate>): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
  } catch {
    // 只读环境（如打包后）下退化为内存存储，不影响主流程
  }
}

/**
 * 记录一个学期的开学日期。
 * "recorded"（从通知解析）优先级最高，可以覆盖 "known"；
 * 反之不允许，避免估算值把实测值冲掉。
 */
export function recordWeek1Monday(
  year: number,
  semester: number,
  week1Monday: string,
  source: TermDateSource,
  evidence?: string
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
 * 从通知正文里解析开学日期。
 * 命中即返回该周的周一，并附上原始句子作为证据。
 */
export function parseTermStartDate(
  text: string
): { week1Monday: string; evidence: string } | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ");
  const ctxYear = new Date().getFullYear();

  // 候选：(年月日, 是否被「开学/上课/第一周」语义锚定, 证据句)
  const candidates: Array<{ y: number; m: number; d: number; evidence: string; score: number }> = [];

  const push = (
    y: number, m: number, d: number, sentence: string, score: number
  ) => {
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
    const m1 = s.match(
      /第[一1]周从\s*(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/
    );
    if (m1) {
      push(+m1[1], +m1[2], +m1[3], s, 100);
      continue;
    }

    // ② 「2026年8月31日（星期一）正式上课」/「8月31日开学」（容忍「8 月 31 日」这类空格）
    const m2 = s.match(
      /(?:(\d{4})\s*[-/年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?\s*[（(]?\s*周[一二三四五六日天]\s*[)）]?\s*[^，。]{0,6}?(正式上课|开始上课|开学)/
    );
    if (m2) {
      push(m2[1] ? +m2[1] : ctxYear, +m2[2], +m2[3], s, hasTermWord ? 95 : 80);
      continue;
    }

    // ③ 「8月31日起开始上课」「于8月31日开学」
    const m3 = s.match(
      /(?:(\d{4})\s*[-/年]\s*)?(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?[^。]{0,8}?(正式上课|开始上课|开学)/
    );
    if (m3 && hasStartWord) {
      push(m3[1] ? +m3[1] : ctxYear, +m3[2], +m3[3], s, 60);
      continue;
    }

    // ④ 「开学时间：2026-08-31」（日期在语义词之后）
    const m4 = s.match(
      /(开学|正式上课|开始上课|第一周)[^0-9]{0,8}(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/
    );
    if (m4) {
      push(+m4[2], +m4[3], +m4[4], s, hasTermWord ? 90 : 50);
    }
  }

  if (!candidates.length) return null;

  // 取分数最高的；同分取日期最早的（开学日一般早于注册/补退选日期）
  candidates.sort((a, b) => b.score - a.score || (a.y * 400 + a.m * 32 + a.d) - (b.y * 400 + b.m * 32 + b.d));
  const best = candidates[0];
  return { week1Monday: mondayOf(best.y, best.m, best.d), evidence: best.evidence };
}

/**
 * 解析学期归属：从通知正文里找「2026-2027学年第一学期」这类表述
 * 找不到时按日期推断（8 月及以后属于当年秋学期）
 */
export function parseTermRef(
  text: string
): { year: number; semester: number } | null {
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
export function resolveWeek1Monday(
  year: number,
  semester: number
): TermStartDate {
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

/** 当前教学周；未开学或超出 30 周返回 null */
export function currentWeekOf(
  year: number,
  semester: number
): { week: number; week1Monday: string; source: TermDateSource; evidence?: string } | null {
  const info = resolveWeek1Monday(year, semester);
  const start = new Date(`${info.week1Monday}T00:00:00`).getTime();
  const week = Math.floor((Date.now() - start) / (7 * 86400000)) + 1;
  if (week < 1 || week > 30) return null;
  return {
    week,
    week1Monday: info.week1Monday,
    source: info.source,
    evidence: info.evidence,
  };
}
