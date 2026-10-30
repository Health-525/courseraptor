/**
 * pptx 逐页结构化提取测试
 *
 * 两条来源互相补位：
 * - pptxgenjs 真生成的文件：验证备注（addNotes）、表格行（addTable）、
 *   空页跳过与「无标题占位符时首段作标题」的兜底路径；
 * - 手工 OOXML（jszip 拼的最小包）：验证 title 占位符识别，以及备注按
 *   slide 的 .rels 关系对应（故意让 notesSlide2 对应 slide1，证明不是同编号猜的）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-pptx-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { extractPptxText, openLocalFile } = await import("../src/core/attachments");
const { textToBlocks } = await import("../src/core/document/convert");
const require = createRequire(import.meta.url);

test("pptxgenjs 生成的课件：页码/标题/备注/表格齐全，空页跳过", async () => {
  const PptxGenJS = require("pptxgenjs") as new () => {
    addSlide: () => {
      addText: (t: string, o?: unknown) => void;
      addNotes: (t: string) => void;
      addTable: (rows: unknown[][], o?: unknown) => void;
    };
    writeFile: (o: { fileName: string }) => Promise<string>;
    layout?: string;
  };
  const pptx = new PptxGenJS();
  const s1 = pptx.addSlide();
  s1.addText("矩阵的定义", { x: 1, y: 0.5, w: 8, h: 0.8 });
  s1.addText("由 m×n 个数排成的矩形数表", { x: 1, y: 1.6, w: 8, h: 0.6 });
  s1.addNotes("老师强调：矩阵是线性映射的表示，别只会背形状。");
  const s2 = pptx.addSlide();
  s2.addText("运算规则", { x: 1, y: 0.5, w: 8, h: 0.8 });
  s2.addTable([
    ["运算", "条件"],
    ["加法", "同型矩阵"],
    ["乘法", "左列数=右行数"],
  ]);
  const s3 = pptx.addSlide(); // 空页：不应出现在结果里
  const file = path.join(tmpData, "线代第1讲.pptx");
  await pptx.writeFile({ fileName: file });
  const text = await extractPptxText(fs.readFileSync(file));

  assert.match(text, /【第 1 页·矩阵的定义】/, "首段作标题并带页码");
  assert.match(text, /矩形数表/);
  assert.match(text, /【备注】老师强调/, "演讲者备注要带出来");
  assert.match(text, /【第 2 页·运算规则】/);
  assert.match(text, /运算 \| 条件/, "表格按「单元格 | 单元格」成行");
  assert.match(text, /加法 \| 同型矩阵/);
  assert.ok(!text.includes("【第 3 页"), "空页跳过");
});

test("手工 OOXML：title 占位符作标题；备注按 rels 对应而非同编号", async () => {
  const titleShape =
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    "<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>傅里叶变换</a:t></a:r></a:p></p:txBody></p:sp>";
  const bodyShape =
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    "<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>时域与频域的桥梁</a:t></a:r></a:p></p:txBody></p:sp>";
  const slide1 =
    '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
    "<p:nvGrpSpPr/><p:grpSpPr/>" +
    `${titleShape}${bodyShape}</p:spTree></p:cSld></p:sld>`;
  // rels 故意指向 notesSlide2（而非同编号的 notesSlide1）
  const rels =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" ' +
    'Target="../notesSlides/notesSlide2.xml"/></Relationships>';
  const notes2 =
    '<?xml version="1.0"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
    "<p:sp><p:txBody><a:p><a:r><a:t>板书：三次谐波叠加示例</a:t></a:r></a:p></p:txBody></p:sp>" +
    "<p:sp><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>" + // 页码占位符，应被过滤
    "</p:spTree></p:cSld></p:notes>";
  const notes1 =
    '<?xml version="1.0"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
    "<p:sp><p:txBody><a:p><a:r><a:t>这条不该出现</a:t></a:r></a:p></p:txBody></p:sp>" +
    "</p:spTree></p:cSld></p:notes>";

  const JSZip = require("jszip") as typeof import("jszip");
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", slide1);
  zip.file("ppt/slides/_rels/slide1.xml.rels", rels);
  zip.file("ppt/notesSlides/notesSlide1.xml", notes1);
  zip.file("ppt/notesSlides/notesSlide2.xml", notes2);
  const buf = await zip.generateAsync({ type: "nodebuffer" });

  const text = await extractPptxText(buf);
  assert.match(text, /【第 1 页·傅里叶变换】/, "title 占位符作页标题");
  assert.match(text, /时域与频域的桥梁/);
  assert.match(text, /【备注】板书：三次谐波叠加示例/, "备注按 rels 关系取 notesSlide2");
  assert.ok(!text.includes("这条不该出现"), "同编号兜底不该抢在 rels 之前");
  assert.ok(!/\n1\n|【备注】1/.test(text), "纯数字页码占位符被过滤");
});

test("页标记与转档契约：textToBlocks 把【第 N 页】还原为小节标题", () => {
  const blocks = textToBlocks(
    "【第 3 页·逆矩阵】\n\n若 AB=BA=E，则 B 是 A 的逆。\n\n【第 4 页·秩】\n\n秩是最高阶非零子式的阶数。",
  );
  assert.deepEqual(blocks, [
    { type: "heading", text: "第 3 页 · 逆矩阵", level: 2 },
    { type: "paragraph", text: "若 AB=BA=E，则 B 是 A 的逆。" },
    { type: "heading", text: "第 4 页 · 秩", level: 2 },
    { type: "paragraph", text: "秩是最高阶非零子式的阶数。" },
  ]);
});

test("openLocalFile 读 pptx：走同一条逐页提取流水线", async () => {
  const PptxGenJS = require("pptxgenjs") as new () => {
    addSlide: () => { addText: (t: string, o?: unknown) => void; addNotes: (t: string) => void };
    writeFile: (o: { fileName: string }) => Promise<string>;
  };
  const pptx = new PptxGenJS();
  const s = pptx.addSlide();
  s.addText("概率回顾", { x: 1, y: 0.5, w: 8, h: 0.8 });
  s.addNotes("备注会进流水线");
  const file = path.join(tmpData, "概率课件.pptx");
  await pptx.writeFile({ fileName: file });
  const r = await openLocalFile(file);
  assert.equal(r.mode, "text");
  if (r.mode !== "text") return;
  assert.equal(r.format, "pptx");
  assert.match(r.text, /【第 1 页·概率回顾】/);
  assert.match(r.text, /【备注】备注会进流水线/);
});
