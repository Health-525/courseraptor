/**
 * 人物图谱数据层测试：data/graph.json 的读写、别名归一、简称模糊解析、
 * 关系定位与删除级联、坏文件隔离。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-graph-store-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const store = await import("../src/core/graph-store");

/**
 * 部分用例会直接改写 graph.json（测坏文件隔离、混合数据）。它们会把
 * 后续用例的基线搅乱——node:test 同文件内顺序执行且共享数据目录，
 * 所以这类用例自己换到一个独立子目录，干完把RAPTOR_DATA_DIR 指回来。
 *
 * 注意子目录必须用 path.resolve 归一化：Git Bash 下 os.tmpdir() 给的是
 * 形如 /tmp/xxx 的短路径，而 Node 会把它归一成 C:\temp\xxx，直接塞进
 * env 会与 mkdtempSync 的实际落盘位置对不上，隔离等于没隔离。
 */
function inIsolatedDir(fn: (dir: string) => void): void {
  const sub = path.resolve(fs.mkdtempSync(path.join(tmpData, "case-")));
  const previous = process.env.RAPTOR_DATA_DIR;
  process.env.RAPTOR_DATA_DIR = sub;
  try {
    fn(sub);
  } finally {
    process.env.RAPTOR_DATA_DIR = previous;
  }
}

test("建书建人加关系：端点不存在时自动建人", () => {
  const book = store.createBook("红楼梦");
  assert.equal(book.title, "红楼梦");

  const { relation, duplicate } = store.addRelation(book.id, "贾宝玉", "贾母", "family", "孙子", {
    evidence: "宝玉自小由祖母教养",
    chapter: "第三回",
  });
  assert.equal(duplicate, false);
  assert.equal(relation.label, "孙子");
  assert.equal(relation.evidence, "宝玉自小由祖母教养");

  // 端点应当自动建成两个人
  const graph = store.getGraph(book.id);
  assert.equal(graph.persons.length, 2);
  assert.deepEqual(graph.persons.map((p) => p.name).sort(), ["贾宝玉", "贾母"]);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.relations[0]?.sourceName, "贾宝玉");
  assert.equal(graph.relations[0]?.targetName, "贾母");
});

test("同一对人物同一关系词不重复堆", () => {
  const book = store.createBook("重复测试");
  store.addRelation(book.id, "甲", "乙", "family", "父亲");
  const second = store.addRelation(book.id, "甲", "乙", "family", "父亲");
  assert.equal(second.duplicate, true);
  assert.equal(store.getGraph(book.id).relations.length, 1);

  // 换个关系词是另一条，应当新增
  const other = store.addRelation(book.id, "甲", "乙", "friendship", "同窗");
  assert.equal(other.duplicate, false);
  assert.equal(store.getGraph(book.id).relations.length, 2);
});

test("别名归一：简称与别名都归到同一主名", () => {
  const book = store.createBook("别名测试");
  store.upsertPerson(book.id, "贾宝玉", ["宝玉", "宝二爷"], "荣国府二少爷");

  assert.equal(store.findPerson(book.id, "宝玉")?.name, "贾宝玉");
  assert.equal(store.findPerson(book.id, "宝二爷")?.name, "贾宝玉");

  // 简称模糊：「宝玉」→「贾宝玉」
  assert.equal(store.resolveName(book.id, "宝玉"), "贾宝玉");
  assert.equal(store.locatePerson(book.id, "宝玉")?.name, "贾宝玉");

  // 同名再 upsert 是补别名而不是新建人
  const { merged } = store.upsertPerson(book.id, "贾宝玉", ["绛洞花王"]);
  assert.equal(merged, true);
  assert.equal(store.getGraph(book.id).persons.length, 1);
  assert.deepEqual(store.findPerson(book.id, "宝玉")?.aliases.slice().sort(), [
    "宝二爷",
    "宝玉",
    "绛洞花王",
  ]);
});

test("简称有歧义时拒绝猜测：宁可新建也不乱并", () => {
  const book = store.createBook("歧义测试");
  store.upsertPerson(book.id, "贾宝玉", ["宝玉"]);
  store.upsertPerson(book.id, "甄宝玉", ["宝玉"]);

  // 「宝玉」同时命中两人：resolveName 返回 null，调用方按字面名处理
  assert.equal(store.resolveName(book.id, "宝玉"), null);
  assert.equal(store.locatePerson(book.id, "宝玉"), null);
  // 唯一命中时才敢归一
  assert.equal(store.resolveName(book.id, "甄宝玉"), "甄宝玉");
});

test("改名与占名冲突", () => {
  const book = store.createBook("改名测试");
  store.upsertPerson(book.id, "张三");
  store.upsertPerson(book.id, "李四");

  const ok = store.updatePerson(book.id, "张三", { newName: "张小明", note: "主角" });
  assert.equal("error" in ok, false);
  if (!("error" in ok)) {
    assert.equal(ok.person.name, "张小明");
    assert.equal(ok.person.note, "主角");
    assert.equal(ok.oldName, "张三");
  }

  // 改成别人已占用的名字要被拦住
  const clash = store.updatePerson(book.id, "张小明", { newName: "李四" });
  assert.equal("error" in clash, true);

  // 重要度越界被拒
  const bad = store.updatePerson(book.id, "张小明", { importance: 9 as never });
  assert.equal("error" in bad, true);
});

test("删人物连带其全部关系，人物之外的保留", () => {
  const book = store.createBook("级联测试");
  store.addRelation(book.id, "甲", "乙", "family", "父亲");
  store.addRelation(book.id, "乙", "丙", "friendship", "同窗");
  store.addRelation(book.id, "丁", "戊", "other", "邻居");

  const found = store.relationsOfPerson(book.id, "乙");
  assert.ok(found);
  const removed = store.deletePerson(book.id, found.person.id);

  assert.equal(removed, 2);
  const graph = store.getGraph(book.id);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.relations[0]?.sourceName, "丁");
  assert.ok(!graph.persons.some((p) => p.name === "乙"));
});

test("按名字删关系与反向定位", () => {
  const book = store.createBook("删关系测试");
  store.addRelation(book.id, "甲", "乙", "conflict", "仇人");

  // 反向写也找得到：画布与对话的录入方向可能相反
  const found = store.findRelation(book.id, "乙", "甲", "仇人");
  assert.ok(found);

  const hit = store.deleteRelationByNames(book.id, "甲", "乙", "仇人");
  assert.equal("error" in hit, false);
  assert.equal(store.getGraph(book.id).relations.length, 0);

  // 找不到就如实报错，不静默成功
  const miss = store.deleteRelationByNames(book.id, "甲", "乙", "仇人");
  assert.equal("error" in miss, true);
});

test("修正关系：改词改类别改方向补证据", () => {
  const book = store.createBook("修正测试");
  store.addRelation(book.id, "甲", "乙", "conflict", "仇人");

  const result = store.updateRelation(book.id, "甲", "乙", "仇人", {
    newLabel: "对手",
    newCategory: "conflict",
    evidence: "第三回两人争夺胭脂",
    chapter: "第三回",
  });
  assert.equal("error" in result, false);
  if (!("error" in result)) {
    assert.equal(result.relation.label, "对手");
    assert.equal(result.relation.evidence, "第三回两人争夺胭脂");
  }

  // 定位不到原关系就报错
  const miss = store.updateRelation(book.id, "甲", "乙", "仇人", { newLabel: "敌人" });
  assert.equal("error" in miss, true);
});

test("清空图谱：人物与关系全清，其他书不受影响", () => {
  const keep = store.createBook("要留着");
  store.addRelation(keep.id, "甲", "乙", "family", "父亲");

  const wipe = store.createBook("要清空");
  store.addRelation(wipe.id, "丙", "丁", "family", "父亲");
  store.addRelation(wipe.id, "丙", "戊", "friendship", "同窗");

  const removed = store.clearGraph(wipe.id);
  assert.equal(removed.persons, 3);
  assert.equal(removed.relations, 2);
  assert.equal(store.getGraph(wipe.id).persons.length, 0);
  assert.equal(store.getGraph(keep.id).relations.length, 1);
});

test("损坏的 graph.json 先隔离留档再当空，不无声吃掉旧图谱", () => {
  inIsolatedDir((dir) => {
    fs.writeFileSync(path.join(dir, "graph.json"), "{ 这不是合法 JSON");

    assert.deepEqual(store.listBooks(), []);
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("graph.json.corrupt-"));
    assert.equal(leftovers.length, 1, "坏文件应被隔离成 .corrupt-<时间戳>");
  });
});

test("单条坏数据不拖垮整份：只丢坏条，好条照常读出", () => {
  inIsolatedDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "graph.json"),
      JSON.stringify({
        books: [{ id: "b1", title: "混合数据", createdAt: Date.now() }],
        persons: [
          { id: "p1", bookId: "b1", name: "正常人", aliases: [], note: "", importance: 2 },
          { id: "p2", bookId: "b1", note: "缺 name" },
          null,
        ],
        relations: [null, { id: "r0", label: "缺端点" }],
        memories: "不是数组",
      }),
    );

    const graph = store.getGraph("b1");
    assert.equal(graph.persons.length, 1, "null 与缺字段的条目都应被丢掉");
    assert.equal(graph.persons[0]?.name, "正常人");
    assert.equal(graph.persons[0]?.importance, 2);
    assert.equal(graph.relations.length, 0, "关系里的坏条同样不该让读取崩溃");
  });
});

test("关系端点指向已删人物时不外泄给画板（不画悬空连线）", () => {
  inIsolatedDir((dir) => {
    const book = store.createBook("悬空测试");
    store.addRelation(book.id, "甲", "乙", "family", "父亲");

    // 手工改文件、只删掉「乙」的人物行而不做级联，模拟历史数据不一致
    const file = path.join(dir, "graph.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      persons: Array<{ id: string; name: string }>;
    };
    raw.persons = raw.persons.filter((p) => p.name !== "乙");
    fs.writeFileSync(file, JSON.stringify(raw));

    const graph = store.getGraph(book.id);
    assert.equal(graph.relations.length, 0, "端点缺失的关系不应出现");
  });
});

test("空占位书会被书名接管：用户说的书名不该塞进自动建的「未命名」", () => {
  inIsolatedDir(() => {
    // 首访问 /api/graph 会自动建一本空的「未命名」
    const placeholder = store.resolveBookId();
    assert.equal(store.getBook(placeholder)?.title, "未命名");

    // 用户明确说了书名：占位书还空着，就地改名，不另起一本
    const named = store.resolveBookId(undefined, "红楼梦");
    assert.equal(named, placeholder, "空占位书应被接管，而不是新建第二本");
    assert.equal(store.getBook(named)?.title, "红楼梦");
    assert.equal(store.listBooks().length, 1, "不该多出一本空书");
  });
});

test("非空的占位书绝不被挪用：已有内容的书要另起新书", () => {
  inIsolatedDir(() => {
    const placeholder = store.resolveBookId();
    store.addRelation(placeholder, "甲", "乙", "family", "父亲");

    // 已有内容的那本不能被书名改写，否则用户看《红楼梦》时看到的是别人的数据
    const named = store.resolveBookId(undefined, "红楼梦");
    assert.notEqual(named, placeholder, "非空书不该被接管");
    assert.equal(store.getBook(placeholder)?.title, "未命名", "原书名不该变");
    assert.equal(store.getBook(named)?.title, "红楼梦");
    assert.equal(store.getGraph(placeholder).relations.length, 1, "原书数据必须完好");
  });
});

test("resolveBookId：显式 id 优先，其次同名复用，再次唯一书，最后才新建", () => {
  inIsolatedDir(() => {
    const only = store.createBook("唯一一本");
    assert.equal(store.resolveBookId(undefined), only.id, "只有一本书时直接用它");

    // 显式指定的 id 优先于任何其他规则
    const explicit = store.createBook("指定这本");
    assert.equal(store.resolveBookId(explicit.id), only.id === explicit.id ? only.id : explicit.id);

    // 同名书复用：反复调用不该造出一堆同名「未命名」
    const byTitle = store.resolveBookId(undefined, "红楼梦");
    assert.equal(store.getBook(byTitle)?.title, "红楼梦");
    assert.equal(store.resolveBookId(undefined, "红楼梦"), byTitle, "第二次同名应复用同一本");
    assert.equal(store.listBooks().filter((b) => b.title === "红楼梦").length, 1);

    // 多本书且既没给 id 也没给书名：新建一本「未命名」，但不替用户挑已有的
    const made = store.resolveBookId(undefined);
    assert.equal(store.getBook(made)?.title, "未命名");
  });
});

test("导入导出按人名落盘，换库也能还原", () => {
  const src = store.createBook("导出源");
  store.upsertPerson(src.id, "甲", ["小甲"], "主角");
  store.addRelation(src.id, "甲", "乙", "family", "父亲", { evidence: "原文一句" });
  store.addMemory(src.id, "用户读得很慢");

  const dumped = store.exportGraph(src.id);
  assert.equal(dumped.version, 1);
  assert.equal(dumped.persons.length, 2);
  assert.equal(dumped.relations[0]?.sourceName, "甲");

  const dst = store.importGraph(dumped);
  const graph = store.getGraph(dst.id);
  assert.equal(graph.persons.length, 2);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.relations[0]?.label, "父亲");
  assert.equal(graph.relations[0]?.evidence, "原文一句");
  assert.deepEqual(store.findPerson(dst.id, "小甲")?.aliases, ["小甲"]);
});

test("graphSummary：空图谱给明确提示，有数据时带书名", () => {
  const empty = store.createBook("空书");
  assert.equal(store.graphSummary(empty.id), "（当前图谱为空）");

  const filled = store.createBook("有内容");
  store.addRelation(filled.id, "甲", "乙", "family", "父亲", { evidence: "第三回" });
  const text = store.graphSummary(filled.id);
  assert.match(text, /《有内容》共 2 个人物、1 条关系/);
  assert.match(text, /甲 --\[父亲\]--> 乙/);
});
