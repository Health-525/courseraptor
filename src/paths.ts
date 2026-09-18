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

/**
 * 路径越界护栏：target 解析后必须落在 root 目录内部（根目录本身不算）。
 * 全项目统一的「只准碰自己目录里的东西」判断，供缓存删除/文件下载/落盘校验共用。
 */
export function isInsideDir(root: string, target: string): boolean {
  return path.resolve(target).startsWith(path.resolve(root) + path.sep);
}
