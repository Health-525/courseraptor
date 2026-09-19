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
import vm from "node:vm";

// 课表工具内部读写 data/，指向临时目录避免污染真实数据
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-chat-"));
// QQ 凭证保存走临时文件：测试里绝不碰真机 credentials.enc
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");

const { setChatAgent, setQQBridgeLauncher, setTitleMaker, startChatWeb } = await import(
  "../src/web/chat-web"
);
const { generatedDir } = await import("../src/document/save");

/** 页面签发的 CSRF token（写请求必须带上；浏览器里由注入的 fetch 包装自动完成） */
let pageToken: string | null = null;
async function csrfToken(): Promise<string> {
  pageToken ??=
    (await (await fetch((await startChatWeb())!)).text()).match(
      /<meta name="csrf-token" content="([0-9a-f]{64})">/,
    )?.[1] ?? null;
  assert.ok(pageToken, "页面必须注入 csrf-token meta");
  return pageToken;
}

/** 模拟正常页面的写请求：JSON 类型 + CSRF token 齐全 */
async function wfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("content-type", "application/json");
  headers.set("x-csrf-token", await csrfToken());
  return fetch(url, { ...init, headers });
}

/** SSE 客户端：收集整条流的 data 事件 */
function post(
  url: string,
  body: unknown,
): Promise<{ status: number; body: string; events: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    void csrfToken().then((token) => {
      const req = http.request(
        `${url}/api/chat`,
        { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": token } },
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
  const res = await wfetch(`${url}/api/chat`, {
    method: "POST",
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
  const res = await wfetch(`${url}/api/chat`, {
    method: "POST",
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

  const res = await wfetch(`${url}/api/reset`, { method: "POST" });
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
  const del = await wfetch(`${url}/api/sessions/aaaa1111`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const list2 = await (await fetch(`${url}/api/sessions`)).json();
  assert.ok(!list2.sessions.some((s: { id: string }) => s.id === "aaaa1111"));
  // 删除不存在的会话 → 404，非法 id 同样 404（不许兜底串档）
  assert.equal((await fetch(`${url}/api/sessions/nope!!`)).status, 404);
});

test("会话接口支持改名与置顶", async () => {
  const url = (await startChatWeb())!;
  await post(url, { message: "需要整理的会话", sessionId: "manage111" });
  const patch = await wfetch(`${url}/api/sessions/manage111`, {
    method: "PATCH",
    body: JSON.stringify({ title: "本周学习安排", pinned: true }),
  });
  assert.equal(patch.status, 200);
  const list = await (await fetch(`${url}/api/sessions`)).json();
  const item = list.sessions.find((s: { id: string }) => s.id === "manage111");
  assert.equal(item.title, "本周学习安排");
  assert.equal(item.pinned, true);
  assert.equal(list.sessions[0].id, "manage111", "置顶会话应排在最前");
});

test("模型自动命名：落盘后覆盖首问兜底，人工改过名不再覆盖", async () => {
  setChatAgent({
    stream() {
      async function* gen() {
        yield { type: "text-delta", text: "答复" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;
  // 注入替身命名 maker：记录拿到的消息、返回固定标题（不联网）
  let makerInput: unknown = null;
  setTitleMaker(async (input) => {
    makerInput = input;
    return "高数答疑";
  });

  // 首轮落盘后即触发自动命名：标题不再是首问原文
  await post(url, { message: "帮我看看这周的高数课在第几节", sessionId: "autotitle1" });
  const list = await (await fetch(`${url}/api/sessions`)).json();
  const item = list.sessions.find((s: { id: string }) => s.id === "autotitle1");
  assert.equal(item.title, "高数答疑", "模型命名的标题应落盘");
  assert.ok(makerInput, "命名 maker 应收到会话消息");

  // 人工改名后 titleSet 置位：再来的轮次不覆盖人工标题
  await wfetch(`${url}/api/sessions/autotitle1`, {
    method: "PATCH",
    body: JSON.stringify({ title: "我自己的名字" }),
  });
  setTitleMaker(async () => "不该出现");
  await post(url, { message: "再问一句", sessionId: "autotitle1" });
  const list2 = await (await fetch(`${url}/api/sessions`)).json();
  const item2 = list2.sessions.find((s: { id: string }) => s.id === "autotitle1");
  assert.equal(item2.title, "我自己的名字", "人工命名优先级高于模型自动命名");

  // 还原默认 maker，避免影响后续用例
  setTitleMaker(null);
});

test("自动命名失败时保留首问兜底，绝不静默清空标题", async () => {
  setChatAgent({
    stream() {
      async function* gen() {
        yield { type: "text-delta", text: "好的" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;
  // maker 抛错：标题必须保持首问兜底
  setTitleMaker(async () => {
    throw new Error("网络挂了");
  });
  await post(url, { message: "兜底标题测试问题", sessionId: "autotitle2" });
  let list = await (await fetch(`${url}/api/sessions`)).json();
  let item = list.sessions.find((s: { id: string }) => s.id === "autotitle2");
  assert.equal(item.title, "兜底标题测试问题", "命名失败时首问兜底仍在");

  // maker 返回超长烂输出：同样放弃，不清空
  setTitleMaker(async () => "这是一个长得不像标题的模型输出根本不该被采纳");
  await post(url, { message: "再触发一次命名", sessionId: "autotitle2" });
  list = await (await fetch(`${url}/api/sessions`)).json();
  item = list.sessions.find((s: { id: string }) => s.id === "autotitle2");
  assert.equal(item.title, "兜底标题测试问题", "烂输出不得覆盖兜底标题");

  setTitleMaker(null);
});

test("网页上传只回附件编号，对话可读取受控路径且详情不泄露路径", async () => {
  const calls: unknown[][] = [];
  setChatAgent({
    stream({ messages }: { messages?: unknown[] }) {
      calls.push(messages ?? []);
      async function* gen() {
        yield { type: "text-delta", text: "附件已收到" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;
  const uploadRes = await wfetch(`${url}/api/uploads`, {
    method: "POST",
    body: JSON.stringify({
      name: "课程说明.txt",
      type: "text/plain",
      data: Buffer.from("示例附件内容").toString("base64"),
    }),
  });
  assert.equal(uploadRes.status, 200);
  const upload = (await uploadRes.json()).upload;
  assert.deepEqual(Object.keys(upload).sort(), ["id", "name", "size", "type"]);

  await post(url, {
    message: "概括附件",
    sessionId: "upload111",
    attachmentIds: [upload.id],
  });
  const sent = JSON.stringify(calls.at(-1));
  assert.match(sent, /课程说明\.txt/);
  assert.match(sent, /web-uploads/);

  const detailText = await (await fetch(`${url}/api/sessions/upload111`)).text();
  assert.match(detailText, /课程说明\.txt/);
  assert.ok(!detailText.includes("storedPath") && !detailText.includes("web-uploads"));
});

test("教务工具结果不再产生结果卡，工具状态与文本照常下发", async () => {
  setChatAgent({
    stream() {
      async function* gen() {
        yield { type: "tool-call", toolCallId: "e1", toolName: "get_exams" };
        yield {
          type: "tool-result",
          toolCallId: "e1",
          toolName: "get_exams",
          output: {
            term: "2026-2027-1",
            total: 1,
            exams: [
              { subject: "高等数学", date: "2026-12-28", time: "09:00", location: "仁智楼 101" },
            ],
          },
        };
        yield { type: "text-delta", text: "考试安排如上" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;
  const first = await post(url, { message: "查考试", sessionId: "cards111" });
  assert.ok(!first.events.some((e) => e.t === "card"), "不再下发结果卡事件");
  assert.ok(first.events.some((e) => e.t === "tool" && e.phase === "end"));
  const detail = await (await fetch(`${url}/api/sessions/cards111`)).json();
  assert.equal(detail.messages.at(-1).role, "assistant");
  assert.equal(detail.messages.at(-1).artifacts, undefined, "历史消息不再保存结果卡");
});

test("待办可创建、完成并导出日历，本地数据接口回脱敏概览", async () => {
  const url = (await startChatWeb())!;
  const create = await wfetch(`${url}/api/reminders`, {
    method: "POST",
    body: JSON.stringify({
      title: "提交选课材料",
      dueAt: "2026-09-10T09:00:00+08:00",
      source: "教务通知",
      sourceUrl: "https://jwc.njtech.edu.cn/example",
    }),
  });
  assert.equal(create.status, 201);
  const reminder = (await create.json()).reminder;
  const patch = await wfetch(`${url}/api/reminders/${reminder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ done: true }),
  });
  assert.equal(patch.status, 200);
  const ics = await fetch(`${url}/api/reminders/${reminder.id}.ics`);
  assert.equal(ics.status, 200);
  assert.match(await ics.text(), /SUMMARY:提交选课材料/);

  const data = await (await fetch(`${url}/api/data`)).json();
  assert.ok(data.sessions.count >= 1);
  assert.ok(data.uploads.count >= 1);
  assert.ok(data.reminders.total >= 1);
  assert.ok(!JSON.stringify(data).includes("storedPath"));

  const exported = await fetch(`${url}/api/data/export`);
  assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
  assert.ok(!(await exported.text()).includes("storedPath"));
});

test("知识库：页面可打开、接口可列表删除、数据概览与导出携带", async () => {
  const url = (await startChatWeb())!;
  const { addKnowledge } = await import("../src/knowledge");
  const { entry } = addKnowledge({ title: "接口测试知识", content: "正文内容" });

  const page = await fetch(`${url}/knowledge`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /知识库/);
  assert.match(html, /api\/knowledge/, "页面应从 /api/knowledge 取数据");
  assert.match(html, /const DEMO_DATA = null;/, "正式页不内嵌数据");
  // knowledgePage 同样是外层模板串：对求值产物做语法检查
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-knowledge-page-"));
  for (const [i, code] of blocks.entries()) {
    const f = path.join(dir, `chunk-${i}.js`);
    fs.writeFileSync(f, code, "utf8");
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  }

  const list = (await (await fetch(`${url}/api/knowledge`)).json()) as {
    entries: Array<{ id: string; title: string }>;
  };
  assert.ok(list.entries.some((e) => e.id === entry.id && e.title === "接口测试知识"));

  const data = (await (await fetch(`${url}/api/data`)).json()) as {
    knowledge: { total: number };
  };
  assert.ok(data.knowledge.total >= 1, "数据概览应带知识统计");
  const exported = await (await fetch(`${url}/api/data/export`)).text();
  assert.ok(exported.includes("接口测试知识"), "数据导出应携带知识条目");

  const del = await wfetch(`${url}/api/knowledge/${entry.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const miss = await wfetch(`${url}/api/knowledge/${entry.id}`, { method: "DELETE" });
  assert.equal(miss.status, 404);
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
  // QQ 分组同样是脱敏状态：只有打码 AppID，绝不回显 AppSecret
  assert.equal(typeof s.qq.configured, "boolean");
  assert.equal(typeof s.qq.passcodeSet, "boolean");
  assert.ok(!("appSecret" in s.qq) && !("qqBotAppSecret" in s.qq), "不得返回 QQ AppSecret");
  // 模型下拉候选随设置一起回：这里绝不联网（弹窗不能因为等远端而卡住），
  // 没有实时缓存时必须是内置兜底清单
  assert.ok(Array.isArray(s.models) && s.models.length >= 2, "models 必须是非空候选清单");
  assert.ok(
    s.models.every(
      (m: { id?: unknown; label?: unknown }) =>
        typeof m.id === "string" && typeof m.label === "string",
    ),
    "候选项必须同时有 id 与展示名",
  );
  const ids = s.models.map((m: { id: string }) => m.id);
  assert.equal(new Set(ids).size, ids.length, "候选清单不得出现重复型号");
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

test("POST /api/settings：坏格式 Key、半套教务凭证、清单外模型都被拒且不落盘", async () => {
  const url = (await startChatWeb())!;
  const call = (body: unknown) =>
    wfetch(`${url}/api/settings`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const readModel = async () => (await (await fetch(`${url}/api/settings`)).json()).model as string;

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

  // 模型只许从下拉清单里选：形状合法但清单外的、以及含非法字符的，一律拒绝
  const before = await readModel();
  const r4 = await call({ model: "gpt-not-deepseek-9x7" });
  assert.equal(r4.status, 400);
  const rejected = (await r4.json()).results.find((x: { field: string }) => x.field === "model");
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /下拉列表/);

  const r5 = await call({ model: "../../etc/passwd" });
  assert.equal(r5.status, 400);
  assert.equal(await readModel(), before, "被拒的模型选择不得改动运行时配置");
});

test("QQ 凭证可经设置面板保存：成对校验、脱敏回显、保存成功后热拉起桥", async () => {
  const url = (await startChatWeb())!;
  // 注入替身桥启动器：记录调用、不真实连 QQ
  let launches = 0;
  setQQBridgeLauncher(async () => {
    launches++;
    return "；QQ 桥已拉起（测试替身）";
  });

  // 半套凭证被拒，且不触发拉起
  const half = await wfetch(`${url}/api/settings`, {
    method: "POST",
    body: JSON.stringify({ qqAppId: "1023456789" }),
  });
  assert.equal(half.status, 400);
  const halfBody = await half.json();
  assert.match(halfBody.results[0].message, /一起/);
  assert.equal(launches, 0, "被拒的保存不得拉起桥");

  // 完整凭证 + 暗号：保存成功、热启动触发、状态脱敏
  const save = await wfetch(`${url}/api/settings`, {
    method: "POST",
    body: JSON.stringify({
      qqAppId: "1023456789",
      qqAppSecret: "web-save-secret",
      qqPasscode: "raptor-pass",
    }),
  });
  assert.equal(save.status, 200);
  const body = await save.json();
  const qqLine = body.results.find((x: { field: string }) => x.field === "qq");
  assert.equal(qqLine.ok, true);
  assert.match(qqLine.message, /测试替身/);
  assert.equal(launches, 1);
  assert.equal(body.status.qq.configured, true);
  assert.equal(body.status.qq.passcodeSet, true);
  assert.equal(body.status.qq.appIdMasked, "1023••••89");
  assert.ok(!JSON.stringify(body).includes("web-save-secret"), "AppSecret 不得出现在响应任何位置");

  // 加密落盘 + GET 状态一致
  const { loadCredentialsStore } = await import("../src/credentials");
  const stored = loadCredentialsStore();
  assert.equal(stored?.qqBotAppSecret, "web-save-secret");
  assert.equal(stored?.qqBotPasscode, "raptor-pass");
  const after = (await (await fetch(`${url}/api/settings`)).json()).qq;
  assert.equal(after.configured, true);
  assert.ok(!JSON.stringify(after).includes("web-save-secret"));

  // 还原默认启动器，避免影响后续用例
  setQQBridgeLauncher(null);
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

// ── 成品文件：SSE 透出 files + /files/ 下载端点 ───────────────

/** 在临时 generated 目录里放一个真实的 ics 成品 */
async function seedGeneratedFile(name: string, content: string): Promise<string> {
  const dir = generatedDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, content, "utf8");
  return filePath;
}

test("工具结果带成品文件时 SSE 透出 files（两种返回形状都认）", async () => {
  const icsPath = await seedGeneratedFile(
    "calendar-2026-1.ics",
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n",
  );
  const docPath = await seedGeneratedFile("学习报告.docx", "fake-docx-bytes");

  setChatAgent({
    stream() {
      async function* gen() {
        yield { type: "tool-call", toolCallId: "e1", toolName: "export_calendar" };
        yield {
          type: "tool-result",
          toolCallId: "e1",
          toolName: "export_calendar",
          output: { file: { filename: "calendar-2026-1.ics", filePath: icsPath, bytes: 42 } },
        };
        yield { type: "tool-call", toolCallId: "d1", toolName: "generate_document" };
        yield {
          type: "tool-result",
          toolCallId: "d1",
          toolName: "generate_document",
          output: { filename: "学习报告.docx", path: docPath, format: "docx", bytes: 15 },
        };
        // 目录外的路径绝不是可下载成品：不透出（哪怕字段形状对）
        yield { type: "tool-call", toolCallId: "x1", toolName: "read_local_file" };
        yield {
          type: "tool-result",
          toolCallId: "x1",
          toolName: "read_local_file",
          output: { filename: "secret.txt", path: path.join(os.tmpdir(), "secret.txt") },
        };
        yield { type: "text-delta", text: "已导出" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });

  const url = (await startChatWeb())!;
  const r = await post(url, { message: "导出课表", sessionId: "files1" });
  const toolEnds = r.events.filter((e) => e.t === "tool" && e.phase === "end");
  const byId = Object.fromEntries(toolEnds.map((e) => [e.id, e]));

  assert.deepEqual(byId.e1?.files, [{ name: "calendar-2026-1.ics", size: 42 }]);
  assert.deepEqual(byId.d1?.files, [{ name: "学习报告.docx", size: 15 }]);
  assert.equal(byId.x1?.files, undefined, "generated 目录外的路径不得出现在 files 里");
});

test("GET /files/<名> 下载 generated 内的成品：类型、附件头与内容正确", async () => {
  await seedGeneratedFile(
    "calendar-2026-1.ics",
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n",
  );
  const url = (await startChatWeb())!;
  const res = await fetch(`${url}/files/calendar-2026-1.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/calendar/);
  const cd = res.headers.get("content-disposition") ?? "";
  assert.match(cd, /attachment/);
  assert.match(cd, /filename\*=UTF-8''calendar-2026-1\.ics/);
  assert.match(await res.text(), /BEGIN:VCALENDAR/);
});

test("中文文件名下载与穿越/不存在一律处理正确", async () => {
  await seedGeneratedFile("学习报告.docx", "fake-docx-bytes");
  const url = (await startChatWeb())!;

  // 中文文件名（URL 编码）可下载，disposition 带 UTF-8 名
  const res = await fetch(`${url}/files/${encodeURIComponent("学习报告.docx")}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /filename\*=UTF-8''/);

  // 路径穿越被 basename 拦下后落不到任何真实文件 → 404
  const evil = await fetch(`${url}/files/${encodeURIComponent("../../../../etc/passwd")}`);
  assert.equal(evil.status, 404);
  // 不存在的文件 → 404（不能兜底吐 HTML 页面骗 200）
  const none = await fetch(`${url}/files/nope.ics`);
  assert.equal(none.status, 404);
  assert.match(none.headers.get("content-type") ?? "", /text\/plain/);
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
  // 会话操作是浮层菜单卡片：置顶/改名/删除不再撑开列表行
  assert.match(html, /\.smenu \{/, "缺少浮层菜单样式");
  assert.match(html, /class="smenu"|el\("smenu"\)/, "菜单应渲染成浮层卡片");
  assert.ok(!html.includes("sactions"), "旧的内联操作行应已移除");
  assert.match(html, /setAttribute\("aria-haspopup", "menu"\)/, "⋯ 按钮应声明弹出菜单语义");
});

test("GET /today 返回独立日程页：语法自检 + 聊天页有入口", async () => {
  const url = (await startChatWeb())!;
  const res = await fetch(`${url}/today`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /今日日程/, "页面标题应为今日日程");
  assert.match(html, /api\/today/, "页面应从 /api/today 取数据");
  assert.match(html, /week-timetable/, "本周概览应使用节次 × 星期的周课表网格");
  assert.match(html, /返回对话/, "应有返回对话页的链接");
  assert.match(html, /const DEMO_DATA = null;/, "正式页不内嵌数据，运行时从 /api/today 取");
  assert.match(html, /id="knowledgeCard"/, "课表页应有知识卡片");
  assert.match(html, /more\.href = "\/knowledge"/, "知识卡片应链到 /knowledge 页");
  // todayPage 同样是外层模板串：对求值产物做语法检查（源码切片会漏判）
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 1, "页面应有内联脚本");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-today-page-"));
  blocks.forEach((code, i) => {
    const f = path.join(dir, `chunk-${i}.js`);
    fs.writeFileSync(f, code, "utf8");
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  });
  // 聊天页入口已收敛为「功能大厅」：侧栏与窄屏顶栏各一个按钮，完整页由面板内链接承接
  const chat = await (await fetch(url)).text();
  assert.match(chat, /id="openHall"[^>]*>功能大厅</, "侧栏应有功能大厅入口");
  assert.match(chat, /id="openHallM"[^>]*>大厅</, "移动顶栏应有功能大厅入口");
  assert.match(chat, /class="hall" id="hall"/, "功能大厅抽屉应存在");
  assert.match(chat, /id="hallSettings"/, "设置面板应常驻在功能大厅抽屉里");
  assert.ok(!chat.includes('id="openSettings"'), "侧栏不应再有独立的设置按钮");
  assert.match(chat, /today: \(\) => briefOf\(\)\.then\(buildToday\)/, "面板注册表应包含今日日程");
  assert.match(chat, /const TOOL_PANEL = \{/, "应有工具→面板联动映射");
  assert.match(chat, /get_schedule: "schedule"/, "课表工具应联动课表面板");
  assert.match(chat, /open_settings: "settings"/, "agent 应可通过 open_settings 工具打开设置");
  assert.match(chat, /ev\.panel && !hallAutoMuted\) openHall/, "未配置等场景应据 ev.panel 自动推出设置");
  assert.ok(
    !chat.includes("看今日日程：下一节课在哪 · 今天还有什么"),
    "首屏不应再展示今日日程 chip",
  );
  assert.match(chat, /默认进入新的空会话/, "每次打开网页应默认新建空会话");
});

test("GET /api/today 纯本地组装当日档案（无缓存时如实降级）", async () => {
  const url = (await startChatWeb())!;
  const res = await fetch(`${url}/api/today`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    dateLabel: string;
    schedule: { available: boolean; note?: string };
    next: unknown;
    exams: { available: boolean };
  };
  assert.ok(data.dateLabel, "应带日期标签");
  assert.equal(typeof data.schedule.available, "boolean");
  // 测试的数据目录里没有课表缓存：必须是「还没有数据」而非报错
  assert.equal(data.schedule.available, false);
  assert.match(data.schedule.note ?? "", /还没有课表数据/);
  assert.equal(data.next, null);
  assert.equal(data.exams.available, false);
});

// ── CSRF 防线：恶意网页借浏览器之手的每条路都要堵死 ───────────

test("写请求不带 CSRF token 一律 403（跨站页面拿不到 token）", async () => {
  const url = (await startChatWeb())!;
  // 恶意网页用 text/plain 免预检 POST 覆写教务凭证：无 token 直接被拒
  const noToken = await fetch(`${url}/api/settings`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ jwglUsername: "2026000001", jwglPassword: "evil-pass" }),
  });
  assert.equal(noToken.status, 403);
  // token 值错误同样被拒，且不产生数据
  const wrongToken = await fetch(`${url}/api/reminders`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "deadbeef" },
    body: JSON.stringify({ title: "伪造待办", dueAt: "2026-09-10T09:00:00Z" }),
  });
  assert.equal(wrongToken.status, 403);
  const reminders = await (await fetch(`${url}/api/reminders`)).json();
  assert.ok(
    !reminders.reminders.some((r: { title: string }) => r.title === "伪造待办"),
    "被拒请求不得留下数据",
  );
});

test("伪造 Host（DNS rebinding 姿势）与跨站 Origin 一律 403", async () => {
  const url = (await startChatWeb())!;
  const port = Number(new URL(url).port);
  const status = (headers: Record<string, string>, method = "GET", path = "/api/data") =>
    new Promise<number>((resolve) => {
      const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      r.on("error", () => resolve(0));
      r.end();
    });
  // DNS rebinding：恶意域名解析到 127.0.0.1，Host 头是它的域名 → 拒
  assert.equal(await status({ host: "evil.example" }), 403);
  // 跨站页面的 fetch：Origin 是它的站点（浏览器只拦读不拦发）→ 拒
  assert.equal(await status({ origin: "http://evil.example" }), 403);
  // 正常本机 Host 的 GET 导航请求：放行
  assert.equal(await status({ host: `127.0.0.1:${port}` }), 200);
});

test("Content-Type 不是 application/json 的写请求被拒（堵 text/plain 免预检绕道）", async () => {
  const url = (await startChatWeb())!;
  // token 齐全但类型不对：过得了第一道门，也要在 jsonBody 处被拒
  const res = await fetch(`${url}/api/reminders`, {
    method: "POST",
    headers: { "content-type": "text/plain", "x-csrf-token": await csrfToken() },
    body: JSON.stringify({ title: "绕道待办", dueAt: "2026-09-10T09:00:00Z" }),
  });
  assert.equal(res.status, 400);
  const reminders = await (await fetch(`${url}/api/reminders`)).json();
  assert.ok(
    !reminders.reminders.some((r: { title: string }) => r.title === "绕道待办"),
    "text/plain 请求不得创建数据",
  );
});

test("页面注入 CSRF 引导：meta 携带 token 且 fetch 包装脚本语法有效", async () => {
  const url = (await startChatWeb())!;
  for (const path of ["/", "/today", "/knowledge"]) {
    const html = await (await fetch(`${url}${path}`)).text();
    assert.match(html, /meta name="csrf-token"/, `${path} 页面应注入 token meta`);
    assert.match(html, /x-csrf-token/, `${path} 页面应注入 fetch 包装脚本`);
  }
  // 包装脚本是合法 JS（与其他内联脚本一起过 node --check）
  const html = await (await fetch(url)).text();
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-csrf-page-"));
  blocks.forEach((code, i) => {
    const f = path.join(dir, `chunk-${i}.js`);
    fs.writeFileSync(f, code, "utf8");
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  });
});

test("注入的 fetch 包装：写请求自动带 token，GET 不带且保留原 headers", async () => {
  const url = (await startChatWeb())!;
  const html = await (await fetch(url)).text();
  const block = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((code) => code.includes("x-csrf-token"));
  assert.ok(block, "应能找到注入的包装脚本");

  // 用 vm 搭一个最小浏览器环境：window.fetch 先装记录器，脚本再包一层
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  const rec = (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response("{}"));
  };
  const token = await csrfToken();
  const sandbox: Record<string, unknown> = {
    document: { querySelector: () => ({ content: token }) },
    Headers,
    window: { fetch: rec },
  };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  const wrapped = (sandbox.window as { fetch: typeof rec }).fetch;

  await wrapped("/api/reminders", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  await wrapped("/api/reminders", { method: "DELETE" });
  await wrapped("/api/sessions");

  assert.equal(calls.length, 3);
  const postInit = calls[0].init ?? {};
  const delInit = calls[1].init ?? {};
  assert.equal((postInit.headers as Headers).get("x-csrf-token"), token, "POST 自动带上 token");
  assert.equal(
    (postInit.headers as Headers).get("content-type"),
    "application/json",
    "原有 headers 必须保留",
  );
  assert.equal((delInit.headers as Headers).get("x-csrf-token"), token, "DELETE 自动带上 token");
  assert.equal(calls[2].init?.headers, undefined, "GET 不应被改写");
});
