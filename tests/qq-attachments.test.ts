/**
 * QQ 入站附件消息测试
 *
 * 钉住「发文件没反应」的回归：纯附件消息（正文为空）必须组装出非空问题
 * 交给模型，而不是被当空消息静默丢弃；同时钉住各类附件的文本标记格式。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { composeInboundQuestion, describeAttachments } from "../local/qq/format";

const file = {
  content_type: "file",
  url: "https://qq.example/dl/abc",
  filename: "课件.pptx",
  size: 3_200_000,
};
const image = {
  content_type: "image/png",
  url: "https://qq.example/img/x.png",
  filename: "截图.png",
};
const voice = {
  content_type: "voice",
  url: "https://qq.example/v.silk",
  asr_refer_text: "明天几点上课",
};

test("纯文件消息（正文为空）组装出非空问题，不再静默丢弃", () => {
  const question = composeInboundQuestion("", [file]);
  assert.ok(question.length > 0, "文件消息必须产生非空问题");
  assert.match(question, /\[文件 课件\.pptx · 3\.1 MB：https:\/\/qq\.example\/dl\/abc\]/);
  assert.match(question, /web_fetch/, "应提示模型可用 web_fetch 读链接");
});

test("正文 + 附件：附件标记拼接在正文之后", () => {
  const question = composeInboundQuestion("帮我看看这个文件", [file]);
  assert.ok(question.startsWith("帮我看看这个文件\n"));
  assert.match(question, /\[文件 课件\.pptx/);
});

test("无附件消息保持原正文，行为不变", () => {
  assert.equal(composeInboundQuestion("这周有什么课"), "这周有什么课");
  assert.equal(composeInboundQuestion("  空白正文  "), "空白正文");
});

test("无正文也无附件返回空串（调用方照旧跳过）", () => {
  assert.equal(composeInboundQuestion("   "), "");
  assert.equal(composeInboundQuestion(""), "");
});

test("图片与语音附件的标记格式", () => {
  const described = describeAttachments([image, voice]);
  assert.ok(described.includes("[图片 截图.png：https://qq.example/img/x.png]"));
  assert.ok(described.includes("[语音：明天几点上课]"), "语音优先展示识别文本");
});

test("缺字段附件兜底：无 filename/size 仍给出可用标记", () => {
  const described = describeAttachments([{ content_type: "file", url: "https://qq.example/f" }]);
  assert.equal(described, "[文件：https://qq.example/f]");
});

test("未知类型且无 URL 的附件不可描述，整条消息按无附件处理", () => {
  assert.equal(describeAttachments([{ content_type: "weird" }]), "");
  assert.equal(describeAttachments(undefined), "");
  assert.equal(
    composeInboundQuestion("", [{ content_type: "weird" }]),
    "",
    "无可描述附件且无正文仍跳过",
  );
});

test("大小人性化：字节/KB/MB/GB 边界", () => {
  const pick = (n: number): string =>
    describeAttachments([{ content_type: "file", url: "u", size: n }]);
  assert.match(pick(512), /512 B/);
  assert.match(pick(2048), /2\.0 KB/);
  assert.match(pick(3_200_000), /3\.1 MB/);
  assert.ok(!pick(0).includes("·"), "size=0 不显示大小段");
});

test("已落地附件：展示本机路径与缓存 id，不再展示会失效的 QQ 链接", () => {
  const stored = {
    ...file,
    localPath: "D:\\data\\attachments\\files\\218fae170170.xlsx",
    cacheId: "218fae170170",
  };
  const described = describeAttachments([stored]);
  assert.ok(described.includes("已下载：D:\\data\\attachments\\files\\218fae170170.xlsx"));
  assert.ok(described.includes("缓存 id=218fae170170"));
  assert.ok(!described.includes("https://qq.example"), "落地后不再展示 QQ 链接");
});

test("落地附件的提示改指本地工具（query_table / read_local_file）", () => {
  const stored = { ...file, localPath: "D:\\data\\attachments\\files\\a1.xlsx", cacheId: "a1" };
  const question = composeInboundQuestion("帮我看看这个表格", [stored]);
  assert.match(question, /query_table/);
  assert.match(question, /read_local_file/);
  assert.ok(!question.includes("web_fetch"), "落地场景不再引导走 web_fetch");
  // 混合场景（一个落地一个失败退回链接）：本地提示优先，链接原样保留
  const mixed = composeInboundQuestion("", [stored, image]);
  assert.match(mixed, /query_table/);
  assert.ok(mixed.includes("https://qq.example/img/x.png"), "未落地附件仍给链接");
});

test("图片落地标记", () => {
  const stored = { ...image, localPath: "D:\\data\\attachments\\files\\i1.png", cacheId: "i1" };
  const described = describeAttachments([stored]);
  assert.ok(described.includes("[图片 截图.png，已下载："), "落地图片带已下载标记");
  assert.ok(!described.includes("https://"), "不再展示链接");
});
