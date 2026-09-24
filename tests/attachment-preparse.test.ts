/**
 * 上传附件预解析注入测试
 *
 * 钉住的行为：用户在网页上传附件并发消息时，服务端先把附件过一遍本地
 * 解析流水线，把内容（小文件全文 / 大表格概览+id）直接注入模型上下文——
 * 模型不必再调一次 read_local_file 试探，第一轮就能基于内容回答。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 数据目录隔离：附件缓存与上传副本都落在临时目录，绝不碰真实 data/
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-preparse-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");

const { setChatAgent, startChatWeb } = await import("../src/channels/web/chat-web");

/** 页面签发的 CSRF token（写请求必须带上） */
let pageToken: string | null = null;
async function csrfToken(): Promise<string> {
  pageToken ??=
    (await (await fetch((await startChatWeb())!)).text()).match(
      /<meta name="csrf-token" content="([0-9a-f]{64})">/,
    )?.[1] ?? null;
  assert.ok(pageToken, "页面必须注入 csrf-token meta");
  return pageToken;
}

async function wfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("content-type", "application/json");
  headers.set("x-csrf-token", await csrfToken());
  return fetch(url, { ...init, headers });
}

/** SSE 客户端：收集整条流的 data 事件 */
function postChat(url: string, body: unknown): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    void csrfToken().then((token) => {
      const req = http.request(
        `${url}/api/chat`,
        { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": token } },
        (res) => {
          let raw = "";
          res.on("data", (d) => (raw += d));
          res.on("end", () =>
            resolve(
              raw
                .split("\n")
                .filter((l) => l.startsWith("data: "))
                .map((l) => JSON.parse(l.slice(6))),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  });
}

test("发消息时附件预解析注入：小文件全文、大表格概览+id，直接进上下文", async () => {
  const calls: unknown[][] = [];
  setChatAgent({
    stream({ messages }: { messages?: unknown[] }) {
      calls.push(messages ?? []);
      async function* gen() {
        yield { type: "text-delta", text: "已读" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;

  // 小文本附件：全文应直接注入
  const txtRes = await wfetch(`${url}/api/uploads`, {
    method: "POST",
    body: JSON.stringify({
      name: "补考安排.txt",
      type: "text/plain",
      data: Buffer.from("高数补考定于 9 月 20 日在仁智楼 201 举行").toString("base64"),
    }),
  });
  assert.equal(txtRes.status, 200);
  const txt = (await txtRes.json()).upload;

  // 大表格附件：注入概览 + query_table 可用的缓存 id
  const XLSX = createRequire(import.meta.url)("xlsx") as typeof import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["课程", "教室"],
      ...Array.from({ length: 60 }, (_, i) => [`课${i + 1}`, `楼${i + 1}`]),
    ]),
    "安排",
  );
  const xlsxRes = await wfetch(`${url}/api/uploads`, {
    method: "POST",
    body: JSON.stringify({
      name: "教室安排.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer).toString(
        "base64",
      ),
    }),
  });
  assert.equal(xlsxRes.status, 200);
  const xlsx = (await xlsxRes.json()).upload;

  const events = await postChat(url, {
    message: "看下这两个附件",
    sessionId: "preparse111",
    attachmentIds: [txt.id, xlsx.id],
  });
  assert.ok(
    events.some((e) => e.t === "end"),
    "本轮应正常走完",
  );
  const sent = JSON.stringify(calls.at(-1));
  // 小文本：全文已在上下文里，agent 不必再调工具
  assert.match(sent, /高数补考定于 9 月 20 日/);
  // 大表格：概览 + 可直接 query_table 的 id
  assert.match(sent, /教室安排\.xlsx/);
  assert.match(sent, /课程 \| 教室/, "表格概览应含表头");
  assert.match(sent, /query_table/, "大文件注入应指引用 query_table 取数");
  assert.match(sent, /缓存 id=[0-9a-f]{12}/, "表格注入必须带缓存 id");

  // 会话详情回看不泄露受控路径（与既有上传测试同一防线）
  const detail = await (await fetch(`${url}/api/sessions/preparse111`)).text();
  assert.ok(!detail.includes("web-uploads"), "详情不泄露上传物理路径");
});

test("预解析失败不挡对话：坏文件退回路径提示，本轮照常完成", async () => {
  const calls: unknown[][] = [];
  setChatAgent({
    stream({ messages }: { messages?: unknown[] }) {
      calls.push(messages ?? []);
      async function* gen() {
        yield { type: "text-delta", text: "好的" };
        yield { type: "finish" };
      }
      return Promise.resolve({ fullStream: gen() });
    },
  });
  const url = (await startChatWeb())!;

  // 造一个「服务端存得下但解析不了」的文件：垃圾字节的 .pdf
  // （pdf-parse 解不开，落 file 模式；.csv 会被 SheetJS 宽容解析成空表，测不到这条路）
  const res = await wfetch(`${url}/api/uploads`, {
    method: "POST",
    body: JSON.stringify({
      name: "损坏.pdf",
      type: "application/pdf",
      data: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]).toString("base64"),
    }),
  });
  assert.equal(res.status, 200);
  const upload = (await res.json()).upload;

  const events = await postChat(url, {
    message: "这个文件是什么",
    sessionId: "fallback222",
    attachmentIds: [upload.id],
  });
  assert.ok(
    events.some((e) => e.t === "end"),
    "预解析失败不影响本轮完成",
  );
  const sent = JSON.stringify(calls.at(-1));
  assert.match(sent, /损坏\.pdf/);
  // file 模式如实告知，不编造内容
  assert.match(sent, /暂不支持自动解析|预解析失败/, "解析不了要如实说");
});
