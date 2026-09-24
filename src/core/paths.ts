/**
 * 项目根目录解析（独立模块避免 config <-> credentials 循环依赖）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

/**
 * 状态文件归位：原先散在项目根的 session.json / memory.json / qq-allowlist.json /
 * qq-bridge.log 统一搬进 data/。首次调用时把旧文件搬一次，迁移失败（如文件被占用）
 * 就继续用旧位置，不挡启动。
 */
export function migratedDataPath(filename: string): string {
  const newPath = path.join(dataDir(), filename);
  // 测试环境把 RAPTOR_DATA_DIR 指到临时目录：不做迁移，避免把真实状态
  // 搬进随测试销毁的目录里
  if (process.env.RAPTOR_DATA_DIR) return newPath;
  const oldPath = path.join(PROJECT_ROOT, filename);
  try {
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.renameSync(oldPath, newPath);
    }
  } catch {
    return fs.existsSync(oldPath) && !fs.existsSync(newPath) ? oldPath : newPath;
  }
  return newPath;
}
