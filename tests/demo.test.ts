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
    // 演示横幅已按需求移除：演示特征改由输入区提示语与各页内嵌数据体现
    assert.match(html, /虚构示例，会话仅保留在内存/);
    assert.doesNotMatch(html, /demo-banner/);
    assert.match(html, /id="hallSettings"/, "设置面板常驻在功能大厅抽屉里");
    assert.match(html, /id="sUser"[^>]+disabled/);
    // 型号改用卡片单选：hidden input 载值，无 disabled 属性可挂，演示拦截由脚本守卫实现
    assert.match(html, /id="sModel"/);
    assert.match(html, /dataset\.demo === "true"\) return;/);
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
    // 课表结果卡已移除：演示只回 Markdown 示例课表，不再有 "t":"card"
    assert.doesNotMatch(reply, /"t":"card"/);
    assert.match(reply, /"t":"tool","phase":"start","id":"demo-get_schedule/);
    assert.match(reply, /"t":"end","dur":\d+,"sid":"demo-a"/);
    await send({ message: "我的成绩和 GPA", sessionId: "demo-b" });
    const first = await (await fetch(`${base}/api/sessions/demo-a`)).json();
    assert.equal(first.messages.length, 2);
    assert.ok(!JSON.stringify(first).includes("学业概览"));
    assert.equal((await send(null)).status, 400);
    assert.equal((await send({ message: " " })).status, 400);
    assert.equal((await send({ message: "a".repeat(20000) })).status, 413);
    assert.equal((await fetch(`${base}/api/settings`)).status, 200);
    assert.equal((await fetch(`${base}/api/settings`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${base}/api/reminders`)).status, 200);
    assert.equal((await fetch(`${base}/api/data`)).status, 200);
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
  for (const message of ["课表", "成绩", "学分", "通知", "考试", "日历", "知识", "随机问题"]) {
    assert.match(demoReply(message), /虚构示例/);
  }
  assert.match(demoReply("日历"), /没有生成文件或发布链接/);
  assert.match(demoReply("知识库"), /自动归类/);
  assert.match(demoReply("今天有什么安排"), /今日简报/, "演示应有日程+待办结合的示例回答");
  assert.match(demoReply("随机问题"), /不调用 AI/);
});

test("演示模式的今日日程页：内嵌虚构数据，不发请求", async () => {
  const server = createDemoServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const res = await fetch(`${base}/today`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /今日日程/);
    assert.doesNotMatch(html, /demo-banner/, "演示横幅已移除，演示页与正式页同视觉");
    // 演示数据内嵌（DEMO_DATA 非空），页面不依赖 /api/today
    assert.match(html, /const DEMO_DATA = \{/);
    assert.match(html, /示例高等数学/);
    assert.match(html, /if \(!DEMO_DATA\) \{/, "自动刷新与取数都必须被演示守卫挡住");
    // 课表/待办/知识已拆独立页：今日页只留头条与考试，左栏导航直达
    assert.match(html, /href="\/schedule"/);
    assert.match(html, /href="\/todos"/);
    assert.match(html, /href="\/knowledge"/);
    assert.ok(!html.includes('id="todoCard"'), "待办卡应拆到 /todos 页");
    assert.ok(!html.includes('id="knowledgeCard"'), "知识卡应拆到 /knowledge 页");
    assert.ok(!html.includes("week-timetable"), "周课表网格应拆到 /schedule 页");
  } finally {
    server.close();
  }
});

test("演示模式的课表页：内嵌虚构周课表，不发请求", async () => {
  const server = createDemoServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const res = await fetch(`${base}/schedule`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /课表/);
    assert.doesNotMatch(html, /demo-banner/, "演示横幅已移除，演示页与正式页同视觉");
    // 演示数据内嵌（DEMO_DATA 非空），页面不依赖 /api/today
    assert.match(html, /const DEMO_DATA = \{/);
    assert.match(html, /示例高等数学/);
    assert.match(html, /week-timetable/, "应使用节次 × 星期的周课表网格");
    assert.match(html, /if \(!DEMO_DATA\) \{/, "自动刷新与取数都必须被演示守卫挡住");
  } finally {
    server.close();
  }
});

test("演示模式的待办页：内嵌虚构待办，交互被守卫挡住", async () => {
  const server = createDemoServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const res = await fetch(`${base}/todos`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /待办/);
    assert.doesNotMatch(html, /demo-banner/, "演示横幅已移除，演示页与正式页同视觉");
    // 演示数据内嵌（DEMO_DATA 非空），页面不依赖 /api/today
    assert.match(html, /const DEMO_DATA = \{/);
    assert.match(html, /id="todoCard"/);
    assert.match(html, /交示例实验报告/);
    assert.match(html, /chk\.disabled = true/, "演示模式不勾选完成");
    assert.match(html, /if \(!DEMO_DATA\) \{/, "自动刷新与取数都必须被演示守卫挡住");
  } finally {
    server.close();
  }
});

test("演示模式的知识库页：内嵌虚构数据，不发请求", async () => {
  const server = createDemoServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const res = await fetch(`${base}/knowledge`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /知识库/);
    assert.doesNotMatch(html, /demo-banner/, "演示横幅已移除，演示页与正式页同视觉");
    // 演示数据内嵌（DEMO_DATA 非空），页面不依赖 /api/knowledge
    assert.match(html, /const DEMO_DATA = \[/);
    assert.match(html, /洛必达法则/);
    assert.match(html, /未分类/);
    assert.match(html, /if \(!DEMO_DATA\) \{/, "自动刷新与取数都必须被演示守卫挡住");
    // 删除按钮的创建包在演示守卫里：演示页只读
    assert.match(html, /if \(!DEMO_DATA\) \{[\s\S]{0,120}k-del/);
    assert.match(html, /示例高等数学/);
  } finally {
    server.close();
  }
});
