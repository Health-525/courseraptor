/**
 * 免登录 JSON 缓存骨架 — schedule-cache / exam-cache 同一套约定
 *
 * 「查通一次就落盘，之后纯读缓存不登录不请求」的本地缓存共用读写与
 * 坏文件隔离：读到坏文件按 .corrupt-<时间戳> 留档后当无缓存，调用方
 * 自行回退在线拉取；写失败只打日志不影响主流程（顶多下次多查一次）。
 */

import fs from "node:fs";
import path from "node:path";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "./atomic-write";
import { dataDir } from "./paths";

function cacheFile(filename: string): string {
  return path.join(dataDir(), filename);
}

/** 读缓存；文件缺失、读坏或未通过校验都返回 null（坏文件先隔离留档） */
export function readJsonCache<E>(
  filename: string,
  isValid: (parsed: unknown) => parsed is E,
): E | null {
  const file = cacheFile(filename);
  let parsed: E;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as E;
  } catch {
    quarantineCorruptFileSync(file);
    return null;
  }
  if (!isValid(parsed)) {
    quarantineCorruptFileSync(file);
    return null;
  }
  return parsed;
}

/** 写缓存（原子替换）；失败只打日志，不影响主流程 */
export function writeJsonCache(filename: string, envelope: unknown, logTag: string): void {
  try {
    writeFileAtomicSync(cacheFile(filename), JSON.stringify(envelope, null, 2));
  } catch (e) {
    console.error(`[${logTag}] 保存失败:`, e);
  }
}
