/**
 * 键位代理：在真实 stdin 和 @ai-sdk/tui 之间插一层，修正按键语义。
 *
 * 为什么需要：库的默认行为是「流式输出中 ESC 和 Ctrl+C 都只打断当前回复」，
 * 但底部状态栏写着「Ctrl+C quit」——用户按 Ctrl+C 想退出却只得到打断，还得再按一次。
 * 用户要的约定（也是 Claude Code 等主流 CLI 的约定）：
 *   - ESC    = 打断当前回复（流式中由库原样处理，已是正确行为）
 *   - Ctrl+C = 退出程序（由本代理拦截，任何状态下都立即生效）
 *
 * 库不支持自定义键位，但 TerminalRenderer 接受自定义输入流（runAgentTUI 的
 * userInput 运行时参数）。代理层把真实 stdin 的 raw mode 管在自己手里，
 * Ctrl+C 不透传、直接优雅退出；其余按键（含方向键、翻页、退格、ESC）原样转发。
 *
 * 注意：嵌入模式下（raptor 同时挂 QQ 桥）TUI 退出后进程可能继续存活，
 * 库只恢复代理流、不会碰真实 stdin——所以必须在 TUI 返回后手动 restore()，
 * 否则终端留在 raw mode。
 */

import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";

export interface KeyProxy {
  /** 传给 runAgentTUI 的 userInput */
  stream: Readable;
  /** TUI 退出后调用：解除转发、关 raw mode、恢复终端 */
  restore(): void;
}

export function createKeyProxy(stdin: Readable): KeyProxy {
  const proxy = new PassThrough();
  // 库检查 input.isTTY 才会启用交互模式（备用屏幕/光标隐藏）；
  // setRawMode 用 ?. 调用，缺失即跳过——真实 raw mode 由本模块管理
  Object.defineProperty(proxy, "isTTY", { value: true });
  Object.defineProperty(proxy, "setRawMode", { value: undefined });

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      stdin.removeListener("data", onData);
      const tty = stdin as NodeJS.ReadStream;
      if (tty.isTTY) {
        tty.setRawMode?.(false);
        tty.pause();
      }
      // 退出备用屏幕、显示光标（与库 stop_fn 的清理序列一致）
      process.stdout.write("\x1B[?25h\x1B[?1049l");
    } catch {
      /* 恢复失败也不阻塞后续流程 */
    }
  };

  const onData = (chunk: Buffer): void => {
    if (restored) return;
    if (chunk.toString("utf8").includes("\x03")) {
      // Ctrl+C = 退出。会话历史逐轮落盘（memory/shortterm），这里直接退出
      // 不丢上下文；下次启动自动恢复上次会话尾部。
      restore();
      process.exit(0);
    }
    proxy.write(chunk);
  };

  const tty = stdin as NodeJS.ReadStream;
  if (tty.isTTY) {
    tty.setRawMode?.(true);
  }
  stdin.resume();
  stdin.on("data", onData);

  // 无论正常退出还是异常退出，都兜底还原终端，避免留下 raw mode 坏终端
  process.once("exit", restore);

  return { stream: proxy, restore };
}
