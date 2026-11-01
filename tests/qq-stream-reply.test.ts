/**
 * QQ 流式回复（官方 stream_messages 能力）测试
 *
 * 钉住粘合层的行为契约（平台对已下发内容锁前缀，帧序必须单调追加）：
 * - QqStreamReply：初帧=应答头立即发；push 只接受以已推送内容为前缀的帧
 *   （回改即主动断流）；finish() 以最后已推送内容定稿、不注入新文本；
 *   fail() 追加提示后定稿；任何帧失败 → broken + onBreak 回调（桥重启
 *   心跳）+ finish 退回 false（桥改走 sendText 分段）
 * - createStreamFeed：text 增量追加在头部之后；首个工具在头部写一行状态行
 *   并冻结（后续工具/结束事件不再改帧）——每一帧都以首帧内容为前缀，
 *   与网页 translateStream 的 send 回调直接对接
 * - toolStatusLabel / mediaKindOf 的组装规则
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { QQBot, StreamSession } from "@tencent-connect/qqbot-nodejs";

import { mediaKindOf } from "../local/qq/format";
import {
  createStreamFeed,
  QqStreamReply,
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

test("流式打开成功：初帧立即发送应答头，alive 为真", async () => {
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

test("push 只接受追加帧；finish() 以最后已推送内容定稿，不注入新文本", async () => {
  const session = new FakeSession();
  const reply = await QqStreamReply.open(fakeBot(session), {} as never, noopLogger);
  const body1 = `${STREAM_ACK_TEXT}\n\n第一段`;
  const body2 = `${body1}第二段`;
  reply?.push(body1);
  reply?.push(body2);
  const done = await reply?.finish();
  assert.equal(done, true);
  assert.deepEqual(session.texts, [STREAM_ACK_TEXT, body1, body2], "finish 不追加终帧文本");
  assert.equal(session.completed, true, "finish 后必须 complete（DONE 定格消息）");
});

test("push 回改已推送前缀：主动断流（不发注定被平台拒的帧）", async () => {
  const session = new FakeSession();
  let broke = 0;
  const reply = await QqStreamReply.open(fakeBot(session), {} as never, noopLogger, () => {
    broke++;
  });
  reply?.push("改头换面的帧"); // 不以应答头为前缀
  assert.equal(broke, 1, "回改帧必须在本地拦下并断流");
  assert.equal(session.cancelled, true);
  assert.equal(session.texts.length, 1, "只有初帧，改写帧绝不发出去");
  const done = await reply?.finish();
  assert.equal(done, false, "断流后 finish 退回 false，桥改走 sendText 分段");
});

test("push 的帧失败：标记 broken、回调 onBreak、cancel 会话，后续 push 不再发", async () => {
  const session = new FakeSession();
  let broke = 0;
  const reply = await QqStreamReply.open(fakeBot(session), {} as never, noopLogger, () => {
    broke++;
  });
  session.failUpdates = true;
  reply?.push(`${STREAM_ACK_TEXT}\n\n这帧会失败`);
  await new Promise((r) => setImmediate(r)); // 等 fire-and-forget 的 catch 跑完
  assert.equal(broke, 1, "帧失败必须回调桥（重启心跳提示）");
  assert.equal(session.cancelled, true);
  assert.equal(reply?.alive, false);
  session.failUpdates = false;
  reply?.push(`${STREAM_ACK_TEXT}\n\nbroken 后不再发送`);
  assert.equal(session.texts.length, 1, "只有初帧，后续帧全部拦截");
  const done = await reply?.finish();
  assert.equal(done, false, "broken 后 finish 退回 false，桥改走 sendText 分段");
});

test("finish 时 complete 抛错：返回 false 并回调 onBreak", async () => {
  const session = new FakeSession();
  session.failComplete = true;
  let broke = 0;
  const reply = await QqStreamReply.open(fakeBot(session), {} as never, noopLogger, () => {
    broke++;
  });
  const done = await reply?.finish();
  assert.equal(done, false);
  assert.equal(broke, 1);
});

test("fail(notice)：在已推送内容之后追加提示再定稿（不回改前文）", async () => {
  const session = new FakeSession();
  const reply = await QqStreamReply.open(fakeBot(session), {} as never, noopLogger);
  const body = `${STREAM_ACK_TEXT}\n\n半截正文`;
  reply?.push(body);
  const done = await reply?.fail("❌ 出错了");
  assert.equal(done, true);
  assert.deepEqual(session.texts, [STREAM_ACK_TEXT, body, `${body}\n\n❌ 出错了`]);
  assert.equal(session.completed, true);
});

test("toolStatusLabel：高频工具有中文动作，未收录退回通用文案", () => {
  assert.equal(toolStatusLabel("get_schedule"), "正在查课表");
  assert.equal(toolStatusLabel("generate_document"), "正在生成文档");
  assert.match(toolStatusLabel("mystery_tool"), /^正在处理（mystery_tool）$/);
  assert.equal(toolStatusLabel(undefined), "正在处理");
});

test("createStreamFeed：帧序单调追加——首帧之后每帧都以它为前缀（平台锁前缀契约）", () => {
  const frames: string[] = [];
  const feed = createStreamFeed({ push: (t) => frames.push(t) });
  feed.send({ t: "tool", phase: "start", name: "get_schedule" });
  feed.send({ t: "text", v: "明天 " });
  feed.send({ t: "text", v: "8 点有课" });
  feed.send({ t: "tool", phase: "end", name: "get_schedule" });
  feed.send({ t: "tool", phase: "start", name: "read_notice" });
  feed.send({ t: "text", v: "，注意" });
  feed.send({ t: "think", v: "思考内容不进正文" });
  assert.deepEqual(frames, [
    `${STREAM_ACK_TEXT}\n⏳ 正在查课表…`,
    `${STREAM_ACK_TEXT}\n⏳ 正在查课表…\n\n明天 `,
    `${STREAM_ACK_TEXT}\n⏳ 正在查课表…\n\n明天 8 点有课`,
    `${STREAM_ACK_TEXT}\n⏳ 正在查课表…\n\n明天 8 点有课，注意`,
  ]);
  const first = frames[0];
  assert.ok(
    first !== undefined && frames.every((f) => f.startsWith(first)),
    "每一帧都必须以首帧（应答头）为前缀（append-only 契约）",
  );
  assert.equal(feed.rawText(), "明天 8 点有课，注意", "思考过程绝不混进正文");
});

test("createStreamFeed：无工具时首帧即正文，应答头保留为固定头部", () => {
  const frames: string[] = [];
  const feed = createStreamFeed({ push: (t) => frames.push(t) });
  feed.send({ t: "text", v: "在的" });
  feed.send({ t: "text", v: "，有什么事" });
  assert.deepEqual(frames, [`${STREAM_ACK_TEXT}\n\n在的`, `${STREAM_ACK_TEXT}\n\n在的，有什么事`]);
});

test("createStreamFeed：正文开始后工具不再写状态行（避免回改前缀）", () => {
  const frames: string[] = [];
  const feed = createStreamFeed({ push: (t) => frames.push(t) });
  feed.send({ t: "text", v: "先说结论" });
  feed.send({ t: "tool", phase: "start", name: "get_grades" });
  feed.send({ t: "text", v: "，再查" });
  assert.deepEqual(
    frames,
    [`${STREAM_ACK_TEXT}\n\n先说结论`, `${STREAM_ACK_TEXT}\n\n先说结论，再查`],
    "正文已开始：工具 start 不产生状态行帧",
  );
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
