/**
 * 手动课表模式的学期开学日期存取
 *
 * 「其他学校」的开学日期是用户导入课表时填的，落在加密凭证里
 * （customTermStarts）。core/channels 与 custom 适配器共用这一份存取，
 * 避免 web 层反向 import 适配器（依赖方向见 core/school.ts 头注）。
 */

import { loadCredentialsStore, saveCredentialsStore } from "./credentials";

/** 学期键：如 2026-2027-1（展示口径，1/2 学期；semester 取学校侧编码 3=秋 12=春） */
export function manualTermKey(year: number, semester: number): string {
  return `${year}-${year + 1}-${semester === 3 ? 1 : 2}`;
}

/** 已记录的开学日期（学期键 → 周一 YYYY-MM-DD） */
export function manualTermStarts(): Record<string, string> {
  return loadCredentialsStore()?.customTermStarts ?? {};
}

/** 记录某学期开学周一；同学期重复写以新值为准 */
export function recordManualTermStart(year: number, semester: number, monday: string): void {
  saveCredentialsStore({
    customTermStarts: {
      ...manualTermStarts(),
      [manualTermKey(year, semester)]: monday,
    },
  });
}
