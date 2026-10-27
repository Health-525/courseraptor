import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { patchTerminalFrames } from "../scripts/tui-frame-patch.mjs";

const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve("@ai-sdk/tui"), "utf8");
const patched = patchTerminalFrames(source);
const start = patched.indexOf("//#region src/tui/terminal-frame-buffer.ts");
const end = patched.indexOf("//#endregion", start);

// 从真实安装包取帧缓冲区，避免测试另写一套渲染实现；不启动 Agent 或访问网络。
const FrameBuffer = runInNewContext(`${patched.slice(start, end)}\nTerminalFrameBuffer;`) as new (
  output: { write(chunk: string): boolean },
  options?: { useSynchronizedUpdates: boolean },
) => { present(frame: string): void; reset(): void };

function capture(synchronized = false) {
  const writes: string[] = [];
  const output = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  };
  return {
    writes,
    output,
    buffer: new FrameBuffer(output, { useSynchronizedUpdates: synchronized }),
  };
}

test("终端整帧不依赖换行符，标题、页脚和输入框各自定位到正确行", () => {
  const { buffer, writes } = capture();
  buffer.present("Raptor\nFooter\nInput");
  const paint = writes.join("");
  assert.ok(paint.includes("\x1b[1;1H\x1b[2KRaptor"));
  assert.ok(paint.includes("\x1b[2;1H\x1b[2KFooter"));
  assert.ok(paint.includes("\x1b[3;1H\x1b[2KInput"));
  assert.ok(!paint.includes("\n"), "Windows 的 LF 不隐式回车时也不能错位");
  assert.ok(paint.startsWith("\x1b[?7l"), "绘制前关闭自动换行，避免右下角滚屏");
  assert.ok(paint.endsWith("\x1b[0m\x1b[H\x1b[?7h"), "光标归位并恢复终端状态");
});

test("连续重绘只更新变化行，缩短内容时擦掉旧页脚，空帧不重复输出", () => {
  const { buffer, writes } = capture();
  buffer.present("Raptor\nFooter\nInput");
  writes.length = 0;
  buffer.present("Raptor\nInput");
  assert.ok(writes[0]?.includes("\x1b[2;1H\x1b[2KInput"));
  assert.ok(writes[0]?.includes("\x1b[3;1H\x1b[2K"), "旧输入行必须清空");
  assert.ok(!writes[0]?.includes("Footer"));
  writes.length = 0;
  buffer.present("Raptor\nInput");
  assert.equal(writes.length, 0);
});

test("外部日志或 resize 之后全帧重画，同步更新模式也恢复自动换行", () => {
  const { buffer, writes, output } = capture(true);
  buffer.present("Raptor\nInput");
  writes.length = 0;
  output.write("background log");
  buffer.present("Raptor\nInput");
  const paint = writes[1] ?? "";
  assert.ok(paint.includes("\x1b[2J"), "外部输出之后不能复用旧帧坐标");
  assert.ok(paint.startsWith("\x1b[?2026h\x1b[?7l"));
  assert.ok(paint.endsWith("\x1b[?7h\x1b[?2026l"));
  writes.length = 0;
  buffer.reset();
  buffer.present("Raptor\nInput");
  assert.ok(writes[0]?.includes("\x1b[2J"), "resize 后也应重画完整帧");
});

test("终端补丁重复应用不改写文件，依赖结构不匹配时明确报错", () => {
  assert.equal(patchTerminalFrames(patched), patched);
  assert.throws(() => patchTerminalFrames("unknown dependency"), /找不到终端帧缓冲区/);
  assert.throws(
    () => patchTerminalFrames("//#region src/tui/terminal-frame-buffer.ts\nunknown\n//#endregion"),
    /重绘锚点未匹配/,
  );
});
