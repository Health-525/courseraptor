/**
 * 桌面版后端入口：与 TUI 同一个内核（bootstrapHost），但不进 TUI 循环。
 *
 * 与 Electron 主进程的唯一约定是 stdout 行协议（见 docs/superpowers/plans/
 * 2026-10-15-desktop-version.md §5）：每行前缀 `@raptor-ipc ` + 单行 JSON。
 *   - ready  ：网页服务起好，携带 URL，主进程据此 loadURL
 *   - notify ：桌面通知端口收到的消息（主进程转 Electron 原生通知）
 *   - log    ：普通日志（桌面无终端）
 * 非该前缀的 stdout（如 bootstrapHost 打印的更新横幅）由主进程按日志处理。
 *
 * 进程常驻：待办提醒调度 / QQ 桥都挂在事件循环上，随本进程存活。
 * 接收到 SIGTERM / SIGINT 时优雅退出并兜底刷写会话。
 */

import { flushCapturedSession } from "../../src/core/memory/shortterm";
import { registerDesktopNotifier } from "../../src/core/notify";
import { bootstrapHost } from "./boot";

function emit(msg: unknown): void {
  process.stdout.write(`@raptor-ipc ${JSON.stringify(msg)}\n`);
}

// 注册桌面通知端口：待办提醒等 core 侧通知转成 notify 行交给 Electron
registerDesktopNotifier((title, body) => emit({ type: "notify", title, body }));

const { webUrl } = await bootstrapHost();

if (webUrl) emit({ type: "ready", url: webUrl });
else emit({ type: "log", level: "error", text: "网页服务启动失败：无法监听本机端口" });

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await flushCapturedSession();
  } catch {
    /* 退出兜底，刷写失败不阻塞 */
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
