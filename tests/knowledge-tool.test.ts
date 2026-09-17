/**
 * manage_knowledge 工具测试：对话里说的知识落进 data/knowledge.json，
 * 课程归类只认课表缓存里的真实课程，对不上保持未分类。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-knowledge-"));
process.env.RAPTOR_DATA_DIR = tmpData;

// 课表缓存先落盘：分类只认这里的课程
fs.writeFileSync(
  path.join(tmpData, "schedule-cache.json"),
  JSON.stringify({
    savedAt: Date.now(),
    schedule: {
      year: 2026,
      semester: 3,
      label: "2026-2027学年第一学期",
      courses: [
        {
          title: "高等数学(上)",
          weekday: 1,
          periods: [1, 2],
          weeks: "1-16",
          location: "",
          teacher: "",
        },
        {
          title: "高等数学(下)",
          weekday: 3,
          periods: [3, 4],
          weeks: "1-16",
          location: "",
          teacher: "",
        },
        {
          title: "大学英语",
          weekday: 2,
          periods: [5, 6],
          weeks: "1-16(单)",
          location: "",
          teacher: "",
        },
        {
          title: "线性代数",
          weekday: 4,
          periods: [7, 8],
          weeks: "1-16",
          location: "",
          teacher: "",
        },
      ],
    },
  }),
  "utf8",
);

const { raptorTools } = await import("../src/tools");
const { listKnowledge } = await import("../src/knowledge");

const manage = raptorTools.manage_knowledge as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

test("add：subject 提示、正文匹配、未匹配三种归类路径", async () => {
  const r = await manage.execute({
    action: "add",
    items: [
      // 俗称「高数」+ 课表里 (上)/(下) 合并：归入规范名「高等数学」
      { title: "洛必达法则", content: "0/0 型极限可以对分子分母分别求导再取极限", subject: "高数" },
      // 不给 subject，正文里提到课程名也能自动归类
      { title: "现在完成时", content: "have/has + 过去分词，大学英语常考的时态" },
      // 既无提示也对不上任何课程：保持未分类
      { title: "番茄工作法", content: "25 分钟专注加 5 分钟休息" },
    ],
  });
  assert.equal(r.ok, true);
  assert.match(String(r.summary), /已记录 3 条知识/);
  assert.match(String(r.summary), /高等数学 ×1/);
  assert.match(String(r.summary), /未分类 ×1/);
  const saved = r.saved as Array<{ title: string; category: string | null }>;
  assert.equal(saved.find((e) => e.title === "洛必达法则")?.category, "高等数学");
  assert.equal(saved.find((e) => e.title === "现在完成时")?.category, "大学英语");
  assert.equal(saved.find((e) => e.title === "番茄工作法")?.category, null);
  assert.equal(listKnowledge().length, 3);
});

test("add 参数校验：缺条目、空标题、超上限都拒绝且不落盘", async () => {
  assert.match(String((await manage.execute({ action: "add" })).error), /items/);
  const empty = await manage.execute({
    action: "add",
    items: [{ title: "  ", content: "有内容没标题" }],
  });
  assert.match(String(empty.error), /标题与内容/);
  const many = await manage.execute({
    action: "add",
    items: Array.from({ length: 11 }, (_, i) => ({ title: `凑数${i}`, content: "x" })),
  });
  assert.match(String(many.error), /最多记录 10 条/);
  assert.equal(listKnowledge().length, 3, "被拒绝的调用不能留下半成品");
});

test("同名知识去重：再次 add 是覆盖更新而不是堆积", async () => {
  const again = await manage.execute({
    action: "add",
    items: [
      { title: "洛必达法则", content: "更新后的表述：0/0 与 ∞/∞ 型都适用", subject: "高等数学" },
    ],
  });
  assert.match(String(again.summary), /更新 1 条同名知识/);
  assert.equal(listKnowledge().length, 3);
  const hit = listKnowledge().find((e) => e.title === "洛必达法则");
  assert.match(hit?.content ?? "", /更新后的表述/);
  // 标题忽略空白与大小写也算同名
  await manage.execute({
    action: "add",
    items: [{ title: "番茄 工作法", content: "改名空格版" }],
  });
  assert.equal(listKnowledge().length, 3);
});

test("list：默认全量、category/keyword 可筛、带分类统计", async () => {
  const all = await manage.execute({ action: "list" });
  assert.match(String(all.summary), /共 3 条知识/);
  const categories = all.categories as Array<{ category: string; count: number }>;
  assert.ok(categories.some((c) => c.category === "高等数学" && c.count === 1));
  assert.ok(categories.some((c) => c.category === "未分类" && c.count === 1));

  const math = await manage.execute({ action: "list", category: "高等数学" });
  const items = math.knowledge as Array<{ title: string }>;
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "洛必达法则");

  const none = await manage.execute({ action: "list", category: "" });
  assert.equal((none.knowledge as unknown[]).length, 1, "空字符串表示只看未分类");

  const kw = await manage.execute({ action: "list", keyword: "过去分词" });
  assert.equal((kw.knowledge as Array<{ title: string }>)[0].title, "现在完成时");

  const miss = await manage.execute({ action: "list", keyword: "不存在的关键词" });
  assert.match(String(miss.note), /空/);
});

test("update 改内容与归属、delete 按 id 删除、错误路径", async () => {
  const listed = await manage.execute({ action: "list" });
  const items = listed.knowledge as Array<{ id: string; title: string }>;
  const taylor = items.find((e) => e.title === "洛必达法则")!;

  const moved = await manage.execute({ action: "update", id: taylor.id, subject: "线性代数" });
  assert.equal(moved.ok, true);
  assert.match(String(moved.summary), /线性代数/);
  const changed = (moved as { updated: { category: string | null } }).updated;
  assert.equal(changed.category, "线性代数");

  // 对不上课表课程的 subject：落回未分类，不编造课程名
  const miss = await manage.execute({ action: "update", id: taylor.id, subject: "美食烹饪" });
  assert.equal((miss as { updated: { category: string | null } }).updated.category, null);

  const del = await manage.execute({ action: "delete", id: taylor.id });
  assert.equal(del.ok, true);
  assert.match(String((await manage.execute({ action: "delete", id: taylor.id })).error), /未找到/);
  assert.equal(listKnowledge().length, 2);

  assert.match(String((await manage.execute({ action: "update", content: "x" })).error), /id/);
  assert.match(String((await manage.execute({ action: "delete" })).error), /id/);
  assert.match(
    String((await manage.execute({ action: "update", id: "ghost", content: "x" })).error),
    /未找到/,
  );
});
