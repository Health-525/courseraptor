/**
 * 桌面版 IPC 行协议解析 + 桌面通知端口回退语义。
 * 纯单元测试：不起 Electron、不发真实通知。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { parseIpcLine, encodeIpc, IPC_PREFIX } = await import("../desktop/src/ipc-protocol");
const { registerDesktopNotifier, sendDesktopNotification } = await import("../src/core/notify");

test("parseIpcLine：三类合法消息解析正确", () => {
  assert.deepEqual(parseIpcLine(`${IPC_PREFIX}{"type":"ready","url":"http://localhost:3210"}`), {
    type: "ready",
    url: "http://localhost:3210",
  });
  assert.deepEqual(parseIpcLine(`${IPC_PREFIX}{"type":"notify","title":"标题","body":"正文"}`), {
    type: "notify",
    title: "标题",
    body: "正文",
  });
  assert.deepEqual(parseIpcLine(`${IPC_PREFIX}{"type":"log","level":"warn","text":"hi"}`), {
    type: "log",
    level: "warn",
    text: "hi",
  });
});

test("parseIpcLine：无前缀 / 非法 JSON / 缺 type 一律返回 null", () => {
  assert.equal(parseIpcLine("普通日志一行"), null);
  assert.equal(parseIpcLine(`${IPC_PREFIX}not-json`), null);
  assert.equal(parseIpcLine(`${IPC_PREFIX}{"url":"x"}`), null);
  assert.equal(parseIpcLine(`${IPC_PREFIX}{"type":123}`), null);
});

test("encodeIpc ↔ parseIpcLine 往返一致", () => {
  const msg = { type: "notify", title: "t", body: "b" } as const;
  assert.deepEqual(parseIpcLine(encodeIpc(msg)), msg);
});

test("桌面通知端口：未注册返回 false；注册后接管；注销后回到回退", () => {
  // 未注册：应如实返回 false（调用方回退 windowsToast）
  registerDesktopNotifier(null);
  assert.equal(sendDesktopNotification("标题", "正文"), false);

  const got: Array<[string, string]> = [];
  registerDesktopNotifier((title, body) => {
    got.push([title, body]);
  });
  assert.equal(sendDesktopNotification("CourseRaptor 待办提醒", "「交作业」今天 20:00 到期"), true);
  assert.deepEqual(got, [["CourseRaptor 待办提醒", "「交作业」今天 20:00 到期"]]);

  registerDesktopNotifier(null);
  assert.equal(sendDesktopNotification("再次", "回退"), false);
});
