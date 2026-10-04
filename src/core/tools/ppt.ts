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
    description: `干跑 PPT 构建代码（不落盘）：执行一遍并返回逐页摘要（类型/标题/体量）与警告（坐标越界、超上限、内容截断），供写完先自检；有 warnings 先改代码，确认后再用 ppt_save 落盘。${API_DOC}`,
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
    description: `用 JS 代码构建 PPT 课件并渲染成 .pptx，落盘本机 data/generated（同名自动加 (2)）并返回完整路径，网页端可翻页预览。自动套「纸墨朱砂」品牌课件模板。写完先用 ppt_preview 干跑自检、清掉 warnings 再落盘。${API_DOC}`,
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
