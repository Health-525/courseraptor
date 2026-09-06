/**
 * 学校注册表 —— RAPTOR_SCHOOL 到适配器的唯一映射点
 *
 * 只有一个地方允许「知道有哪些学校」：本文件的 ADAPTERS。工具层一律
 * `activeSchool()` + capability 判断，写 `if (school === "hebau")` 就是设计失败——
 * 那样第三所学校进来时要改一遍所有工具。
 */

import { config } from "../config";
import { hebauAdapter } from "./hebau";
import { KNOWN_SCHOOL_IDS } from "./ids";
import { njtechAdapter } from "./njtech";
import type { SchoolAdapter } from "./types";
import { type SchoolCapability, supportsCapability } from "./types";

const ADAPTERS: ReadonlyMap<string, SchoolAdapter> = new Map<string, SchoolAdapter>(
  [njtechAdapter, hebauAdapter].map((adapter) => [adapter.id, adapter]),
);

/** 名单与适配器必须同步。漏登记时 ids.ts 允许配置、这里却查不到 → 运行时才炸，
 *  所以启动即断言（loadSchoolRegistry 由 activeSchool 第一次调用时执行）。 */
function assertRegistered(): void {
  for (const id of KNOWN_SCHOOL_IDS) {
    if (!ADAPTERS.has(id)) {
      throw new Error(
        `学校 "${id}" 在 src/schools/ids.ts 登记了但没有适配器，请补注册或从名单删除`,
      );
    }
  }
}

let memo: { id: string; adapter: SchoolAdapter } | null = null;

/** 当前生效的学校。按 config.school 解析一次后缓存 */
export function activeSchool(): SchoolAdapter {
  if (memo && memo.id === config.school) return memo.adapter;
  assertRegistered();
  const adapter = ADAPTERS.get(config.school);
  if (!adapter) {
    // config 已经拦过一遍，走到这里说明有代码绕过了 normalizeSchoolId
    throw new Error(`未知学校 "${config.school}"，可选：${KNOWN_SCHOOL_IDS.join(" | ")}`);
  }
  memo = { id: config.school, adapter };
  return adapter;
}

export function getSchool(id: string): SchoolAdapter | undefined {
  return ADAPTERS.get(id);
}

export function allSchools(): SchoolAdapter[] {
  assertRegistered();
  return [...ADAPTERS.values()];
}

/** 学校是否有某能力（工具层门禁的唯一入口） */
export function schoolSupports(cap: SchoolCapability): boolean {
  return supportsCapability(activeSchool(), cap);
}

/** 测试用：清掉缓存，让改了 config.school 的用例重新解析 */
export function resetSchoolCache(): void {
  memo = null;
}
