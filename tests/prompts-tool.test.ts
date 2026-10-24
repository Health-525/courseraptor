/**
 * manage_prompts 工具测试：提示词模板的增删改与默认清单语义——
 * 没存过时生效清单即默认模板，update/delete 先固化默认再改，
 * 删空/reset 回默认清单（credentialsStore.webQuickQuestions 的既定约定）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-prompts-"));
process.env.RAPTOR_DATA_DIR = tmpData;
process.env.RAPTOR_CREDENTIALS_FILE = path.join(tmpData, "credentials.enc");

const { coreTools } = await import("../src/core/tools");
const { loadCredentialsStore } = await import("../src/core/credentials");
const { DEFAULT_QUESTIONS } = await import("../src/core/quick-questions");

const manage = coreTools.manage_prompts as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

test("list：未自定义时给默认清单并说明", async () => {
  const r = await manage.execute({ action: "list" });
  const prompts = r.prompts as Array<Record<string, unknown>>;
  assert.equal(prompts.length, DEFAULT_QUESTIONS.length);
  assert.equal(prompts[0]?.text, DEFAULT_QUESTIONS[0]);
  assert.ok(String(r.note).includes("还没自定义"));
});

test("add：保存为自定义清单，读回生效清单一致", async () => {
  const r = await manage.execute({ action: "add", items: ["帮我复习高数", "  整理本周待办  "] });
  assert.equal(r.ok, true);
  const stored = loadCredentialsStore()?.webQuickQuestions;
  assert.deepEqual(stored, [...DEFAULT_QUESTIONS, "帮我复习高数", "整理本周待办"]);
});

test("add 重复与超长拒绝，不落盘", async () => {
  const dup = await manage.execute({ action: "add", items: ["帮我复习高数"] });
  assert.ok(String(dup.error).includes("已经在清单里"));

  const long = await manage.execute({ action: "add", items: ["x".repeat(61)] });
  assert.ok(String(long.error).includes("上限"));
});

test("update：按 id 改默认条目（默认清单先固化再改）", async () => {
  // 重置回默认后改第 0 条
  await manage.execute({ action: "reset" });
  const r = await manage.execute({ action: "update", id: "0", text: "今天有什么安排（详细版）" });
  assert.equal(r.ok, true);
  const stored = loadCredentialsStore()?.webQuickQuestions;
  assert.equal(stored?.[0], "今天有什么安排（详细版）");
  assert.equal(stored?.length, DEFAULT_QUESTIONS.length);
});

test("delete：删单条生效，删空回默认清单", async () => {
  await manage.execute({ action: "add", items: ["临时提示词"] });
  const total = DEFAULT_QUESTIONS.length + 1;
  const r = await manage.execute({ action: "delete", ids: [String(total - 1)] });
  assert.equal(r.ok, true);
  assert.equal(loadCredentialsStore()?.webQuickQuestions?.length, DEFAULT_QUESTIONS.length);

  const ids = DEFAULT_QUESTIONS.map((_, i) => String(i));
  const empty = await manage.execute({ action: "delete", ids });
  assert.equal(empty.ok, true);
  // 空清单按设计回默认：存储为空数组，生效清单即默认
  assert.deepEqual(loadCredentialsStore()?.webQuickQuestions, []);
  const prompts = empty.prompts as Array<Record<string, unknown>>;
  assert.equal(prompts.length, DEFAULT_QUESTIONS.length);
});

test("reset：恢复默认清单", async () => {
  await manage.execute({ action: "add", items: ["再记一条"] });
  const r = await manage.execute({ action: "reset" });
  assert.equal(r.ok, true);
  assert.deepEqual(loadCredentialsStore()?.webQuickQuestions, []);
  const prompts = r.prompts as Array<Record<string, unknown>>;
  assert.equal(prompts[0]?.text, DEFAULT_QUESTIONS[0]);
});

test("add 超量（>12 条）拒绝并提示先删", async () => {
  await manage.execute({ action: "reset" });
  // 默认 7 条 + 5 条 = 12 条（上限），再加 1 条必须被拒
  const fill = Array.from({ length: 5 }, (_, i) => `自定义提示 ${i + 1}`);
  const filled = await manage.execute({ action: "add", items: fill });
  assert.equal(filled.ok, true);
  const overflow = await manage.execute({ action: "add", items: ["第 13 条"] });
  assert.ok(String(overflow.error).includes("最多"));
});
