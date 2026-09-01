/**
 * 文件流水线端到端测试：read_local_file -> 缓存 -> query_table 筛选 -> 清理
 *
 * 复现真实痛点：教务处通知带一个上千行的 xlsx 附件，旧链路把整本表转成
 * 一坨 CSV 文本、超 12000 字符掐断——模型永远读不完，也无从筛选。
 * 新链路：解析成结构 -> 落盘缓存回概览 -> 按条件筛行 -> 任务完删缓存副本。
 * 全程离线（不碰网络），数据目录隔离在临时路径。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-pipeline-"));
const tmpFiles = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-userfiles-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { openLocalFile } = await import("../src/attachments");
const { raptorTools } = await import("../src/tools");
const { listAttachments, attachmentStats } = await import("../src/attachment-store");

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

/** 造一个「教务处风格」的表：多 sheet、合并标题噪声、空行 */
function makeCatalog(): string {
  const aoa: unknown[][] = [["2026 年暑期网课目录（示例）"], []];
  aoa.push(["课程号", "课程名称", "学院", "学分", "上课时间"]);
  const majors = ["信息学院", "管理学院", "艺术学院"];
  for (let i = 1; i <= 300; i++) {
    aoa.push([
      `K${String(i).padStart(4, "0")}`,
      `课程${i}`,
      majors[i % 3],
      String(1 + (i % 3)),
      `周${(i % 7) + 1}`,
    ]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "总表");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["说明：本目录仅供参考"]]), "备注");
  const file = path.join(tmpFiles, "网课目录.xlsx");
  fs.writeFileSync(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
  return file;
}

test("openLocalFile: 大表回概览不回全文，带可查询的 id", async () => {
  const file = makeCatalog();
  const r = await openLocalFile(file);
  assert.equal(r.mode, "table");
  if (r.mode !== "table") return;
  assert.ok(r.id.length >= 12);
  assert.equal(r.totalDataRows, 300, "标题/空行噪声行不算数据行");
  assert.equal(r.sheets.length, 2);
  const [main] = r.sheets;
  assert.deepEqual(main.headers, ["课程号", "课程名称", "学院", "学分", "上课时间"]);
  assert.equal(main.preview.length, 16, "表头+15 行预览，而不是 300 行");
  assert.equal(main.moreRows, 285);
  assert.match(r.hint, /query_table/, "概览必须自带下一步指引");
  // 用户原文件分毫未动
  assert.ok(fs.existsSync(file));
});

test("缓存命中：二次读取不换 id、不清零索引", async () => {
  const file = path.join(tmpFiles, "网课目录.xlsx");
  const first = await openLocalFile(file);
  const second = await openLocalFile(file);
  assert.equal((first as { id: string }).id, (second as { id: string }).id);
  const { count } = attachmentStats();
  assert.equal(listAttachments().length, count, "索引与统计一致，没有重复登记");
});

test("query_table 工具：筛选/排序/去重统计/分页全链路", async () => {
  const { id } = (await openLocalFile(path.join(tmpFiles, "网课目录.xlsx"))) as { id: string };
  const q = raptorTools.query_table as unknown as {
    execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };

  const sheets = await q.execute({ id, action: "sheets" });
  assert.equal(sheets.error, undefined);
  assert.equal((sheets.sheets as unknown[]).length, 2);

  const filtered = await q.execute({
    id,
    action: "filter",
    sheet: "总表",
    where: [{ col: "学院", op: "eq", value: "艺术学院" }],
    sortBy: "课程号",
    sortDesc: true,
    columns: ["课程名称", "课程号", "学分"],
    limit: 10,
  });
  assert.equal(filtered.error, undefined);
  const rows = filtered.rows as string[];
  assert.equal(rows.length, 10);
  assert.equal(filtered.matched, 100, "300 行里艺术学院恰有 100 行");
  assert.equal(rows[0], "课程299 | K0299 | 3", "课程号降序首行确定；补零序号按字典序=数值序");
  assert.ok((filtered.nextOffset as number) > 0 && filtered.note, "还有未返回行时给续取指针");

  const values = await q.execute({ id, action: "values", sheet: "总表", col: "学院" });
  const vs = values.values as Array<{ value: string; count: number }>;
  assert.equal(vs.length, 3);
  assert.equal(
    vs.reduce((s, x) => s + x.count, 0),
    300,
  );

  const bad = await q.execute({
    id,
    action: "filter",
    sheet: "总表",
    where: [{ col: "不存在的列", op: "eq", value: "x" }],
  });
  assert.match(String(bad.error), /找不到列/, "列名错了要说清楚有哪些列可选");

  const ghost = await q.execute({ id: "deadbeefdead", action: "sheets" });
  assert.match(String(ghost.error), /不存在/);
});

test("长文本：分页续读 + keyword 定位（读得完，也不谎称没读全）", async () => {
  const paras: string[] = [];
  for (let i = 0; i < 400; i++)
    paras.push(`第${i}段：这是用于占位的教务通知内容，涉及补考与重修安排。`);
  paras.push("关键句：2026年秋季运动会因故取消，届时以新通知为准。");
  const file = path.join(tmpFiles, "长通知.txt");
  fs.writeFileSync(file, paras.join("\n"), "utf8");

  const p1 = await openLocalFile(file, { limit: 5000 });
  assert.equal(p1.mode, "text");
  if (p1.mode !== "text") return;
  assert.ok(p1.hasMore && p1.nextOffset);
  assert.ok(p1.charCount > 5000);
  assert.equal(p1.text.length, 5000);

  // 逐页翻到结尾：总字符严丝合缝（旧链路 12000 掐断后剩余部分永远见天日无门）
  let seen = p1.text.length;
  let off = p1.nextOffset!;
  let guard = 0;
  let tail = "";
  while (off < p1.charCount && guard++ < 100) {
    const nx = await openLocalFile(file, { offset: off, limit: 5000 });
    assert.equal(nx.mode, "text");
    if (nx.mode !== "text") return;
    seen += nx.text.length;
    tail = nx.text;
    off = nx.nextOffset ?? nx.charCount;
  }
  assert.equal(seen, p1.charCount, "分页拼接必须等于全文长度");
  assert.match(tail, /运动会因故取消/, "最后一块能看到结尾");

  const hit = await openLocalFile(file, { keyword: "运动会" });
  assert.equal(hit.mode, "search");
  if (hit.mode !== "search") return;
  assert.equal(hit.matchCount, 1);
  assert.match(hit.matches[0], /运动会因故取消/);

  const miss = await openLocalFile(file, { keyword: "游泳比赛" });
  assert.equal(miss.mode, "search");
  if (miss.mode !== "search") return;
  assert.equal(miss.matchCount, 0);
  assert.match(miss.note ?? "", /不是没读全/, "查无此词要给出「查过」的底气");
});

test("错误路径：文件不存在 / 目录 / 不支持的格式落 file 模式", async () => {
  await assert.rejects(openLocalFile(path.join(tmpFiles, "查无此文件.xlsx")), /不存在|无法访问/);
  await assert.rejects(openLocalFile(tmpFiles), /不是文件/);
  const bin = path.join(tmpFiles, "未知格式.bin");
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3]));
  const r = await openLocalFile(bin);
  assert.equal(r.mode, "file", "解析不了的也要落缓存并如实告知，而非静默失败");
});

test("manage_attachments 工具：列缓存、删副本、用户原文件无恙", async () => {
  const m = raptorTools.manage_attachments as unknown as {
    execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const listed = await m.execute({ action: "list" });
  const files = listed.files as Array<{ id: string; filename: string }>;
  assert.ok(files.length >= 2);

  const victim = files.find((f) => f.filename.endsWith(".txt"))!;
  const userOriginal = path.join(tmpFiles, "长通知.txt");
  assert.ok(fs.existsSync(userOriginal));
  const del = await m.execute({ action: "delete", id: victim.id });
  assert.equal(del.ok, true);
  assert.ok(fs.existsSync(userOriginal), "删除只动缓存副本，用户原文件必须还在");

  const again = await m.execute({ action: "delete", id: victim.id });
  assert.match(String(again.error), /未找到/);
});
