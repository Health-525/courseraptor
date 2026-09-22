/**
 * 短期记忆测试（memory/shortterm）
 *
 * 这层以前零测试：captureSessionPrompt 决定「跨重启延续」存下什么，
 * loadLastSessionTranscript 决定注入提示词的形状。截断上限一旦失灵，
 * 要么上下文被旧对话撑爆，要么重启后记忆悄悄丢失。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// SESSION_FILE 在模块加载时按数据目录定死，必须先设 env 再 import
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-shortterm-"));
process.env.RAPTOR_DATA_DIR = dataDir;
const sessionFile = path.join(dataDir, "session.json");

const { captureSessionPrompt, flushCapturedSession, loadLastSessionTranscript } = await import(
  "../src/memory/shortterm"
);

test("未捕获过任何会话：转写为空串，不编造记忆", async () => {
  assert.equal(await loadLastSessionTranscript(), "");
});

test("capture：滤掉 system、非数组输入忽略、条数封顶 200", async () => {
  const messages = [
    { role: "system", content: "你是教务助手" },
    ...Array.from({ length: 205 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `消息${i}`,
    })),
  ];
  captureSessionPrompt(messages);
  captureSessionPrompt("not-an-array");
  captureSessionPrompt(undefined);
  await flushCapturedSession();

  const saved = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as {
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(saved.messages.length, 200, "只存最后 200 条");
  assert.equal(
    saved.messages.some((m) => m.role === "system"),
    false,
    "system 不落盘",
  );
  assert.equal(saved.messages.at(-1)?.content, "消息204", "截断保尾部，最新内容必须在");
});

test("连续 capture 串行落盘：flush 之后文件是最后一次的内容", async () => {
  captureSessionPrompt([{ role: "user", content: "第一轮" }]);
  captureSessionPrompt([{ role: "user", content: "第二轮" }]);
  await flushCapturedSession();
  const saved = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as {
    messages: Array<{ content: string }>;
  };
  assert.equal(saved.messages.at(-1)?.content, "第二轮", "链式写入不丢最后一次");
});

test("转写：user/assistant 前缀 + savedAt 时间行 + parts 数组取 text", async () => {
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      savedAt: "2026-09-01T10:00:00Z",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "今天有什么课" },
            { type: "other", text: "忽略我" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "上午有高数" }] },
      ],
    }),
  );
  const t = await loadLastSessionTranscript();
  assert.match(t, /^## 上次会话记录（/, "头部要有标题与时间");
  assert.match(t, /你: 今天有什么课/);
  assert.match(t, /🦖: 上午有高数/);
  assert.ok(!t.includes("忽略我"), "parts 里非 text 类型不进转写");
});

test("转写：只取最后 8 条，更早的对话不挤占上下文", async () => {
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      messages: Array.from({ length: 12 }, (_, i) => ({
        role: "user",
        content: `第${i}问`,
      })),
    }),
  );
  const t = await loadLastSessionTranscript();
  assert.ok(t.includes("第11问"), "最新内容必须在");
  assert.ok(t.includes("第4问"), "窗口边界（最后 8 条的最早一条）必须在");
  assert.ok(!t.includes("第3问"), "更早的轮次要被裁掉（只保留最后 8 条）");
});

test("转写：超长对话按 3000 字符预算截尾并标注", async () => {
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      messages: Array.from({ length: 8 }, (_, i) => ({
        role: "user",
        content: `问${i}：${"长".repeat(600)}`,
      })),
    }),
  );
  const t = await loadLastSessionTranscript();
  assert.match(t, /…（更早已截断）/, "超预算要明确标注，不装作完整");
  // 头部 + 截断标记之外，正文主体不超过 3000 字符
  assert.ok(t.length < 3100 + 100, `转写要按预算收口，实际 ${t.length}`);
  assert.ok(t.includes("长".repeat(600).slice(0, 100)), "保留的是尾部内容");
});

test("坏文件与空消息：返回空串而不是抛错", async () => {
  fs.writeFileSync(sessionFile, "{broken json");
  assert.equal(await loadLastSessionTranscript(), "");
  fs.writeFileSync(sessionFile, JSON.stringify({ messages: [] }));
  assert.equal(await loadLastSessionTranscript(), "");
  fs.writeFileSync(sessionFile, JSON.stringify({ messages: [{ role: "tool", content: "x" }] }));
  assert.equal(await loadLastSessionTranscript(), "", "非 user/assistant 轮次不进转写");
});
