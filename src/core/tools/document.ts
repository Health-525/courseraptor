/**
 * 文档写作工具：generate_document / convert_document
 */

import { tool } from "ai";
import { z } from "zod";
import { convertDocument } from "../document/convert";
import { generateAndSave } from "../document/save";
import type { DocumentSpec } from "../document/types";

export const documentTools = {
  /** 生成文档（Word/Excel/PPT/PDF 成品文件） */
  generate_document: tool({
    description:
      "AI 辅助写作：按结构化内容直接产出成品文件，支持 Word(docx)/Excel(xlsx)/PPT(pptx)/PDF 四种格式，中文原生可写。学生要「一份报告 / 课件 / 表格 / 简历模板」等交付物时用。落盘到本机 data/generated 并返回完整路径。docx/pdf 用 blocks（标题/正文/列表/表格/分页），pptx 用 slides（或给 blocks 自动转分页），xlsx 用 sheets。内容要自己组织好（可先引用教务数据或改写润色后的文本再喂进来）。",
    inputSchema: z.object({
      format: z.enum(["docx", "xlsx", "pptx", "pdf"]).describe("目标文件格式"),
      title: z.string().optional().describe("文档主标题（Word/PDF 顶部、PPT 封面）"),
      author: z.string().optional().describe("作者/署名（PPT 封面、可选）"),
      filename: z.string().optional().describe("成品文件名，可不带扩展名，同名自动加(2)"),
      blocks: z
        .array(
          z.object({
            type: z.enum(["heading", "paragraph", "list", "table", "pagebreak"]),
            text: z.string().optional().describe("heading/paragraph 的文本"),
            level: z.number().int().min(1).max(3).optional().describe("标题级别 1-3"),
            items: z.array(z.string()).optional().describe("list 的条目"),
            ordered: z.boolean().optional().describe("list 是否有序（true 用 1.2.3 前缀）"),
            caption: z.string().optional().describe("表格标题（可选）"),
            table: z
              .object({
                headers: z.array(z.string()).optional(),
                rows: z.array(z.array(z.string())).describe("数据行，每行是单元格数组"),
              })
              .optional(),
          }),
        )
        .optional()
        .describe("Word/PDF 的正文块序列（按顺序排版）"),
      slides: z
        .array(
          z.object({
            title: z.string(),
            subtitle: z.string().optional(),
            bullets: z.array(z.string()).optional(),
            notes: z.string().optional().describe("演讲者备注"),
            table: z
              .object({
                headers: z.array(z.string()).optional(),
                rows: z.array(z.array(z.string())),
              })
              .optional(),
          }),
        )
        .optional()
        .describe("PPT 幻灯片（不给则由 blocks 自动按标题分页）"),
      sheets: z
        .array(
          z.object({
            name: z.string().describe("工作表名（≤31 字）"),
            headers: z.array(z.string()).optional(),
            rows: z.array(z.array(z.string())).describe("数据行"),
          }),
        )
        .optional()
        .describe("Excel 工作表"),
    }),
    execute: async (input) => {
      const spec: DocumentSpec = {
        format: input.format,
        ...(input.title ? { title: input.title } : {}),
        ...(input.author ? { author: input.author } : {}),
        ...(input.blocks ? { blocks: input.blocks as DocumentSpec["blocks"] } : {}),
        ...(input.slides ? { slides: input.slides as DocumentSpec["slides"] } : {}),
        ...(input.sheets ? { sheets: input.sheets as DocumentSpec["sheets"] } : {}),
      };
      const hasContent =
        spec.blocks?.length || spec.slides?.length || spec.sheets?.length || spec.title;
      if (!hasContent) return { error: "内容为空：至少提供 title + blocks / slides / sheets 之一" };
      try {
        const file = await generateAndSave(spec, { filename: input.filename });
        return {
          ok: true,
          format: file.format,
          filename: file.filename,
          path: file.filePath,
          bytes: file.bytes,
          note: `已生成 ${file.format.toUpperCase()}，保存于本机 ${file.filePath}`,
        };
      } catch (e) {
        return { error: `生成失败：${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }),

  /** 转换/改写文档（读入源文件→重排为另一种格式） */
  convert_document: tool({
    description:
      "文件格式转换与重排：把已有内容（fetch_attachment 读入的附件 id、或本机文件路径、或直接一段文本）转换/重排成 Word/Excel/PPT/PDF 目标格式。用于「把这份 PDF/Word 转成 PPT」「把表格转成 Word」「把这段文字整理成一份排版好的文档」。源文件只读，成品写 data/generated 并返回路径。改写润色本身（换词、调结构）你直接改好文本再用 generate_document 即可，本工具擅长跨格式搬运与排版。",
    inputSchema: z.object({
      target: z.enum(["docx", "xlsx", "pptx", "pdf"]).describe("目标格式"),
      sourceId: z.string().optional().describe("附件缓存 id（fetch_attachment 返回的 id）"),
      sourcePath: z.string().optional().describe("本机文件绝对路径（只读，不落库原件）"),
      text: z.string().optional().describe("直接提供一段文本作为来源"),
      title: z.string().optional().describe("成品标题（默认取源文件名）"),
      filename: z.string().optional().describe("成品文件名，可不带扩展名"),
    }),
    execute: async (input) => {
      const r = await convertDocument(input);
      if (!r.ok) return { error: r.error };
      return {
        ok: true,
        convertedFrom: r.from,
        format: r.file.format,
        filename: r.file.filename,
        path: r.file.filePath,
        bytes: r.file.bytes,
        note: `已从「${r.from}」转换为 ${r.file.format.toUpperCase()}：${r.file.filePath}`,
      };
    },
  }),
};
