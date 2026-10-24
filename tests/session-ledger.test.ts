/**
 * 会话状态台账（src/core/session-ledger.ts）+ 会话档案落盘接线
 *
 * 台账的失败模式都是「静默失忆」：该记的没记（模型会说自己没记过），
 * 或者不该记的记了（台账变成第二份 history，白烧 token）。所以这里逐条钉：
 * 闭集判定、失败不记、部分成功要记、去重、条数与行宽上限。
 *
 * 另含一条漂移钉：闭集里登记的工具名必须都是真实存在的 core 工具——
 * 有人重命名工具却忘了改台账，闭集就会静默失效。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { LEDGER_MAX, LEDGER_RENDER, didMutate, ledgerBlock, ledgerLine, pushLedger } = await import(
  "../src/core/session-ledger"
);

// ── 闭集：查得到但不记 ───────────────────────────────────

test("查询类动作不进台账：list / status / list（番茄钟）", () => {
  assert.equal(ledgerLine("manage_todos", { action: "list" }, { ok: true }), null);
  assert.equal(ledgerLine("manage_knowledge", { action: "list" }, { ok: true }), null);
  assert.equal(ledgerLine("save_memory", { action: "list" }, { ok: true }), null);
  assert.equal(
    ledgerLine("manage_pomodoro", { action: "status" }, { summary: "还剩 12 分钟" }),
    null,
  );
  assert.equal(ledgerLine("manage_pomodoro", { action: "list" }, { ok: true }), null);
});

test("非写操作工具不进台账：get_time / get_schedule / manage_knowledge 之外都不登记", () => {
  assert.equal(ledgerLine("get_time", { format: "date" }, { ok: true, now: "2026-09-20" }), null);
  assert.equal(ledgerLine("get_schedule", { week: 3 }, { ok: true }), null);
  assert.equal(ledgerLine("run_js", { code: "1+1" }, { ok: true, result: 2 }), null);
  assert.equal(ledgerLine("read_local_file", { path: "a.txt" }, { ok: true }), null);
  // 未知工具名一律不进（闭集是白名单，不是黑名单）
  assert.equal(ledgerLine("some_future_writer", { action: "add" }, { ok: true }), null);
});

// ── 闭集：改到东西了就记 ─────────────────────────────────

test("写操作成功即记，并带上分类前缀", () => {
  const todo = ledgerLine(
    "manage_todos",
    { action: "add" },
    { ok: true, summary: "已记录 1 条待办" },
  );
  assert.ok(todo?.startsWith("【待办】"), `待办台账行应带前缀，实际 ${todo}`);

  const know = ledgerLine(
    "manage_knowledge",
    { action: "add" },
    { ok: true, summary: "已入库 1 条知识" },
  );
  assert.ok(know?.startsWith("【知识库】"), `知识库台账行应带前缀，实际 ${know}`);
});

test("对话改课表/考试/成绩/提示词：写动作记账带前缀，list 与失败不记", () => {
  const cases: Array<[string, string]> = [
    ["edit_schedule", "【课表】"],
    ["edit_exams", "【考试】"],
    ["edit_grades", "【成绩】"],
    ["manage_prompts", "【提示词】"],
  ];
  for (const [tool, prefix] of cases) {
    const line = ledgerLine(tool, { action: "update" }, { ok: true, summary: "已改一条" });
    assert.ok(line?.startsWith(prefix), `${tool} 台账行应带前缀 ${prefix}，实际 ${line}`);
    assert.equal(ledgerLine(tool, { action: "list" }, { ok: true, summary: "x" }), null);
    assert.equal(ledgerLine(tool, { action: "update" }, { error: "id 无效" }), null);
  }
});

test("失败不记：工具以 {error} 形态返回失败（不抛异常）时不进台账", () => {
  assert.equal(
    ledgerLine("manage_todos", { action: "add" }, { error: "add 需要 items（至少一条待办）" }),
    null,
  );
  // 空白 error 不算失败（有些工具返回 error: "" 表示无错）
  assert.ok(ledgerLine("manage_todos", { action: "add" }, { ok: true, error: "" }));
});

test("set_holidays 部分成功要记：部分日期非法但其余已落盘（error 与 recorded 并存）", () => {
  const out = { recorded: 3, removed: [], error: "以下日期无效：2026-13-01" };
  assert.equal(didMutate("set_holidays", out), true, "已落盘 3 天就该记，哪怕同时报了无效日期");
  const line = ledgerLine("set_holidays", { days: [{ date: "2026-10-01", type: "holiday" }] }, out);
  assert.ok(line?.includes("3 天"), `台账行应说明落盘天数，实际 ${line}`);

  // 全军覆没（recorded 0 且无移除）才算没改动
  assert.equal(didMutate("set_holidays", { recorded: 0, removed: [], error: "日期无效" }), false);
  // 只移除了记录也算改动
  assert.equal(
    didMutate("set_holidays", { recorded: 0, removed: ["2026-10-01"], error: "x" }),
    true,
  );
});

test("无 summary 时按入参兜底拼行：待办 add / knowledge add / 文件产出", () => {
  const todo = ledgerLine(
    "manage_todos",
    { action: "add", items: [{ title: "交高数作业" }] },
    { ok: true },
  );
  assert.ok(todo?.includes("交高数作业"), `兜底行应含待办标题，实际 ${todo}`);

  const batch = ledgerLine(
    "manage_todos",
    { action: "add", items: [{ title: "a" }, { title: "b" }, { title: "c" }] },
    { ok: true },
  );
  assert.ok(batch?.includes("3 条待办"), `批量 add 应折成一条，实际 ${batch}`);

  const know = ledgerLine(
    "manage_knowledge",
    { action: "add", items: [{ title: "洛必达法则" }] },
    { ok: true },
  );
  assert.ok(know?.includes("洛必达法则"), `兜底行应含知识标题，实际 ${know}`);

  const doc = ledgerLine(
    "generate_document",
    { format: "docx" },
    { ok: true, format: "docx", filename: "报告.docx" },
  );
  assert.ok(
    doc?.includes("报告.docx") && doc?.includes("DOCX"),
    `文件行应含格式与文件名，实际 ${doc}`,
  );
});

test("日期在台账里压成 月-日：不让 ISO 全串占掉一行预算", () => {
  const line = ledgerLine(
    "manage_todos",
    { action: "update", id: "t1", title: "交实验报告", dueAt: "2026-09-20T23:59:00" },
    { ok: true },
  );
  assert.ok(line?.includes("9-20"), `应压成 9-20，实际 ${line}`);
  assert.ok(!line?.includes("T23:59"), `不该带时间部分，实际 ${line}`);
});

// ── 入参形状 robustness ──────────────────────────────────

test("入参形状意外不崩：缺字段 / 类型不对 / 空输入都只是少记，不抛", () => {
  for (const bad of [undefined, null, {}, "string", 42, [], { action: 123 }]) {
    assert.doesNotThrow(() => ledgerLine("manage_todos", bad, { ok: true }));
    assert.doesNotThrow(() => ledgerLine("generate_document", bad, bad));
  }
  // 缺 title 的 add 不该编出「undefined」字样
  const line = ledgerLine("manage_todos", { action: "add", items: [{}] }, { ok: true });
  assert.ok(!line?.includes("undefined"), `不该出现 undefined，实际 ${line}`);
});

// ── 队列：去重、条数上限、行宽上限 ───────────────────────

test("pushLedger：同一事实重复出现只保留最新位置（台账表达当前状态，不是流水账）", () => {
  let e = pushLedger(undefined, "【待办】已添加待办「交高数作业」", 1);
  e = pushLedger(e, "【知识库】已入库知识「洛必达法则」", 2);
  e = pushLedger(e, "【待办】已添加待办「交高数作业」", 3);
  assert.equal(e.length, 2, "重复事实应去重");
  assert.equal(e[1]?.line, "【待办】已添加待办「交高数作业」", "重复项应移到尾部（最新位置）");
});

test("pushLedger：落盘上限 LEDGER_MAX，超出丢最旧", () => {
  let e: ReturnType<typeof pushLedger> = [];
  for (let i = 1; i <= LEDGER_MAX + 5; i++) e = pushLedger(e, `【待办】条目${i}`, i);
  assert.equal(e.length, LEDGER_MAX);
  assert.equal(e[0]?.line, "【待办】条目6", "最旧的 5 条应被丢掉");
  assert.equal(e[e.length - 1]?.line, `【待办】条目${LEDGER_MAX + 5}`);
});

test("行宽截断：超长摘要压到一行内且带省略号", () => {
  // 硬编码超长串（不用拼接：这里要的就是「工具会返回一长串」的形状）
  const long =
    "已添加待办「期末复习高数A线期末考试重点范围整理与错题归因分析及对策逐条梳理报告合集」";
  assert.ok(long.length > 42, `样本必须超出行宽上限，实际 ${long.length} 字`);
  const line = pushLedger(undefined, long, 1)[0]?.line ?? "";
  assert.ok(line.length <= 42, `台账行应 ≤42 字，实际 ${line.length}`);
  assert.ok(line.endsWith("…"), `截断应带省略号，实际末尾：${line.slice(-6)}`);
});

// ── 渲染成提示词块 ───────────────────────────────────────

test("ledgerBlock：无条目返回空串（不留多余空行）", () => {
  assert.equal(ledgerBlock(undefined), "");
  assert.equal(ledgerBlock([]), "");
});

test("ledgerBlock：渲染最近 LEDGER_RENDER 条，并带「已生效、别否认」的措辞", () => {
  let e: ReturnType<typeof pushLedger> = [];
  for (let i = 1; i <= 12; i++) e = pushLedger(e, `【待办】条目${i}`, i);
  const block = ledgerBlock(e);
  const lines = block.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, LEDGER_RENDER, `只渲染最近 ${LEDGER_RENDER} 条`);
  assert.ok(lines[0]?.includes("条目5"), `最旧可见条目应是第 5 条，实际 ${lines[0]}`);
  assert.ok(!block.includes("条目4"), "第 4 条应已被截掉");
  // 措辞必须明确「已写入本地」与「别否认」，否则模型仍会说「还没记过」
  assert.match(block, /已生效|已写入本地/);
  assert.match(block, /不要重复执行/);
  assert.match(block, /还没记过/);
});

test("ledgerBlock 拼在用户消息尾部时前后不粘连（自带首尾换行）", () => {
  const block = ledgerBlock(pushLedger(undefined, "【待办】已添加待办「a」", 1));
  assert.ok(block.startsWith("\n\n"), "应以空行开头，与用户消息分开");
  const merged = ["帮我看看这周啥安排", block].join("");
  assert.ok(merged.includes("帮我看看这周啥安排\n\n["), "拼接后用户消息与台账块之间应有空行");
});

// ── 漂移钉：闭集里的工具名必须真实存在 ───────────────────

test("闭集登记的工具名都是真实装配给 agent 的工具（重命名工具会让闭集静默失效）", async (t) => {
  // 装配口径与 agent.ts 一致：coreTools + school().tools——set_holidays 就
  // 挂在适配器（custom 的 schedule.ts）下，不在 coreTools 里
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-ledger-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.RAPTOR_DATA_DIR = dir;

  const { coreTools } = await import("../src/core/tools");
  await import("../src/adapters"); // 装默认适配器（school() 依赖它）
  const { school } = await import("../src/core/school");
  const assembled: Record<string, unknown> = { ...coreTools, ...school().tools };

  for (const name of [
    "manage_todos",
    "manage_knowledge",
    "save_memory",
    "set_holidays",
    "manage_pomodoro",
    "edit_schedule",
    "edit_exams",
    "edit_grades",
    "manage_prompts",
    "generate_document",
    "convert_document",
    "export_schedule_image",
  ]) {
    assert.ok(name in assembled, `台账登记了未装配的工具：${name}`);
  }
});

// ── 会话档案落盘接线 ─────────────────────────────────────

test("appendRound 落台账并能读回；不传 ledger 时保持原样", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.RAPTOR_DATA_DIR = dir;

  const { appendRound, ledgerOf } = await import("../src/core/chat-sessions");

  assert.deepEqual(ledgerOf("default"), [], "新会话台账应为空");
  assert.equal(ledgerBlock(ledgerOf("default")), "", "新会话不该渲染出台账块");

  appendRound("s1", "记一下周五交实验报告", "好的，已记下", null, {
    ledger: ["【待办】已添加待办「交实验报告」"],
  });
  appendRound("s1", "这周还有啥待办", "还有一条高数作业", null);

  const ledger = ledgerOf("s1");
  assert.equal(ledger.length, 1, "第二轮没传 ledger 就不该凭空多一条");
  assert.equal(ledger[0]?.line, "【待办】已添加待办「交实验报告」");

  // 落盘形状：台账与会话同文件、重启后仍在
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "chat-sessions.json"), "utf8")) as {
    sessions: Array<{ id: string; ledger?: Array<{ line: string }>; messages?: unknown[] }>;
  };
  const s1 = raw.sessions.find((s) => s.id === "s1");
  assert.equal(s1?.ledger?.[0]?.line, "【待办】已添加待办「交实验报告」", "台账应随会话档案落盘");

  // 台账与 messages 是两个字段——混在一起模型会把事实清单当成聊天记录
  assert.ok(Array.isArray(s1?.messages), "messages 应仍是独立字段");
});

test("台账随会话删除一并消失（resetAll 清空，不留孤儿事实）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-ledger2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.RAPTOR_DATA_DIR = dir;

  const { appendRound, ledgerOf, resetAll } = await import("../src/core/chat-sessions");
  appendRound("s1", "记一下", "好", null, { ledger: ["【待办】已添加待办「a」"] });
  assert.equal(ledgerOf("s1").length, 1);
  resetAll();
  assert.deepEqual(ledgerOf("s1"), [], "清空后不该残留台账（否则模型会断言已做但其实没做）");
});
