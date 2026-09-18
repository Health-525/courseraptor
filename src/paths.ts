/**
 * 项目根目录解析（独立模块避免 config <-> credentials 循环依赖）
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 数据目录：测试经 RAPTOR_DATA_DIR 重定向，生产落在项目根 data/ 下 */
export function dataDir(): string {
  return process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data");
}
