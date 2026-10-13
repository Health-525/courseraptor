/**
 * 画板页冒烟测试：GET /graph 的页面契约。
 *
 * 交互逻辑全在内联脚本里（TS 模板字符串，编译期管不到），所以这里钉住
 * 页面结构与关键挂点：控件 id、提示文案、位置持久化键名、类别嵌入——
 * 防止后续改动误删交互入口，或把"刷新即复位"的老文案写回来。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { graphPage } = await import("../src/channels/web/graph-page");
const { GRAPH_CATEGORIES } = await import("../src/core/graph-categories");

test("画板页包含全部交互控件（缩放/查找/布局/导出）", () => {
  const html = graphPage();
  for (const id of [
    "btn-export",
    "btn-relayout",
    "btn-fit",
    "btn-zin",
    "btn-zout",
    "q",
    "q-cnt",
    "zoom-pct",
    "wrap",
    "books",
    "cats",
    "toast",
    "hint",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `画板页缺少 #${id}`);
  }
  // 提示文案必须覆盖新交互；"位置只在本页有效，刷新即复位"是位置持久化
  // 之前的老口径，不许回来（注释里的历史说明不在此列）
  assert.match(html, /拖动人物调整位置/);
  assert.match(html, /滚轮 \/ 双指缩放/);
  assert.match(html, /顶栏可按人名查找/);
  assert.ok(!html.includes("位置只在本页有效"), "位置已持久化，提示不能再说刷新即复位");
  // localStorage 持久化键名（拖动位置按书记住）
  assert.ok(html.includes("raptor-graph-pos-v1:"), "缺少位置持久化键名");
});

test("内联脚本自洽：不再开 script 标签、CSRF 读取点在位", () => {
  const html = graphPage();
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>");
  assert.ok(start > 0 && end > start, "页面必须有一段内联脚本");
  const script = html.slice(start + 8, end);
  assert.ok(script.length > 5000, "内联脚本被截断了？");
  assert.ok(!script.includes("<script"), "内联脚本里不允许再开 script 标签");
  assert.ok(script.includes('meta[name="csrf-token"]'), "删除请求要读 CSRF meta");
});

test("类别闭集嵌入页面（图例与连线配色同源）", () => {
  const html = graphPage();
  for (const key of Object.keys(GRAPH_CATEGORIES)) {
    assert.ok(html.includes(key), `类别 ${key} 未嵌入画板页`);
  }
  assert.ok(html.includes(GRAPH_CATEGORIES.family.color), "类别展示色未嵌入");
});

test("删整本书入口在页：左栏 × 按钮、删除栏两步确认、删书接口", () => {
  const html = graphPage();
  // 左栏书名行的删除按钮（悬停显现、触屏常驻的规则在 CSS 里）
  assert.ok(html.includes("gn-book-del"), "左栏缺少删书 × 按钮");
  assert.ok(html.includes("armBookDelete"), "删书缺少悬停触发函数");
  // 删除栏对 book 选择的文案：不可恢复要写明
  assert.ok(html.includes("删后不可恢复"), "删书删除栏必须提示不可恢复");
  assert.ok(html.includes("整本书："), "删书删除栏必须标明删的是整本书");
  // 两步确认与删书请求目标
  assert.ok(html.includes("/api/graph/book/delete"), "页面缺少删书接口");
  assert.ok(html.includes("确认删除"), "删除必须是两步确认");
  // 删的是当前书时要让 refresh 重新择书，否则画板还挂在已删书上
  assert.ok(
    html.includes("if (state.bookId === sel.id) state.bookId = null;"),
    "删当前书后要交还择书",
  );
  // 位置缓存要按被删书的 id 清，不能只清当前书
  assert.ok(html.includes("clearPos(sel.id)"), "删书要清掉那本书的位置缓存");
});

test("演示模式：嵌数据、禁写请求、无持久化副作用", () => {
  const demoData = {
    bookId: "b-demo",
    version: 1,
    persons: [
      {
        id: "p1",
        bookId: "b-demo",
        name: "贾宝玉",
        aliases: ["宝玉"],
        note: "主角",
        importance: 3,
        createdAt: 1,
      },
      {
        id: "p2",
        bookId: "b-demo",
        name: "林黛玉",
        aliases: [],
        note: "",
        importance: 2,
        createdAt: 2,
      },
    ],
    relations: [
      {
        id: "r1",
        bookId: "b-demo",
        sourceId: "p1",
        targetId: "p2",
        category: "romance" as const,
        label: "暗恋",
        directed: true,
        evidence: "",
        chapter: "",
        createdAt: 1,
        sourceName: "贾宝玉",
        targetName: "林黛玉",
      },
    ],
  };
  const html = graphPage({ demo: true, demoData });
  assert.ok(html.includes('data-demo="true"'));
  assert.ok(html.includes("演示数据 · 不发请求"));
  assert.ok(html.includes("贾宝玉"), "演示数据应嵌进页面");
  // 演示模式禁用删除与导出
  assert.match(html, /演示模式不能删除/);
  assert.match(html, /演示模式没有可导出的数据/);
});
