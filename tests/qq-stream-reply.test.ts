/**
 * QQ 流式回复（官方 stream_messages 能力）测试
 *
 * 钉住粘合层的行为契约：
 * - QqStreamReply：初帧立即发；任何帧失败 → broken + onBreak 回调（桥重启
 *   心跳）+ finish 退回 false（桥改走 sendText 分段）
 * - createStreamFeed：text 增量累积成正文、tool start/end 切状态行，
 *   与网页 translateStream 的 send 回调直接对接
 * - renderStreamFrame / toolStatusLabel / mediaKindOf 的组装规则
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { QQBot, StreamSession } from "@tencent-connect/qqbot-nodejs";

import { mediaKindOf } from "../local/qq/format";
import {
  createStreamFeed,
  QqStreamReply,
  renderStreamFrame,
  STREAM_ACK_TEXT,
  toolStatusLabel,
} from "../local/qq/stream-reply";

/** 假 StreamSession：记录每次 update 的全量文本，可注入失败 */
class FakeSession {
  texts: string[] = [];
  completed = false;
  cancelled = false;
  failUpdates = false;
  failComplete = false;
  async update(text: string): Promise<void> {
    if (this.failUpdates) throw new Error("stream dead");
    this.texts.push(text);
  }
  async complete(): Promise<undefined> {
    if (this.failComplete) throw new Error("complete dead");
    this.completed = true;
    return undefined;
  }
  cancel(): void {
    this.cancelled = true;
  }
}

const noopLogger = console;

function fakeBot(session: FakeSession, failOpen = false): QQBot {
  return {
    openStream: () => {
      if (failOpen) throw new Error("no stream permission");
      return session as unknown as StreamSession;
    },
  } as unknown as QQBot;
}

test("流式打开成功：初帧立即发送，alive 为真", async () => {
  const session = new FakeSession();
  const reply = await QqStreamReply.open(fakeBot(session), {} as never, noopLogger);
  assert.ok(reply, "打开应成功");
  assert.equal(reply.alive, true);
  assert.deepEqual(session.texts, [STREAM_ACK_TEXT], "初帧就是应答文案，收到当下即可见");
});

test("openStream 抛错时返回 null（桥退回旧通路），绝不向上抛", async () => {
  const reply = await QqStreamReply.open(fakeBot(new FakeSession(), true), {} as never, noopLogger);
  assert.equal(reply, null);
});

test("push 追加全量帧；finish 发终帧并 complete", async () => {
  const session = new FakeSession();
  const reply = await QqStreamReply.open(fakeBot(session), {} as never, noopLogger);
  reply?.push("第一段");
  reply?.push("第一段第二段");
  const done = await reply?.finish("最终回复");
  assert.equal(done, true);
  assert.deepEqual(session.texts, [STREAM_ACK_TEXT, "第一段", "第一段第二段", "最终回复"]);
  assert.equal(session.completed, true, "终帧后必须 complete（DONE 定格消息）");
});

test("push 的帧失败：标记 broken、回调 onBreak、cancel 会话，后续 push 不再发", async () => {
  const session = new FakeSession();
  let broke = 0;
  const reply = await QqStreamReply.open(fakeBot(session), {} as never, noopLogger, () => {
    broke++;
  });
  session.failUpdates = true;
  reply?.push("这帧会失败");
  await new Promise((r) => setImmediate(r)); // 等 fire-and-forget 的 catch 跑完
  assert.equal(broke, 1, "帧失败必须回调桥（重启心跳提示）");
  assert.equal(session.cancelled, true);
  assert.equal(reply?.alive, false);
  session.failUpdates = false;
  reply?.push("broken 后不再发送");
  assert.equal(session.texts.length, 1, "只有初帧，后续帧全部拦截");
  const done = await reply?.finish("收尾");
  assert.equal(done, false, "broken 后 finish 退回 false，桥改走 sendText 分段");
});

test("finish 时终帧/complete 抛错：返回 false 并回调 onBreak", async () => {
  const session = new FakeSession();
  session.failComplete = true;
  let broke = 0;
  const reply = await QqStreamReply.open(fakeBot(session), {} as never, noopLogger, () => {
    broke++;
  });
  const done = await reply?.finish("最终回复");
  assert.equal(done, false);
  assert.equal(broke, 1);
});

test("renderStreamFrame：状态行与正文的组装规则", () => {
  assert.equal(renderStreamFrame("正文", null), "正文");
  assert.equal(renderStreamFrame("", "正在查课表"), "⏳ 正在查课表…");
  assert.equal(renderStreamFrame("已有正文", "正在查课表"), "⏳ 正在查课表…\n\n已有正文");
});

test("toolStatusLabel：高频工具有中文动作，未收录退回通用文案", () => {
  assert.equal(toolStatusLabel("get_schedule"), "正在查课表");
  assert.equal(toolStatusLabel("generate_document"), "正在生成文档");
  assert.match(toolStatusLabel("mystery_tool"), /^正在处理（mystery_tool）$/);
  assert.equal(toolStatusLabel(undefined), "正在处理");
});

test("createStreamFeed：text 增量累积，tool start/end 切状态行（网页 send 形态对接）", () => {
  const frames: string[] = [];
  const feed = createStreamFeed({ push: (t) => frames.push(t) });
  feed.send({ t: "tool", phase: "start", name: "get_schedule" });
  feed.send({ t: "text", v: "明天 " });
  feed.send({ t: "text", v: "8 点有课" });
  feed.send({ t: "tool", phase: "end", name: "get_schedule" });
  feed.send({ t: "think", v: "思考内容不进正文" });
  assert.deepEqual(frames, [
    "⏳ 正在查课表…",
    "⏳ 正在查课表…\n\n明天 ",
    "⏳ 正在查课表…\n\n明天 8 点有课",
    "明天 8 点有课",
  ]);
  assert.equal(feed.rawText(), "明天 8 点有课", "思考过程绝不混进正文");
});

test("createStreamFeed：reply 为 null 时只累积不发（群聊复用同一事件循环）", () => {
  const feed = createStreamFeed(null);
  feed.send({ t: "tool", phase: "start", name: "get_grades" });
  feed.send({ t: "text", v: "绩点 3.8" });
  assert.equal(feed.rawText(), "绩点 3.8");
});

test("mediaKindOf：按扩展名选回传通道（图片/视频媒体消息，其余文件消息）", () => {
  assert.equal(mediaKindOf("课表.png"), "image");
  assert.equal(mediaKindOf("照片.JPG"), "image", "扩展名大小写不敏感");
  assert.equal(mediaKindOf("demo.mp4"), "video");
  assert.equal(mediaKindOf("报告.docx"), "file");
  assert.equal(mediaKindOf("成绩单.xlsx"), "file");
  assert.equal(mediaKindOf("无扩展名"), "file");
  assert.equal(mediaKindOf("archive.tar.gz"), "file");
});
