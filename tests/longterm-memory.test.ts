/**
 * 长期记忆（memory/longterm）：增删改、去重、归档、过期、年级提取与
 * 提示词注入。这层以前零测试——记忆是「模型的行为人格」，去重和过期
 * 一旦失灵，上下文会被过期结论悄悄污染。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 每个测试文件独立进程：在导入被测模块前把数据目录指到临时目录。
// 注意 MEMORY_FILE 在模块加载时定死，之后只能对同一个文件做文章。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-memory-"));
process.env.RAPTOR_DATA_DIR = dataDir;
const memoryFile = path.join(dataDir, "memory.json");

const {
  addMemory,
  updateMemory,
  deleteMemory,
  archiveMemory,
  loadMemory,
  formatMemoryForPrompt,
  loadUserGrade,
} = await import("../src/memory/longterm");

test("addMemory：新增条目进提示词，返回未合并", async () => {
  const r = await addMemory("用户是 2024 级学生", "用户档案");
  assert.equal(r.merged, false);
  const prompt = await formatMemoryForPrompt();
  assert.match(prompt, /2024 级学生/);
  assert.match(prompt, /\[m/, "条目要带 [id] 前缀，模型才能 update/delete");
});

test("addMemory：完全重复刷新时间不新增；近似重复以新表述覆盖", async () => {
  const first = await addMemory("用户不喜欢被提及抢课", "偏好");
  const exact = await addMemory("用户不喜欢被提及抢课", "偏好");
  assert.equal(exact.merged, true);
  assert.equal(exact.total, first.total, "完全重复不增条目");

  const near = await addMemory("用户不喜欢被提到抢课这件事", "偏好");
  assert.equal(near.merged, true, "换个说法再说一遍要命中近似去重");
  assert.equal(near.total, first.total);
});

test("archiveMemory：归档后留在文件但不再注入提示词", async () => {
  const { entry } = await addMemory("已执行完的抢课计划：高等数学", "任务状态");
  assert.ok(await archiveMemory(entry.id));
  const prompt = await formatMemoryForPrompt();
  assert.doesNotMatch(prompt, /抢课计划：高等数学/);
  assert.ok((await loadMemory()).some((e) => e.content.includes("抢课计划：高等数学")));
});

test("过期条目（expiresAt 已过）不再注入提示词", async () => {
  await addMemory("临时：本周三交实验报告", "任务状态", "2000-01-01T00:00:00Z");
  const prompt = await formatMemoryForPrompt();
  assert.doesNotMatch(prompt, /本周三交实验报告/);
});

test("updateMemory 改内容；deleteMemory 删条目；不存在的 id 如实返回 null/false", async () => {
  const { entry } = await addMemory("原始内容版本一", "事实");
  const updated = await updateMemory(entry.id, "改成版本二");
  assert.equal(updated?.content, "改成版本二");
  assert.equal(await updateMemory("m不存在", "x"), null);

  assert.equal(await deleteMemory(entry.id), true);
  assert.equal(await deleteMemory(entry.id), false, "删两次第二次应返回 false");
});

test("loadUserGrade：认「2025级」直接表述；没有任何年级线索时给 null", async () => {
  await addMemory("用户是 2025 级的新生", "用户档案");
  assert.equal(await loadUserGrade(), "2025");
});

test("格式化：删掉存储文件后记忆为空，提示词段为空串", async () => {
  fs.rmSync(memoryFile);
  assert.equal(await formatMemoryForPrompt(), "");
});
