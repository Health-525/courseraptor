/**
 * 文档转换 / 改写：读入源（附件缓存或本机文件，只读）→ 统一内容 → 目标格式
 *
 * 复用已有的读取侧基础设施：
 * - 表格：spreadsheet.loadWorkbook（xlsx/xls/csv/tsv）
 * - 正文：docx 用 mammoth、pdf 用 pdf-parse、txt/md 直接解码
 * 读进来后先归一成「文本」或「若干张表」，再按目标格式重排成 DocumentSpec。
 * 转换后的成品写进 data/generated（见 save.ts），源文件只读不动。
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { getMeta, readStoredBuffer } from "../attachment-store";
import { loadWorkbook } from "../spreadsheet";
import { type GeneratedFile, generateAndSave } from "./save";
import type { DocFormat, DocumentSpec, SheetSpec, TableSpec } from "./types";

const require = createRequire(import.meta.url);
const requireAny = require as unknown as (id: string) => any;

export interface ConvertInput {
  /** 目标格式 */
  target: DocFormat;
  /** 三选一来源：附件缓存 id */
  sourceId?: string;
  /** 三选一来源：本机文件绝对路径（只读） */
  sourcePath?: string;
  /** 三选一来源：直接给一段文本 */
  text?: string;
  /** 成品标题（默认取文件名或源标题） */
  title?: string;
  /** 覆盖成品文件名 */
  filename?: string;
}

export interface ConvertError {
  ok: false;
  error: string;
}

type Loaded =
  | { kind: "text"; text: string; name: string }
  | { kind: "tables"; tables: { name: string; table: TableSpec }[]; name: string };

async function loadSource(input: ConvertInput): Promise<{ loaded?: Loaded; error?: string }> {
  let buf: Buffer | null = null;
  let filename = input.title ?? "converted";

  if (input.text?.trim()) {
    return { loaded: { kind: "text", text: input.text, name: input.title ?? "文本" } };
  }
  if (input.sourceId) {
    const meta = getMeta(input.sourceId);
    if (!meta) return { error: `找不到附件 id=${input.sourceId}（先用 fetch_attachment 读入）` };
    buf = readStoredBuffer(input.sourceId);
    filename = meta.filename;
    if (meta.kind === "table" || /\.(xlsx|xls|csv|tsv)$/i.test(meta.filename)) {
      const sheets = buf ? loadWorkbook(buf, meta.filename) : null;
      if (!sheets) return { error: "表格解析失败" };
      return {
        loaded: {
          kind: "tables",
          name: filename,
          tables: sheets.map((s) => ({
            name: s.name,
            table: { headers: s.headers, rows: s.rows },
          })),
        },
      };
    }
  } else if (input.sourcePath) {
    const abs = path.resolve(input.sourcePath);
    if (!fs.existsSync(abs)) return { error: `本机文件不存在: ${abs}` };
    buf = await fs.promises.readFile(abs); // 只读
    filename = path.basename(abs);
    if (/\.(xlsx|xls|csv|tsv)$/i.test(filename)) {
      const sheets = loadWorkbook(buf, filename);
      if (!sheets) return { error: "表格解析失败" };
      return {
        loaded: {
          kind: "tables",
          name: filename,
          tables: sheets.map((s) => ({
            name: s.name,
            table: { headers: s.headers, rows: s.rows },
          })),
        },
      };
    }
  } else {
    return { error: "需要 sourceId / sourcePath / text 三者之一作为来源" };
  }

  // 正文类（docx/pdf/txt/md…）
  if (!buf) return { error: "源内容为空" };
  const text = await extractText(buf, filename);
  if (text == null) return { error: `无法从 ${filename} 抽取文本（可能是扫描件或不支持的格式）` };
  return { loaded: { kind: "text", text, name: filename } };
}

async function extractText(buf: Buffer, filename: string): Promise<string | null> {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
  try {
    if (ext === "pdf") {
      const { PDFParse } = requireAny("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      const r = await parser.getText();
      await parser.destroy().catch(() => {});
      return typeof r === "string" ? r : ((r as any).text ?? null);
    }
    if (ext === "docx") {
      const mammoth = requireAny("mammoth");
      const r = await mammoth.extractRawText({ buffer: buf });
      return r.value;
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/** 粗粒度 Markdown/纯文本 → 结构化 blocks */
export function textToBlocks(text: string): NonNullable<DocumentSpec["blocks"]> {
  const blocks: NonNullable<DocumentSpec["blocks"]> = [];
  const paras = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const chunk of paras) {
    const lines = chunk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    const listItems = lines.filter((l) => /^([-*•]|\d+[.)、])\s+/.test(l));
    if (listItems.length === lines.length) {
      blocks.push({
        type: "list",
        items: lines.map((l) => l.replace(/^([-*•]|\d+[.)、])\s+/, "")),
      });
    } else if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0])) {
      const level = lines[0].match(/^#+/)![0].length as 1 | 2 | 3;
      blocks.push({ type: "heading", text: lines[0].replace(/^#+\s+/, ""), level });
    } else {
      blocks.push({ type: "paragraph", text: chunk.trim() });
    }
  }
  return blocks;
}

function specFromLoaded(loaded: Loaded, target: DocFormat, title?: string): DocumentSpec {
  if (loaded.kind === "tables") {
    const docTitle = title ?? loaded.name;
    if (target === "xlsx") {
      const sheets: SheetSpec[] = loaded.tables.map((t) => ({
        name: t.name,
        headers: t.table.headers,
        rows: t.table.rows,
      }));
      return { format: "xlsx", title: docTitle, sheets };
    }
    if (target === "pptx") {
      const slides = loaded.tables.map((t) => ({ title: t.name, table: t.table }));
      return { format: "pptx", title: docTitle, slides };
    }
    const blocks: NonNullable<DocumentSpec["blocks"]> = [];
    for (const t of loaded.tables) {
      blocks.push({ type: "heading", text: t.name, level: 2 });
      blocks.push({ type: "table", table: t.table });
    }
    return { format: target, title: docTitle, blocks };
  }
  // text
  const docTitle = title ?? "";
  const blocks = textToBlocks(loaded.text);
  if (target === "xlsx") {
    const rows = blocks.flatMap((b) =>
      b.type === "heading"
        ? [[`# ${b.text}`]]
        : b.type === "paragraph"
          ? [[b.text]]
          : b.type === "list"
            ? b.items.map((i) => [i])
            : [],
    );
    return {
      format: "xlsx",
      title: docTitle || loaded.name,
      sheets: [{ name: "内容", rows: rows.length ? rows : [[""]] }],
    };
  }
  if (target === "pptx") {
    return { format: "pptx", title: docTitle || loaded.name, blocks };
  }
  return { format: target, title: docTitle || loaded.name || undefined, blocks };
}

/** 执行一次转换，返回落盘后的文件信息 */
export async function convertDocument(
  input: ConvertInput,
): Promise<{ ok: true; file: GeneratedFile; from: string } | ConvertError> {
  const { loaded, error } = await loadSource(input);
  if (!loaded) return { ok: false, error: error ?? "来源读取失败" };
  const spec = specFromLoaded(loaded, input.target, input.title);
  const file = await generateAndSave(spec, { filename: input.filename });
  return { ok: true, file, from: loaded.name };
}
