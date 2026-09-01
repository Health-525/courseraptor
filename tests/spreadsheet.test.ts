/**
 * 表格引擎测试（Excel 筛选能力）
 *
 * 背景：教务处附件（网课目录/考场表）动辄上千行，旧链路整本转 CSV 文本
 * 再按 12000 字符掐断——模型永远「读不完」。新链路改成结构化查询：
 * 概览 + keyword 检索 + where 多条件 + 排序 + 去重统计 + 分页。
 * 这组测试钉住筛选语义与列名解析的边界行为。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  distinctValues,
  isTableFilename,
  loadWorkbook,
  querySheet,
  resolveColumn,
  sheetOverview,
  type TableSheet,
} from "../src/spreadsheet";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

function xlsxBuffer(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const CATALOG = xlsxBuffer({
  网课目录: [
    ["课程号", "课程名称", "学院", "学分", "考核"],
    ["A001", "创新创业基础", "管理学院", "2", "考查"],
    ["A002", "音乐鉴赏", "艺术学院", "1", "考查"],
    ["A003", "人工智能导论", "信息学院", "2.5", "考试"],
    ["A004", "人工智能伦理", "信息学院", "1", "考试"],
    ["A005", "心理健康", "马院", "2", "考查"],
  ],
  说明: [["本表为示例"]],
});

test("isTableFilename: 只认表格扩展名", () => {
  assert.ok(isTableFilename("目录.XLSX"));
  assert.ok(isTableFilename("a.csv"));
  assert.ok(isTableFilename("a.tsv"));
  assert.ok(!isTableFilename("通知.docx"));
  assert.ok(!isTableFilename("readme.txt"));
});

test("loadWorkbook: 表头识别 / 多 sheet / 空表头补列号 / 单元格换行压平", () => {
  const buf = xlsxBuffer({
    Sheet1: [
      ["", "", ""], // 空行（标题前留白）应跳过
      ["姓名", "", "备注"],
      ["张三", "a", "第一行\n第二行"],
    ],
    空表: [[]],
  });
  const sheets = loadWorkbook(buf, "x.xlsx");
  assert.ok(sheets);
  const s1 = sheets[0];
  assert.deepEqual(s1.headers, ["姓名", "列2", "备注"]);
  assert.equal(s1.rows.length, 1);
  assert.equal(s1.rows[0][2], "第一行 第二行", "换行必须压平，保证一行渲染不乱");
  assert.equal(sheets[1].headers.length, 0);
  assert.equal(sheets[1].rows.length, 0);
});

test("loadWorkbook: 非表格文件名/坏字节返回 null 不抛", () => {
  assert.equal(loadWorkbook(Buffer.from("hello"), "通知.docx"), null);
  assert.equal(loadWorkbook(Buffer.from("not an xlsx"), "fake.xlsx"), null);
});

test("loadWorkbook: csv 直接可解析", () => {
  const buf = Buffer.from("班级,人数\n计科211,45\n计科212,43\n", "utf8");
  const sheets = loadWorkbook(buf, "班级.csv");
  assert.ok(sheets);
  assert.deepEqual(sheets[0].headers, ["班级", "人数"]);
  assert.equal(sheets[0].rows.length, 2);
});

test("resolveColumn: 精确 / 忽略大小写 / 唯一包含 / 序号 / 歧义与缺失报错", () => {
  const headers = ["课程名称", "Course Code", "教师"];
  assert.equal(resolveColumn(headers, "教师"), 2);
  assert.equal(resolveColumn(headers, "course code"), 1);
  assert.equal(resolveColumn(headers, "名称"), 0, "唯一包含匹配");
  assert.equal(resolveColumn(headers, "2"), 1, "1-based 序号");
  assert.equal(
    resolveColumn(["教师", "教师工号", "教师电话"], "教师"),
    0,
    "精确匹配优先于模糊，不该报歧义",
  );
  assert.throws(() => resolveColumn(["教师工号", "教师电话"], "教师"), /同时匹配多列/);
  assert.throws(() => resolveColumn(headers, "教室"), /找不到列/);
});

test("querySheet: keyword 全列不分大小写", () => {
  const [sheet] = loadWorkbook(CATALOG, "网课目录.xlsx")!;
  const r = querySheet(sheet, { keyword: "人工" });
  assert.equal(r.matched, 2);
  assert.ok(r.rows.every((row) => row.some((c) => c.includes("人工"))));
});

test("querySheet: where 多条件 AND + 数值比较自动按数字", () => {
  const [sheet] = loadWorkbook(CATALOG, "网课目录.xlsx")!;
  const r = querySheet(sheet, {
    where: [
      { col: "学院", op: "contains", value: "信息" },
      { col: "学分", op: "ge", value: "2" },
    ],
  });
  assert.equal(r.matched, 1, "学分 2.5>=2 命中；1 学分的伦理课被数值排除");
  assert.ok(r.rows[0].includes("人工智能导论"));

  const eq = querySheet(sheet, { where: [{ col: "学分", op: "eq", value: "2.50" }] });
  assert.equal(eq.matched, 1, "eq 数值口径：2.50 == 2.5");

  const notFull = querySheet(sheet, {
    where: [
      { col: "考核", op: "ne", value: "考试" },
      { col: "课程名称", op: "notContains", value: "音乐" },
    ],
  });
  assert.deepEqual(notFull.rows.map((r2) => r2[1]).sort(), ["创新创业基础", "心理健康"]);
});

test("querySheet: regex / empty 条件", () => {
  const [sheet] = loadWorkbook(CATALOG, "网课目录.xlsx")!;
  const re = querySheet(sheet, { where: [{ col: "课程号", op: "regex", value: "^A00[12]$" }] });
  assert.equal(re.matched, 2);
  assert.throws(
    () => querySheet(sheet, { where: [{ col: "课程号", op: "regex", value: "(((" }] }),
    /正则无效/,
  );
  const noEmpty = querySheet(sheet, { where: [{ col: "学院", op: "notEmpty" }] });
  assert.equal(noEmpty.matched, 5);
});

test("querySheet: 排序（数值列按数值）+ 投影 + 分页", () => {
  const [sheet] = loadWorkbook(CATALOG, "网课目录.xlsx")!;
  const asc = querySheet(sheet, { sortBy: "学分", limit: 2 });
  assert.deepEqual(
    asc.rows.map((r) => r[3]),
    ["1", "1"],
  );
  const desc = querySheet(sheet, { sortBy: "学分", sortDesc: true, columns: ["课程名称", "学分"] });
  assert.deepEqual(desc.headers, ["课程名称", "学分"]);
  assert.equal(desc.rows[0][0], "人工智能导论", "2.5 是数值最大，不该按字典序排");

  const p1 = querySheet(sheet, { offset: 0, limit: 2 });
  const p2 = querySheet(sheet, { offset: 2, limit: 2 });
  assert.equal(p1.matched, 5);
  assert.ok(p1.truncated);
  assert.equal(p1.returned, 2);
  assert.equal(p2.returned, 2);
  assert.notDeepEqual(p1.rows, p2.rows, "两页内容不重叠");
  assert.equal(p2.truncated, true);
  const p3 = querySheet(sheet, { offset: 4, limit: 2 });
  assert.equal(p3.returned, 1);
  assert.equal(p3.truncated, false, "最后一页不再截断");
});

test("distinctValues: 去重计数按频次降序", () => {
  const [sheet] = loadWorkbook(CATALOG, "网课目录.xlsx")!;
  const v = distinctValues(sheet, "学院");
  assert.deepEqual(v[0], { value: "信息学院", count: 2 }, "出现最多的排前面");
  assert.equal(
    v.reduce((s, x) => s + x.count, 0),
    5,
  );
});

test("sheetOverview: 概览行数与 moreRows 提示", () => {
  const [sheet] = loadWorkbook(CATALOG, "网课目录.xlsx")!;
  const o = sheetOverview(sheet, 3);
  assert.equal(o.dataRows, 5);
  assert.equal(o.preview.length, 4, "表头 + 3 行预览");
  assert.equal(o.moreRows, 2);
});

test("空 keyword/where 的 rows 查询等于全表分页", () => {
  const sheet: TableSheet = {
    name: "t",
    headers: ["a"],
    rows: [["1"], ["2"], ["3"]],
  };
  const r = querySheet(sheet, { limit: 2 });
  assert.equal(r.matched, 3);
  assert.equal(r.returned, 2);
});
