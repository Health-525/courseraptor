/**
 * core 统一文件日志：后台诊断一律走这里，不再裸 console。
 *
 * 为什么不用 console：CLI 是 TUI 应用，裸 console.* 会把终端卡片界面撕开；
 * 网页 / QQ 渠道常驻后台，console 输出没人看、事后也没处查。用户可见的
 * 启动横幅、引导提示、进度消息（cli/index.ts、onboarding、updater 等）
 * 是界面不是日志，继续用 console，不在这里收编。
 *
 * 与 qq/logger.ts 的关系：qq-bridge.log 仍有独立文件（排查桥接问题时
 * 一个文件看全），但写入实现统一为这里的 createFileLogger。
 *
 * 级别：RAPTOR_LOG_LEVEL=debug|info|warn|error（默认 info），
 * 行格式与 qq-bridge.log 一致：[ISO 时间] [级别] 消息 {JSON meta}。
 */

import fs from "node:fs";
import path from "node:path";

import { migratedDataPath } from "./paths";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface FileLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** 同步落盘实现下无缓冲，仅保持接口兼容（历史：流式实现需要） */
  close(): Promise<void>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 超过该大小轮转为 .old（只留一代；日志是排障用，不留档案） */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function levelFromEnv(): LogLevel {
  const v = process.env.RAPTOR_LOG_LEVEL?.trim().toLowerCase();
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}

export interface FileLoggerOptions {
  /** 最低输出级别，默认取 RAPTOR_LOG_LEVEL（缺省 info） */
  minLevel?: LogLevel;
  /** 轮转阈值字节，默认 5MB（测试用小值钉轮转行为） */
  maxBytes?: number;
}

export function createFileLogger(file: string, options: FileLoggerOptions = {}): FileLogger {
  const minLevel = options.minLevel ?? levelFromEnv();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let bytesWritten = 0;
  let known = false;

  /** 逐行 appendFileSync 而非常驻流：日志是低频诊断输出，同步写的代价
   *  可以忽略，换来轮转时没有打开中的句柄——Windows 对打开中的文件
   *  rename 会 EPERM，流式实现必然踩这个竞态。 */
  function write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const line = `[${new Date().toISOString()}] [${level}] ${msg}${
      meta ? ` ${JSON.stringify(meta)}` : ""
    }\n`;
    // 磁盘满 / 目录只读：静默放弃——日志故障绝不能带崩主流程
    try {
      if (!known) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // 上一进程写超的遗留：先按大小轮转一次
        bytesWritten = fs.existsSync(file) ? fs.statSync(file).size : 0;
        if (bytesWritten >= maxBytes) rotate();
        known = true;
      }
      fs.appendFileSync(file, line);
      bytesWritten += Buffer.byteLength(line);
      if (bytesWritten >= maxBytes) rotate();
    } catch {
      /* 忽略本次写入，下次再试 */
    }
  }

  function rotate(): void {
    try {
      fs.renameSync(file, `${file}.old`);
      bytesWritten = 0;
    } catch {
      /* 轮转失败（文件被占用等）：继续往原文件追加，下次超限再试 */
    }
  }

  return {
    debug: (m, meta) => write("debug", m, meta),
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta),
    // appendFileSync 语义下无缓冲，close 仅保持接口兼容
    close: () => Promise.resolve(),
  };
}

/** 默认实例：data/raptor.log（落盘惰性，首次写入才建文件） */
export const logger = createFileLogger(migratedDataPath("raptor.log"));
