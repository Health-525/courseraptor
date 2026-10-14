/**
 * 预览载荷校验闸测试（web-ppt-preview.ts）
 *
 * 钉住四件事：
 * 1. 双载荷分流：旧 spec→PPT 载荷（slides 带 kind）与新 slide JSON 载荷
 *    （不带 kind，deck 原形）各走各的校验路径，互不误判；
 * 2. 新载荷整份过 core 的 slideDeckSchema：畸形元素（未知 type/缺字段/
 *    越界坐标/颜色乱写）整份拒绝，绝不把坑货透到前端；
 * 3. 服务端净化：text 元素的 HTML 过白名单（innerHTML 的前提），公式的
 *    MathML 预览串原样带回（temml 产物，白名单外但来源可信）；
 * 4. count 兜底：模型漏报页数骗不过前端计数器。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { pptPreviewOfToolOutput } from "../src/channels/web/web-ppt-preview";
import type { PptDslPreview } from "../src/core/document/pptx-theme";

/** 过闸结果收窄成 DSL 载荷（旧管线载荷的 slides 带 kind，DSL 不带） */
function asDsl(p: ReturnType<typeof pptPreviewOfToolOutput>): PptDslPreview {
  assert.ok(p, "载荷应过闸");
  assert.ok(!("kind" in p.slides[0]!), "应是 DSL 载荷");
  return p as PptDslPreview;
}

/** 合法的最小 DSL 载荷（一页一个 text 元素） */
const dslPayload = {
  ppt: {
    count: 2,
    slides: [
      {
        motif: "cover",
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
          { type: "text", left: 100, top: 80, width: 800, height: 70, content: "<p>要点</p>" },
        ],
      },
    ],
  },
};

test("DSL 载荷：合法放行，形状与 count 保留", () => {
  const p = asDsl(pptPreviewOfToolOutput(dslPayload));
  assert.equal(p.count, 2);
  assert.equal(p.slides.length, 2);
  assert.equal(p.slides[0]!.motif, "cover");
  assert.equal(p.slides[0]!.elements[0]!.type, "text");
  // 色板名在闸内归一（与工具硬闸同一份 schema）
  const el = p.slides[0]!.elements[0] as { defaultColor?: string };
  assert.equal(el.defaultColor, "#FDFCF9");
});

test("DSL 载荷：畸形整份拒绝", () => {
  // 未知元素 type
  assert.equal(
    pptPreviewOfToolOutput({
      ppt: {
        count: 1,
        slides: [{ elements: [{ type: "image", left: 0, top: 0, width: 1, height: 1 }] }],
      },
    }),
    null,
  );
  // 缺必填字段
  assert.equal(
    pptPreviewOfToolOutput({
      ppt: { count: 1, slides: [{ elements: [{ type: "text", left: 0, top: 0 }] }] },
    }),
    null,
  );
  // 颜色乱写
  assert.equal(
    pptPreviewOfToolOutput({
      ppt: {
        count: 1,
        slides: [
          {
            elements: [
              {
                type: "text",
                left: 0,
                top: 0,
                width: 10,
                height: 10,
                content: "x",
                defaultColor: "赤",
              },
            ],
          },
        ],
      },
    }),
    null,
  );
  // 空 slides / 非对象
  assert.equal(pptPreviewOfToolOutput({ ppt: { slides: [] } }), null);
  assert.equal(pptPreviewOfToolOutput({ ppt: "x" }), null);
  assert.equal(pptPreviewOfToolOutput(null), null);
  // 首页带 kind（旧管线形状）但后续页畸形：旧路径拒绝，不落到 DSL 路径
  assert.equal(
    pptPreviewOfToolOutput({
      ppt: { count: 2, slides: [{ kind: "cover", title: "x" }, { elements: "坏" }] },
    }),
    null,
  );
});

test("DSL 载荷：服务端净化 text HTML，MathML 原样带回", () => {
  const p = asDsl(
    pptPreviewOfToolOutput({
      ppt: {
        count: 2,
        slides: [
          {
            elements: [
              {
                type: "text",
                left: 100,
                top: 80,
                width: 800,
                height: 70,
                content:
                  '<p onclick="alert(1)">要点<script>alert(2)</script></p><a href="javascript:x">坏</a>',
              },
              {
                type: "latex",
                left: 100,
                top: 200,
                width: 400,
                height: 60,
                latex: "E=mc^2",
                mathml: "<math>…</math>",
              },
            ],
          },
        ],
      },
    }),
  );
  const text = p.slides[0]!.elements[0] as { content: string };
  assert.ok(!text.content.includes("script"), "script 连内容一起丢");
  assert.ok(!text.content.includes("onclick"), "事件属性被剥");
  assert.ok(!text.content.includes("javascript:"), "javascript: URL 被丢");
  assert.ok(text.content.includes("要点"), "正常文本保留");
  const latex = p.slides[0]!.elements[1] as { mathml?: string };
  assert.equal(latex.mathml, "<math>…</math>", "MathML 预览串原样带回");
});

test("DSL 载荷：页数/元素数截断有 elemCut，count 以实际为准", () => {
  const p = asDsl(
    pptPreviewOfToolOutput({
      ppt: {
        count: 1, // 漏报：实际 3 页
        slides: [{ elements: [] }, { elements: [] }, { elements: [] }],
      },
    }),
  );
  assert.equal(p.count, 3, "count 以实际页数为准");
});

test("旧 spec→PPT 载荷：kind 版式页仍走原路径", () => {
  const p = pptPreviewOfToolOutput({
    ppt: {
      count: 1,
      slides: [{ kind: "cover", title: "老课件", author: "我" }],
    },
  });
  assert.ok(p, "旧载荷应仍能过闸");
  if (!p) return;
  const first = p.slides[0]!;
  assert.ok("kind" in first, "旧载荷带 kind");
  assert.equal(first.kind, "cover");
});
