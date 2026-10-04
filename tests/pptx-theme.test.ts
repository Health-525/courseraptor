/**
 * PPT 品牌主题引擎测试
 *
 * 钉住四件事：
 * 1. 版式计划：封面/章节页/内容页正确归类、blocks 自动分页、字号自适应；
 * 2. 成品保真：解包 pptx（zip），在 slide/layout/master XML 里断言品牌色、
 *    中文字体、项目符号、页码字段、表格头填充真的写进去了——不是「看起来
 *    对」，是「字节里对」；
 * 3. 预览载荷：与版式计划同源（封面在前、截断有上限），形状校验闸拒绝
 *    畸形输入（chat-web 透传前的同一道闸）；
 * 4. 工具接线：ppt_save（代码工具）/ convert_document 的 pptx 结果带 ppt 载荷。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-ppt-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const require = createRequire(import.meta.url);

import {
  buildPptPreview,
  PPT_THEME,
  PREVIEW_SLIDE_CAP,
  planPptSlides,
  pptPreviewOfToolOutput,
} from "../src/core/document/pptx-theme";
import { renderPptx } from "../src/core/document/render";

const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 4).equals(PK);
}

/** 解包 pptx 并按类别拼接 XML 全文（slides / layouts / masters / notes + 媒体计数） */
async function pptxXml(buf: Buffer): Promise<{
  slides: string;
  layouts: string;
  masters: string;
  notes: string;
  mediaCount: number;
  all: string;
}> {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buf);
  const read = async (filter: RegExp) => {
    const names = Object.keys(zip.files)
      .filter((n) => filter.test(n))
      .sort();
    const parts = await Promise.all(names.map((n) => zip.files[n].async("string")));
    return parts.join("\n");
  };
  const slides = await read(/^ppt\/slides\/slide\d+\.xml$/);
  const layouts = await read(/^ppt\/slideLayouts\/slideLayout\d+\.xml$/);
  const masters = await read(/^ppt\/slideMasters\/slideMaster\d+\.xml$/);
  const notes = await read(/^ppt\/notesSlides\/notesSlide\d+\.xml$/);
  const mediaCount = Object.keys(zip.files).filter((n) => /^ppt\/media\//.test(n)).length;
  return {
    slides,
    layouts,
    masters,
    notes,
    mediaCount,
    all: `${slides}\n${layouts}\n${masters}\n${notes}`,
  };
}

test("planPptSlides：封面/章节页/内容页归类 + 字号自适应", () => {
  const plan = planPptSlides({
    format: "pptx",
    title: "期末复习",
    author: "小明",
    slides: [
      { title: "第一部分 高数" },
      { title: "极限", bullets: ["定义", "计算"] },
      { title: "公式表", table: { headers: ["式", "值"], rows: [["e", "2.718"]] } },
      { title: "引言", subtitle: "研究背景" },
    ],
  });
  assert.deepEqual(
    plan.map((s) => s.kind),
    ["cover", "section", "content", "content", "content"],
  );
  assert.equal(plan[0].author, "小明");
  assert.equal(plan[2].bodySize, 16, "2 条要点应给最大字号");
  assert.equal(plan[3].bodySize, 13, "表格 1 行给表格档最大字号");

  const many = planPptSlides({
    format: "pptx",
    slides: [{ title: "多要点", bullets: Array.from({ length: 15 }, (_, i) => `点${i}`) }],
  });
  assert.equal(many[0].bodySize, 13, "15 条要点收缩到最小档");
});

test("planPptSlides：blocks 自动分页（标题切页、有序列表带前缀）", () => {
  const plan = planPptSlides({
    format: "pptx",
    blocks: [
      { type: "heading", text: "背景", level: 1 },
      { type: "list", items: ["一", "二"], ordered: true },
      { type: "heading", text: "方案", level: 2 },
      { type: "paragraph", text: "一句话" },
      { type: "heading", text: "附录（三级不切页）", level: 3 },
    ],
  });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0].bullets, ["1. 一", "2. 二"]);
  assert.deepEqual(plan[1].bullets, ["一句话"]);
});

test("renderPptx：品牌样式在 XML 字节层可验证", async () => {
  const buf = await renderPptx({
    format: "pptx",
    title: "开题答辩",
    author: "李雷",
    slides: [
      { title: "第一章 背景" },
      { title: "研究意义", bullets: ["效率提升", "门槛降低"], notes: "备注甲" },
      {
        title: "方案对比",
        table: {
          headers: ["方案", "得分"],
          rows: [
            ["A", "90"],
            ["B", "2.718"],
          ],
        },
      },
      {
        title: "复习清单",
        bullets: ["一", "二", "三", "四", "五", "六", "七", "八"],
      },
    ],
  });
  assert.ok(isZip(buf), "pptx 应是 zip");
  assert.ok(buf.length > 4000, "含品牌母版与配色，体积应明显大于朴素版");

  const xml = await pptxXml(buf);
  // 封面（官方三明治深色端）：朱砂整版、居中大印章、楷体大标题、日期
  assert.match(xml.slides, /开题答辩/);
  assert.match(xml.slides, /李雷/);
  assert.match(xml.slides, /年\d+月\d+日/);
  assert.ok(xml.slides.includes("KaiTi"), "封面主标题应引用楷体");
  // 签名 motif：朱砂印章（椭圆描边圈 + 圆形裁切 logo + 整章旋转）
  assert.ok(xml.mediaCount >= 1, "logo 应作为媒体嵌入 pptx");
  assert.ok(xml.slides.includes("<p:pic>"), "封面应内嵌 logo 图片");
  assert.ok(xml.slides.includes('prst="ellipse"'), "印章描边圈应为椭圆形状");
  assert.ok(xml.all.includes(PPT_THEME.accent), "朱砂主色应出现在印章描边/章节页底色里");
  // 章节页标题 + 内容页要点/表格正文
  assert.match(xml.slides, /第一章 背景/);
  assert.match(xml.slides, /效率提升/);
  assert.match(xml.slides, /方案对比/);
  assert.match(xml.slides, /2\.718/);
  // 中文字体引用、两种要点形态（≤6 条数字圆圈行 / >6 条 ▪ 紧凑列表）、表头与斑马纹
  assert.ok(xml.all.includes("Microsoft YaHei"));
  assert.ok(xml.all.toUpperCase().includes("25AA"), "超量要点回退 ▪ 列表");
  assert.ok(xml.slides.includes("复"), "数字圆圈行与列表页正文都应落进 XML");
  assert.ok(xml.all.includes(PPT_THEME.accentDeep), "表格头应填朱砂深色");
  assert.ok(xml.all.includes(PPT_THEME.paperDeep), "表格斑马纹应有压深纸色");
  // 母版层：页脚品牌字 + 自动页码字段（logo 落款走媒体部件）
  assert.ok(xml.layouts.includes("COURSERAPTOR"), "内容页母版应带品牌页脚");
  assert.ok(xml.layouts.includes("slidenum"), "母版应带自动页码字段");
  // 演讲者备注进了独立部件
  assert.match(xml.notes, /备注甲/);
});

test("buildPptPreview：与版式计划同源，截断有上限", () => {
  const slides = Array.from({ length: PREVIEW_SLIDE_CAP + 5 }, (_, i) => ({
    title: `页${i}`,
    bullets: Array.from({ length: 20 }, (_, j) => `点${j}`),
  }));
  const pv = buildPptPreview({ format: "pptx", title: "大课件", slides });
  // 总页数 = 封面 + 35 页；预览数组封顶 30
  assert.equal(pv.count, PREVIEW_SLIDE_CAP + 6);
  assert.equal(pv.slides.length, PREVIEW_SLIDE_CAP);
  assert.equal(pv.slides[0].kind, "cover");
  const s = pv.slides[1];
  assert.equal(s.bullets?.length, 12, "要点截到 12 条");
  assert.equal(s.bulletCut, 8);
});

test("pptPreviewOfToolOutput：合法载荷放行、畸形载荷拒绝", () => {
  assert.equal(pptPreviewOfToolOutput({}), null);
  assert.equal(pptPreviewOfToolOutput({ ppt: { slides: [] } }), null);
  assert.equal(pptPreviewOfToolOutput({ ppt: { slides: [{ title: "x", kind: "hack" }] } }), null);
  assert.equal(pptPreviewOfToolOutput({ ppt: { slides: [{ kind: "cover" }] } }), null);
  assert.equal(pptPreviewOfToolOutput("string"), null);

  const good = pptPreviewOfToolOutput({
    ppt: {
      count: 2,
      slides: [
        { kind: "cover", title: "课件", author: "我" },
        { kind: "content", title: "要点", bullets: ["一", 42, null], table: { rows: [["a"]] } },
      ],
    },
  });
  assert.ok(good);
  assert.equal(good.count, 2);
  assert.deepEqual(good.slides[1].bullets, ["一"], "非字符串要点应被滤掉");
  assert.equal(good.slides[1].table?.rows.length, 1);

  // free 页（代码工具 blank 页）：标题可缺省，元素逐个校验
  const free = pptPreviewOfToolOutput({
    ppt: {
      count: 1,
      slides: [
        {
          kind: "free",
          elements: [
            { kind: "text", x: 0.5, y: 1, w: 4, h: 0.5, text: "自由行", size: 18, bold: true },
            { kind: "rect", x: 0, y: 0, w: 10, h: 0.1, fill: "AD392C" },
            { kind: "logo", x: 9, y: 5, w: 0.5, h: 0.5 },
          ],
        },
      ],
    },
  });
  assert.ok(free, "合法 free 页应过闸");
  assert.equal(free!.slides[0].elements!.length, 3);
  assert.equal(
    pptPreviewOfToolOutput({ ppt: { count: 1, slides: [{ kind: "free" }] } })?.slides[0].elements,
    undefined,
    "无元素的 free 页也合法",
  );

  // count 小于实际页数：以实际为准（防模型漏报页数骗过前端计数器）
  const under = pptPreviewOfToolOutput({
    ppt: {
      count: 1,
      slides: [
        { kind: "cover", title: "a" },
        { kind: "section", title: "b" },
      ],
    },
  });
  assert.equal(under?.count, 2);

  // 超量载荷：输出仍封顶
  const fat = pptPreviewOfToolOutput({
    ppt: {
      count: 99,
      slides: Array.from({ length: 99 }, () => ({ kind: "content", title: "x" })),
    },
  });
  assert.equal(fat?.slides.length, PREVIEW_SLIDE_CAP);
});

test("工具接线：ppt_save 的 pptx 带 ppt 载荷，generate_document 不再产出课件", async () => {
  const { coreTools } = await import("../src/core/tools");
  const save = (coreTools.ppt_save as unknown as { execute: (i: unknown) => Promise<any> }).execute;
  const g = await save({
    code: 'pptx.cover({ title: "工具层课件" }); pptx.section("章节"); pptx.bullets({ title: "要点", points: ["一", "二"] });',
  });
  assert.equal(g.ok, true, `生成应成功，实为 ${JSON.stringify(g)}`);
  assert.ok(g.ppt, "pptx 结果应带预览载荷");
  assert.equal(g.ppt.count, 3, "封面 + 章节页 + 内容页");
  assert.equal(g.ppt.slides[0].kind, "cover");
  assert.ok(fs.existsSync(g.path));

  const gen = (coreTools.generate_document as unknown as { execute: (i: unknown) => Promise<any> })
    .execute;
  const gDocx = await gen({
    format: "docx",
    title: "不是课件",
    blocks: [{ type: "paragraph", text: "x" }],
  });
  assert.equal(gDocx.ok, true);
  assert.equal(gDocx.ppt, undefined, "docx 不带 ppt 载荷");

  const conv = (coreTools.convert_document as unknown as { execute: (i: unknown) => Promise<any> })
    .execute;
  const c = await conv({ target: "pptx", text: "# 标题甲\n\n- 要点一\n- 要点二" });
  assert.equal(c.ok, true, `转换应成功，实为 ${JSON.stringify(c)}`);
  assert.ok(c.ppt, "转换成 pptx 也应带预览载荷");
  assert.ok(c.ppt.count >= 2);
});

test("前端接线：chat-app.js 定义并调用 pptCard，chat-page.ts 带查看器样式", () => {
  const app = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/channels/web/assets/chat-app.js"),
    "utf8",
  );
  assert.match(app, /function pptCard\(/, "pptCard 应有定义");
  assert.match(app, /pptCard\(shell\.tl, ev\.ppt/, "SSE 分发应调用 pptCard");
  assert.match(app, /function pptView\(/, "全屏查看器应有定义");

  const css = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/channels/web/chat-page.ts"),
    "utf8",
  );
  for (const sel of [".pptcard", ".pptstrip", ".pptslide", ".pptv-stage", ".pptview"]) {
    assert.ok(css.includes(sel), `chat-page.ts 应含 ${sel} 样式`);
  }
});

test("媒体去重：重复 logo 合并为一份，且 rels 不悬空（PowerPoint 破损图回放）", async () => {
  const buf = await renderPptx({
    format: "pptx",
    title: "印章课件",
    slides: [
      { title: "章节一" },
      { title: "要点", bullets: ["一"] },
      { title: "表", table: { headers: ["a"], rows: [["b"]] } },
      { title: "章节二" },
    ],
  });
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  // 同一份 logo（封面印章 + 两个章节页印章 + 内容页母版落款）必须合并为一份媒体
  const media = names.filter((n) => /^ppt\/media\/[^/]+$/.test(n));
  assert.equal(media.length, 1, `重复媒体应合并为一份，实为 ${media.join(", ")}`);
  // 所有 .rels 引用的 media 目标都必须真实存在（相对路径 ../media/ 归一化后核对）
  for (const relsName of names.filter((n) => n.endsWith(".rels"))) {
    const xml = await zip.files[relsName].async("string");
    for (const m of xml.matchAll(/Target="([^"]*media\/[^"/]+)"/g)) {
      const target = m[1].replace(/^\.\.\//, "ppt/");
      assert.ok(
        names.includes(target),
        `${relsName} 引用的 ${target} 不存在（悬空引用 → PowerPoint 破损图片）`,
      );
    }
  }
  // 内容页母版（slideLayout）的落款 logo 仍在位——母版级图片挂在 layout 的
  // rels 上，去重误伤它会让全部内容页一起掉图
  const layoutRelsNames = names.filter((n) => /^ppt\/slideLayouts\/_rels\/.+\.rels$/.test(n));
  const withMedia = await Promise.all(
    layoutRelsNames.map(async (n) => await zip.files[n].async("string")),
  );
  assert.ok(
    withMedia.some((xml) => /media\//.test(xml)),
    "内容页版式的 rels 应仍指向合并后的 logo 媒体",
  );
});
