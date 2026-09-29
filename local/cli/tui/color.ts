/**
 * 终端颜色统一出口：检测能力 + 语义化常量。
 *
 * 为什么集中：welcome.ts / slash-menu.ts / inline.ts 原先各自定义 CYAN/DIM，
 * 既漂移又没法统一降级。重定向到文件、管道、CI 环境下，ANSI 转义码会原样
 * 污染输出（clig.dev 明确要求：非 TTY 时自动关颜色）。
 *
 * 判断顺序：NO_COLOR（业界约定，https://no-color.org）→ CI=true（持续集成
 * 默认无 TTY）→ process.stdout.isTTY。三者任一命中即降级为空串，所有调用
 * 方无需感知。
 *
 * 注意：这些常量在模块加载时求值一次。应用启动后中途重定向 stdout 不常见，
 * 真发生也不会崩——只是颜色不随新目标变。@ai-sdk/tui 全屏模式下输出由库
 * 自己管 isTTY，应用层这里管的是注入进帧/直接写 stdout 的文案。
 */

/** 当前是否应输出 ANSI 颜色码 */
const supportsColor =
  !process.env.NO_COLOR && process.env.CI !== "true" && process.stdout.isTTY !== false;

export const RESET = supportsColor ? "\x1b[0m" : "";
export const CYAN = supportsColor ? "\x1b[36m" : "";
export const DIM = supportsColor ? "\x1b[2m" : "";
export const GREEN = supportsColor ? "\x1b[32m" : "";
export const YELLOW = supportsColor ? "\x1b[33m" : "";
export const RED = supportsColor ? "\x1b[31m" : "";
export const INVERT = supportsColor ? "\x1b[7m" : "";

/** 「标题」语义：cyan 包裹【...】 */
export const header = (s: string) => `${CYAN}【${s}】${RESET}`;
/** 「弱化说明」语义：dim 包裹 */
export const dim = (s: string) => `${DIM}${s}${RESET}`;
