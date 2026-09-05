import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoServer, demoReply } from "../src/web/demo-server";

test("免账号演示：共用网页、内存会话、拒绝凭证设置与任意文件", async () => {
  const server = createDemoServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const html = await (await fetch(base)).text();
    assert.match(html, /离线演示 · 全部为虚构数据/);
    assert.match(html, /id="openSettings"[^>]+disabled/);
    assert.equal((await fetch(`${base}/logo.png`)).status, 200);
    assert.equal((await fetch(`${base}/vendor/marked.min.js`)).status, 200);
    const send = (body: unknown) =>
      fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const reply = await (await send({ message: "这周课表", sessionId: "demo-a" })).text();
    assert.match(reply, /示例高等数学/);
    assert.match(reply, /"t":"end","sid":"demo-a"/);
    await send({ message: "我的成绩和 GPA", sessionId: "demo-b" });
    const first = await (await fetch(`${base}/api/sessions/demo-a`)).json();
    assert.equal(first.messages.length, 2);
    assert.ok(!JSON.stringify(first).includes("学业概览"));
    assert.equal((await send(null)).status, 400);
    assert.equal((await send({ message: " " })).status, 400);
    assert.equal((await send({ message: "a".repeat(20000) })).status, 413);
    for (const method of ["GET", "POST"]) {
      assert.equal((await fetch(`${base}/api/settings`, { method })).status, 403);
    }
    assert.equal((await fetch(`${base}/files/credentials.enc`)).status, 404);
    assert.equal((await fetch(`${base}/api/sessions/demo-a`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${base}/api/sessions/demo-a`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("演示不伪造实时数据、文件和任意 AI 回答", () => {
  for (const message of ["课表", "成绩", "学分", "通知", "考试", "日历", "随机问题"]) {
    assert.match(demoReply(message), /虚构示例/);
  }
  assert.match(demoReply("日历"), /没有生成文件或发布链接/);
  assert.match(demoReply("随机问题"), /不调用 AI/);
});
