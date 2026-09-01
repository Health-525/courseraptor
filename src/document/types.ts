/**
 * 文档生成引擎 · 统一内容模型
 *
 * 动机：学生要「一句话/一份大纲 → 成品文件」。与其为每种格式各开一个工具，
 * 不如定义一套与格式无关的 DocumentSpec，由渲染层分别产出 docx / xlsx / pptx / pdf。
 * 这样 agent 只需按内容结构思考（标题、正文、列表、表格、幻灯片、工作表），
 * 格式与中文渲染细节都收敛在这里。
 */

export type DocFormat = "docx" | "xlsx" | "pptx" | "pdf";

/** 表格：表头 + 若干行（字符串即可，数字在写入表格类格式时按需转换） */
export interface TableSpec {
  headers?: string[];
  rows: (string | number)[][];
}

/** 正文块：用于 docx / pdf 这种线性文档 */
export type DocBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[]; ordered?: boolean }
  | { type: "table"; table: TableSpec; caption?: string }
  | { type: "pagebreak" };

/** 幻灯片：用于 pptx */
export interface SlideSpec {
  title: string;
  subtitle?: string;
  bullets?: string[];
  table?: TableSpec;
  notes?: string;
}

/** 工作表：用于 xlsx */
export interface SheetSpec {
  name: string;
  headers?: string[];
  rows: (string | number)[][];
}

export interface DocumentSpec {
  format: DocFormat;
  /** 文档主标题（docx/pdf 顶部大标题、pptx 封面页、xlsx 仅在无 sheet 名时兜底） */
  title?: string;
  author?: string;
  /** docx / pdf 用 */
  blocks?: DocBlock[];
  /** pptx 用 */
  slides?: SlideSpec[];
  /** xlsx 用 */
  sheets?: SheetSpec[];
}

export const DOC_FORMATS: DocFormat[] = ["docx", "xlsx", "pptx", "pdf"];

export function isDocFormat(x: string): x is DocFormat {
  return (DOC_FORMATS as string[]).includes(x);
}

export const FORMAT_EXT: Record<DocFormat, string> = {
  docx: ".docx",
  xlsx: ".xlsx",
  pptx: ".pptx",
  pdf: ".pdf",
};
