/**
 * PPT 课件工具：ppt_preview / ppt_save
 *
 * 设计取向：模型「写代码排版」而非填 slides 大 JSON——代码在录音式沙箱
 * （ppt-program.ts）里执行，产出 op 程序后由 pptx-theme 渲染成品牌课件。
 * 拆成两个小工具各司其职：preview 干跑自检（不落盘不出预览卡），save 落盘
 * 并带网页翻页预览载荷（与 generate_document 的 ppt 字段同一条 SSE 链路）。
 */

import { tool } from "ai";
import { z } from "zod";

import { type PptOp, type PptProgram, runPptCode } from "../document/ppt-program";
import { buildProgramPreview, renderPptxProgram } from "../document/pptx-theme";
import { saveGenerated } from "../document/save";

/** 沙箱 API 速查（两个工具共用一份，避免漂移；description 里是模型唯一教程面） */
const API_DOC = `沙箱里有全局 pptx 对象（可写变量/循环/条件/函数，console.log 可调试）：
- pptx.cover({ title, author?, notes? }) 朱砂品牌封面（自动印章+日期）
- pptx.section("章节标题") 朱砂整版章节页
- pptx.bullets({ title, subtitle?, points: ["…"], notes? }) 要点页（≤6 条自动数字圆圈行，>6 条紧凑列表，字号自适应）
- pptx.table({ title, subtitle?, headers?: ["…"], rows: [["…"]], notes? }) 表格页（朱砂表头+斑马纹）
- s = pptx.blank(title?) 自由版式页（拿内容页母版打底，页脚页码不断档），句柄：
  s.text("文字", { x, y, w, h, size?, color?, bold?, align?: "left"|"center"|"right", valign?: "top"|"middle"|"bottom", font?: "kai", wrap?: false })
  s.shape("rect"|"ellipse"|"line", { x, y, w, h, fill?, line?, lineW?, rotate? })
  s.logo({ x, y, w, h }) 品牌印章 logo；s.notes("演讲者备注")
- 常量：pptx.W=10、pptx.H=5.625（画布英寸，原点左上）；pptx.theme 品牌色板（paper/paperDeep/ink/ink2/ink3/accent/accentDeep/rule/onAccent/onAccentDim）
坐标/宽高单位英寸；颜色用 6 位十六进制（如 "AD392C"）或主题色名。常规课件 cover + bullets/table 一把梭；时间线、对比栏、图文混排等特殊版式用 blank 自由排。示例：
pptx.cover({ title: "期末复习" });
pptx.bullets({ title: "重点", points: ["极限", "微分"] });`;

/**
 * 排版法则（改编自 OpenMAIC slide-craft skill，MIT / THU-MAIC）：法则照搬，
 * 数字全部换成本项目的体系——那边是 1000×562.5 px 的自有渲染器加一张高度
 * 查表，本项目是 10×5.625 英寸 + 品牌色板 + pptxgenjs，那套像素数字一条
 * 都不成立，能留下的只有「法则」本身。
 */
const LAYOUT_RULES = `

## 排版法则（照着排，别自创一套）

- **画布与留白**：10 × 5.625 英寸，原点左上。四周留 ≥0.4 英寸边距，越界/贴边 ppt_preview 会警告。居中内容的 left 要按 (10 - w) / 2 重算——改 width 就得同步改 left，这是两次独立写入。**没有对齐操作**，每个位置都是你自己算出来写进去的数字：让一排元素对齐，就是把这一排已经在用的那个数字原样给它们。
- **字号用阶梯，不靠目测**：页标题 28-32、小标题/要点 18-22、正文 14-16、注释 11-12。同一层级用同一字号，层级之间差 2-4pt。正文掉到 10pt 以下说明这页字太多——**删词，不要继续缩字号**；一页只有 10pt 才装得下，是内容放多了。
- **对比度是一对，不是一个颜色**：文字只对着它正下方的底色读。ink / ink2 / ink3 配 paper / paperDeep 都安全；accent（朱砂）适合标题和强调块，**不适合当小字正文色**；accentDeep 才配浅底反白字。改颜色时前景后景一起改，只改一半就毁了。
- **间距用完全相同的数值**：并排的卡片或列共享同一个 w、同一个 h、同一个 y、同一个间距（0.15-0.25 英寸）。人眼分辨得出 0.05 英寸的差别，"差不多"会被看出来。删掉一张卡或加一张，整行按行内的算式重排，别把新来的塞在邻居旁边。
- **文字写在形状里是同一个对象**：text.w = shape.w - 左右内边距、text.h ≤ shape.h - 上下内边距，left / top 由 shape 与 text 的尺寸算出居中，中心点偏差 ≤0.02 英寸。经典错法是把 text 的 left/top 直接写成 shape 的——那会把它钉死在左上角。移动形状永远是两次编辑：先移形状，再重算文字。
- **一种内容一种元素**：要点走 pptx.bullets，结构化对比走 pptx.table，时间线 / 流程 / 图文混排才用 blank 自由排。别把三行长文塞进一个 s.text 假装是列表。
- **口播台词不上页面**：讲课的话进 notes（cover/bullets/table 的 notes 参数或 s.notes），页面只留关键词和短句（每行 ≤20 字或 ≤30 汉字）。不要出现"老师""同学说"这类角色台词，也不要把要讲的口语化成满页句子。
- **公式与代码用能直接读的写法**：a/b、x^2、∂f/∂x、O(n log n)、f(x)=∑…——不要贴 LaTeX 源码或 Markdown 星号，页面上没人渲染它们。表格单元格只放纯文本，不放公式和标记。
- **密度自检不用渲染**：把元素按 y 排序读间距。间距普遍 <0.15 英寸 = 挤，删词、合并元素，别缩字号；元素全挤在上半页、下面空 1.5 英寸以上 = 空，把字号升一级并整体下移居中，别加废话填充。
- **层叠顺序就是代码顺序**：元素按数组顺序绘制，后写的盖在先写的上面。背景色块写在它要承载的文字之前；被挡住时改顺序，不要靠挪位置或删背景绕过去。`;

/** 两个工具共用的「教程面」：API 速查 + 排版法则 */
const GUIDE = API_DOC + LAYOUT_RULES;

function summarizeProgram(program: PptProgram): { count: number; pages: string[] } {
  const label: Record<PptOp["op"], string> = {
    cover: "封面",
    section: "章节",
    bullets: "要点",
    table: "表格",
    blank: "自由",
  };
  const CAP = 30;
  const all = program.ops.map((op, i) => {
    const extra =
      op.op === "bullets"
        ? `（${op.points.length} 要点）`
        : op.op === "table"
          ? `（${op.rows.length} 行）`
          : op.op === "blank"
            ? `（${op.elements.length} 元素）`
            : "";
    return `${i + 1}. [${label[op.op]}] ${op.op === "blank" ? (op.title ?? "") : op.title}${extra}`;
  });
  const cut = all.length - CAP;
  return { count: all.length, pages: cut > 0 ? [...all.slice(0, CAP), `…还有 ${cut} 页`] : all };
}

export const pptTools = {
  /** 干跑 PPT 构建代码（不落盘）：返回逐页摘要与越界/超限警告 */
  ppt_preview: tool({
    description: `干跑 PPT 构建代码（不落盘）：执行一遍并返回逐页摘要（类型/标题/体量）与警告（坐标越界、超上限、内容截断），供写完先自检；有 warnings 先改代码，确认后再用 ppt_save 落盘。${GUIDE}`,
    inputSchema: z.object({
      code: z.string().describe("PPT 构建代码（JS）"),
    }),
    execute: async ({ code }) => {
      const r = runPptCode(code);
      if (!r.program) {
        return {
          error: r.error ?? "没有构建出任何一页",
          warnings: r.warnings?.length ? r.warnings : undefined,
          ...(r.logs?.length ? { logs: r.logs } : {}),
        };
      }
      const sum = summarizeProgram(r.program);
      return {
        ok: r.ok,
        ...(r.ok ? {} : { error: r.error }),
        slides: sum.count,
        pages: sum.pages,
        warnings: r.warnings?.length ? r.warnings : undefined,
        ...(r.logs?.length ? { logs: r.logs } : {}),
        note: r.ok
          ? "干跑通过。确认版式无误后用 ppt_save 落盘。"
          : `报错前已构建 ${sum.count} 页，定位报错修正后重试。`,
      };
    },
  }),

  /** 用代码构建 PPT 并渲染落盘（.pptx 成品 + 网页翻页预览） */
  ppt_save: tool({
    description: `用 JS 代码构建 PPT 课件并渲染成 .pptx，落盘本机 data/generated（同名自动加 (2)）并返回完整路径，网页端可翻页预览。自动套「纸墨朱砂」品牌课件模板。写完先用 ppt_preview 干跑自检、清掉 warnings 再落盘。${GUIDE}`,
    inputSchema: z.object({
      code: z.string().describe("PPT 构建代码（JS）"),
      filename: z.string().optional().describe("成品文件名，可不带扩展名；默认取封面/首页标题"),
    }),
    execute: async ({ code, filename }) => {
      const r = runPptCode(code);
      if (!r.ok || !r.program) {
        return {
          error: r.error ?? "没有构建出任何一页",
          ...(r.program
            ? {
                slides: r.program.ops.length,
                note: "存在报错前的半成品页，已拒绝落盘——修正代码后重试",
              }
            : {}),
          warnings: r.warnings?.length ? r.warnings : undefined,
        };
      }
      try {
        const base = r.program.ops[0]?.title || "课件";
        const file = await saveGenerated(await renderPptxProgram(r.program), "pptx", {
          filename,
          baseName: base,
        });
        return {
          ok: true,
          filename: file.filename,
          path: file.filePath,
          bytes: file.bytes,
          slides: r.program.ops.length,
          // 网页端翻页预览载荷（与 generate_document/convert_document 的 ppt 字段同一条 SSE 链路）
          ppt: buildProgramPreview(r.program),
          warnings: r.warnings?.length ? r.warnings : undefined,
          note: `已生成 PPT（${r.program.ops.length} 页），保存于本机 ${file.filePath}`,
        };
      } catch (e) {
        return { error: `渲染失败：${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }),
};
