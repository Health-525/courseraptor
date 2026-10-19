/**
 * 技能库测试（read_skill）
 *
 * 钉住：allowlist、防漂移、无 OpenMAIC 幽灵工具名、工具接线、提示词路由。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { GHOST_TOOLS, SKILL_SOURCES, sanitizeBody } from "../scripts/skill-library-source";

await import("../src/adapters");

const { SKILL_LIBRARY, skillLibraryMenu } = await import("../src/core/skill-library");
const { coreTools } = await import("../src/core/tools");
const { basePrompt } = await import("../src/core/prompt");

const SKILLS_DIR = path.join(import.meta.dirname, "..", "skills");

const EXPECTED_IDS = [
  "feynman-learning",
  "learning-to-learn",
  "zone-of-proximal-development",
  "understanding-by-design",
  "spiral-curriculum",
  "curriculum-planner",
  "export-schedule",
  "ai-news",
];

test("技能库：allowlist 8 篇，id 唯一、原文平级在 skills/<id>/", () => {
  assert.equal(SKILL_LIBRARY.length, 8);
  assert.equal(SKILL_SOURCES.length, SKILL_LIBRARY.length);
  const ids = SKILL_LIBRARY.map((s) => s.id);
  assert.deepEqual([...ids].sort(), [...EXPECTED_IDS].sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const s of SKILL_LIBRARY) {
    assert.ok(s.id && s.title && s.when, `${s.id} 元信息应齐全`);
    assert.ok(s.content.length > 400, `${s.id} 正文不应为空壳`);
    assert.match(s.content, /^# /, `${s.id} 正文应保留原文标题`);
    assert.ok(
      fs.existsSync(path.join(SKILLS_DIR, s.id, "SKILL.md")),
      `${s.id} 应在 skills/${s.id}/ 留有原文`,
    );
  }
});

test("防漂移：生成物 = 原文经清洗规则处理后的结果", () => {
  for (const s of SKILL_LIBRARY) {
    const raw = fs.readFileSync(path.join(SKILLS_DIR, s.id, "SKILL.md"), "utf8");
    assert.equal(
      s.content,
      sanitizeBody(s.id, raw, SKILL_SOURCES),
      `${s.id} 生成物与清洗结果不符——重跑 node --import tsx scripts/build-skill-library.ts`,
    );
  }
});

test("无幻觉诱饵：入库正文不得残留 OpenMAIC 专有工具名", () => {
  for (const s of SKILL_LIBRARY) {
    for (const ghost of GHOST_TOOLS) {
      assert.ok(!s.content.includes(ghost), `${s.id} 正文出现 ${ghost}`);
    }
  }
});

test("收录边界：不收讲法课型与课堂构建类", () => {
  const ids = new Set(SKILL_LIBRARY.map((s) => s.id));
  for (const banned of [
    "lecture-style",
    "workshop-style",
    "vocational",
    "deep-interactive",
    "stage-design",
    "slide-dsl",
    "pptx-import",
    "social-emotional-learning",
    "build-personal-skill",
    "fact-check",
    "deep-research",
    "k12-core-literacy-planning",
  ]) {
    assert.ok(!ids.has(banned), `${banned} 不应进本期技能库`);
  }
});

test("工具接线：read_skill 注册、按 id 返回、未知 id 报错", async () => {
  const read = coreTools.read_skill as unknown as {
    description?: string;
    execute: (input: { skill: string }) => Promise<Record<string, unknown>>;
  };
  assert.ok(read, "read_skill 应注册进 coreTools");
  assert.match(read.description ?? "", /技能库/, "描述应点明是什么");
  assert.ok(!("read_learning_reference" in coreTools), "旧学习教练工具应已移除");
  assert.ok(!("ppt_save" in coreTools), "PPT 工具应已从 agent 下线");
  assert.ok("export_schedule_image" in coreTools, "课表图工具应注册");

  const doc = SKILL_LIBRARY.find((s) => s.id === "feynman-learning");
  assert.ok(doc);
  const got = (await read.execute({ skill: doc.id })) as {
    id?: string;
    title?: string;
    content?: string;
  };
  assert.equal(got.id, doc.id);
  assert.equal(got.title, doc.title);
  assert.equal(got.content, doc.content);

  const miss = (await read.execute({ skill: "no-such-skill" })) as { error?: string };
  assert.match(miss.error ?? "", /没有这篇 skill/);
});

test("菜单与提示词路由：场景对照进 description，提示词指向 read_skill", () => {
  const menu = skillLibraryMenu();
  assert.match(menu, /→feynman-learning/);
  assert.match(menu, /→export-schedule/);
  assert.match(menu, /→zone-of-proximal-development/);

  const desc = String((coreTools.read_skill as { description?: string }).description ?? "");
  for (const s of SKILL_LIBRARY) {
    assert.ok(desc.includes(s.id), `工具描述应列出 ${s.id}`);
  }

  const s = basePrompt();
  assert.match(s, /read_skill/, "学习辅导应指向 read_skill");
  assert.match(s, /export_schedule_image/, "应指向课表图工具");
  assert.doesNotMatch(s, /ppt_preview|ppt_save/, "提示词不应再推销 PPT 工具");
  assert.doesNotMatch(s, /read_learning_reference|学习教练/, "旧学习教练话术应清除");
});
