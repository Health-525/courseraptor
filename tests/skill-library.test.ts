/**
 * 教学法技能库测试（read_skill）
 *
 * 钉住五件事：
 * 1. 库本身：id 唯一、元信息齐全、正文非空壳、原文仍在 skills/openmaic/；
 * 2. **防漂移**：生成物 = 原文经 skill-library-source.ts 清洗后的结果，
 *    改了原文没重跑生成脚本（或反之）这里就红；
 * 3. **无幻觉诱饵**：入库正文不得残留 OpenMAIC 专有工具名（create_stage 等），
 *    也不得收录课堂构建类/不适用者——它们会让模型去调不存在的工具；
 * 4. 工具接线：read_skill 注册、按 id 返回、未知 id 报错；
 * 5. 菜单与提示词路由：场景对照进 description，提示词指向 read_skill。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { GHOST_TOOLS, SKILL_SOURCES, sanitizeBody } from "../scripts/skill-library-source";

// basePrompt 需要先装配学校适配器（与 prompt.test.ts 同一前置）
await import("../src/adapters");

const { SKILL_LIBRARY, skillLibraryMenu } = await import("../src/core/skill-library");
const { coreTools } = await import("../src/core/tools");
const { basePrompt } = await import("../src/core/prompt");

const SRC_DIR = path.join(import.meta.dirname, "..", "skills", "openmaic");

test("技能库：10 篇教学法 skill，id 唯一、元信息齐全、正文非空壳", () => {
  assert.equal(SKILL_LIBRARY.length, 10, "应为 10 篇教学法与讲法 skill");
  assert.equal(SKILL_SOURCES.length, SKILL_LIBRARY.length, "清单与生成物数量应一致");
  const ids = SKILL_LIBRARY.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "id 不得重复");
  for (const s of SKILL_LIBRARY) {
    assert.ok(s.id && s.title && s.when, `${s.id} 元信息应齐全`);
    assert.ok(s.content.length > 700, `${s.id} 正文不应为空壳`);
    assert.match(s.content, /^# /, `${s.id} 正文应保留原文标题`);
    assert.ok(
      fs.existsSync(path.join(SRC_DIR, s.id, "SKILL.md")),
      `${s.id} 应在 skills/openmaic/ 留有原文`,
    );
  }
});

test("防漂移：生成物 = 原文经清洗规则处理后的结果", () => {
  for (const s of SKILL_LIBRARY) {
    const raw = fs.readFileSync(path.join(SRC_DIR, s.id, "SKILL.md"), "utf8");
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
      assert.ok(!s.content.includes(ghost), `${s.id} 正文出现 ${ghost}，模型可能据此编造调用`);
    }
  }
});

test("收录边界：不收课堂构建类与不适用者", () => {
  const ids = new Set(SKILL_LIBRARY.map((s) => s.id));
  for (const banned of [
    "stage-design", // 引用 create_stage/set_roster/generate_scene
    "stage-dsl",
    "slide-dsl",
    "page-clone",
    "pro-editing",
    "style-clone",
    "teacher-style-clone",
    "pptx-import",
    "k12-core-literacy-planning", // 中小学课标，场景不符
    "deep-research", // 要求联网检索，本项目无 web_search
    "curriculum-planner", // 骨架就是平台流程；其「先签核后执行」已进 basePrompt
    "zone-of-proximal-development", // 已改写为 meta-learning 第七篇参考
    "fact-check", // 已进 basePrompt「事实纪律」段
  ]) {
    assert.ok(!ids.has(banned), `${banned} 不应进技能库`);
  }
});

test("工具接线：read_skill 注册、按 id 返回原文、未知 id 报错", async () => {
  const read = coreTools.read_skill as unknown as {
    description?: string;
    execute: (input: { skill: string }) => Promise<Record<string, unknown>>;
  };
  assert.ok(read, "read_skill 应注册进 coreTools");
  assert.match(read.description ?? "", /教学法技能库/, "描述应点明是什么");
  assert.match(read.description ?? "", /read_learning_reference/, "应说明与学习参考的分工");

  const doc = SKILL_LIBRARY[0];
  assert.ok(doc, "技能库不应为空");
  const got = (await read.execute({ skill: doc.id })) as {
    id?: string;
    title?: string;
    content?: string;
  };
  assert.equal(got.id, doc.id);
  assert.equal(got.title, doc.title);
  assert.equal(got.content, doc.content);

  const miss = (await read.execute({ skill: "no-such-skill" })) as { error?: string };
  assert.match(miss.error ?? "", /没有这篇 skill/, "未知 id 应报错并列出可用项");
});

test("菜单与提示词路由：场景对照进 description，提示词指向 read_skill", () => {
  const menu = skillLibraryMenu();
  assert.match(menu, /→feynman-learning/);
  assert.match(menu, /→lecture-style/);

  const desc = String((coreTools.read_skill as { description?: string }).description ?? "");
  for (const s of SKILL_LIBRARY) {
    assert.ok(desc.includes(s.id), `工具描述应列出 ${s.id}`);
  }

  const s = basePrompt();
  assert.match(s, /read_skill/, "学习教练段应指向 read_skill");
  assert.match(s, /教学流程与讲法/, "应说明什么场景去调它");
});
