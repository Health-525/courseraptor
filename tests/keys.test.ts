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
import type { SlashCommandSpec } from "../src/tui/keys";
import {
  coalesceText,
  commandsForMode,
  SLASH_COMMANDS,
  splitKeys,
} from "../src/tui/slash-menu";

const { createKeyProxy } = await import("../src/tui/keys");

interface Harness {
  stdin: PassThrough;
  out: string[];
  readonly switchRequest: string | null;
  restore(): void;
}

// keys.ts 创建代理时会给 stdout 写鼠标启用序列，仅在创建瞬间屏蔽，
// 避免污染测试输出（不能全局替换 stdout.write——node:test 报告也走它）
function makeProxy(
  commands?: Record<string, SlashCommandSpec>,
): Harness {
  const stdin = new PassThrough();
  const out: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = () => true;
  // 菜单状态挂在全局（补丁从这里取帧行），测试间必须隔离
  globalThis.__raptorSlashMenu = undefined;
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
    get switchRequest() {
      return proxy.switchRequest;
    },
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

/**
 * 读当前菜单帧行。makeProxy 里给全局赋了 undefined，流分析会把后续读取窄化
 * 成 never，所以统一走这个带断言的入口。
 */
const menuLines = (): string[] | undefined =>
  globalThis.__raptorSlashMenu as string[] | undefined;

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
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(h, "hello");
  write(h, "\r");
  await flush();
  assert.deepEqual(h.out, ["hello", "\r"]);
  h.restore();
});

test("/inline + Enter 触发切换：注入 Ctrl+C、不提交命令", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(h, "/inline");
  await flush();
  write(h, "\r");
  await flush();
  assert.ok(h.out.join("").includes("\x03"), "应注入 Ctrl+C");
  assert.ok(!h.out.includes("\r"), "Enter 不应透传");
  h.restore();
});

test("命令镜像支持退格修正", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(h, "/inlinx");
  write(h, "\x7f"); // 删掉 x
  write(h, "e");
  write(h, "\r");
  await flush();
  assert.ok(h.out.join("").includes("\x03"));
  h.restore();
});

test("非命令斜杠输入照常提交", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(h, "/foo");
  write(h, "\r");
  await flush();
  assert.deepEqual(h.out, ["/foo", "\r"]);
  h.restore();
});

test("切换后残余输入被丢弃", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
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

// ── 斜杠命令候选菜单 ─────────────────────────────────────────

test("菜单：输入 / 前缀后 ↑/↓ 被选择语义接管，不透传", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(h, "/in");
  await flush();
  const before = h.out.length;
  write(h, "\x1b[A");
  write(h, "\x1b[B");
  await flush();
  assert.equal(h.out.length, before, "方向键不应透传给库");
  h.restore();
});

test("菜单：Tab 补全选中命令的剩余字符", async () => {
  const h = makeProxy({ "/key": { desc: "配置 Key", handler: () => {} } });
  write(h, "/");
  await flush();
  write(h, "\t");
  await flush();
  assert.equal(h.out.join(""), "/key");
  h.restore();
});

test("菜单：回车 = 补全选中命令后分发，不透传回车", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(h, "/inl");
  await flush();
  write(h, "\r");
  await flush();
  const all = h.out.join("");
  assert.ok(all.includes("ine"), "应补全剩余字符 ine");
  assert.ok(all.includes("\x03"), "应注入 Ctrl+C 走切换");
  assert.ok(!h.out.includes("\r"), "Enter 不应透传");
  h.restore();
});

test("菜单：ESC 收起菜单，方向键恢复滚动放大语义", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(h, "/");
  await flush();
  write(h, "\x1b");
  await flush();
  write(h, "\x1b[A");
  await flush();
  assert.deepEqual(
    h.out.slice(1),
    ["\x1b[A", "\x1b[A", "\x1b[A"],
    "ESC 后 ↑ 恢复 3 行放大透传",
  );
  h.restore();
});

test("菜单：非命令前缀不弹菜单，照常透传提交", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(h, "/foo");
  write(h, "\r");
  await flush();
  assert.deepEqual(h.out, ["/foo", "\r"]);
  h.restore();
});

// ── 多按键 chunk ──────────────────────────────────────────────
// 终端不保证一次 data 事件只给一个按键。整块喂给按单按键写的判断会误判：
// 连按退格拿到的 "\x7f\x7f\x7f" 既不等于 "\x7f"、又满足 `text >= " "`，
// 会被当成普通文本拼进命令镜像，镜像一脏过滤就永远匹配不上——菜单直接假死。

test("splitKeys：转义序列整体成键，孤立 ESC 单独成键", () => {
  assert.deepEqual(splitKeys("\x1b[A\x1b[B"), ["\x1b[A", "\x1b[B"]);
  assert.deepEqual(splitKeys("\x1b"), ["\x1b"]);
  // 连按 ESC / ESC 紧跟方向键：不能让前一个 ESC 吃掉 "["，否则剩下的
  // "[A" 会被当成普通文本拼进输入行
  assert.deepEqual(splitKeys("\x1b\x1b[A"), ["\x1b", "\x1b[A"]);
  assert.deepEqual(splitKeys("a\x7f\x7f"), ["a", "\x7f", "\x7f"]);
  assert.deepEqual(splitKeys("中文"), ["中", "文"]);
});

test("coalesceText：只合并连续可打印字符，控制键单独成块", () => {
  assert.deepEqual(coalesceText(["h", "i", "\r"]), ["hi", "\r"]);
  assert.deepEqual(coalesceText(["h", "\x7f", "i"]), ["h", "\x7f", "i"]);
  assert.deepEqual(coalesceText(["\x1b[A", "\x1b[B"]), ["\x1b[A", "\x1b[B"]);
});

test("连按退格挤在同一 chunk：镜像逐键回退，菜单能重新弹出", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(h, "/inline");
  await flush();
  write(h, "\x7f".repeat(7)); // 一次 data 事件里塞 7 个退格
  await flush();
  assert.equal(menuLines(), undefined, "删空后菜单应隐藏");
  write(h, "/");
  await flush();
  assert.ok(menuLines()?.length, "重新输入 / 菜单必须能再弹出");
  h.restore();
});

test("粘贴长文本合并成一块透传（逐字符写会让库逐字重绘）", async () => {
  const h = makeProxy();
  write(h, "x".repeat(80));
  await flush();
  assert.equal(h.out.length, 1, "应合并为一次写入");
  assert.equal(h.out[0]?.length, 80);
  h.restore();
});

test("ESC 紧跟方向键（同一 chunk）不被误切成文本", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  let interrupts = 0;
  const off = onSoftInterrupt(() => interrupts++);
  write(h, "\x1b\x1b[A");
  await flush();
  assert.equal(interrupts, 1, "ESC 应被识别为软打断");
  assert.deepEqual(h.out, ["\x1b[A", "\x1b[A", "\x1b[A"], "↑ 应恢复 3 行放大");
  off();
  h.restore();
});

// ── ESC 语义 ──────────────────────────────────────────────────
// 菜单打开时 ESC 只收菜单（用户想关的是菜单，不是中止回复）；收起后本行内
// 不再自动弹出，否则每敲一个键菜单又糊上来，等于关不掉。

test("ESC：菜单打开时只收菜单、不发软打断，且本行内不复弹", async () => {
  const h = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  let interrupts = 0;
  const off = onSoftInterrupt(() => interrupts++);
  write(h, "/");
  await flush();
  assert.ok(menuLines()?.length, "输入 / 应弹出菜单");
  write(h, "\x1b");
  await flush();
  assert.equal(menuLines(), undefined, "菜单应收起");
  assert.equal(interrupts, 0, "收菜单不应触发软打断");
  write(h, "i"); // 继续打字
  await flush();
  assert.equal(menuLines(), undefined, "ESC 后本行内不应再弹");
  write(h, "\x7f\x7f"); // 删空 = 新的一行
  await flush();
  write(h, "/");
  await flush();
  assert.ok(menuLines()?.length, "删空后新行应能重新唤出菜单");
  write(h, "\x1b"); // 再收起
  await flush();
  write(h, "\x1b"); // 菜单已关 → 走到软打断
  await flush();
  assert.equal(interrupts, 1, "菜单关闭后 ESC 才是软打断");
  off();
  h.restore();
});

// ── 滚轮：菜单内选命令，菜单外滚正文 ──────────────────────────

test("滚轮：菜单打开时一格一项（不透传），关闭时一格 3 行", async () => {
  const closed = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(closed, "\x1b[<65;10;5M");
  await flush();
  assert.equal(closed.out.length, 3, "菜单关闭：一格放大成 3 行");
  closed.restore();

  const opened = makeProxy({ "/inline": { desc: "切换到行内模式", switchTo: "inline" } });
  write(opened, "/");
  await flush();
  const before = opened.out.length;
  write(opened, "\x1b[<65;10;5M");
  await flush();
  assert.equal(opened.out.length, before, "菜单打开：滚轮被选择语义消费，不滚动正文");
  opened.restore();
});

test("命令文案单一来源：菜单候选的 desc 全部取自 SLASH_COMMANDS", () => {
  for (const mode of ["card", "inline"] as const) {
    for (const c of commandsForMode(mode)) {
      assert.equal(
        c.desc,
        SLASH_COMMANDS[c.name].desc,
        `${c.name} 的 desc 应来自 SLASH_COMMANDS，不能各自硬编码一份`,
      );
    }
  }
});


test("共享 /key 命令不要求在普通输入框填写参数", () => {
  const command = commandsForMode("card").find((item) => item.name === "/key");
  assert.ok(command, "/key 必须出现在卡片模式菜单");
  assert.equal(command.requiresArgument, undefined);
});


test("/key 携带旧式可见参数时本地拒绝，不切换也不透传回车", async () => {
  let rejected = 0;
  const h = makeProxy({
    "/key": {
      desc: "配置 Key",
      switchTo: "key-setup",
      // 当前版本尚未实现该命令约束；此测试先固定期望行为。
      rejectsArgument: true,
      onArgumentRejected: () => rejected++,
    } as unknown as SlashCommandSpec,
  });
  write(h, "/key sk-OldKey1234567890ABCDE\r");
  await flush();

  assert.equal(rejected, 1, "带参数的旧写法应被本地拒绝");
  assert.equal(h.switchRequest, null, "拒绝时不能请求进入设置流程");
  assert.ok(!h.out.includes("\r"), "回车不得透传给 Agent");
  h.restore();
});


test("/Key 大小写变体同样请求本地设置，不透传给 Agent", async () => {
  const h = makeProxy({
    "/key": { desc: "管理 API Key", switchTo: "setup-key" },
  });
  write(h, "/Key\r");
  await flush();

  assert.equal(h.switchRequest, "setup-key");
  assert.ok(!h.out.includes("\r"), "回车不得透传给 Agent");
  h.restore();
});
