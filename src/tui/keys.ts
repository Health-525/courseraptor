/**
 * 键位代理：在真实 stdin 和 @ai-sdk/tui 之间插一层，补齐库缺失的交互。
 *
 * 键位语义（1.0.84 实测）：流式期间 ESC 和 Ctrl+C 都会打断当前回复并终结
 * 整个会话，它的词表里没有「打断但继续」。期望的约定（Claude Code 等主流 CLI）：
 *   - ESC    = 打断当前回复，回到输入框（本代理拦下单字节 ESC，转成软打断
 *              信号，由 agent 包装层消费：src/tui/soft-interrupt.ts）
 *   - Ctrl+C = 退出程序（原样透传。库任何状态下按 Ctrl+C 都会打断在途
 *              回复并走 runAgentTUI 正常 resolve 的优雅退出路径）
 *
 * 滚轮支持：库完全不解析鼠标事件，又挡在备用屏幕里，终端原生滚动全失效，
 * 用户只能按住 ↑/↓ 逐行挪。这里自己启用 SGR 鼠标上报（1000/1006），把滚轮
 * 事件翻译成合成方向键（一格 3 行），其余鼠标事件（按下/释放/移动）吞掉。
 * ↑/↓ 本身也放大成 3 行——库固定每次 1 行，逐行挪太慢；库的 ↑/↓ 只用于
 * 滚动（输入框不支持历史翻阅），放大无副作用。
 *
 * 斜杠命令切换 UI：提示符下输入 /inline 回车 → 不把命令提交给 TUI，而是
 * 注入 Ctrl+C 让 runAgentTUI 优雅返回，index.ts 据此切到行内渲染器。库不
 * 支持提交前拦截，只能在代理里镜像输入框文本（退格同步回退）来识别。
 * 注入按 300ms 重试到生效为止：若命令是流式期间敲的（库忽略字符但代理
 * 镜像仍在累积），第一次 Ctrl+C 只会打断在途回复，重试确保回到输入框后
 * 必然触发退出。
 *
 * 为什么合成事件必须逐条 write：库的 parseKey 对整个 chunk 做**精确**匹配
 * （一次只认一个按键序列），多条拼在一个 chunk 里会被丢弃。
 *
 * raw mode 不在这里管：库会检查 input.isTTY 并调 input.setRawMode，前者
 * 伪造为 true，后者转发给真实 stdin，开关随库的生命周期走。鼠标上报是库
 * 不感知的模式，由本模块启用、restore() 时关闭。
 */

import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { emitSoftInterrupt } from "./soft-interrupt";

/** 一次滚轮滚格 / 一次 ↑/↓ 对应的滚动行数（库原生是 1，太慢） */
const SCROLL_LINES = 3;

export interface KeyProxy {
  /** 传给 runAgentTUI 的 userInput */
  stream: Readable;
  /** TUI 退出后调用：解除转发、关鼠标上报。嵌入模式下 QQ 桥会让进程继续存活， */
  /** 不还原的话按键会继续流向已退出的 UI */
  restore(): void;
  /** 斜杠命令已请求切换到的目标模式；未触发为 null */
  readonly switchRequest: string | null;
}

export interface KeyProxyOptions {
  /** 提示符下输入 key 回车 → 不提交给 TUI，改为请求切换到对应模式 */
  commands?: Record<string, string>;
}

export function createKeyProxy(
  stdin: Readable,
  options: KeyProxyOptions = {},
): KeyProxy {
  const commands = options.commands ?? {};
  const proxy = new PassThrough();
  // 库检查 input.isTTY 才启用交互模式，并对 input 调 setRawMode——
  // 前者伪造为 true，后者转发给真实 stdin
  Object.defineProperty(proxy, "isTTY", { value: true });
  Object.defineProperty(proxy, "setRawMode", {
    value: (flag: boolean) => (stdin as NodeJS.ReadStream).setRawMode?.(flag),
  });

  let restored = false;
  let switchTarget: string | null = null;
  /** 镜像输入框文本，识别斜杠命令；\u0000 标记本行已不是命令 */
  let cmdBuffer = "";
  let retryTimer: NodeJS.Timeout | undefined;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (retryTimer) clearInterval(retryTimer);
    try {
      stdin.removeListener("data", onData);
      stdin.pause();
      // 关鼠标上报（与启用顺序相反）
      process.stdout.write("\x1b[?1006l\x1b[?1000l");
    } catch {
      /* 恢复失败也不阻塞后续流程 */
    }
  };

  /** 触发切换：注入 Ctrl+C 走库的优雅退出路径。立即注入一次，再按 300ms
   * 重试——若库正在流式中（命令是流式期间敲的），第一次只会打断在途回复，
   * 重试保证回到输入框后必然退出。restore() 时清掉定时器。 */
  const triggerSwitch = (target: string): void => {
    switchTarget = target;
    proxy.write("\x03");
    retryTimer = setInterval(() => {
      if (!restored) proxy.write("\x03");
    }, 300);
    retryTimer.unref?.();
  };

  const onData = (chunk: Buffer): void => {
    if (restored || switchTarget !== null) return;
    // ESC 是孤立的 \x1b 单字节；方向键/功能键等转义序列（\x1b[A …）必须透传
    if (chunk.length === 1 && chunk[0] === 0x1b) {
      emitSoftInterrupt();
      return;
    }

    // SGR 鼠标事件：滚轮(编码 64/65)翻译成合成方向键，其余（按下/释放/移动）吞掉
    let wheelUp = 0;
    let wheelDown = 0;
    let text = chunk.toString("utf8").replace(
      /\x1b\[<(\d+);\d+;\d+[Mm]/g,
      (_m, code: string) => {
        if (code === "64") wheelUp++;
        else if (code === "65") wheelDown++;
        return "";
      },
    );
    const synth: string[] = [];
    for (let i = 0; i < wheelUp * SCROLL_LINES; i++) synth.push("\x1b[A");
    for (let i = 0; i < wheelDown * SCROLL_LINES; i++) synth.push("\x1b[B");

    // ↑/↓ 放大步长（parseKey 要求整块恰好是一个序列，所以必须拆条写）
    if (text === "\x1b[A" || text === "\x1b[B") {
      for (let i = 0; i < SCROLL_LINES; i++) synth.push(text);
      text = "";
    }
    for (const key of synth) proxy.write(key);
    if (!text) return;

    // 斜杠命令镜像：整行以 / 开头才跟踪，回车命中则触发切换、不提交命令
    if (Object.keys(commands).length) {
      if (text === "\r" || text === "\n") {
        const cmd = cmdBuffer.trim();
        cmdBuffer = "";
        if (cmd in commands) {
          triggerSwitch(commands[cmd]);
          return;
        }
      } else if (text === "\x7f" || text === "\b") {
        cmdBuffer = cmdBuffer.slice(0, -1);
      } else if (text >= " ") {
        if (cmdBuffer.startsWith("/")) {
          cmdBuffer += text;
        } else if (cmdBuffer === "") {
          cmdBuffer = text.startsWith("/") ? text : "\u0000";
        }
      }
    }

    proxy.write(text);
  };

  stdin.resume();
  stdin.on("data", onData);

  // 启用 SGR 鼠标上报（滚轮）；restore() 时按相反顺序关闭。
  // 只在代理存活期（全屏卡片 UI 期间）启用，行内模式依赖终端原生滚动
  process.stdout.write("\x1b[?1000h\x1b[?1006h");

  return {
    stream: proxy,
    restore,
    get switchRequest() {
      return switchTarget;
    },
  };
}
