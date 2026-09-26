/**
 * 演示 live 模式测试：虚构数据 fixtures、内存工具集、SSE 翻译循环与
 * 带 liveAgent 的 /api/chat 集成。全程不触网——真实模型路径用桩 agent 验证协议形状。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type DemoStreamAgent, demoLiveTools, runDemoLiveTurn } from "../src/demo/agent";
import { demoExams, demoGrades, demoNews, demoTodayBrief, demoTodos } from "../src/demo/data";
import { createDemoServer } from "../src/demo/server";

const asTool = (t: unknown) =>
  t as { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };

/* ── 虚构数据 fixtures ── */

test("demoGrades：与离线剧本同数字（GPA 3.30 / 42 学分 / 58 分未过 / 缓考）", () => {
  const g = demoGrades();
  assert.equal(g.gpa, 3.3);
  assert.equal(g.creditsEarned, 42);
  const failed = g.courses.find((c) => c.name === "示例课程 A");
  assert.equal(failed?.score, 58);
  assert.equal(failed?.status, "未通过");
  assert.ok(g.courses.some((c) => c.name === "示例课程 B" && String(c.status).includes("缓考")));
  assert.equal(g.general.公共艺术类, 0);
});

test("demoExams：两场考试、日期相对今天（+5/+7）、非今天", () => {
  const now = new Date(2026, 8, 26, 12, 0); // 2026-09-26
  const exams = demoExams(now);
  assert.equal(exams.length, 2);
  assert.equal(exams[0].date, "2026-10-01");
  assert.equal(exams[1].date, "2026-10-03");
  assert.ok(exams.every((e) => e.inDays > 0 && e.isToday === false));
});

test("demoNews：3 条虚构通知，任何字段都不含真实链接", () => {
  const news = demoNews(new Date());
  assert.equal(news.length, 3);
  assert.ok(!JSON.stringify(news).includes("http"));
});

test("demoTodos/demoTodayBrief：逾期/今天/数天后三种形态，学期固定第 2 周", () => {
  const t = demoTodos(new Date());
  assert.equal(t.items.length, 3);
  assert.equal(t.items[0].overdue, true);
  assert.equal(t.items[1].isToday, true);
  assert.equal(t.done.length, 1);
  const brief = demoTodayBrief();
  assert.equal(brief.term.week, 2);
  assert.equal(brief.exams.upcoming[0].subject, "示例课程 A");
});

/* ── live 工具集（纯内存，不落盘）── */

test("get_time / get_schedule / get_grades / get_exams / get_news：返回虚构数据", async () => {
  const tools = demoLiveTools();
  const time = await asTool(tools.get_time).execute({});
  assert.equal(time.week, 2);
  assert.ok(typeof time.date === "string" && time.date.length === 10);

  const schedule = await asTool(tools.get_schedule).execute({});
  assert.equal((schedule.week as { days: unknown[] }).days.length, 7);
  assert.ok(JSON.stringify(schedule).includes("示例高等数学"));

  const grades = await asTool(tools.get_grades).execute({});
  assert.equal(grades.gpa, 3.3);

  const exams = await asTool(tools.get_exams).execute({});
  assert.equal((exams.exams as unknown[]).length, 2);

  const news = await asTool(tools.get_news).execute({});
  assert.equal(news.count, 3);
});

test("manage_todos：add → list → update 完成 → 再 list 不含已完成", async () => {
  const tools = demoLiveTools();
  const manage = asTool(tools.manage_todos);
  const list = async (includeDone?: boolean) =>
    (await manage.execute({ action: "list", ...(includeDone ? { includeDone } : {}) }))
      .todos as Array<{ id: string }>;
  assert.equal((await list()).length, 3); // 种子未完成
  const added = await manage.execute({
    action: "add",
    items: [{ title: "预习示例程序设计", dueAt: "2026-09-28T23:59:00" }],
  });
  assert.equal(added.ok, true);
  const newId = (added.added as Array<{ id: string }>)[0].id;
  assert.equal((await list()).length, 4);
  await manage.execute({ action: "update", id: newId, done: true });
  assert.equal((await list()).length, 3);
  assert.equal((await list(true)).length, 5); // 3 未完成 + 种子已完成 1 + 新完成 1
  await manage.execute({ action: "delete", id: newId });
  assert.equal((await list(true)).length, 4);
  assert.match(String((await manage.execute({ action: "update", id: "nope" })).error), /不存在/);
});

test("manage_knowledge：subject 归课程 / 自定义分类 / 未分类，关键词检索", async () => {
  const tools = demoLiveTools();
  const manage = asTool(tools.manage_knowledge);
  const r = await manage.execute({
    action: "add",
    items: [
      { title: "极限的夹逼定理", content: "两边夹则中间收敛", subject: "示例高等数学（习题课）" },
      { title: "薛定谔方程", content: "量子力学基本方程", subject: "量子力学" },
      { title: "随手记", content: "没有归属的笔记" },
    ],
  });
  assert.equal(r.ok, true);
  const saved = r.saved as Array<{ title: string; category: string | null }>;
  assert.equal(saved.find((e) => e.title === "极限的夹逼定理")?.category, "示例高等数学");
  assert.equal(saved.find((e) => e.title === "薛定谔方程")?.category, "量子力学");
  assert.equal(saved.find((e) => e.title === "随手记")?.category, null);

  const hits = await manage.execute({ action: "list", keyword: "洛必达" });
  assert.equal((hits.entries as Array<{ title: string }>).length, 1);
  assert.equal((hits.entries as Array<{ title: string }>)[0].title, "洛必达法则");
});

/* ── SSE 翻译循环（桩 agent，验证与正式协议同形）── */

function stubAgent(
  events: Array<Record<string, unknown>>,
  options?: { throwError?: Error },
): { agent: DemoStreamAgent; calls: Array<{ messages: unknown[] }> } {
  const calls: Array<{ messages: unknown[] }> = [];
  return {
    calls,
    agent: {
      async stream(opts: { messages: unknown[] }) {
        calls.push({ messages: opts.messages });
        if (options?.throwError) throw options.throwError;
        return {
          fullStream: (async function* generate() {
            for (const e of events) yield e;
          })(),
        };
      },
    } as unknown as DemoStreamAgent,
  };
}

test("runDemoLiveTurn：think → tool → text 事件序列与正式 /api/chat 同形", async () => {
  const { agent, calls } = stubAgent([
    { type: "reasoning-delta", delta: "先查时间" },
    { type: "reasoning-end" },
    { type: "tool-call", toolCallId: "t1", toolName: "get_time", input: {} },
    { type: "tool-result", toolCallId: "t1", toolName: "get_time", output: { summary: "第 2 周" } },
    { type: "text-delta", text: "你好" },
    { type: "text-delta", text: "！" },
  ]);
  const sent: Array<Record<string, unknown>> = [];
  const result = await runDemoLiveTurn({
    agent,
    history: [{ role: "user", content: "上次的问题" }],
    message: "现在第几周",
    send: (obj) => sent.push(obj),
    signal: new AbortController().signal,
  });
  assert.equal(result.text, "你好！");
  assert.equal(result.think, "先查时间");
  assert.equal(result.failure, null);
  assert.deepEqual(sent[0], { t: "think", v: "先查时间" });
  assert.deepEqual(sent[1], { t: "think", phase: "end" });
  assert.deepEqual(sent[2], { t: "tool", phase: "start", id: "t1", name: "get_time", args: "{}" });
  assert.equal(sent[3].t, "tool");
  assert.equal(sent[3].phase, "end");
  assert.equal(sent[3].brief, "第 2 周");
  assert.ok(typeof sent[3].dur === "number");
  assert.deepEqual(sent.slice(4), [
    { t: "text", v: "你好" },
    { t: "text", v: "！" },
  ]);
  // 历史与当前消息都传给了模型
  assert.equal(calls[0].messages.length, 2);
  assert.deepEqual(calls[0].messages[0], { role: "user", content: "上次的问题" });
});

test("runDemoLiveTurn：流内 error 事件与 agent 抛错都归入 failure", async () => {
  const inner = stubAgent([{ type: "error", error: new Error("配额不足") }]);
  const r1 = await runDemoLiveTurn({
    agent: inner.agent,
    history: [],
    message: "hi",
    send: () => {},
    signal: new AbortController().signal,
  });
  assert.equal(r1.failure, "配额不足");

  const throwing = stubAgent([], { throwError: new Error("连接失败") });
  const r2 = await runDemoLiveTurn({
    agent: throwing.agent,
    history: [],
    message: "hi",
    send: () => {},
    signal: new AbortController().signal,
  });
  assert.match(String(r2.failure), /连接失败/);
});

/* ── 带 liveAgent 的服务器集成 ── */

async function withServer(liveAgent: DemoStreamAgent | null, run: (base: string) => Promise<void>) {
  const server = createDemoServer({ liveAgent });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

test("live /api/chat：先发虚构数据声明，再流模型正文；轮次写回内存会话", async () => {
  const { agent } = stubAgent([{ type: "text-delta", text: "这是实时生成的回答" }]);
  await withServer(agent, async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "今天有什么安排", sessionId: "live-a" }),
    });
    assert.equal(res.status, 200);
    const events = await readSse(res);
    assert.equal(events[0].t, "text");
    assert.match(String(events[0].v), /^> 演示模式：以下回答由 AI 实时生成/);
    assert.deepEqual(events[1], { t: "text", v: "这是实时生成的回答" });
    const last = events[events.length - 1];
    assert.equal(last.t, "end");
    assert.equal(last.sid, "live-a");

    const session = (await (await fetch(`${base}/api/sessions/live-a`)).json()) as {
      messages: Array<{ role: string; text: string }>;
    };
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[0].role, "user");
    assert.match(session.messages[1].text, /^> 演示模式：[\s\S]*这是实时生成的回答$/);

    // 设置面板如实标注 live 模式
    const settings = (await (await fetch(`${base}/api/settings`)).json()) as { model: string };
    assert.equal(settings.model, "DeepSeek 实时生成（虚构数据演示）");
  });
});

test("live /api/chat：模型失败只发 err 事件（含排查提示），不写回会话", async () => {
  const { agent } = stubAgent([], { throwError: new Error("401 unauthorized") });
  await withServer(agent, async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "你好", sessionId: "live-b" }),
    });
    const events = await readSse(res);
    const err = events.find((e) => e.t === "err");
    assert.ok(err, "应有 err 事件");
    assert.match(String(err.v), /401 unauthorized/);
    assert.match(String(err.v), /DEEPSEEK_API_KEY/);
    assert.equal((await fetch(`${base}/api/sessions/live-b`)).status, 404);
  });
});
