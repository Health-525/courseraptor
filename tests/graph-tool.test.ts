/**
 * manage_graph 工具测试：11 个动作合并成一个工具后的 action 分派、参数
 * 校验、错误路径，以及「被拒绝的调用不落盘半成品」这条硬约定。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-graph-tool-"));
process.env.RAPTOR_DATA_DIR = tmpData;
process.env.RAPTOR_CREDENTIALS_FILE = path.join(tmpData, "credentials.enc");
process.env.RAPTOR_SCHOOL = "custom";

await import("../src/adapters");
const { coreTools } = await import("../src/core/tools");
const store = await import("../src/core/graph-store");

/** 把 tool() 强转成可直调 execute 的形状，绕开 SDK 包装（与 knowledge 测试同款） */
async function call(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t = coreTools.manage_graph as unknown as {
    execute: (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  return (await t.execute(input)) as Record<string, unknown>;
}

test("工具已注册进coreTools", () => {
  assert.ok(coreTools.manage_graph, "manage_graph 必须在 coreTools 里");
});

test("add_relation：新增关系并回带可重绘的图谱快照", async () => {
  const out = await call({
    action: "add_relation",
    book: "红楼梦",
    from: "贾宝玉",
    to: "林黛玉",
    category: "romance",
    label: "暗恋",
    evidence: "宝玉自小便有个“林妹妹”",
  });

  assert.equal(out.ok, true);
  assert.match(String(out.summary), /已新增 1 条关系/);
  assert.match(String(out.summary), /婚姻爱情/, "摘要应带上类别");
  // SSE 重绘靠这两个字段，缺一个前端就画不出来
  assert.equal(out.graphDirty, true);
  const snapshot = out.snapshot as { persons: unknown[]; relations: unknown[] };
  assert.equal(snapshot.persons.length, 2);
  assert.equal(snapshot.relations.length, 1);
  assert.ok(out.categories, "应带上类别定义供前端配色");
});

test("add_relation 批量：整段原文一次抽完", async () => {
  const out = await call({
    action: "add_relation",
    book: "三国演义",
    relations: [
      { from: "刘备", to: "关羽", category: "friendship", label: "结拜" },
      { from: "刘备", to: "张飞", category: "friendship", label: "结拜" },
      { from: "曹操", to: "刘备", category: "conflict", label: "对手" },
    ],
  });

  assert.equal(out.ok, true);
  assert.match(String(out.summary), /已新增 3 条关系/);
  const saved = out.saved as Array<{ from: string; to: string }>;
  assert.equal(saved.length, 3);
});

test("add_relation：重复关系不堆叠，如实说明", async () => {
  await call({
    action: "add_relation",
    book: "重复",
    from: "甲",
    to: "乙",
    category: "family",
    label: "父亲",
  });
  const again = await call({
    action: "add_relation",
    book: "重复",
    from: "甲",
    to: "乙",
    category: "family",
    label: "父亲",
  });

  assert.match(String(again.summary), /已存在未重复添加/);
  assert.deepEqual(again.duplicates, ["甲 —父亲→ 乙"]);
});

test("add_relation 参数校验：缺字段一律拒绝且不落盘", async () => {
  const book = store.createBook("校验测试").id;

  const noCategory = await call({
    action: "add_relation",
    book: "校验测试",
    from: "甲",
    to: "乙",
    label: "父亲",
  });
  assert.ok(noCategory.error, "缺 category 应报错");
  assert.equal(store.getGraph(book).relations.length, 0, "被拒绝的调用不能留下半成品");

  const noLabel = await call({
    action: "add_relation",
    book: "校验测试",
    from: "甲",
    to: "乙",
    category: "family",
  });
  assert.ok(noLabel.error, "缺 label 应报错");
  assert.equal(store.getGraph(book).persons.length, 0, "端点也不该被自动建出来");

  const emptyName = await call({
    action: "add_relation",
    book: "校验测试",
    from: "  ",
    to: "乙",
    category: "family",
    label: "父亲",
  });
  assert.ok(emptyName.error);
});

test("merge_person：别名并入已有主名", async () => {
  const out = await call({
    action: "merge_person",
    book: "别名",
    canonical: "贾宝玉",
    alias: "宝二爷",
  });

  assert.equal(out.ok, true);
  assert.match(String(out.summary), /并入/);
  assert.equal(out.graphDirty, true);

  const same = await call({
    action: "merge_person",
    book: "别名",
    canonical: "贾宝玉",
    alias: "贾宝玉",
  });
  assert.ok(same.error, "主名与别名相同应拒绝");
});

test("update_person：改名与调重要度", async () => {
  await call({
    action: "add_relation",
    book: "改人",
    from: "张三",
    to: "李四",
    category: "other",
    label: "邻居",
  });

  const renamed = await call({
    action: "update_person",
    book: "改人",
    name: "张三",
    newName: "张小明",
    importance: 3,
  });
  assert.equal(renamed.ok, true);
  assert.match(String(renamed.summary), /主名改为「张小明」/);
  assert.match(String(renamed.summary), /重要度 3/);

  const nothing = await call({ action: "update_person", book: "改人", name: "张小明" });
  assert.ok(nothing.error, "没有任何待改字段应报错");

  const missing = await call({
    action: "update_person",
    book: "改人",
    name: "查无此人",
    newName: "某某",
  });
  assert.ok(missing.error);
});

test("update_relation：修正关系词与类别", async () => {
  await call({
    action: "add_relation",
    book: "改关系",
    from: "甲",
    to: "乙",
    category: "conflict",
    label: "仇人",
  });

  const out = await call({
    action: "update_relation",
    book: "改关系",
    relFrom: "甲",
    relTo: "乙",
    relLabel: "仇人",
    newLabel: "对手",
    evidence: "第三回",
  });
  assert.equal(out.ok, true);
  assert.equal(out.graphDirty, true);

  const miss = await call({
    action: "update_relation",
    book: "改关系",
    relFrom: "甲",
    relTo: "乙",
    relLabel: "根本不存在的关系",
    newLabel: "随便",
  });
  assert.ok(miss.error);
});

test("delete_person：连带删除其关系并报出数量", async () => {
  const book = store.createBook("删人").id;
  await call({
    action: "add_relation",
    book: "删人",
    from: "甲",
    to: "乙",
    category: "family",
    label: "父亲",
  });
  await call({
    action: "add_relation",
    book: "删人",
    from: "甲",
    to: "丙",
    category: "hierarchy",
    label: "师父",
  });

  const out = await call({ action: "delete_person", book: "删人", name: "甲" });
  assert.equal(out.ok, true);
  assert.match(String(out.summary), /连带 2 条关系/);
  assert.equal(store.getGraph(book).relations.length, 0);

  const miss = await call({ action: "delete_person", book: "删人", name: "查无此人" });
  assert.ok(miss.error);
});

test("delete_relation：只删这一条，人物保留", async () => {
  const book = store.createBook("删关系").id;
  await call({
    action: "add_relation",
    book: "删关系",
    from: "甲",
    to: "乙",
    category: "conflict",
    label: "仇人",
  });

  const out = await call({
    action: "delete_relation",
    book: "删关系",
    relFrom: "甲",
    relTo: "乙",
    relLabel: "仇人",
  });
  assert.equal(out.ok, true);
  const graph = store.getGraph(book);
  assert.equal(graph.relations.length, 0);
  assert.equal(graph.persons.length, 2, "删关系不该带走人物");
});

test("clear_graph：清空并报出清掉多少", async () => {
  await call({
    action: "add_relation",
    book: "清空",
    from: "甲",
    to: "乙",
    category: "family",
    label: "父亲",
  });

  const out = await call({ action: "clear_graph", book: "清空" });
  assert.equal(out.ok, true);
  assert.match(String(out.summary), /2 个人物、1 条关系/);
  assert.equal(out.graphDirty, true);
});

test("query_person：回答提问前先查图", async () => {
  await call({
    action: "add_relation",
    book: "查询",
    from: "贾宝玉",
    to: "林黛玉",
    category: "romance",
    label: "暗恋",
  });
  await call({
    action: "add_relation",
    book: "查询",
    from: "贾宝玉",
    to: "薛宝钗",
    category: "romance",
    label: "青梅竹马",
  });

  const out = await call({ action: "query_person", book: "查询", name: "贾宝玉" });
  assert.match(String(out.summary), /2 条关系/);
  const relations = out.relations as Array<{ label: string }>;
  assert.equal(relations.length, 2);

  const missing = await call({ action: "query_person", book: "查询", name: "查无此人" });
  assert.match(String(missing.summary), /没有/);
  // 关键：给模型一句「别靠记忆编」的提示，与工具 description 的铁律呼应
  assert.match(String(missing.note), /不要靠/);
});

test("list：图谱全貌与分类统计", async () => {
  await call({
    action: "add_relation",
    book: "一览",
    from: "甲",
    to: "乙",
    category: "family",
    label: "父亲",
  });
  await call({
    action: "add_relation",
    book: "一览",
    from: "丙",
    to: "丁",
    category: "conflict",
    label: "仇人",
  });

  const out = await call({ action: "list", book: "一览" });
  assert.match(String(out.summary), /4 个人物、2 条关系/);
  assert.equal((out.persons as unknown[]).length, 4);
  assert.equal((out.relations as unknown[]).length, 2);
});

test("new_book：新建另一本书的图谱", async () => {
  const out = await call({ action: "new_book", book: "水浒传" });
  assert.equal(out.ok, true);
  assert.match(String(out.summary), /已新建《水浒传》/);
  assert.ok(out.bookId);
  assert.ok(store.getBook(String(out.bookId)));
});

test("不同书之间互不干扰", async () => {
  await call({
    action: "add_relation",
    book: "书甲",
    from: "甲",
    to: "乙",
    category: "family",
    label: "父亲",
  });
  await call({
    action: "add_relation",
    book: "书乙",
    from: "丙",
    to: "丁",
    category: "other",
    label: "邻居",
  });

  const a = store.listBooks().find((b) => b.title === "书甲");
  const b = store.listBooks().find((x) => x.title === "书乙");
  assert.ok(a && b);
  assert.equal(store.getGraph(a.id).relations.length, 1);
  assert.equal(store.getGraph(b.id).relations.length, 1);
  assert.deepEqual(
    store
      .getGraph(a.id)
      .persons.map((p) => p.name)
      .sort(),
    ["乙", "甲"],
  );
});

test("action 缺失或未知时报错而非静默", async () => {
  const none = await call({ from: "甲", to: "乙", category: "family", label: "父亲" });
  assert.ok(none.error, "缺 action 应报错");

  const bogus = await call({ action: "完全不存在的动作" });
  assert.ok(bogus.error || bogus.summary !== undefined);
});

test("证据留空时不编造：用户没给原句就真的空着", async () => {
  await call({
    action: "add_relation",
    book: "证据",
    from: "甲",
    to: "乙",
    category: "family",
    label: "父亲",
  });
  const book = store.listBooks().find((b) => b.title === "证据");
  assert.ok(book);
  const relation = store.getGraph(book.id).relations[0];
  assert.equal(relation?.evidence, "", "没给原句就不该凭空生成证据");
});

test("delete_book：删整本书连书档带内容，回带删除摘要", async () => {
  const target = store.createBook("整本删掉");
  store.upsertPerson(target.id, "甲", [], "");
  store.addRelation(target.id, "甲", "乙", "family", "父亲", { evidence: "原文" });

  const out = await call({ action: "delete_book", book: "整本删掉" });
  assert.equal(out.ok, true);
  assert.match(String(out.summary), /已删除整本书：《整本删掉》/);
  assert.match(String(out.summary), /不可恢复/);
  assert.deepEqual(out.deletedBooks, ["整本删掉"]);
  assert.equal(out.graphDirty, true);

  // 书档与内容一起消失
  assert.equal(store.getBook(target.id), null);
  assert.equal(
    store.listBooks().some((b) => b.id === target.id),
    false,
  );
  assert.equal(store.getGraph(target.id).persons.length, 0);
});

test("delete_book：删不存在的书只报错，绝不把默认占位书改名删掉", async () => {
  // resolveBookId 遇到「书名不存在 + 目录里有空占位书」会把占位书改名成它
  // 再返回——delete_book 的分支必须赶在这之前，否则用户默认书凭空蒸发
  const placeholder = store.createBook("占位未命名");

  const out = await call({ action: "delete_book", book: "绝对不存在的书名" });
  assert.ok(out.error, "查不到书必须报错");
  assert.match(String(out.error), /没有找到《绝对不存在的书名》/);

  // 占位书标题没被篡改、书档还在，一点副作用都不许有
  assert.ok(store.getBook(placeholder.id), "占位书不允许被顺手删掉");
  assert.equal(store.getBook(placeholder.id)?.title, "占位未命名", "占位书标题不允许被改名");
});

test("delete_book：同名多本时只删空书档，有内容的绝不误删", async () => {
  const withData = store.createBook("重名书");
  store.upsertPerson(withData.id, "甲", [], "");
  const empty = store.createBook("重名书");

  const out = await call({ action: "delete_book", book: "重名书" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.deletedBooks, ["重名书"]);

  assert.equal(store.getBook(empty.id), null, "空书档该被删掉");
  assert.ok(store.getBook(withData.id), "有内容的那本必须保住");
  assert.equal(store.getGraph(withData.id).persons.length, 1, "有内容书的数据必须完好");
});

test("delete_book：不指名时多本必须报错，只剩一本才动手", async () => {
  // 此刻共享库里铁定不止一本书（前面用例建了一摞）
  const many = await call({ action: "delete_book" });
  assert.ok(many.error, "多本书时不指名删除必须报错");
  assert.match(String(many.error), /必须用 book 指明/);

  // 清空到只剩一本，才允许不指名删除（首访问自动建的占位书就是这样清掉的）
  for (const b of store.listBooks()) store.deleteBook(b.id);
  const only = store.createBook("唯一一本");
  const out = await call({ action: "delete_book" });
  assert.equal(out.ok, true);
  assert.match(String(out.summary), /唯一一本/);
  assert.equal(store.getBook(only.id), null);
  assert.equal(store.listBooks().length, 0, "删完就该一本不剩");
});
