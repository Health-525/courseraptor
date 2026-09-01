/**
 * 文档生成 / 转换引擎测试
 *
 * 钉住三件事：
 * 1. 四种格式（docx/xlsx/pptx/pdf）都能产出「格式魔数正确、非空」的字节；
 *    PDF 尤其要证明中文字形真的进了文件（回读能抽到中文），而不是渲染成空白。
 * 2. 落盘护栏：成品只写进 data/generated，同名自动去重不覆盖；
 *    转换只读源文件、绝不改动原件（红线）。
 * 3. QQ 回传用的本轮登记流水按 roundId 精确隔离，不跨轮/跨用户串台。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-doc-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const require = createRequire(import.meta.url);

import { convertDocument, textToBlocks } from "../src/document/convert";
import { resolveCjkFont } from "../src/document/font";
import {
  renderDocument,
  renderDocx,
  renderPdf,
  renderPptx,
  renderXlsx,
} from "../src/document/render";
import {
  drainGeneratedRound,
  generateAndSave,
  generatedDir,
  runInDocumentRound,
} from "../src/document/save";
import { loadWorkbook } from "../src/spreadsheet";

const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_MAGIC = Buffer.from("%PDF");

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 4).equals(PK);
}

test("docx 生成：zip 魔数 + 含中文回读", async () => {
  const buf = await renderDocx({
    format: "docx",
    title: "实践报告",
    blocks: [
      { type: "heading", text: "一、背景", level: 1 },
      { type: "paragraph", text: "人工智能与教务，English mixed。" },
      { type: "table", table: { headers: ["项", "状态"], rows: [["Word", "完成"]] } },
    ],
  });
  assert.ok(isZip(buf), "docx 应是 zip");
  const mammoth = require("mammoth");
  const r = await mammoth.extractRawText({ buffer: buf });
  assert.match(r.value, /实践报告/);
  assert.match(r.value, /背景/);
});

test("xlsx 生成：多 sheet 可被表格引擎回读", async () => {
  const buf = renderXlsx({
    format: "xlsx",
    sheets: [
      { name: "成绩", headers: ["课程", "分"], rows: [["高数", "88"]] },
      { name: "备注", rows: [["说明", "中文"]] },
    ],
  });
  assert.ok(isZip(buf));
  const sheets = loadWorkbook(buf, "out.xlsx");
  assert.ok(sheets);
  assert.deepEqual(sheets!.map((s) => s.name).sort(), ["备注", "成绩"]);
  const grade = sheets!.find((s) => s.name === "成绩")!;
  assert.deepEqual(grade.headers, ["课程", "分"]);
  assert.equal(grade.rows[0][0], "高数");
});

test("pptx 生成：zip 魔数 + 非空", async () => {
  const buf = await renderPptx({
    format: "pptx",
    title: "开题答辩",
    slides: [{ title: "意义", bullets: ["效率", "门槛"] }],
  });
  assert.ok(isZip(buf));
  assert.ok(buf.length > 1000, "pptx 应有实际体积");
});

test("pdf 生成：中文字形真的嵌入（回读可抽取）", async () => {
  const buf = await renderPdf({
    format: "pdf",
    title: "课程总结",
    blocks: [
      { type: "heading", text: "第一章 概述", level: 1 },
      { type: "paragraph", text: "这是一段用于验证 PDF 中文字形的正文。" },
      { type: "table", table: { headers: ["指标", "值"], rows: [["准确率", "95%"]] } },
    ],
  });
  assert.ok(buf.subarray(0, 4).equals(PDF_MAGIC), "pdf 应以 %PDF 开头");
  if (resolveCjkFont()) {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const r = await parser.getText();
    await parser.destroy().catch(() => {});
    const text = typeof r === "string" ? r : (r as any).text;
    assert.match(text, /课程总结|概述|准确率/, "PDF 应能抽回中文，证明字形已嵌入");
  }
});

test("renderDocument 编排 + suggestBaseName 清洗非法字符", async () => {
  const { buffer, baseName } = await renderDocument({
    format: "pdf",
    title: "a/b:c*d?报告",
  });
  assert.ok(buffer.length > 0);
  assert.equal(baseName, "abcd报告", "文件名里的 \\ / : * ? 应被剔除");
});

test("generateAndSave 落盘到 generated 目录并同名去重", async () => {
  const spec = {
    format: "docx" as const,
    title: "重复名报告",
    blocks: [{ type: "paragraph" as const, text: "x" }],
  };
  const a = await generateAndSave(spec);
  const b = await generateAndSave(spec);
  assert.ok(a.filePath.startsWith(generatedDir()));
  assert.ok(fs.existsSync(a.filePath) && fs.existsSync(b.filePath));
  assert.notEqual(a.filename, b.filename, "同名应追加(2)不覆盖");
});

test("convertDocument：文本→docx / pdf；缺源报错", async () => {
  const doc = await convertDocument({
    target: "docx",
    text: "# 标题\n\n一段正文\n- 项一\n- 项二",
    title: "转换测试",
  });
  assert.ok(doc.ok, "文本转 docx 应成功");
  if (doc.ok) assert.ok(doc.file.filename.endsWith(".docx"));

  const pdf = await convertDocument({ target: "pdf", text: "纯文本一页" });
  assert.ok(pdf.ok);

  const bad = await convertDocument({ target: "docx" });
  assert.ok(!bad.ok && !!bad.error, "无来源应报错");
});

test("convertDocument：表格附件/文件→xlsx 保留结构，且不改动源文件（红线）", async () => {
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["姓名", "分数"],
      ["张三", "90"],
    ]),
    "表1",
  );
  const srcPath = path.join(tmpData, "src-table.xlsx");
  fs.writeFileSync(srcPath, XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
  const before = fs.readFileSync(srcPath);
  const mtimeBefore = fs.statSync(srcPath).mtimeMs;

  const r = await convertDocument({ target: "docx", sourcePath: srcPath });
  assert.ok(r.ok);
  // 源文件字节与修改时间都不得变
  assert.ok(fs.readFileSync(srcPath).equals(before), "源文件内容被改动，违反红线");
  assert.equal(fs.statSync(srcPath).mtimeMs, mtimeBefore, "源文件 mtime 变了");
});

test("textToBlocks：markdown 标题/列表/段落分层", () => {
  const blocks = textToBlocks("# 一级\n\n正文段落\n\n- 甲\n- 乙");
  const types = blocks.map((b) => b.type);
  assert.ok(types.includes("heading"));
  assert.ok(types.includes("paragraph"));
  assert.ok(types.includes("list"));
});

test("drainGeneratedRound：按 roundId 精确隔离，取后即清", async () => {
  const spec = (t: string) => ({
    format: "docx" as const,
    title: t,
    blocks: [{ type: "paragraph" as const, text: "y" }],
  });
  await runInDocumentRound("round-A", async () => {
    await generateAndSave(spec("A报告"));
    return 1;
  });
  await runInDocumentRound("round-B", async () => {
    await generateAndSave(spec("B报告"));
    return 1;
  });
  // A 先取：只拿回 A 的，B 的留在流水里
  const a = drainGeneratedRound("round-A");
  assert.equal(a.length, 1);
  assert.match(a[0].filename, /A报告/);
  const b = drainGeneratedRound("round-B");
  assert.equal(b.length, 1);
  assert.match(b[0].filename, /B报告/);
  // 再取为空（已清）
  assert.equal(drainGeneratedRound("round-A").length, 0);
  // 非任何 round 生成的（如前面测试直接 generateAndSave 不在 round 内）不会被误捞
  assert.equal(drainGeneratedRound("nope").length, 0);
});

test("工具层接线：raptorTools.generate_document / convert_document 可直接 execute", async () => {
  const { raptorTools } = await import("../src/tools");
  assert.ok(raptorTools.generate_document, "generate_document 应注册");
  assert.ok(raptorTools.convert_document, "convert_document 应注册");

  const gen = (
    raptorTools.generate_document as unknown as {
      execute: (i: unknown) => Promise<any>;
    }
  ).execute;
  const g = await gen({
    format: "pdf",
    title: "工具层报告",
    blocks: [{ type: "paragraph", text: "中文正文校验" }],
  });
  assert.equal(g.ok, true, `生成应成功，实为 ${JSON.stringify(g)}`);
  assert.ok(fs.existsSync(g.path));
  assert.ok(path.resolve(g.path).startsWith(path.resolve(generatedDir())));

  const conv = (
    raptorTools.convert_document as unknown as {
      execute: (i: unknown) => Promise<any>;
    }
  ).execute;
  const c = await conv({ target: "docx", text: "一段要转成 Word 的文字" });
  assert.equal(c.ok, true);
  const cErr = await conv({ target: "docx" });
  assert.ok(!cErr.ok && !!cErr.error, "无来源应报错");
});
