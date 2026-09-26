/**
 * QQ 桥文件日志：嵌入 TUI 运行时把 SDK 与桥接日志写进 qq-bridge.log，
 * 避免控制台输出破坏终端 UI 渲染。
 * 写入实现统一走 core/logger 的 createFileLogger（格式、分级、轮转一致），
 * 保留独立文件：排查桥接问题时一个文件看全。
 */

import { createFileLogger } from "../../core/logger";
import { migratedDataPath } from "../../core/paths";

const LOG_FILE = migratedDataPath("qq-bridge.log");
const impl = createFileLogger(LOG_FILE);

export interface QQFileLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

export function createQQFileLogger(): QQFileLogger {
  return {
    info: impl.info,
    error: impl.error,
    warn: impl.warn,
    debug: impl.debug,
    // 旧调用点有 .log 别名，语义等同 info
    log: impl.info,
  };
}
