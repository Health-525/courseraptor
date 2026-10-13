/**
 * 图谱载荷校验闸测试：畸形/伪造的图谱快照必须在 SSE 透传前被整份拒绝。
 *
 * 这是保护浏览器渲染器的一道闸——载荷里的节点名与关系词会被直接画到
 * 画板上，端点 id 错位会画出悬空连线。所以规则是「形状不对就整份不认」，
 * 而不是逐字段容错。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-graph-payload-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { graphPayloadOfToolOutput } = await import("../src/channels/web/web-graph-payload");
const { GRAPH_CATEGORIES } = await import("../src/core/graph-categories");

/** 构造一份合法的载荷，方便在某个字段上做破坏 */
function valid(): Record<string, unknown> {
  return {
    graphDirty: true,
    bookId: "book-1",
    snapshot: {
      bookId: "book-1",
      version: 123,
      persons: [
        { id: "p1", name: "贾宝玉", aliases: ["宝玉"], note: "主角", importance: 3 },
        { id: "p2", name: "林黛玉", aliases: [], note: "", importance: 2 },
      ],
      relations: [
        {
          id: "r1",
          sourceId: "p1",
          targetId: "p2",
          category: "romance",
          label: "暗恋",
          directed: true,
          evidence: "原句",
          chapter: "第三回",
          sourceName: "贾宝玉",
          targetName: "林黛玉",
        },
      ],
    },
  };
}

test("合法载荷原样通过", () => {
  const out = graphPayloadOfToolOutput(valid());
  assert.ok(out);
  assert.equal(out.bookId, "book-1");
  assert.equal(out.persons.length, 2);
  assert.equal(out.relations.length, 1);
  assert.equal(out.relations[0]?.label, "暗恋");
  assert.equal(out.persons[0]?.importance, 3);
});

test("非图谱结果（缺 graphDirty）一律不认", () => {
  const plain = valid();
  delete plain.graphDirty;
  assert.equal(graphPayloadOfToolOutput(plain), null);

  // 别名/清空等只读动作没带 graphDirty，前端不该重绘
  assert.equal(graphPayloadOfToolOutput({ ok: true, summary: "已新增 1 条关系" }), null);
});

test("非对象输入安全返回 null，不抛", () => {
  for (const bad of [null, undefined, 42, "字符串", [], [{ snapshot: {} }]]) {
    assert.equal(graphPayloadOfToolOutput(bad), null);
  }
});

test("缺 persons / relations 数组即拒绝", () => {
  const noPersons = valid();
  (noPersons.snapshot as Record<string, unknown>).persons = undefined;
  assert.equal(graphPayloadOfToolOutput(noPersons), null);

  const noRelations = valid();
  (noRelations.snapshot as Record<string, unknown>).relations = "不是数组";
  assert.equal(graphPayloadOfToolOutput(noRelations), null);
});

test("空图谱不重绘（前端自己显示空态）", () => {
  const empty = valid();
  (empty.snapshot as Record<string, unknown>).persons = [];
  (empty.snapshot as Record<string, unknown>).relations = [];
  assert.equal(graphPayloadOfToolOutput(empty), null);
});

test("人物缺 id 或主名即整份拒绝", () => {
  const noId = valid();
  (noId.snapshot as { persons: Array<{ id?: string }> }).persons[0]!.id = undefined as never;
  assert.equal(graphPayloadOfToolOutput(noId), null);

  const noName = valid();
  (noName.snapshot as { persons: Array<{ name?: string }> }).persons[0]!.name = "";
  assert.equal(graphPayloadOfToolOutput(noName), null);

  const nullPerson = valid();
  (nullPerson.snapshot as { persons: unknown[] }).persons[1] = null;
  assert.equal(graphPayloadOfToolOutput(nullPerson), null);
});

test("关系端点必须落在已透传的人物集合里，否则会画出悬空连线", () => {
  const dangling = valid();
  (dangling.snapshot as { relations: Array<{ sourceId: string }> }).relations[0]!.sourceId =
    "不存在的人";
  assert.equal(graphPayloadOfToolOutput(dangling), null);

  const noEdgeId = valid();
  (noEdgeId.snapshot as { relations: Array<{ id?: string }> }).relations[0]!.id = "";
  assert.equal(graphPayloadOfToolOutput(noEdgeId), null);

  // 空关系词单独有用例覆盖（丢弃该条而非整份拒绝），这里只关心 id/端点
});

test("关系类别必须在 6 类闭集内：模型跑偏的类别不放行", () => {
  const bogus = valid();
  (bogus.snapshot as { relations: Array<{ category: string }> }).relations[0]!.category = "亲情";
  assert.equal(graphPayloadOfToolOutput(bogus), null, "「亲情」不在闭集，应拒");

  // 闭集里的每一个都必须放行
  for (const key of Object.keys(GRAPH_CATEGORIES)) {
    const ok = valid();
    (ok.snapshot as { relations: Array<{ category: string }> }).relations[0]!.category = key;
    assert.ok(graphPayloadOfToolOutput(ok), `闭集类别 ${key} 应放行`);
  }
});

test("超长展示文本被截断而非拒收：一张超长备注不该挡住整张图", () => {
  const long = valid();
  (long.snapshot as { persons: Array<{ name: string; note: string }> }).persons[0]!.name =
    "名".repeat(50);
  const out = graphPayloadOfToolOutput(long);
  assert.ok(out, "超长只是显示不下，不该整份拒绝");
  assert.ok((out.persons[0]?.name.length ?? 0) <= 25, "应截断到上限并带省略号");
  assert.match(String(out.persons[0]?.name), /…$/);

  const longEvidence = valid();
  (longEvidence.snapshot as { relations: Array<{ evidence: string }> }).relations[0]!.evidence =
    "原句".repeat(300);
  const out2 = graphPayloadOfToolOutput(longEvidence);
  assert.ok(out2);
  assert.ok((out2.relations[0]?.evidence.length ?? 0) <= 201);
});

test("别名与备注做过清洗，非字符串项被丢弃而不是崩掉", () => {
  const messy = valid();
  (messy.snapshot as { persons: Array<{ aliases: unknown; note: string }> }).persons[0]!.aliases = [
    "宝玉",
    42,
    null,
    "宝二爷",
  ];
  const out = graphPayloadOfToolOutput(messy);
  assert.ok(out);
  assert.deepEqual(out.persons[0]?.aliases, ["宝玉", "宝二爷"]);
});

test("importance 越界被夹到 1-3，不让模型定出 99 级节点", () => {
  const wild = valid();
  (wild.snapshot as { persons: Array<{ importance: number }> }).persons[0]!.importance = 99;
  const out = graphPayloadOfToolOutput(wild);
  assert.equal(out?.persons[0]?.importance, 3);

  const low = valid();
  (low.snapshot as { persons: Array<{ importance: number }> }).persons[0]!.importance = -5;
  assert.equal(graphPayloadOfToolOutput(low)?.persons[0]?.importance, 1);
});

test("关系规模封顶：超大图谱只透传前 N 条，且不因截顶误判端点悬空", () => {
  const huge = valid();
  const persons = Array.from({ length: 400 }, (_, i) => ({
    id: `p${i}`,
    name: `人物${i}`,
    aliases: [],
    note: "",
    importance: 1,
  }));
  const relations = Array.from({ length: 400 }, (_, i) => ({
    id: `r${i}`,
    sourceId: `p${i}`,
    targetId: `p${i + 1}`,
    category: "other",
    label: "邻居",
  }));
  (huge.snapshot as Record<string, unknown>).persons = persons;
  (huge.snapshot as Record<string, unknown>).relations = relations;

  const out = graphPayloadOfToolOutput(huge);
  // 人物全量透传（节点不占版面），关系封顶——且不能因为人物/关系
  // 各自截断就把仍然有效的端点误判成悬空而整份拒绝
  assert.ok(out, "截顶不应触发整份拒绝");
  assert.equal(out.persons.length, 400);
  assert.ok(out.relations.length <= 260, `关系应封顶，实际 ${out.relations.length}`);
});

test("关系词为空：丢掉这条线而不是拒绝整份快照", () => {
  const blank = valid();
  (blank.snapshot as { relations: Array<{ label: string }> }).relations[0]!.label = "";
  const out = graphPayloadOfToolOutput(blank);
  assert.ok(out, "空关系词只是这条线画不出来，不该拖垮整份");
  assert.equal(out.relations.length, 0);
  assert.equal(out.persons.length, 2);
});

test("bookId 缺失即拒绝：拿不到归属的快照没法定位到画板", () => {
  const noBook = valid();
  (noBook.snapshot as Record<string, unknown>).bookId = "";
  assert.equal(graphPayloadOfToolOutput(noBook), null);
});
