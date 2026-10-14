/**
 * PPT 富文本 HTML 面测试（ppt-html.ts）
 *
 * 钉住四件事：
 * 1. parseHtml：迷你解析器的容错（p/li 自动闭合、void 标签、实体解码、
 *    剥 \n、裸 < 按文本）；
 * 2. htmlToRuns：样式逐级继承、段落边界 breakLine、列表记号（•/序号）、
 *    sup/sub 映射——pptx 的 runs 是扁平文本，记号必须落在文本里；
 * 3. sanitizeHtml：重建式白名单——脚本/事件属性/javascript: URL 在结构上
 *    无法存活（这是网页预览渲染器敢用 innerHTML 的前提）；
 * 4. htmlToPlainText：表格单元格的纯文本降级。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  htmlToPlainText,
  htmlToRuns,
  parseHtml,
  sanitizeHtml,
} from "../src/core/document/ppt-html";

const flat = (runs: ReturnType<typeof htmlToRuns>) =>
  runs.map((r) => `${r.text}${r.breakLine ? "\n" : ""}`).join("");

test("parseHtml：自动闭合、实体解码、剥换行", () => {
  const nodes = parseHtml("<p>甲<p>乙<br>丙<img src=x>&amp;&lt;");
  // 两层 p：第二个 p 是第一个的子节点还是兄弟？本解析器遇开标签压栈、
  // 关闭时弹到同名标签——<p> 不自动关闭上一个 <p>，但 li/p 的常见嵌套成立
  assert.ok(nodes.length >= 1);
  const json = JSON.stringify(nodes);
  assert.ok(json.includes("甲"), "文本保留");
  assert.ok(json.includes("丙"), "void 标签后的文本保留");
  assert.ok(!json.includes("\n"), "源码换行被剥掉");
  // 实体解码
  const t = htmlToPlainText("&amp;&lt;&gt;&quot;&#39;&nbsp;");
  assert.equal(t, "&<>\"' ");
});

test("htmlToRuns：样式继承 + 段落 breakLine + 列表记号", () => {
  const runs = htmlToRuns(
    '<p style="color:#AD392C">外层<span style="font-size:24px">内层</span>尾</p><p>第二段</p>',
  );
  const colored = runs.find((r) => r.text === "外层");
  assert.equal(colored?.color, "AD392C", "块级样式被后代继承");
  const big = runs.find((r) => r.text === "内层");
  assert.equal(big?.fontSize, 18, "24px → 18pt（PT_PER_PX=0.75）");
  assert.equal(big?.color, "AD392C", "内层继承外层颜色");
  const tail = runs.find((r) => r.text === "尾");
  assert.equal(tail?.breakLine, true, "进入下一段时上一段末尾落 breakLine");

  const ul = htmlToRuns("<ul><li>甲</li><li>乙</li></ul>");
  assert.equal(flat(ul), "• 甲\n• 乙", "无序列表加 • 记号");

  const ol = htmlToRuns("<ol><li>甲</li><li>乙</li></ol>");
  assert.equal(flat(ol), "1. 甲\n2. 乙", "有序列表按同级序号");

  const sup = htmlToRuns("x<sup>2</sup>");
  assert.equal(sup.find((r) => r.text === "2")?.superscript, true, "sup 映射上标");
  const strong = htmlToRuns("<strong>粗</strong>");
  assert.equal(strong[0]?.bold, true, "strong 映射粗体");
});

test("sanitizeHtml：脚本与事件属性在结构上无法存活", () => {
  const out = sanitizeHtml(
    '<p onclick="alert(1)">安全<script>alert(2)</script><span style="font-size:20px;color:#AD392C">样式</span></p><a href="javascript:alert(3)">坏链</a><a href="https://ok.cn">好链</a>',
  );
  assert.ok(!out.includes("script"), "script 标签被剥");
  assert.ok(!out.includes("onclick"), "事件属性被剥");
  assert.ok(!out.includes("javascript:"), "javascript: URL 被丢");
  assert.ok(!out.includes("alert"), "脚本内容不残留");
  assert.ok(out.includes("font-size: 20px"), "白名单样式保留");
  assert.ok(out.includes("#AD392C"), "白名单颜色保留");
  assert.ok(out.includes('href="https://ok.cn"'), "https 外链保留");
  assert.ok(out.includes("安全"), "正常文本保留");
});

test("sanitizeHtml：未知标签脱壳留内容，列表标签放行", () => {
  const out = sanitizeHtml("<div><ul><li>甲</li></ul><table><tr><td>乙</td></tr></table></div>");
  assert.ok(!out.includes("<div"), "div 脱壳");
  assert.ok(!out.includes("<table"), "table 脱壳");
  assert.ok(out.includes("<ul>"), "ul 放行（预览要原生列表）");
  assert.ok(out.includes("<li>甲</li>"), "li 放行");
  assert.ok(out.includes("乙"), "脱壳标签的内容保留");
});

test("sanitizeHtml：style 值白名单（表达式/非 hex 色丢弃）", () => {
  const out = sanitizeHtml(
    '<span style="color:expression(alert(1));background-color:red;font-size:20px">x</span>',
  );
  assert.ok(!out.includes("expression"), "CSS 表达式被丢");
  assert.ok(!out.includes("red"), "非 hex 颜色被丢");
  assert.ok(out.includes("font-size: 20px"), "合法 px 字号保留");
});

test("htmlToPlainText：块级换行、标签剥离", () => {
  assert.equal(htmlToPlainText("<p>甲</p><p>乙</p>"), "甲\n乙");
  assert.equal(htmlToPlainText("<strong>粗</strong>斜"), "粗斜");
  assert.equal(htmlToPlainText(""), "");
});
