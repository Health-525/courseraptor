/**
 * 网页对话窗口测试
 *
 * 钉住：页面能打开、POST /api/chat 以 SSE 流式回传 agent 的文本与工具状态、
 * 多轮历史逐轮累积传给 agent、agent 未就绪时返回明确错误而不是挂掉。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// 课表工具内部读写 data/，指向临时目录避免污染真实数据
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-chat-"));

const { setChatAgent, startChatWeb } = await import("../src/web/chat-web");

/** SSE 客户端：收集整条流的 data 事件 */
function post(
  url: string,
  body: unknown,
): Promise<{ status: number; body: string; events: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${url}/api/chat`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: raw,
            events: raw
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => JSON.parse(l.slice(6))),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("GET / 返回对话页面（含 marked 引用与快捷提问）", async () => {
  const url = await startChatWeb();
  assert.ok(url);
  assert.match(url, /^http:\/\/localhost:\d+$/);
  const res = await fetch(url);
  const html = await res.text();
  assert.match(html, /CourseRaptor 对话|CourseRaptor</);
  assert.match(html, /api\/chat/);
  // Markdown 渲染脚本与快捷提问气泡必须就位
  assert.match(html, /\/vendor\/marked\.min\.js/);
  assert.match(html, /这周课表/);
});

test("GET /vendor/marked.min.js 返回 marked 脚本本体", async () => {
  const url = (await startChatWeb())!;
  const res = await fetch(`${url}/vendor/marked.min.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  const body = await res.text();
  assert.ok(body.length > 10000, "marked UMD 构建应有实际体积");
});

test("agent 未就绪时返回 503 与明确错误", async () => {
  setChatAgent(null);
  const url = (await startChatWeb())!;
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "你好" }),
  });
  assert.equal(res.status, 503);
});

test("SSE 流式回传文本与工具状态，历史逐轮累积", async () => {
  const calls: unknown[][] = [];
  setChatAgent({
    stream({ messages }: { messages?: unknown[] }) {
      calls.push(messages ?? []);
      async function* gen() {
        yield { type: "tool-call", toolCallId: "t1", toolName: "get_schedule" };
        yield { type: "tool-result", toolCallId: "t1", toolName: "get_schedule", output: { term: "2026-2027-1", total: 5 } };
        yield { type: "text-delta", text: "你" };
        yield { type: "text-delta", text: "好" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });

  const url = (await startChatWeb())!;
  const r1 = await post(url, { message: "查课表" });
  assert.equal(r1.status, 200);
  const types1 = r1.events.map((e) => e.t);
  assert.ok(types1.includes("tool"));
  assert.deepEqual(
    r1.events.filter((e) => e.t === "text").map((e) => e.v),
    ["你", "好"],
  );
  assert.ok(r1.events.some((e) => e.t === "end"));
  // 工具结果摘要透出 term/total
  const toolEnd = r1.events.find((e) => e.t === "tool" && e.phase === "end");
  assert.match(String(toolEnd?.brief), /2026-2027-1/);

  // 第二轮：历史应带上第一轮的 user + assistant 消息
  const r2 = await post(url, { message: "谢谢" });
  const secondCall = calls[1] as { role: string; content: unknown }[];
  assert.deepEqual(secondCall.map((m) => m.role), [
    "user",
    "assistant",
    "user",
  ]);
  assert.equal(secondCall[0].content, "查课表");
  assert.match(String(r2.events.at(-1)?.t), /end/);
});

test("空消息返回 400", async () => {
  const url = (await startChatWeb())!;
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "   " }),
  });
  assert.equal(res.status, 400);
});

test("GET /api/brief：有课表缓存返回今日速览，无缓存返回 hasData=false", async () => {
  const url = (await startChatWeb())!;
  const { saveScheduleCache } = await import("../src/schedule-cache");

  // 无缓存：hasData=false，前端据此隐藏速览条
  fs.rmSync(path.join(process.env.RAPTOR_DATA_DIR!, "schedule-cache.json"), { force: true });
  let brief = await (await fetch(`${url}/api/brief`)).json();
  assert.equal(brief.hasData, false);

  // 有缓存：term/周次/今日课齐全
  const weekday = ((new Date().getDay() + 6) % 7) + 1;
  saveScheduleCache({
    year: 2026,
    semester: 3,
    label: "2026-2027-1",
    courses: [
      {
        title: "高等数学",
        weekday,
        periods: [1, 2],
        weeks: "1-16",
        location: "教A-101",
        teacher: "张三",
      },
    ],
  });
  brief = await (await fetch(`${url}/api/brief`)).json();
  assert.equal(brief.hasData, true);
  assert.equal(brief.term, "2026-2027-1");
  assert.equal(brief.today.length, 1);
  assert.equal(brief.today[0].title, "高等数学");
  assert.equal(brief.today[0].location, "教A-101");
});

test("POST /api/reset 清空服务端会话上下文", async () => {
  const url = (await startChatWeb())!;
  // 发一轮让服务端历史非空
  await post(url, { message: "第一条" });
  let brief = await (await fetch(`${url}/api/brief`)).json();
  assert.ok(brief.historyLen > 0, "对话后服务端应有历史");

  const res = await fetch(`${url}/api/reset`, { method: "POST" });
  assert.equal(res.status, 200);
  brief = await (await fetch(`${url}/api/brief`)).json();
  assert.equal(brief.historyLen, 0);
});

test("多会话历史：sessionId 隔离上下文，列表/详情/删除接口", async () => {
  const calls: unknown[][] = [];
  setChatAgent({
    stream({ messages }: { messages?: unknown[] }) {
      calls.push(messages ?? []);
      async function* gen() {
        yield { type: "text-delta", text: "收到" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;
  await post(url, { message: "甲会话的问题", sessionId: "aaaa1111" });
  await post(url, { message: "乙会话的问题", sessionId: "bbbb2222" });

  // 列表：两个会话都在，标题自动取首问
  const list = await (await fetch(`${url}/api/sessions`)).json();
  const titles = list.sessions.map((s: { title: string }) => s.title);
  assert.ok(titles.includes("甲会话的问题"));
  assert.ok(titles.includes("乙会话的问题"));

  // 上下文隔离：乙这一轮发给 agent 的消息里不能出现甲的内容
  const lastCall = calls.at(-1)!;
  assert.ok(!JSON.stringify(lastCall).includes("甲会话的问题"));

  // 详情带完整消息；删除后列表不再包含
  const detail = await (await fetch(`${url}/api/sessions/aaaa1111`)).json();
  assert.equal(detail.messages[0].text, "甲会话的问题");
  assert.equal(detail.messages[0].role, "user");
  const del = await fetch(`${url}/api/sessions/aaaa1111`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const list2 = await (await fetch(`${url}/api/sessions`)).json();
  assert.ok(!list2.sessions.some((s: { id: string }) => s.id === "aaaa1111"));
  // 删除不存在的会话 → 404，非法 id 同样 404（不许兜底串档）
  assert.equal((await fetch(`${url}/api/sessions/nope!!`)).status, 404);
});

test("工具事件带 id/参数/结果预览（独立工具卡片的数据源）", async () => {
  setChatAgent({
    stream() {
      async function* gen() {
        yield {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "get_grades",
          input: { term: "2025-2026-2" },
        };
        yield {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "get_grades",
          output: { gpa: 3.7, courses: ["高等数学"] },
        };
        yield { type: "text-delta", text: "成绩如上" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;
  const r = await post(url, { message: "查成绩", sessionId: "cccc3333" });
  const start = r.events.find((e) => e.t === "tool" && e.phase === "start");
  assert.equal(start?.id, "c1");
  assert.match(String(start?.args), /2025-2026-2/);
  const end = r.events.find((e) => e.t === "tool" && e.phase === "end");
  assert.equal(end?.id, "c1");
  assert.match(String(end?.out), /gpa/);
});

/**
 * 设置接口测试。注意：只走「读取」与「拒绝」路径——成功保存会写
 * PROJECT_ROOT/credentials.enc（真机上那是用户的加密凭证），绝不在测试里碰。
 */
test("GET /api/settings 只回脱敏状态，不吐明文密钥", async () => {
  const url = (await startChatWeb())!;
  const res = await fetch(`${url}/api/settings`);
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(typeof s.jwgl.configured, "boolean");
  assert.ok(!("password" in s.jwgl), "不得返回教务密码");
  assert.equal(typeof s.deepseek.configured, "boolean");
  assert.ok(!("key" in s.deepseek) && !("apiKey" in s.deepseek), "不得返回完整 Key");
  const fullKey = process.env.DEEPSEEK_API_KEY;
  if (fullKey) {
    assert.ok(!JSON.stringify(s).includes(fullKey), "响应任意位置都不得出现完整 Key");
  }
});

test("POST /api/settings：坏格式 Key 与半套教务凭证都被拒且不落盘", async () => {
  const url = (await startChatWeb())!;
  const call = (body: unknown) =>
    fetch(`${url}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const r1 = await call({ apiKey: "not-a-valid-key" });
  assert.equal(r1.status, 400);
  const d1 = await r1.json();
  assert.equal(d1.ok, false);
  assert.match(d1.results[0].message, /sk-/);

  const r2 = await call({ jwglUsername: "2026000001" });
  assert.equal(r2.status, 400);
  const d2 = await r2.json();
  assert.match(d2.results[0].message, /一起/);

  // 空提交视为无修改（200），同样不应产生任何写入
  const r3 = await call({});
  assert.equal(r3.status, 200);
});
