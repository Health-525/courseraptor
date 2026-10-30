/**
 * 学习笔记 HTML 渲染测试
 *
 * 钉住五件事：
 * 1. 所有内容转义——模型输出里的 <script>/<img> 只能当文本显示；
 *    meta CSP 是第二道闸（default-src 'none' 只放行内联样式）。
 * 2. 目录锚点：heading 生成 id，目录 href 指得过去。
 * 3. callout 三种语气（重点/易错/考点）各自成框；docx/pdf 转档时退化为着色段落。
 * 4. 单文件交付约束：深浅色与打印样式内嵌，无外链无脚本。
 * 5. 落盘走 generateAndSave：扩展名 .html，进 data/generated 本轮流水。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DocumentSpec } from "../src/core/document/types";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-note-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { renderNoteHtml } = await import("../src/core/document/note-html");
const { renderDocument } = await import("../src/core/document/render");
const { generateAndSave, generatedDir } = await import("../src/core/document/save");

const SPEC: DocumentSpec = {
  format: "html" as const,
  title: "高等数学 · 第三章 学习笔记",
  course: "高等数学",
  sources: ["第3章课件.pptx", "习题讲义.pdf"],
  blocks: [
    { type: "heading", text: "一、中值定理", level: 1 as const },
    { type: "paragraph", text: "罗尔定理是拉格朗日中值定理的特例。" },
    { type: "callout", text: "罗尔定理要求端点函数值相等。", tone: "key" as const },
    { type: "callout", text: "可导≠连续可导，验证条件别漏。", tone: "warn" as const },
    { type: "callout", text: "证明题大概率考拉格朗日。", tone: "exam" as const },
    { type: "heading", text: "1.1 罗尔定理", level: 2 as const },
    {
      type: "table",
      caption: "定理条件对照",
      table: { headers: ["定理", "条件"], rows: [["罗尔", "f(a)=f(b)"]] },
    },
    { type: "list", items: ["几何意义：存在水平切线"], ordered: false },
    { type: "pagebreak" },
  ],
};

test("转义与 CSP：模型输出不当 HTML 用，脚本不外链", () => {
  const html = renderNoteHtml({
    format: "html",
    title: "笔记<script>alert(1)</script>",
    blocks: [
      { type: "paragraph", text: '<img src=x onerror="alert(1)">' },
      { type: "heading", text: '章节"><script>alert(2)</script>', level: 1 },
    ],
  });
  assert.ok(!/<script>/.test(html), "不允许出现裸 <script>");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "标题文本转义");
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), "正文转义");
  assert.match(
    html,
    /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/,
  );
  assert.ok(!/<script[^>]*src/.test(html), "不引入外部脚本");
});

test("目录锚点、callout 语气与来源页脚", () => {
  const html = renderNoteHtml(SPEC);
  assert.match(html, /<h2 id="s1">一、中值定理<\/h2>/);
  assert.match(html, /<h3 id="s2">1.1 罗尔定理<\/h3>/);
  assert.match(html, /<a href="#s1">一、中值定理<\/a>/);
  assert.match(html, /<aside class="callout tone-key"><strong>重点<\/strong>/);
  assert.match(html, /<aside class="callout tone-warn"><strong>易错<\/strong>/);
  assert.match(html, /<aside class="callout tone-exam"><strong>考点<\/strong>/);
  assert.match(html, /来源课件：第3章课件\.pptx、习题讲义\.pdf/);
  assert.match(html, /高等数学 · 学习笔记/, "课程名进眉题");
  assert.match(html, /<caption>定理条件对照<\/caption>/);
  assert.match(html, /<tr><td>罗尔<\/td><td>f\(a\)=f\(b\)<\/td><\/tr>/);
  assert.ok(!/<img/.test(html), "零图片零外链");
});

test("单文件约束：深浅色与打印样式内嵌", () => {
  const html = renderNoteHtml(SPEC);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /@media print/);
  assert.match(html, /<meta name="viewport"/);
});

test("renderDocument / generateAndSave：html 成品可落盘", async () => {
  const { buffer, baseName } = await renderDocument(SPEC);
  const html = buffer.toString("utf8");
  assert.match(html, /<!doctype html>/);
  assert.equal(baseName, "高等数学 · 第三章 学习笔记");

  const file = await generateAndSave(SPEC, { filename: "线代笔记" });
  assert.ok(file.filename.startsWith("线代笔记"));
  assert.ok(file.filename.endsWith(".html"));
  assert.ok(file.filePath.startsWith(generatedDir()));
  assert.ok(fs.existsSync(file.filePath));
  assert.ok(fs.statSync(file.filePath).size > 1000, "笔记不至于空壳");
});

test("callout 在 docx/pdf 转档时退化为着色段落而不炸", async () => {
  const { renderDocx, renderPdf } = await import("../src/core/document/render");
  const spec: DocumentSpec = {
    format: "docx",
    title: "带提示框的笔记",
    blocks: [
      { type: "callout", text: "必记：端点相等。", tone: "key" as const },
      { type: "callout", text: "易漏：可导条件。", tone: "warn" as const },
      { type: "callout", text: "考点：中值定理证明。", tone: "exam" as const },
      { type: "paragraph", text: "正文不受影响" },
    ],
  };
  const docx = await renderDocx(spec);
  assert.ok(docx.length > 0);
  const pdf = await renderPdf(spec);
  assert.ok(pdf.subarray(0, 4).toString() === "%PDF");
});
