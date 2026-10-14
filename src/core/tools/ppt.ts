/**
 * PPT 课件工具：ppt_preview / ppt_save
 *
 * 管线（照抄 OpenMAIC 的页面对象模型与导出映射，MIT / THU-MAIC）：
 * 模型直接输出 slide JSON（DSL）→ pptx-slides 渲染器映射为 pptxgenjs 页面，
 * 取代旧的「写代码 + node:vm 沙箱录音」管线（ppt-program.ts 已随之删除）。
 * 「纸墨朱砂」品牌（印章/页脚/页码）不靠母版继承，而是每页可选 motif 字段：
 * cover = 朱砂大印章封面 / section = 朱砂章节页 / plain = 内容页页脚。
 *
 * 两个小工具各司其职：preview 干跑自检（软警告，不落盘不出预览卡），
 * save 硬校验（结构不合法拒绝落盘）后渲染落盘，并带网页翻页预览载荷
 * （与 generate_document 的 ppt 字段同一条 SSE 链路）。
 */

import { tool } from "ai";
import { z } from "zod";
import {
  checkSlideDeck,
  type DeckSlide,
  parseSlideDeck,
  type SlideDeck,
  slideDeckSchema,
} from "../document/ppt-dsl";
import { htmlToPlainText } from "../document/ppt-html";
import { renderSlidesDeck } from "../document/pptx-slides";
import { buildSlidesPreview } from "../document/pptx-theme";
import { saveGenerated } from "../document/save";

/**
 * 模型唯一教程面（两个工具共用一份，避免漂移）：输出结构 + 画布 + 色板 +
 * 七种元素字段 + 高度查表 + 排版法则（改编自 OpenMAIC slide-craft 与
 * system.md 的 Pre-Output Checklist，MIT / THU-MAIC：法则与查表照搬，
 * 色板/单位全部换成本项目的「纸墨朱砂」与 px 体系）。
 */
const GUIDE = `
## 输出格式（只输出 JSON）

- 全部内容组织成一个 JSON：{ "slides": [ {slide}, … ] }，作为工具的 deck 参数传入。不要输出解释文字，不要包 Markdown 代码围栏。
- 每页 slide：{ background?, motif?, notes?, elements: [...] }。notes 是演讲者备注——讲课的口播台词放这里，页面只留关键词和短句。
- 上限：全片 ≤60 页，每页 ≤60 个元素；超出会被拒绝。

## 画布与坐标

- 画布 1000 × 562.5 px，原点左上。所有 left/top/width/height 单位都是 px。
- 四边安全边距 50px：内容放在 left∈[50,950]、top∈[50,512.5]。越界/贴边 ppt_preview 会警告。
- 一页一个观点；页标题 ≤20 字；每行 ≤30 汉字。居中排布时 left = (1000 - width) / 2 自己算。

## motif（品牌母版，每页可选，缺省 plain）

- cover：朱砂整版封面（大印章 + 浅色标题位）——只用于第 1 页，把主标题/副标题/署名做成 text 元素放上去，文字用 onAccent / onAccentDim。
- section：朱砂章节页——只放一个章节标题（同样浅色字）。
- plain：内容页（页脚细线 + COURSERAPTOR + 页码），配纸底墨字。
- 深色底（朱砂/墨色）文字必须用 onAccent/onAccentDim 浅色，浅色底用 ink 系；背景与文字颜色永远成对改。

## 七种元素（通用字段：left/top/width/height 必填，rotate/id 可选）

1. text 文本：{ "type":"text", "content":"HTML 片段", defaultFontName?, defaultColor?, fill?, lineHeight?, vAlign?, paragraphSpace?, wordSpace?, opacity?, shadow?, outline? }
   content 支持内联 HTML：<p>/<strong>/<b>/<em>/<i>/<u>/<br>/<sup>/<sub>/<span style="…">/<ul><li>；span 的行内样式可写 color / font-size / font-weight / font-family / text-align / background-color。
   文本框高度必须按下面的高度查表预留，装不下会溢出。
2. shape 形状：{ "type":"shape", "viewBox":[W,H], "path":"SVG path d", fill?, gradient?, outline?, opacity?, flipH?, flipV?, shadow?, text? }
   path 用 SVG 路径命令（M/L/C/A/Q/Z），坐标在 viewBox 内。矩形 "M 0 0 L 100 0 L 100 100 L 0 100 Z"；圆 "M 50 0 A 50 50 0 1 1 49.9 0 Z"。fill 为 "" 表示无填充。text 是形状内文本：{ content, defaultColor?, align? }。
3. line 线条：{ "type":"line", left, top, width, start:[x,y], end:[x,y], style?, color?, points?:["","arrow"|"dot"], broken?/broken2?/curve?/cubic?, shadow? }
   width 是描边粗细（2-6），不是长度；长度由 start/end 决定，它们是相对 left/top 的局部坐标。points 是 [起点样式, 终点样式]。折线用 broken（两段直角）或 broken2（阶梯三段）；曲线用 curve（二次）或 cubic（三次，两个控制点）。
4. chart 图表：{ "type":"chart", chartType:"bar|column|line|pie|ring|area|radar|scatter", data:{ labels:[…], legends:[…], series:[[…]] }, themeColors?, textColor?, fill?, outline?, options? }
   series 的每一组长度必须等于 labels 数；legends 与 series 一一对应。饼/环图只有一个 series。themeColors 不足时按类似色自动补。
5. table 表格：{ "type":"table", colWidths:[0.3,0.5,0.2], data:[[{text,colspan?,rowspan?,style?}]], theme?, outline?, cellMinHeight? }
   colWidths 是列宽占比，总和应为 1。单元格只放纯文本，不放公式和标记。style 可设 bold/em/underline/strikethrough/color/backcolor/fontsize(px 数字字符串)/fontname/align。theme 设高亮：{ color, rowHeader?, colHeader?, rowFooter?, colFooter? }。
6. latex 公式：{ "type":"latex", latex:"E=mc^2", align? }
   latex 是 LaTeX 源码（不带 $ 定界符），渲染成可编辑公式对象。页内所有数学公式必须走这个元素，不要在 text 里贴 LaTeX 源码。
7. code 代码：{ "type":"code", language?, lines:[{content:"…"}], fileName?, showLineNumbers?, fontSize? }
   纸底代码卡片 + 文件名标题栏 + 行号；≤40 行、每行 ≤200 字。

## 文本高度查表（px；行高 1.5 + 四周 10px 内边距。写 height 前先查表）

字号 14 → 1-5 行：43 / 64 / 85 / 106 / 127
字号 16 → 46 / 70 / 94 / 118 / 142
字号 18 → 49 / 76 / 103 / 130 / 157
字号 20 → 52 / 82 / 112 / 142 / 172
字号 24 → 58 / 94 / 130 / 166 / 202
字号 28 → 64 / 106 / 148 / 190 / 232
字号 32 → 70 / 118 / 166 / 214 / 262
字号 36 → 76 / 130 / 184 / 238 / 292

行数估算：中文每行约 width / fontSize 个汉字，英文数字更宽；拿不准按多一行给高度。

## 字号阶梯（px）

页标题 32-36 / 小标题 24-28 / 要点 18-20 / 正文 16-18 / 注释 14-16。同一层级用同一字号，层级之间差 2-4px。正文掉到 14 以下说明这页字太多——删词，不要继续缩字号。

## 色板（纸墨朱砂；可直接写色板名或 #RRGGBB）

paper 纸底 FDFCF9 · paperDeep 压深纸 F0EDE4 · ink 墨 25221C · ink2 次级 5A554A · ink3 弱 6E6656 · accent 朱砂 AD392C · accentDeep 深朱砂 852B22 · rule 细线 E1DCCF · onAccent 朱砂上浅字 FDFCF9 · onAccentDim 朱砂上次级浅字 E9C8C2

- 对比度是一对，不是一个颜色：文字只对着它正下方的底色读。浅底用 ink/ink2/ink3；朱砂底用 onAccent/onAccentDim。accent 只做标题和强调块，不做小字正文色；反白字用 accentDeep 打底。

## 排版法则（照着排，别自创一套）

- **一页一观点**：每页只讲一件事；讲不完就拆页，不要塞。
- **间距用完全相同的数值**：并排的卡片/列共享同一个 width、height、top 和间距（15-25px）。人眼分辨得出 5px 的差别。加一张卡删一张卡，整行按行内的算式重排。
- **文字写在形状里是同一个对象**：形状内文本由 text 字段垂直居中，宽度自动收窄；不要在形状上再叠一个 left/top 手算的 text 元素冒充。
- **一种内容一种元素**：要点列表用 text + 列表 HTML；结构化对比用 table；时间线/流程/关系图用 shape + line 组合；数据用 chart；公式用 latex；代码用 code。别把三行长文塞进一个元素假装是列表。
- **口播台词不上页面**：要讲的话进 notes，页面只留关键词和短句。不出现"老师""同学说"这类角色台词。
- **层叠顺序就是数组顺序**：后写的盖在先写的上面。背景色块写在它要承载的文字之前；被挡住时改顺序，不要靠挪位置绕过去。
- **密度自检不用渲染**：把元素按 top 排序读间距。间距普遍 <15px = 挤，删词、合并元素，别缩字号；元素全挤在上半页、下面空 150px 以上 = 空，把字号升一级并整体下移居中，别加废话填充。
- **图表数据量克制**：柱/条形 ≤8 组，折线 ≤6 条 series，饼/环 ≤8 块；表格 ≤6 列 × 8 行，超出就拆页或汇总。

## 落盘前检查单（P0 必须为零，P1 尽量清零）

P0（结构错误，ppt_save 会直接拒绝）：元素越出安全区、text 高度低于查表下限、line 的 width 当成长度用、text 里贴 LaTeX 源码、chart 的 series 与 labels 长度不一致、colWidths 总和明显不为 1。
P1（设计问题，ppt_preview 给警告）：字号不在阶梯上、同页字号层级过多、表格超 6 列、代码超 30 行、形状无填充又无描边、深色底配深色字。
`;

const deckInput = z.object({
  deck: slideDeckSchema.describe(
    "slide deck JSON：{ slides: [{ background?, motif?, notes?, elements: [...] }] }，字段见工具说明",
  ),
});

const saveInput = deckInput.extend({
  filename: z.string().optional().describe("成品文件名，可不带扩展名；默认取首页第一个文本"),
});

/** 首页第一个文本元素的纯文字（页摘要标题与默认文件名共用） */
function firstTextOf(slide: DeckSlide): string {
  for (const el of slide.elements) {
    if (el.type === "text") return htmlToPlainText(el.content).trim();
    if (el.type === "shape" && el.text) return htmlToPlainText(el.text.content).trim();
  }
  return "";
}

function summarizeDeck(deck: SlideDeck): { count: number; pages: string[] } {
  const CAP = 30;
  const all = deck.slides.map((s, i) => {
    const counts = new Map<string, number>();
    for (const el of s.elements) counts.set(el.type, (counts.get(el.type) ?? 0) + 1);
    const parts = [...counts].map(([t, n]) => `${t}×${n}`).join(" ");
    const title = firstTextOf(s).slice(0, 24);
    return `${i + 1}. [${s.motif ?? "plain"}] ${title || "（无标题）"}${parts ? ` — ${parts}` : ""}`;
  });
  const cut = all.length - CAP;
  return { count: all.length, pages: cut > 0 ? [...all.slice(0, CAP), `…还有 ${cut} 页`] : all };
}

export const pptTools = {
  /** 干跑 slide deck（不落盘）：返回逐页摘要与设计警告 */
  ppt_preview: tool({
    description: `生成或修改 PPT 时**必须先调本工具干跑**：传入完整 slide deck JSON，返回逐页摘要与软警告（越界/文本高度不足/图表数据不一致等）。有警告先改 deck，清零后再用 ppt_save 落盘。不写盘、不出预览卡。${GUIDE}`,
    inputSchema: deckInput,
    execute: async ({ deck }) => {
      const parsed = parseSlideDeck(deck);
      if (!parsed.ok) return { error: parsed.error };
      const sum = summarizeDeck(parsed.deck);
      const warnings = checkSlideDeck(parsed.deck);
      return {
        ok: warnings.length === 0,
        slides: sum.count,
        pages: sum.pages,
        warnings: warnings.length ? warnings : undefined,
        note: warnings.length
          ? "存在警告：逐条修正后重新干跑，清零再落盘。"
          : "干跑通过。确认版式无误后用 ppt_save 落盘。",
      };
    },
  }),

  /** slide deck JSON → .pptx 落盘（品牌模板 + 网页翻页预览） */
  ppt_save: tool({
    description: `把 slide deck JSON 渲染成 .pptx 并落盘本机 data/generated（同名自动加 (2)），返回完整路径与网页翻页预览载荷。结构不合法会直接拒绝并返回中文错误、不写盘。修改已有 PPT 时重新生成完整 deck，不要增量补丁。${GUIDE}`,
    inputSchema: saveInput,
    execute: async ({ deck, filename }) => {
      const parsed = parseSlideDeck(deck);
      if (!parsed.ok) {
        return { error: parsed.error, note: "结构不合法，已拒绝落盘——按错误修正 deck 后重试" };
      }
      const warnings = checkSlideDeck(parsed.deck);
      try {
        const base =
          firstTextOf(parsed.deck.slides[0] ?? { elements: [] }).slice(0, 30) || "演示文稿";
        const file = await saveGenerated(await renderSlidesDeck(parsed.deck), "pptx", {
          filename,
          baseName: base,
        });
        return {
          ok: true,
          filename: file.filename,
          path: file.filePath,
          bytes: file.bytes,
          slides: parsed.deck.slides.length,
          // 网页端翻页预览载荷（与 generate_document/convert_document 的 ppt 字段同一条 SSE 链路）
          ppt: buildSlidesPreview(parsed.deck),
          warnings: warnings.length ? warnings : undefined,
          note: `已生成 PPT（${parsed.deck.slides.length} 页），保存于本机 ${file.filePath}`,
        };
      } catch (e) {
        return { error: `渲染失败：${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }),
};
