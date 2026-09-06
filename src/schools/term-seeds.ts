/**
 * 开学日期（第 1 周周一）播种表 —— 一校一份
 *
 * 为什么必须有学校维度：这些日期原先只有南工大一套真值，落在 data/term-dates.json。
 * 如果接了河北农大还共用一个文件，南工大的「2026 秋 = 08-31」会被当成河北农大的
 * 开学日（河农大是 09-01），整个学期的周次系统性错一周——而且错得很像对的，
 * 用户不会发现。所以：文件按学校分开，种子表按学校分开。
 *
 * 本模块必须是叶子：src/jwgl/term-dates.ts 要 import 它，而它只能反向 import 类型
 * （type-only，运行时被擦除），否则循环依赖。
 */

import type { TermStartDate } from "../jwgl/term-dates";

/** 南工大：2025 两学期人工按校历校准；2026 秋依据南工教〔2026〕91号 */
export const NJTECH_TERM_SEED: Record<string, TermStartDate> = {
  "2025-1": { week1Monday: "2025-09-01", source: "known", evidence: "人工按校历校准" },
  "2025-2": { week1Monday: "2026-03-02", source: "known", evidence: "人工按校历校准" },
  "2026-1": {
    week1Monday: "2026-08-31",
    source: "known",
    evidence: "南工教〔2026〕91号：报到 8-29～8-30、注册 8-31～9-30（修正此前 9-07 的估算）",
  },
};

/**
 * 河北农大：沿用 ScholarFlow 侧人工整理的校历表（lib/schools/hebau/index.ts）。
 * source 标 "known" 而非 "recorded"：有确定依据，但没有可追溯的通知解析链路。
 */
export const HEBAU_TERM_SEED: Record<string, TermStartDate> = {
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

/** 学校 id -> 播种表。未登记的学校不播种，一律按月份估算并如实标 estimated */
export const TERM_SEEDS: Record<string, Record<string, TermStartDate>> = {
  njtech: NJTECH_TERM_SEED,
  hebau: HEBAU_TERM_SEED,
};
