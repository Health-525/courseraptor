/**
 * slide JSON DSL 测试（ppt-dsl.ts）
 *
 * 钉住三件事：
 * 1. 硬闸 parseSlideDeck：合法 deck 放行（色板名归一、默认值补齐），畸形
 *    输入拒绝且错误是人话（模型改输入的导航）；
 * 2. 软闸 checkSlideDeck：P0/P1 检查单程序化（安全边距/高度查表/线宽误用/
 *    文本藏 LaTeX/图表 series 对不上/列宽和/代码块高度），干净 deck 零警告；
 * 3. 上限：页数/元素数超限直接拒绝。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANVAS_H,
  CANVAS_MARGIN,
  CANVAS_W,
  checkSlideDeck,
  PPT_DSL_LIMITS,
  parseSlideDeck,
} from "../src/core/document/ppt-dsl";

/** 一页只放指定元素的小 deck */
const deckOf = (...elements: unknown[]) => ({ slides: [{ elements }] });

test("parseSlideDeck：合法 deck 放行，色板名归一 + 默认值补齐", () => {
  const r = parseSlideDeck({
    slides: [
      {
        motif: "cover",
        background: { type: "solid", color: "accent" },
        notes: "口播",
        elements: [
          {
            type: "text",
            left: 100,
            top: 220,
            width: 800,
            height: 120,
            content: "<p>封面</p>",
            defaultColor: "onAccent",
          },
        ],
      },
      {
        elements: [
          {
            type: "table",
            left: 100,
            top: 100,
            width: 800,
            height: 200,
            colWidths: [0.5, 0.5],
            data: [[{ text: "甲" }, { text: "乙" }]],
          },
        ],
      },
    ],
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.deepEqual(
    r.deck.slides[0]!.background,
    { type: "solid", color: "#AD392C" },
    "accent 归一",
  );
  assert.equal(r.deck.slides[1]!.elements[0]!.type, "table");
  const cell = (r.deck.slides[1]!.elements[0] as { data: Array<Array<{ colspan: number }>> })
    .data[0]![0]!;
  assert.equal(cell.colspan, 1, "colspan 默认 1");
});

test("parseSlideDeck：background solid + 色板名归一成 #RRGGBB", () => {
  const r = parseSlideDeck({
    slides: [
      {
        background: { type: "solid", color: "paper" },
        elements: [
          {
            type: "text",
            left: 60,
            top: 60,
            width: 400,
            height: 70,
            content: "x",
            defaultColor: "ink",
          },
        ],
      },
    ],
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  const s = r.deck.slides[0]!;
  assert.deepEqual(s.background, { type: "solid", color: "#FDFCF9" });
  const el = s.elements[0]!;
  assert.equal(el.type === "text" && el.defaultColor, "#25221C");
});

test("parseSlideDeck：畸形输入拒绝，错误是人话", () => {
  const noSlides = parseSlideDeck({ slides: [] });
  assert.equal(noSlides.ok, false);
  assert.match(noSlides.ok ? "" : noSlides.error, /至少要有一页/);

  const tooMany = parseSlideDeck({
    slides: Array.from({ length: PPT_DSL_LIMITS.slides + 1 }, () => ({ elements: [] })),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.ok ? "" : tooMany.error, /页：拆成多份课件/);

  const badType = parseSlideDeck(deckOf({ type: "image", left: 0, top: 0, width: 1, height: 1 }));
  assert.equal(badType.ok, false);
  assert.match(badType.ok ? "" : badType.error, /text\/shape\/line\/chart\/table\/latex\/code/);

  const badColor = parseSlideDeck(
    deckOf({
      type: "text",
      left: 0,
      top: 0,
      width: 10,
      height: 10,
      content: "x",
      defaultColor: "红",
    }),
  );
  assert.equal(badColor.ok, false);
  assert.match(badColor.ok ? "" : badColor.error, /色板名/);

  const missingField = parseSlideDeck(deckOf({ type: "text", left: 0, top: 0, width: 10 }));
  assert.equal(missingField.ok, false);
  assert.match(missingField.ok ? "" : missingField.error, /不合法/);
});

test("checkSlideDeck：干净 deck 零警告", () => {
  // text：width 800 → 每行 (800-20)/16 ≈ 48 字，<p>标题</p> 记 2 行 → 16px 档高 70
  const deck = {
    slides: [
      {
        elements: [
          { type: "text", left: 100, top: 80, width: 800, height: 70, content: "<p>标题</p>" },
          {
            type: "shape",
            left: 100,
            top: 200,
            width: 200,
            height: 120,
            viewBox: [100, 60],
            path: "M 0 0 L 100 0 L 100 60 L 0 60 Z",
            fill: "accent",
          },
          {
            type: "chart",
            left: 100,
            top: 360,
            width: 300,
            height: 120,
            chartType: "bar",
            data: { labels: ["甲", "乙"], legends: ["S1"], series: [[1, 2]] },
          },
          {
            type: "table",
            left: 450,
            top: 360,
            width: 400,
            height: 120,
            colWidths: [0.5, 0.5],
            data: [
              [{ text: "甲" }, { text: "乙" }],
              [{ text: "1" }, { text: "2" }],
            ],
          },
          { type: "latex", left: 100, top: 482, width: 300, height: 30, latex: "E=mc^2" },
          {
            type: "code",
            left: 450,
            top: 430,
            width: 400,
            height: 80,
            language: "ts",
            lines: [{ content: "const a = 1;" }, { content: "const b = 2;" }],
          },
        ],
      },
    ],
  };
  const warnings = checkSlideDeck(deck as Parameters<typeof checkSlideDeck>[0]);
  assert.deepEqual(warnings, [], "干净 deck 不应有警告");
});

test("checkSlideDeck：P0 警告逐条命中", () => {
  const out = checkSlideDeck(
    deckOf({
      type: "text",
      left: 10,
      top: 60,
      width: 400,
      height: 70,
      content: "<p>贴边</p>",
    }) as Parameters<typeof checkSlideDeck>[0],
  );
  assert.ok(
    out.some((w) => /安全边距/.test(w)),
    "越界应警告",
  );

  const short = checkSlideDeck(
    deckOf({
      type: "text",
      left: 100,
      top: 80,
      width: 800,
      height: 40,
      content: "<p>标题</p>",
    }) as Parameters<typeof checkSlideDeck>[0],
  );
  assert.ok(
    short.some((w) => /高度查表/.test(w)),
    "高度不足应警告",
  );

  const chart = checkSlideDeck(
    deckOf({
      type: "chart",
      left: 100,
      top: 100,
      width: 400,
      height: 200,
      chartType: "bar",
      data: { labels: ["甲", "乙"], legends: ["S1"], series: [[1, 2, 3]] },
    }) as Parameters<typeof checkSlideDeck>[0],
  );
  assert.ok(
    chart.some((w) => /对不上/.test(w)),
    "series 与 labels 长度不一致应警告",
  );

  const widths = checkSlideDeck(
    deckOf({
      type: "table",
      left: 100,
      top: 100,
      width: 400,
      height: 200,
      colWidths: [0.3, 0.3],
      data: [[{ text: "甲" }, { text: "乙" }]],
    }) as Parameters<typeof checkSlideDeck>[0],
  );
  assert.ok(
    widths.some((w) => /colWidths 总和/.test(w)),
    "列宽和不为 1 应警告",
  );

  const fat = checkSlideDeck(
    deckOf({
      type: "line",
      left: 100,
      top: 100,
      width: 300,
      start: [0, 0],
      end: [300, 0],
    }) as Parameters<typeof checkSlideDeck>[0],
  );
  assert.ok(
    fat.some((w) => /线宽/.test(w)),
    "线宽超 6（当成长度）应警告",
  );

  const tex = checkSlideDeck(
    deckOf({
      type: "text",
      left: 100,
      top: 80,
      width: 800,
      height: 70,
      content: "<p>公式 \\frac{1}{2}</p>",
    }) as Parameters<typeof checkSlideDeck>[0],
  );
  assert.ok(
    tex.some((w) => /LaTeX/.test(w)),
    "文本里藏 LaTeX 应警告",
  );

  const empty = checkSlideDeck({ slides: [{ elements: [] }] });
  assert.ok(
    empty.some((w) => /没有任何元素/.test(w)),
    "空白页应警告",
  );
});

test("上限常量与画布常量自洽", () => {
  assert.equal(CANVAS_W, 1000);
  assert.equal(CANVAS_H, 562.5);
  assert.equal(CANVAS_MARGIN, 50);
  assert.equal(CANVAS_W / CANVAS_H, 16 / 9, "16:9 画布");
  assert.ok(PPT_DSL_LIMITS.slides >= 30, "预览上限 30 页在硬上限之内");
});
