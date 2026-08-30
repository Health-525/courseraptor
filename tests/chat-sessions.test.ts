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
