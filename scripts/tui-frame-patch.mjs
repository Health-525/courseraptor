/**
 * Windows 终端兼容：整帧按绝对行定位绘制，并在绘制期间临时关闭自动换行。
 * 不依赖 LF 是否隐式回车，避免右下角触发滚屏后增量帧留在错误行。
 */
export function patchTerminalFrames(source) {
  const marker = "// raptor: absolute rows and scoped autowrap";
  if (source.includes(marker)) return source;

  const start = source.indexOf("//#region src/tui/terminal-frame-buffer.ts");
  const end = source.indexOf("//#endregion", start);
  if (start < 0 || end < 0)
    throw new Error("[patch-tui] 找不到终端帧缓冲区，请检查 @ai-sdk/tui 版本");

  let region = source.slice(start, end);
  const replacements = [
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 匹配依赖源码的模板字面量，不能在补丁阶段求值
      "`${cursorHome}${clearScreen}${frame}`",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 生成依赖源码中的模板表达式
      '`${cursorHome}${clearScreen}${nextFrame.lines.map((line, index) => `${escape}[${index + 1};1H${clearLine}${line}`).join("")}`',
    ],
    [
      "#writeUpdate(update) {",
      `#writeUpdate(update) {\n\t\t${marker}\n\t\tconst paint = \`\${escape}[?7l\${update}\${escape}[0m\${cursorHome}\${escape}[?7h\`;`,
    ],
    ["this.#originalWrite(update);", "this.#originalWrite(paint);"],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 匹配依赖源码的模板字面量
      "`${synchronizeStart}${update}${synchronizeEnd}`",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 生成依赖源码中的模板表达式
      "`${synchronizeStart}${paint}${synchronizeEnd}`",
    ],
  ];
  for (const [anchor, replacement] of replacements) {
    if (!region.includes(anchor)) {
      throw new Error(`[patch-tui] 终端重绘锚点未匹配：${anchor}`);
    }
    region = region.replace(anchor, replacement);
  }
  return source.slice(0, start) + region + source.slice(end);
}
