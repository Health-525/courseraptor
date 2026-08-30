/**
 * 多会话存储模块测试
 *
 * 钉住：建档时机（首条消息才建档）、标题自动提取、ModelMessage 上下文
 * 形状、显示存档/上下文窗口两级截断、删除与清空。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 与真实数据目录隔离
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-sessions-"));

const S = await import("../src/chat-sessions");

test("appendRound 自动建档：标题取首问，列表按最近活跃返回", () => {
  S.appendRound("aaaa1111", "第一个问题", "回答一");
  S.appendRound("bbbb2222", "另一个会话的问题", "回答二");
  const list = S.listSessions();
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((x) => x.title).sort(),
    ["另一个会话的问题", "第一个问题"],
  );
  const s = S.getSession("aaaa1111");
  assert.ok(s);
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[0].role, "user");
  assert.equal(s.messages[1].role, "assistant");
  assert.equal(s.messages[1].text, "回答一");
});

test("空回答只存提问；空白回答不落库", () => {
  S.appendRound("cccc3333", "只有问题没有回答", null);
  const s = S.getSession("cccc3333");
  assert.ok(s);
  assert.equal(s.messages.length, 1);
});

test("思考挂在本轮 assistant 消息上：不单独成条，没正文时也不入库", () => {
  S.appendRound("eeee5555", "带思考的一问", "回答", "先查课表再对比周次");
  const s = S.getSession("eeee5555");
  assert.ok(s);
  assert.equal(s.messages.length, 2, "思考不额外占一条消息");
  assert.equal(s.messages[1].role, "assistant");
  assert.equal(s.messages[1].text, "回答");
  assert.equal(s.messages[1].think, "先查课表再对比周次");

  // 半截轮次（无正文）：照旧只存提问，思考不能把空轮次带进历史
  S.appendRound("ffff6666", "没答上来的一问", null, "想了一堆但没输出");
  const s2 = S.getSession("ffff6666");
  assert.ok(s2);
  assert.equal(s2.messages.length, 1);
  assert.ok(!JSON.stringify(s2).includes("想了一堆"), "无正文的思考不落盘");

  // 超长思考截断，别把档案文件撑肥
  S.appendRound("gggg7777", "长思考", "答", "思".repeat(S.MAX_THINK_CHARS + 500));
  const long = S.getSession("gggg7777")?.messages[1].think ?? "";
  assert.ok(long.length < S.MAX_THINK_CHARS + 30, "应截到上限附近");
  assert.match(long, /已截断）$/);
});

test("思考绝不回流进模型上下文：contextMessages 只读 text", () => {
  const dump = JSON.stringify(S.contextMessages("eeee5555"));
  assert.ok(dump.includes("回答"), "正文仍在上下文里");
  assert.ok(!dump.includes("先查课表再对比周次"), "思考不该喂回模型");
});

test("contextMessages 输出 ModelMessage 形状（user 纯串 / assistant 块数组）", () => {
  const ctx = S.contextMessages("aaaa1111");
  assert.equal(ctx.length, 2);
  assert.equal(ctx[0].role, "user");
  const asst = ctx[1] as { role: string; content: unknown };
  assert.ok(Array.isArray(asst.content));
  assert.equal((asst.content as { type: string }[])[0].type, "text");
});

test("长会话两级截断：显示存档 ≤ MAX_STORED_MSGS，上下文只取最后窗口", () => {
  for (let i = 0; i < 130; i++) S.appendRound("dddd4444", "问题" + i, "回答" + i);
  const s = S.getSession("dddd4444");
  assert.ok(s);
  assert.ok(s.messages.length <= S.MAX_STORED_MSGS, "显示存档要封顶");
  assert.equal(s.messages.at(-1)?.text, "回答129", "最新内容必须在");
  assert.equal(S.contextMessages("dddd4444").length, S.CONTEXT_WINDOW);
});

test("删除与清空", () => {
  assert.equal(S.deleteSession("bbbb2222"), true);
  assert.equal(S.deleteSession("bbbb2222"), false, "二次删除应报不存在");
  assert.ok(!S.getSession("bbbb2222"));
  S.resetAll();
  assert.equal(S.listSessions().length, 0);
});
