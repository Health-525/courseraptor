/**
 * 学习教练（meta-learning）内置测试：
 * - 六篇方法论文档完整可用（id 唯一、内容非空、场景说明齐全）
 * - read_learning_reference 工具注册进 coreTools 且按 id 返回对应文档
 * - basePrompt 带触发规则：学习类对话切换学习教练模式
 * 方法论与 skills/meta-learning/references/ 同源，防两边漂移。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-learning-"));
process.env.RAPTOR_DATA_DIR = tmpData;

// basePrompt 依赖学校适配器（school()），先装配入口（与 prompt.test.ts 同约定）
await import("../src/adapters");
const { LEARNING_REFERENCES, learningReferenceMenu } = await import("../src/core/learning");
const { coreTools } = await import("../src/core/tools");
const { basePrompt } = await import("../src/core/prompt");

test("参考库：六篇文档 id 唯一、标题/场景/内容齐全", () => {
  assert.equal(LEARNING_REFERENCES.length, 6, "应为六篇方法论文档");
  const ids = LEARNING_REFERENCES.map((r) => r.id);
  assert.equal(new Set(ids).size, 6, "id 不得重复");
  for (const r of LEARNING_REFERENCES) {
    assert.ok(r.id && r.title && r.when, `${r.id} 元信息应齐全`);
    assert.ok(r.content.length > 300, `${r.id} 内容不应为空壳`);
    assert.match(r.content, /^# /, `${r.id} 内容应保留原文标题`);
  }
  // 与 skills/meta-learning/references/ 的文件名对齐（同步契约）
  const src = fs
    .readdirSync(path.join(import.meta.dirname, "..", "skills", "meta-learning", "references"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  assert.deepEqual(
    [...ids].sort(),
    src,
    "src/core/learning.ts 的 id 应与 skills/meta-learning/references/ 文件名一一对应",
  );
});

test("工具接线：read_learning_reference 注册且按 id 返回文档", async () => {
  const read = coreTools.read_learning_reference as unknown as {
    execute: (input: { doc: string }) => Promise<Record<string, unknown>>;
  };
  assert.ok(read, "read_learning_reference 应注册进 coreTools");

  const exams = (await read.execute({ doc: "exam-strategies" })) as {
    title?: string;
    content?: string;
    error?: string;
  };
  assert.equal(exams.title, "考试专项策略");
  assert.match(exams.content ?? "", /错题归因/, "备考篇应含错题归因策略");
  assert.match(exams.content ?? "", /主动回忆训练/);

  const structure = (await read.execute({ doc: "knowledge-structure-assessment" })) as {
    content?: string;
  };
  assert.match(structure.content ?? "", /五维诊断/, "结构诊断篇应含五维诊断");

  const miss = (await read.execute({ doc: "no-such-doc" })) as { error?: string };
  assert.match(miss.error ?? "", /没有这篇参考/, "未知 id 应明确报错并列出可用项");
});

test("工具描述：场景→篇目对照拼进 description，指导按需选篇", () => {
  const menu = learningReferenceMenu();
  assert.match(menu, /备考[^；]*→exam-strategies/);
  assert.match(menu, /讲解知识点[^；]*→deep-understanding/);
  assert.match(
    String((coreTools.read_learning_reference as { description?: string }).description),
    /学习类对话中按需取一篇/,
    "工具 description 应包含选篇指南",
  );
});

test("提示词：学习教练触发规则进 basePrompt，且强调方法论走工具按需取", () => {
  const s = basePrompt(false);
  assert.match(s, /学习教练/, "应有学习教练段");
  assert.match(s, /触发场景/, "应写明什么对话切换到此模式");
  assert.match(s, /直觉先于形式/, "应带教学核心原则");
  assert.match(s, /read_learning_reference/, "方法论细节应指到按需加载工具");
  assert.match(s, /get_exams/, "备考规划应先查真实考试安排");
  assert.match(s, /普通问答不套用/, "应防止非学习对话误触发");
});
