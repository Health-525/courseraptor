/**
 * 行内模式斜杠菜单集成测试。
 *
 * 行内渲染器（src/tui/inline.ts）的菜单逻辑无法单独导出——它和 readline、
 * process.stdin 粘在一起。这里用替身驱动整条链路：PassThrough 顶替 stdin、
 * 内存流接收渲染输出（runInlineTUI 的 output 选项，不劫持全局 stdout，否则
 * test runner 自己的报告会被一起吞掉）、假 agent 提供空流，验证「输入 / 弹
 * 菜单、↑↓ 换选中项」在真实 readline 环境下确实成立。
 *
 * 重点覆盖的回归：菜单打开时连按 ↑↓ 会挤进同一个 data 事件，整块透传给
 * readline 会被当成历史翻阅、把上一轮内容翻进输入行；必须先切分再处理。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runInlineTUI, type TUIStreamableAgent } from "../src/tui/inline";

/** 不产生任何流事件的假 agent：本测试只关心输入行与菜单的交互 */
const nullAgent: TUIStreamableAgent = {
  stream: async () => ({ fullStream: (async function* () {})() }),
};

interface Rig {
  /** 发一段按键，等渲染稳定后返回这一帧新增的输出 */
  press(keys: string): Promise<string>;
}

async function withInline(fn: (rig: Rig) => Promise<void>): Promise<void> {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, "isTTY", { value: true });
  Object.defineProperty(stdin, "setRawMode", { value: () => {} });

  // 渲染输出目标：readline 会读它的 columns / isTTY，按终端规格伪造
  const output = new PassThrough() as PassThrough & { columns?: number };
  Object.defineProperty(output, "isTTY", { value: true });
  output.columns = 80;
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

  let done: Promise<unknown> | undefined;
  const rig: Rig = {
    press: async (keys) => {
      const mark = chunks.length;
      stdin.write(keys);
      // PassThrough 的 data 是异步 emit 的，用真实定时器等一轮 I/O：
      // 只 setImmediate 不够稳，偶尔会拿到半个帧导致假失败
      await new Promise((r) => setTimeout(r, 10));
      return chunks.slice(mark).join("");
    },
  };

  /**
   * 收工：Ctrl+D 只在输入行为空时才关闭 readline（非空时它是 delete
   * char-right），所以先退格清行再发。正常结束与异常路径都走这里。
   */
  let quitting = false;
  const quit = async (): Promise<void> => {
    if (quitting || !done) return;
    quitting = true;
    stdin.write("\x7f".repeat(64));
    stdin.write("\x04");
    await done;
  };

  try {
    // stdin / stdout 都走注入，不碰任何全局：node --test 会并发跑多个测试
    // 文件，抢 process.stdin 的话用例会互相干扰、随机失败
    done = runInlineTUI({
      title: "test",
      agent: nullAgent,
      output: output as never,
      input: stdin as never,
    });
    // 等第一帧（标题 + 提示符）画完
    await new Promise((r) => setTimeout(r, 10));
    await fn(rig);
  } finally {
    await quit();
  }
}

/** 菜单框首行固定是这个开头，用它判断菜单是否画在屏上 */
const MENU_TOP = "┌ 命令";

/** 取这一帧里处于选中态（反显）的菜单行 */
const selectedRows = (frame: string): string[] =>
  frame.split("\r\n").filter((l) => l.includes("\x1b[7m"));

// 每个用例都要顶替 process.stdin，必须串行跑：并发会让它们抢同一个替身
describe("行内模式斜杠菜单", { concurrency: 1 }, () => {
  test("输入 / 在提示符下方画出候选菜单", async () => {
    await withInline(async (rig) => {
      const frame = await rig.press("/");
      assert.ok(frame.includes(MENU_TOP), "应画出菜单框");
      for (const name of ["/card", "/key", "/update", "/exit"]) {
        assert.ok(frame.includes(name), `菜单应含 ${name}`);
      }
    });
  });

  test("↓ 换选中项：菜单重绘且高亮下移", async () => {
    await withInline(async (rig) => {
      await rig.press("/");
      const frame = await rig.press("\x1b[B");
      assert.ok(frame.includes(MENU_TOP), "换选中项应触发菜单重绘");
      const rows = selectedRows(frame);
      assert.equal(rows.length, 1, "有且只有一项处于选中态");
      assert.ok(rows[0].includes("/key"), "↓ 后应选中第二项 /key");
    });
  });

  test("继续输入按前缀过滤", async () => {
    await withInline(async (rig) => {
      await rig.press("/");
      const frame = await rig.press("k");
      assert.ok(frame.includes(MENU_TOP));
      assert.ok(frame.includes("/key"), "应只剩 /key");
      assert.ok(!frame.includes("/card"), "/card 应被过滤掉");
    });
  });

  test("菜单打开时连按 ↑↓ 不被 readline 当成历史翻阅", async () => {
    await withInline(async (rig) => {
      await rig.press("/");
      // 同一个 data 事件里塞两个方向键：整块透传的话 readline 会去翻历史，
      // 菜单卡在原地不动，输入行还会被倒进上一轮的内容
      const frame = await rig.press("\x1b[B\x1b[B");
      assert.ok(frame.includes(MENU_TOP), "菜单应重绘");
      // 按两次 = 重绘两次，这一帧里会有两份菜单；看最后一份的选中项
      const rows = selectedRows(frame);
      assert.equal(rows.length, 2, "每按一次 ↓ 都应重绘一次");
      assert.ok(rows[rows.length - 1].includes("/update"), "两次 ↓ 后应选中第三项 /update");
    });
  });

  test("ESC 收起菜单，且本行内不再自动弹出", async () => {
    await withInline(async (rig) => {
      await rig.press("/");
      await rig.press("\x1b"); // 收起
      const afterTyping = await rig.press("k");
      assert.ok(!afterTyping.includes(MENU_TOP), "ESC 后继续打字不应再弹菜单");
      // 删空后是新的一行，菜单应能重新唤出
      await rig.press("\x7f\x7f");
      const again = await rig.press("/");
      assert.ok(again.includes(MENU_TOP), "删空后重新输入 / 应能再次唤出菜单");
    });
  });
});
