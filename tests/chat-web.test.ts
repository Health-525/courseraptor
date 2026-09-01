/**
 * 网页对话窗口测试
 *
 * 钉住：页面能打开、POST /api/chat 以 SSE 流式回传 agent 的文本与工具状态、
 * 多轮历史逐轮累积传给 agent、agent 未就绪时返回明确错误而不是挂掉。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

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

test("GET /logo.png 返回项目 logo，favicon 与首屏印章都指向它", async () => {
  const url = (await startChatWeb())!;
  const res = await fetch(`${url}/logo.png`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /image\/png/);
  const buf = await res.arrayBuffer();
  assert.ok(buf.byteLength > 10_000, "logo 应是真实图片而非占位");
  // 浏览器还会自行请求 /favicon.ico，同一张图兜住，别让它 404
  assert.equal((await fetch(`${url}/favicon.ico`)).status, 200);

  const html = await (await fetch(url)).text();
  assert.match(html, /<link rel="icon"[^>]*href="\/logo\.png"/, "标签页应有 favicon");
  assert.match(html, /class="seal"[^>]*><img src="\/logo\.png"/, "首屏印章应是 logo");
  assert.ok(!html.includes("🦖"), "印章已换成 logo，页面不再用 emoji 占位");
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
        yield {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "get_schedule",
          output: { term: "2026-2027-1", total: 5 },
        };
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
  assert.deepEqual(
    secondCall.map((m) => m.role),
    ["user", "assistant", "user"],
  );
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

test("POST /api/reset 清空服务端会话上下文", async () => {
  const url = (await startChatWeb())!;
  // 发一轮让服务端历史非空
  await post(url, { message: "第一条" });
  let list = await (await fetch(`${url}/api/sessions`)).json();
  assert.ok(list.sessions.length > 0, "对话后服务端应有会话档案");

  const res = await fetch(`${url}/api/reset`, { method: "POST" });
  assert.equal(res.status, 200);
  list = await (await fetch(`${url}/api/sessions`)).json();
  assert.equal(list.sessions.length, 0, "reset 后会话档案应清空");
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

test("default 会话可被侧栏点击读取（id 白名单必须放行字母）", async () => {
  const url = (await startChatWeb())!;
  // 不带 sessionId 的对话落到 default 档
  await post(url, { message: "无会话id的一问" });
  const list = await (await fetch(`${url}/api/sessions`)).json();
  assert.ok(
    list.sessions.some((s: { id: string }) => s.id === "default"),
    "default 档应出现在会话列表",
  );
  const res = await fetch(`${url}/api/sessions/default`);
  assert.equal(res.status, 200, "GET default 档不得 404（曾致点击无反应）");
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

/** 桩 agent 收到的 messages，供「思考不进上下文」那条测试回看 */
const thinkCalls: unknown[][] = [];

test("reasoning 走独立 think 通道，绝不混进正文 text", async () => {
  setChatAgent({
    stream({ messages }: { messages?: unknown[] }) {
      thinkCalls.push(messages ?? []);
      async function* gen() {
        yield { type: "reasoning-start", id: "r1" };
        yield { type: "reasoning-delta", delta: "先" };
        yield { type: "reasoning-delta", text: "想想" };
        yield { type: "reasoning-end", id: "r1" };
        yield { type: "tool-call", toolCallId: "z1", toolName: "get_schedule" };
        yield {
          type: "tool-result",
          toolCallId: "z1",
          toolName: "get_schedule",
          output: { term: "1" },
        };
        // 第二段思考没有 reasoning-end（各家实现不保证）：靠后续事件收尾
        yield { type: "reasoning-delta", delta: "再核对周次" };
        yield { type: "text-delta", text: "答案在此" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;
  const r = await post(url, { message: "这周有什么课", sessionId: "think1" });

  const thinkEvs = r.events.filter((e) => e.t === "think");
  assert.equal(
    thinkEvs
      .filter((e) => e.v)
      .map((e) => e.v)
      .join(""),
    "先想想再核对周次",
    "两段思考都完整下发",
  );
  assert.ok(
    thinkEvs.some((e) => e.phase === "end"),
    "段末有 end 标记供前端折叠卡片",
  );
  assert.equal(
    r.events
      .filter((e) => e.t === "text")
      .map((e) => e.v)
      .join(""),
    "答案在此",
    "正文通道只有正文，思考没漏进去",
  );
});

test("思考随本轮落盘成 think，但不回流进模型上下文", async () => {
  const url = (await startChatWeb())!;
  await post(url, { message: "再来一轮", sessionId: "think2" });
  await post(url, { message: "追一句", sessionId: "think2" });

  const detail = await (await fetch(`${url}/api/sessions/think2`)).json();
  const bot = detail.messages.find((m: { role: string }) => m.role === "assistant");
  assert.equal(bot.text, "答案在此");
  assert.equal(bot.think, "先想想再核对周次", "重开会话还能回看思考");

  const lastCall = JSON.stringify(thinkCalls.at(-1));
  assert.ok(lastCall.includes("答案在此"), "正文照常进上下文");
  assert.ok(!lastCall.includes("先想想"), "思考不喂回模型（省 token 也防自我复读）");
});

test("渲染产物语法自检 + 思考卡片与齿轮图标锚点", async () => {
  const url = (await startChatWeb())!;
  const html = await (await fetch(url)).text();

  // chatPage 是外层模板串：必须对「求值后的页面」做语法检查，源码切片会漏判
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 1, "页面应有内联脚本");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-page-"));
  blocks.forEach((code, i) => {
    const f = path.join(dir, `chunk-${i}.js`);
    fs.writeFileSync(f, code, "utf8");
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  });

  // 思考独立建模：有自己的样式块（楷体草稿区，与黑体正文分层）与绘图函数
  assert.match(html, /\.think \{/, "缺少 .think 卡片样式");
  assert.match(html, /\.think \.thbody[\s\S]{0,200}var\(--kai\)/, "思考区应为楷体");
  assert.match(html, /function thinkNew/, "缺少思考卡片渲染函数");
  assert.match(html, /"思考"/, "思考卡片要有常驻文字标记");
  // 工具卡片行首是内联 SVG 齿轮，不再用勾叉字形表达状态
  assert.match(html, /<svg viewBox="0 0 24 24"/, "工具行首应为内联 SVG 图标");
  assert.match(html, /function toolDone[\s\S]{0,400}"完成"/, "完成状态用文字表达");
  assert.ok(!html.includes('"✓"') && !html.includes("'✓'"), "工具状态不再用勾号");
});
