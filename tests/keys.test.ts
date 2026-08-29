/**
 * 键位代理测试：滚轮翻译、方向键放大、斜杠命令识别、普通输入透传。
 *
 * 对应三类真实问题：
 * - 库不解析鼠标事件，滚轮失效，用户只能按住 ↑/↓ 逐行挪（太慢）
 * - 库固定每次 ↑/↓ 只滚 1 行
 * - 运行时切换 UI 需要在代理层识别 /inline 命令并注入 Ctrl+C 优雅退出
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { onSoftInterrupt, emitSoftInterrupt } from "../src/tui/soft-interrupt";

const { createKeyProxy } = await import("../src/tui/keys");

interface Harness {
  stdin: PassThrough;
  out: string[];
  restore(): void;
}

// keys.ts 创建代理时会给 stdout 写鼠标启用序列，仅在创建瞬间屏蔽，
// 避免污染测试输出（不能全局替换 stdout.write——node:test 报告也走它）
function makeProxy(commands?: Record<string, string>): Harness {
  const stdin = new PassThrough();
  const out: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = () => true;
  let proxy: ReturnType<typeof createKeyProxy>;
  try {
    proxy = createKeyProxy(stdin, { commands });
  } finally {
    process.stdout.write = realWrite;
  }
  proxy.stream.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
  return {
    stdin,
    out,
    restore: () => {
      proxy.restore();
      proxy.stream.destroy();
    },
  };
}

const write = (h: Harness, s: string): void => {
  h.stdin.write(s);
};
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

test("滚轮上/下翻译成合成方向键，一格 3 行", async () => {
  const h = makeProxy();
  write(h, "\x1b[<64;10;5M"); // 滚轮上
  write(h, "\x1b[<65;10;5M"); // 滚轮下
  await flush();
  assert.deepEqual(h.out, ["\x1b[A", "\x1b[A", "\x1b[A", "\x1b[B", "\x1b[B", "\x1b[B"]);
  h.restore();
});

test("↑/↓ 放大成 3 行（逐条 write，parseKey 整块只认一个序列）", async () => {
  const h = makeProxy();
  write(h, "\x1b[A");
  write(h, "\x1b[B");
  await flush();
  assert.deepEqual(h.out, ["\x1b[A", "\x1b[A", "\x1b[A", "\x1b[B", "\x1b[B", "\x1b[B"]);
  h.restore();
});

test("非滚轮鼠标事件（按下/释放）被吞掉，不进输入框", async () => {
  const h = makeProxy();
  write(h, "\x1b[<0;5;5M"); // 左键按下
  write(h, "\x1b[<0;5;5m"); // 左键释放
  await flush();
  assert.deepEqual(h.out, []);
  h.restore();
});

test("普通字符原样透传", async () => {
  const h = makeProxy();
  write(h, "hi");
  write(h, "\r");
  await flush();
  assert.deepEqual(h.out, ["hi", "\r"]);
  h.restore();
});

test("孤立 ESC 触发软打断，不透传给库", async () => {
  const h = makeProxy();
  let interrupted = 0;
  const off = onSoftInterrupt(() => interrupted++);
  write(h, "\x1b");
  write(h, "\x1b[A"); // 转义序列不能误触发
  await flush();
  assert.equal(interrupted, 1);
  off();
  h.restore();
});

test("普通输入镜像不干扰：hello + Enter 原样提交", async () => {
  const h = makeProxy({ "/inline": "inline" });
  write(h, "hello");
  write(h, "\r");
  await flush();
  assert.deepEqual(h.out, ["hello", "\r"]);
  h.restore();
});

test("/inline + Enter 触发切换：注入 Ctrl+C、不提交命令", async () => {
  const h = makeProxy({ "/inline": "inline" });
  write(h, "/inline");
  await flush();
  write(h, "\r");
  await flush();
  assert.ok(h.out.join("").includes("\x03"), "应注入 Ctrl+C");
  assert.ok(!h.out.includes("\r"), "Enter 不应透传");
  h.restore();
});

test("命令镜像支持退格修正", async () => {
  const h = makeProxy({ "/inline": "inline" });
  write(h, "/inlinx");
  write(h, "\x7f"); // 删掉 x
  write(h, "e");
  write(h, "\r");
  await flush();
  assert.ok(h.out.join("").includes("\x03"));
  h.restore();
});

test("非命令斜杠输入照常提交", async () => {
  const h = makeProxy({ "/inline": "inline" });
  write(h, "/foo");
  write(h, "\r");
  await flush();
  assert.deepEqual(h.out, ["/foo", "\r"]);
  h.restore();
});

test("切换后残余输入被丢弃", async () => {
  const h = makeProxy({ "/inline": "inline" });
  write(h, "/inline");
  write(h, "\r");
  await flush();
  const before = h.out.length;
  write(h, "residual");
  await flush();
  assert.equal(h.out.length, before);
  h.restore();
});

test("emitSoftInterrupt 无监听时不抛错（回归：软打断信号在流外发出）", () => {
  assert.doesNotThrow(() => emitSoftInterrupt());
});
