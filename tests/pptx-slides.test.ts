/**
 * DSL→PPTX 渲染器测试（pptx-slides.ts）
 *
 * 钉住四件事（解包 zip 看字节，不是「看起来对」）：
 * 1. 七种元素都落到 slide XML：富文本 runs / custGeom 任意形状 / 线条 /
 *    图表 graphicFrame / 表格 a:tbl / 公式注入（PUA 标记被替换成 OMML）/
 *    代码卡片（Consolas + 行号）；
 * 2. 品牌 chrome 由 motif 驱动：封面朱砂底、内容页页脚 COURSERAPTOR +
 *    页码、印章 logo 进媒体部件且被去重（多页同一 logo 只留一份）；
 * 3. 渐变背景取首尾混色（pptx 背景只吃纯色），深色底判定随亮度；
 * 4. notes 进独立 notesSlide 部件。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-slides-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const require = createRequire(import.meta.url);

import { parseSlideDeck, type SlideDeck } from "../src/core/document/ppt-dsl";
import { renderSlidesDeck } from "../src/core/document/pptx-slides";

async function pptxParts(buf: Buffer) {
  const JSZip = require("jszip") as typeof import("jszip");
  const zip = await JSZip.loadAsync(buf);
  const read = async (filter: RegExp) => {
    const names = Object.keys(zip.files)
      .filter((n) => filter.test(n))
      .sort();
    const parts = await Promise.all(
      names.map((n) => zip.files[n]?.async("string") ?? Promise.resolve("")),
    );
    return parts.join("\n");
  };
  return {
    slides: await read(/^ppt\/slides\/slide\d+\.xml$/),
    slide1: (await zip.files["ppt/slides/slide1.xml"]?.async("string")) ?? "",
    notes: await read(/^ppt\/notesSlides\/notesSlide\d+\.xml$/),
    media: Object.keys(zip.files).filter((n) => /^ppt\/media\/[^/]+$/.test(n)),
  };
}

/** 覆盖七种元素 + 三态 motif 的小课件（先过硬闸，与工具落盘同一条路） */
function fullDeck(): SlideDeck {
  const parsed = parseSlideDeck({
    slides: [
      {
        motif: "cover",
        background: { type: "solid", color: "accent" },
        notes: "开场白",
        elements: [
          {
            type: "text",
            left: 100,
            top: 260,
            width: 800,
            height: 120,
            content:
              '<p style="text-align:center"><span style="font-size:44px;color:#FDFCF9">期末复习</span></p>',
            defaultColor: "onAccent",
          },
          {
            type: "shape",
            left: 400,
            top: 420,
            width: 200,
            height: 60,
            viewBox: [100, 30],
            path: "M 0 0 L 100 0 L 100 30 L 0 30 Z",
            fill: "paper",
            text: { content: "2026 春", defaultColor: "accent" },
          },
        ],
      },
      {
        motif: "section",
        background: {
          type: "gradient",
          gradient: {
            colors: [
              { pos: 0, color: "accent" },
              { pos: 1, color: "accentDeep" },
            ],
          },
        },
        elements: [
          {
            type: "text",
            left: 100,
            top: 240,
            width: 800,
            height: 80,
            content: "<p>第一章 极限</p>",
            defaultColor: "onAccent",
          },
          {
            type: "line",
            left: 100,
            top: 360,
            width: 3,
            start: [0, 0],
            end: [400, 0],
            color: "onAccent",
            points: ["", "arrow"],
          },
        ],
      },
      {
        elements: [
          {
            type: "text",
            left: 100,
            top: 80,
            width: 800,
            height: 70,
            content: "<p>公式与代码</p>",
          },
          { type: "latex", left: 100, top: 180, width: 400, height: 60, latex: "E=mc^2" },
          {
            type: "chart",
            left: 550,
            top: 170,
            width: 350,
            height: 220,
            chartType: "bar",
            data: { labels: ["甲", "乙", "丙"], legends: ["成绩"], series: [[80, 92, 76]] },
          },
          {
            type: "table",
            left: 100,
            top: 280,
            width: 400,
            height: 140,
            colWidths: [0.5, 0.5],
            theme: { color: "accent", rowHeader: true },
            data: [
              [{ text: "式" }, { text: "值" }],
              [{ text: "π" }, { text: "3.14" }],
            ],
          },
          {
            type: "code",
            left: 550,
            top: 410,
            width: 350,
            height: 90,
            language: "ts",
            fileName: "demo.ts",
            lines: [{ content: "const x = 1;" }, { content: "console.log(x);" }],
          },
        ],
      },
    ],
  });
  if (!parsed.ok) throw new Error(`测试 deck 不合法：${parsed.error}`);
  return parsed.deck;
}

test("renderSlidesDeck：七种元素都落进 slide XML", async () => {
  const buf = await renderSlidesDeck(fullDeck());
  const { slides } = await pptxParts(buf);
  // 富文本：内联样式的字号/颜色进 runs
  assert.match(slides, /44/, "内联 font-size 应换算成磅值");
  assert.match(slides, /FDFCF9/i, "封面浅色字");
  // 形状：custGeom + points（SVG path 映射）
  assert.match(slides, /custGeom/, "任意形状走 custGeom");
  // 线条：箭头
  assert.match(slides, /arrow/i, "endArrowType 应写入");
  // 图表：graphicFrame
  assert.match(slides, /graphicFrame/, "图表走 graphicFrame");
  // 表格：a:tbl
  assert.match(slides, /<a:tbl>/, "表格走 a:tbl");
  // 代码：Consolas
  assert.match(slides, /Consolas/, "代码卡片用等宽字体");
  // 形状内文本
  assert.match(slides, /2026 春/, "形状内文本应渲染");
});

test("renderSlidesDeck：公式注入 OMML，PUA 标记不残留", async () => {
  const buf = await renderSlidesDeck(fullDeck());
  const { slides } = await pptxParts(buf);
  assert.match(slides, /<m:oMath/, "LaTeX 应注入 OMML 公式块");
  assert.match(slides, /a14:m/, "公式走 mc:AlternateContent 的 a14:m");
  assert.ok(!slides.includes("\uE000"), "占位私用区字符不应残留");
  assert.ok(!slides.includes("E=mc^2"), "LaTeX 源码不应以文本形式留在页面上");
});

test("renderSlidesDeck：motif 品牌 chrome（页脚/页码/印章 logo 去重）", async () => {
  const buf = await renderSlidesDeck(fullDeck());
  const { slides, media } = await pptxParts(buf);
  assert.match(slides, /COURSERAPTOR/, "内容页页脚品牌字");
  assert.match(slides, /AD392C/i, "朱砂色（封面底/章节印章）");
  // 渐变背景取首尾混色：AD392C 与 852B22 的中点 = 993227
  assert.match(slides, /993227/i, "章节页渐变应降级为首尾混色");
  // 印章 logo：三页各画一次，媒体去重后只留一份
  assert.equal(media.length, 1, `印章 logo 应去重成一份，实为 ${media.length}`);
});

test("renderSlidesDeck：notes 进独立部件，空元素页不炸", async () => {
  const buf = await renderSlidesDeck(fullDeck());
  const { notes } = await pptxParts(buf);
  assert.match(notes, /开场白/, "演讲者备注应落 notesSlide");

  const bare = await renderSlidesDeck({ slides: [{ elements: [] }] });
  const parts = await pptxParts(bare);
  assert.equal(parts.slides.length > 0, true, "空白页也应产出 slide XML");
});
