/**
 * QQ 桥文件日志：嵌入 TUI 运行时把 SDK 与桥接日志写进 qq-bridge.log，
 * 避免控制台输出破坏终端 UI 渲染
 */

import fs from "node:fs";
import path from "node:path";

import { PROJECT_ROOT } from "../config";

const LOG_FILE = path.join(PROJECT_ROOT, "qq-bridge.log");
const stream = fs.createWriteStream(LOG_FILE, { flags: "a" });

export interface QQFileLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

function write(level: string, msg: string, meta?: Record<string, unknown>): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${
    meta ? " " + JSON.stringify(meta) : ""
  }`;
  stream.write(line + "\n");
}

export function createQQFileLogger(): QQFileLogger {
  return {
    info: (m, meta) => write("info", m, meta),
    error: (m, meta) => write("error", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    debug: (m, meta) => write("debug", m, meta),
    log: (m, meta) => write("log", m, meta),
  };
}
