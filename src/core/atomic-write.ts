/**
 * 原子写文件（同步 / 异步两版）
 *
 * 为什么需要：本项目的本地数据（memory.json / session.json /
 * credentials.enc / qq-allowlist.json）全是「读-改-写」，而读取方一律用
 * try/catch 把解析失败兜底成「没有数据」。直写一旦被 Ctrl+C 或崩溃打断，
 * 文件就是半截 JSON —— 下一次 load 静默返回空，再下一次写入以空为基回写，
 * 记忆、会话、凭证就这样无声消失，且没有任何报错。
 *
 * 同分区内 rename 是原子的：磁盘上要么是旧文件要么是新文件，不存在中间态。
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** 同目录临时文件（rename 跨分区不原子，必须同目录） */
const tmpName = (target: string): string =>
  `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;

export async function writeFileAtomic(target: string, data: string): Promise<void> {
  const tmp = tmpName(target);
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(tmp, data, "utf8");
    await fsp.rename(tmp, target);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 把读不出来的文件挪成 .corrupt-<时间戳> 备份。
 * 用在「读失败就当没数据」的场合：留一份坏文件，用户还有得救。
 */
export async function quarantineCorruptFile(target: string): Promise<void> {
  try {
    await fsp.access(target);
    await fsp.rename(target, `${target}.corrupt-${Date.now()}`);
  } catch {
    /* 文件不存在或挪不动都不影响主流程 */
  }
}

/** quarantineCorruptFile 的同步版 */
export function quarantineCorruptFileSync(target: string): void {
  try {
    fs.accessSync(target);
    fs.renameSync(target, `${target}.corrupt-${Date.now()}`);
  } catch {
    /* 同上 */
  }
}

export function writeFileAtomicSync(target: string, data: string): void {
  const tmp = tmpName(target);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败无所谓，主错误更重要 */
    }
    throw e;
  }
}
