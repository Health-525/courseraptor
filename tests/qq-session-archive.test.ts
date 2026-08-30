/**
 * QQ 对话进网页历史档案的测试
 *
 * 钉住三件事：
 * 1. 归档粒度——私聊按人分档、群聊按群分档，同一目标每轮都落进同一个档案
 * 2. 档案 id 必须落在网页侧栏的 id 白名单里（否则写进去了也点不开）
 * 3. 端到端可见——QQ 一轮问答写进 chat-sessions 后，/api/sessions 列表与
 *    /api/sessions/:id 详情都能读到，且不会串进网页自己的会话上下文
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 与真实数据目录隔离（必须在 import chat-sessions 之前设好）
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-qq-arch-"));

const S = await import("../src/chat-sessions");
const { qqArchiveSlot } = await import("../src/qq/session-archive");

/** 与 src/web/chat-web.ts 的 SESSION_ID_RE 同规则：侧栏点得开的硬约束 */
const SESSION_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

const c2c = (id: string, content = "这周有什么课", name?: string) => ({
  kind: "c2c",
  senderId: id,
  senderName: name,
  content,
});

test("私聊按人分档：同一 openid 每轮同一档案，不同 openid 互不串档", () => {
  const a1 = qqArchiveSlot(c2c("B5F3AA", "这周有什么课"));
  const a2 = qqArchiveSlot(c2c("B5F3AA", "下学期开学几天"));
  const b = qqArchiveSlot(c2c("9988FFBB", "我的绩点"));
  assert.ok(a1 && a2 && b);
  assert.equal(a1.id, a2.id, "同一人应落同一档");
  assert.notEqual(a1.id, b.id, "不同人应各自成档");
  assert.equal(a1.titlePrefix, "QQ");
  assert.equal(a1.userText, "这周有什么课", "私聊不加昵称前缀");
});

test("群聊按群分档：同群不同人进同一档案，提问带 [昵称] 才分得清是谁", () => {
  const g1 = qqArchiveSlot({ kind: "group", groupOpenid: "GROUP_X", senderId: "u1", senderName: "张三", content: "课表发下" });
  const g2 = qqArchiveSlot({ kind: "group", groupOpenid: "GROUP_X", senderId: "u2", senderName: "李四", content: "周日有课吗" });
  const other = qqArchiveSlot({ kind: "group", groupOpenid: "GROUP_Y", senderId: "u1", senderName: "张三", content: "课表发下" });
  assert.ok(g1 && g2 && other);
  assert.equal(g1.id, g2.id, "同一个群合成一档");
  assert.notEqual(g1.id, other.id, "不同群分开");
  assert.equal(g1.titlePrefix, "QQ群");
  assert.equal(g1.userText, "[张三] 课表发下");
  assert.equal(g2.userText, "[李四] 周日有课吗");
});

test("昵称压平：换行与方括号不许把 [昵称] 撑成多行或伪标记", () => {
  const slot = qqArchiveSlot({
    kind: "group",
    groupOpenid: "G",
    senderName: "小明\n[管理员]",
    content: "在吗",
  });
  assert.ok(slot);
  assert.equal(slot.userText, "[小明 管理员] 在吗");
  assert.ok(!slot.userText.includes("\n"), "显示文本必须单行");
});

test("档案 id 合规：定长摘要，超长 openid 也不会掉出侧栏白名单", () => {
  const long = qqArchiveSlot(c2c("Q".repeat(200)));
  assert.ok(long);
  assert.match(long.id, SESSION_ID_RE, "必须能被 /api/sessions/:id 取到");
  assert.ok(long.id.startsWith("qq-"), "前缀标记渠道，与网页 uuid 天然不撞");
  assert.ok(long.id.length <= 64);
});

test("kind 缺失按私聊兜底；连发送者都认不出时宁可不归档也不糊进别人档案", () => {
  const fallback = qqArchiveSlot({ senderId: "solo", content: "在吗" });
  assert.ok(fallback);
  assert.equal(fallback.titlePrefix, "QQ");
  assert.equal(qqArchiveSlot({ kind: "c2c", content: "没人知道是谁" }), null);
  assert.equal(qqArchiveSlot({ kind: "group", content: "群 id 和人都没有" }), null);
});

test("QQ 一轮问答进历史：标题带渠道前缀，答失败那轮只留提问", () => {
  const slot = qqArchiveSlot(c2c("C2C_ONE", "这周有什么课"))!;
  S.appendRound(slot.id, slot.userText, "周一到周五各两节", null, {
    titlePrefix: slot.titlePrefix,
  });
  const failed = qqArchiveSlot(c2c("C2C_TWO", "帮我抢体育课"))!;
  S.appendRound(failed.id, failed.userText, null, null, {
    titlePrefix: failed.titlePrefix,
  });

  const meta = S.listSessions();
  const first = meta.find((m) => m.id === slot.id);
  assert.ok(first, "QQ 档应出现在会话列表");
  assert.equal(first.title, "QQ｜这周有什么课");
  assert.equal(first.count, 2);
  const second = meta.find((m) => m.id === failed.id);
  assert.ok(second, "失败那轮也应建档");
  assert.equal(second.title, "QQ｜帮我抢体育课", "没答上来也要有标题");
  assert.equal(second.count, 1, "失败轮只存提问");
});

test("建档标题只认首问：后续轮次不改名，超长首问按 24 字截断", () => {
  const slot = qqArchiveSlot(c2c("C2C_LONG", "问".repeat(40)))!;
  S.appendRound(slot.id, slot.userText, "答一", null, { titlePrefix: slot.titlePrefix });
  S.appendRound(slot.id, "第二问", "答二", null, { titlePrefix: slot.titlePrefix });
  const s = S.getSession(slot.id);
  assert.ok(s);
  assert.equal(s.messages.length, 4);
  assert.equal(s.title, `QQ｜${"问".repeat(24)}…`, "前缀 + 截断到 24 字");
});

test("QQ 档不串网页上下文：default 档读不到 QQ 的内容", () => {
  const slot = qqArchiveSlot(c2c("C2C_ISO", "只在 QQ 说过的一句"))!;
  S.appendRound(slot.id, slot.userText, "秘密回答", null, { titlePrefix: slot.titlePrefix });
  assert.ok(JSON.stringify(S.contextMessages(slot.id)).includes("只在 QQ 说过的一句"));
  assert.ok(!JSON.stringify(S.contextMessages(S.DEFAULT_ID)).includes("只在 QQ 说过的一句"));
});

test("端到端：QQ 写进档案后，网页历史接口列得出来、点得开", async () => {
  const { startChatWeb } = await import("../src/web/chat-web");
  const url = await startChatWeb();
  assert.ok(url, "网页服务应能起来");
  const slot = qqArchiveSlot(c2c("C2C_WEB", "QQ 里问的课表"))!;
  S.appendRound(slot.id, slot.userText, "网页这边能看到这段回答", null, {
    titlePrefix: slot.titlePrefix,
  });

  const list = (await (await fetch(`${url}/api/sessions`)).json()) as {
    sessions: { id: string; title: string; count: number }[];
  };
  const row = list.sessions.find((s) => s.id === slot.id);
  assert.ok(row, "侧栏列表应包含 QQ 档案");
  assert.equal(row.title, "QQ｜QQ 里问的课表");
  assert.equal(row.count, 2);

  const detail = (await (await fetch(`${url}/api/sessions/${slot.id}`)).json()) as {
    messages: { role: string; text: string }[];
  };
  assert.equal(detail.messages[0].role, "user");
  assert.equal(detail.messages[0].text, "QQ 里问的课表");
  assert.equal(detail.messages[1].text, "网页这边能看到这段回答");
});

test("桥的落盘入口 archiveQQRound：写对档案，认不出归属时一条都不加", async () => {
  const { archiveQQRound } = await import("../src/qq/bridge");
  const before = S.listSessions().length;

  archiveQQRound(c2c("C2C_BRIDGE", "体育课上完了吗"), "周四第 3 节", console);
  const session = S.listSessions().find((m) => m.id === qqArchiveSlot(c2c("C2C_BRIDGE"))!.id);
  assert.ok(session, "bridge 写入的一轮应出现在会话列表");
  assert.equal(session.title, "QQ｜体育课上完了吗");
  assert.deepEqual(
    S.getSession(session.id)?.messages.map((m) => m.text),
    ["体育课上完了吗", "周四第 3 节"]
  );

  // 认不出是谁发的：宁可不记，也不能糊进别人的档案
  archiveQQRound({ kind: "c2c", content: "没人认领的一句" }, "回答", console);
  assert.equal(S.listSessions().length, before + 1, "无归属消息不应新增档案");
});
