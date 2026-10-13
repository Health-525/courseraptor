/**
 * 中文短句规则引擎测试：parseGraphRules 认得哪些句式、认不出时是否老实
 * 返回空（宁可漏给模型，不可瞎猜），以及 applyGraphOps 的实际落库效果。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-graph-rules-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { parseGraphRules, applyGraphOps, MUTATING_EVENT_RE } = await import(
  "../src/core/graph-rules"
);
const store = await import("../src/core/graph-store");

/** 每个用例一本干净的书，互不干扰 */
function freshBook(title: string): string {
  return store.createBook(title).id;
}

test("「A 是 B 的 X」：血缘关系有向", () => {
  const ops = parseGraphRules("张三是李四的父亲");
  assert.equal(ops.length, 1);
  const op = ops[0];
  assert.equal(op?.op, "relation");
  if (op?.op !== "relation") return;
  assert.equal(op.from, "张三");
  assert.equal(op.to, "李四");
  assert.equal(op.label, "父亲");
  assert.equal(op.category, "family");
  assert.equal(op.directed, true, "父子关系有方向");
  assert.equal(op.evidence, "张三是李四的父亲", "原句应留作证据");
});

test("「A 的 X 是 B」：反向解析成 B 是 A 的 X", () => {
  const ops = parseGraphRules("李四的父亲是张三");
  const op = ops[0];
  assert.equal(op?.op, "relation");
  if (op?.op !== "relation") return;
  assert.equal(op.from, "张三", "B 是 A 的父亲 → A 发出");
  assert.equal(op.to, "李四");
  assert.equal(op.label, "父亲");
});

test("「A 和 B 是 X」：友情无向，血缘有向", () => {
  const friend = parseGraphRules("王五和赵六是同窗");
  const f = friend[0];
  assert.equal(f?.op, "relation");
  if (f?.op === "relation") {
    assert.equal(f.category, "friendship");
    assert.equal(f.directed, false, "同窗对称，不该画箭头");
  }

  // 同一句式但关系词是有向的，仍应有向
  const father = parseGraphRules("王五和赵六是仇人");
  const f2 = father[0];
  if (f2?.op === "relation") assert.equal(f2.directed, true, "仇人未必对称");
});

test("情感动词：「A 暗恋 B」", () => {
  const ops = parseGraphRules("贾宝玉暗恋林黛玉");
  const op = ops[0];
  assert.equal(op?.op, "relation");
  if (op?.op !== "relation") return;
  assert.equal(op.from, "贾宝玉");
  assert.equal(op.to, "林黛玉");
  assert.equal(op.label, "暗恋");
  assert.equal(op.category, "romance");
  assert.equal(op.directed, true);
});

test("别名：「A 又叫 B」与「A 就是 B」", () => {
  const alias = parseGraphRules("宝玉又叫宝二爷");
  assert.equal(alias[0]?.op, "alias");
  if (alias[0]?.op === "alias") {
    assert.equal(alias[0].name, "宝玉");
    assert.equal(alias[0].alias, "宝二爷");
  }
  assert.equal(parseGraphRules("宝玉就是宝二爷")[0]?.op, "alias");
});

test("改名：把 A 改叫 B", () => {
  const ops = parseGraphRules("把张三改叫张小明");
  assert.equal(ops[0]?.op, "rename_person");
  if (ops[0]?.op !== "rename_person") return;
  assert.equal(ops[0].name, "张三");
  assert.equal(ops[0].newName, "张小明");
});

test("删除人物与删除关系走不同路径", () => {
  const delPerson = parseGraphRules("删除张三");
  assert.equal(delPerson[0]?.op, "delete_person");
  if (delPerson[0]?.op === "delete_person") assert.equal(delPerson[0].name, "张三");

  const delRel = parseGraphRules("删掉张三和李四的仇人关系");
  assert.equal(delRel[0]?.op, "delete_relation");
  if (delRel[0]?.op === "delete_relation") {
    assert.equal(delRel[0].from, "张三");
    assert.equal(delRel[0].to, "李四");
    assert.equal(delRel[0].label, "仇人");
  }
});

test("清空图谱只认明确指令，模糊说法不动手", () => {
  assert.equal(parseGraphRules("清空图谱")[0]?.op, "clear_graph");
  assert.equal(parseGraphRules("全部删掉重来")[0]?.op, "clear_graph");

  // 含糊说法必须不产操作——这是不可恢复的危险动作，宁可漏
  assert.deepEqual(parseGraphRules("我不想看到这些人了"), []);
  assert.deepEqual(parseGraphRules("删掉重新开始吧"), []);
});

test("认不出的句子老实返回空数组，交给模型", () => {
  assert.deepEqual(parseGraphRules("今天天气不错"), []);
  assert.deepEqual(parseGraphRules("帮我看下这周有什么课"), []);
  // 关系词不在闭集内也不硬塞进「其他」
  assert.deepEqual(parseGraphRules("张三是李四的宿命"), []);
});

test("代词与停用词不当人名：不会把「他」建成人物", () => {
  assert.deepEqual(parseGraphRules("他和她是同窗"), []);
});

test("一段多句：逐句拆成多个操作", () => {
  const ops = parseGraphRules("张三是李四的父亲。王五是赵六的仇人。宝玉又叫宝二爷。");
  assert.equal(ops.length, 3);
  assert.deepEqual(
    ops.map((o) => o.op),
    ["relation", "relation", "alias"],
  );
});

test("applyGraphOps：落库结果与事件描述都对得上", () => {
  const bookId = freshBook("落库测试");
  const ops = parseGraphRules("张三是李四的父亲。王五是赵六的仇人。");
  const events = applyGraphOps(bookId, ops);

  assert.equal(events.length, 2);
  assert.ok(
    events.every((e) => MUTATING_EVENT_RE.test(e)),
    "变更事件应带变更符号",
  );

  const graph = store.getGraph(bookId);
  assert.equal(graph.persons.length, 4);
  assert.equal(graph.relations.length, 2);
  const father = graph.relations.find((r) => r.label === "父亲");
  assert.equal(father?.sourceName, "张三");
  assert.equal(father?.category, "family");
});

test("applyGraphOps：简称自动归到已有主名，不裂成两个人", () => {
  const bookId = freshBook("简称归一");
  store.upsertPerson(bookId, "贾宝玉", ["宝玉"]);

  // 「宝玉的父亲是贾母」——「宝玉」应解析成主名「贾宝玉」
  const events = applyGraphOps(bookId, parseGraphRules("宝玉的父亲是贾母"));
  assert.equal(events.length, 1);

  const graph = store.getGraph(bookId);
  const names = graph.persons.map((p) => p.name).sort();
  assert.deepEqual(names, ["贾宝玉", "贾母"], "宝玉不该被建成第三个人物");
});

test("applyGraphOps：重复关系标为已存在，不堆叠", () => {
  const bookId = freshBook("去重测试");
  applyGraphOps(bookId, parseGraphRules("张三是李四的父亲"));
  const second = applyGraphOps(bookId, parseGraphRules("张三是李四的父亲"));

  assert.match(second[0] ?? "", /^↺/, "重复应标记已存在");
  assert.equal(store.getGraph(bookId).relations.length, 1);
});

test("applyGraphOps：删人物连带删关系，事件里报出数量", () => {
  const bookId = freshBook("级联删除");
  applyGraphOps(bookId, parseGraphRules("张三是李四的父亲。张三是王五的师父。"));

  const events = applyGraphOps(bookId, parseGraphRules("删除张三"));
  assert.match(events[0] ?? "", /连带 2 条关系/);
  assert.equal(store.getGraph(bookId).relations.length, 0);
});

test("applyGraphOps：删不存在的人物如实说明，不谎称成功", () => {
  const bookId = freshBook("删不存在");
  const events = applyGraphOps(bookId, parseGraphRules("删除查无此人"));
  assert.match(events[0] ?? "", /^？/, "失败事件用问号而非变更符号");
  assert.ok(!MUTATING_EVENT_RE.test(events[0] ?? ""));
});

test("applyGraphOps：改主名撞上别人占用的名字时拒绝", () => {
  const bookId = freshBook("改名冲突");
  store.upsertPerson(bookId, "张三");
  store.upsertPerson(bookId, "李四");

  const events = applyGraphOps(bookId, parseGraphRules("把张三改叫李四"));
  assert.match(events[0] ?? "", /^？/);
  assert.ok(store.findPerson(bookId, "张三"), "原名应保持不变");
});

test("applyGraphOps：清空图谱，事件里报出清掉多少", () => {
  const bookId = freshBook("清空测试");
  applyGraphOps(bookId, parseGraphRules("张三是李四的父亲。"));
  const events = applyGraphOps(bookId, parseGraphRules("清空图谱"));

  assert.match(events[0] ?? "", /2 个人物、1 条关系/);
  assert.equal(store.getGraph(bookId).persons.length, 0);
});

test("applyGraphOps：别名合并会并入已有人物而非新建", () => {
  const bookId = freshBook("别名合并");
  store.upsertPerson(bookId, "宝玉");

  const events = applyGraphOps(bookId, parseGraphRules("宝玉又叫宝二爷"));
  assert.match(events[0] ?? "", /并入/);
  assert.equal(store.getGraph(bookId).persons.length, 1);
  assert.deepEqual(store.findPerson(bookId, "宝二爷")?.name, "宝玉");
});
