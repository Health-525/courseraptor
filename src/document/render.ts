/**
 * 文档渲染层：DocumentSpec → 各格式字节
 *
 * 四种格式对中文的处理路径不同，这里统一收口：
 * - docx / pptx：Office 只是「引用」字体名，字符以 UTF-8 存进 XML，阅读器用本机
 *   字体渲染，无需嵌字体，天生不怕中文。显式指定中文字体名以保观感一致。
 * - xlsx：SheetJS 写 UTF-8 字符串，同样安全。
 * - pdf：pdfkit 内建字体无中文字形，必须注册一份系统 TTF（见 font.ts）并子集化嵌入。
 *
 * 依赖一律用 createRequire 载入并转 any：pdfkit 无官方 @types，避免 tsc 缺声明。
 */

import { createRequire } from "node:module";
import { resolveCjkFont } from "./font";
import type { DocBlock, DocumentSpec, SheetSpec, SlideSpec, TableSpec } from "./types";

const require = createRequire(import.meta.url);
const requireAny = require as unknown as (id: string) => any;

/** 统一中文字体名（docx/pptx 里作为引用写入，阅读器回退到本机同名字体） */
const CJK_FONT = "Microsoft YaHei";

function firstNonEmpty(...xs: (string | undefined | null)[]): string {
  for (const x of xs) if (x?.trim()) return x.trim();
  return "";
}

/** 从 spec 推导一个建议文件名（不含扩展名） */
export function suggestBaseName(spec: DocumentSpec): string {
  const t = firstNonEmpty(
    spec.title,
    spec.blocks?.[0]?.type === "heading" ? (spec.blocks[0] as any).text : "",
    spec.slides?.[0]?.title,
    spec.sheets?.[0]?.name,
  );
  const cleaned = (t || "文档")
    .replace(/[\\/:*?"<>|\r\n]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "文档").slice(0, 60);
}

// ── docx ──────────────────────────────────────────────────────
export async function renderDocx(spec: DocumentSpec): Promise<Buffer> {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
    PageBreak,
  } = requireAny("docx");

  const children: any[] = [];
  if (spec.title) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [new TextRun({ text: spec.title, bold: true, size: 40, font: CJK_FONT })],
      }),
    );
  }
  for (const b of spec.blocks ?? [])
    pushDocxBlock(children, b, {
      Paragraph,
      TextRun,
      Table,
      TableRow,
      TableCell,
      WidthType,
      PageBreak,
    });
  if (children.length === 0)
    children.push(new Paragraph({ children: [new TextRun({ text: "", font: CJK_FONT })] }));

  const doc = new Document({
    styles: { default: { document: { run: { font: CJK_FONT, size: 22 } } } },
    sections: [{ properties: {}, children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

function pushDocxBlock(children: any[], b: DocBlock, lib: any): void {
  const { Paragraph, TextRun, Table, TableRow, TableCell, WidthType, PageBreak } = lib;
  switch (b.type) {
    case "heading": {
      const size = b.level === 1 ? 32 : b.level === 3 ? 24 : 28;
      children.push(
        new Paragraph({
          spacing: { before: 160, after: 100 },
          children: [new TextRun({ text: b.text, bold: true, size, font: CJK_FONT })],
        }),
      );
      break;
    }
    case "paragraph":
      children.push(
        new Paragraph({
          spacing: { after: 120 },
          children: [new TextRun({ text: b.text, size: 22, font: CJK_FONT })],
        }),
      );
      break;
    case "list":
      for (const it of b.items) {
        children.push(
          new Paragraph({
            ...(b.ordered ? {} : { bullet: { level: 0 } }),
            spacing: { after: 60 },
            children: [
              new TextRun({ text: (b.ordered ? "• " : "") + it, size: 22, font: CJK_FONT }),
            ],
          }),
        );
      }
      break;
    case "table":
      children.push(
        docxTable({ Paragraph, TextRun, Table, TableRow, TableCell, WidthType }, b.table),
      );
      children.push(new Paragraph({ children: [new TextRun({ text: "", size: 12 })] }));
      break;
    case "pagebreak":
      children.push(new Paragraph({ children: [new PageBreak()] }));
      break;
  }
}

function docxTable(lib: any, table: TableSpec): any {
  const { Paragraph, TextRun, Table, TableRow, TableCell, WidthType } = lib;
  const allRows: (string | number)[][] = table.headers
    ? [table.headers, ...table.rows]
    : table.rows;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: allRows.map(
      (cells, ri) =>
        new TableRow({
          tableHeader: ri === 0 && !!table.headers,
          children: cells.map(
            (c) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: String(c ?? ""),
                        bold: ri === 0 && !!table.headers,
                        size: 20,
                        font: CJK_FONT,
                      }),
                    ],
                  }),
                ],
              }),
          ),
        }),
    ),
  });
}

// ── xlsx ──────────────────────────────────────────────────────
export function renderXlsx(spec: DocumentSpec): Buffer {
  const XLSX = requireAny("xlsx");
  const wb = XLSX.utils.book_new();
  const sheets: SheetSpec[] = spec.sheets?.length
    ? spec.sheets
    : [{ name: firstNonEmpty(spec.title, "Sheet1"), rows: tableFromBlocks(spec)?.rows ?? [] }];
  const used = new Set<string>();
  for (const s of sheets) {
    const aoa: (string | number)[][] = s.headers ? [s.headers, ...s.rows] : s.rows;
    const ws = XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [[""]]);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(s.name, used));
  }
  return Buffer.from(XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
}

function tableFromBlocks(spec: DocumentSpec): TableSpec | null {
  for (const b of spec.blocks ?? []) if (b.type === "table") return b.table;
  return null;
}

function safeSheetName(name: string, used: Set<string>): string {
  const n = (name || "Sheet").replace(/[[\]:*?/\\]/g, "").slice(0, 31) || "Sheet";
  let out = n;
  let i = 1;
  while (used.has(out)) out = `${n.slice(0, 28)}_${i++}`;
  used.add(out);
  return out;
}

// ── pptx ──────────────────────────────────────────────────────
export async function renderPptx(spec: DocumentSpec): Promise<Buffer> {
  const PptxGenJS = requireAny("pptxgenjs");
  const Ctor = PptxGenJS.default ?? PptxGenJS;
  const pptx = new Ctor();
  pptx.layout = "LAYOUT_16x9";

  if (spec.title) {
    const cover = pptx.addSlide();
    cover.addText(spec.title, {
      x: 0.8,
      y: 3.0,
      w: 8.4,
      h: 1.5,
      fontSize: 40,
      bold: true,
      align: "center",
      fontFace: CJK_FONT,
      color: "222222",
    });
    if (spec.author)
      cover.addText(spec.author, {
        x: 0.8,
        y: 4.6,
        w: 8.4,
        h: 0.6,
        fontSize: 18,
        align: "center",
        fontFace: CJK_FONT,
        color: "888888",
      });
  }

  const slides: SlideSpec[] = spec.slides ?? slidesFromBlocks(spec);
  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.addText(s.title, {
      x: 0.5,
      y: 0.4,
      w: 9,
      h: 0.9,
      fontSize: 28,
      bold: true,
      fontFace: CJK_FONT,
      color: "1a1a1a",
    });
    let y = 1.6;
    if (s.subtitle) {
      slide.addText(s.subtitle, {
        x: 0.6,
        y,
        w: 8.8,
        h: 0.5,
        fontSize: 16,
        italic: true,
        fontFace: CJK_FONT,
        color: "666666",
      });
      y += 0.6;
    }
    if (s.bullets?.length) {
      slide.addText(
        s.bullets.map((t) => ({ text: t, options: { bullet: { code: "2022" }, color: "333333" } })),
        {
          x: 0.7,
          y,
          w: 8.6,
          h: 5.0 - (y - 1.6),
          fontSize: 18,
          valign: "top",
          fontFace: CJK_FONT,
          lineSpacingMultiple: 1.4,
        },
      );
    }
    if (s.table) {
      const rows = (s.table.headers ? [s.table.headers, ...s.table.rows] : s.table.rows).map((r) =>
        r.map((c) => ({ text: String(c ?? ""), options: { fontFace: CJK_FONT, fontSize: 14 } })),
      );
      slide.addTable(rows, {
        x: 0.6,
        y: 1.8,
        w: 8.8,
        border: { pt: 0.5, color: "bbbbbb" },
        fontFace: CJK_FONT,
      });
    }
    if (s.notes) slide.addNotes(s.notes);
  }

  if (!spec.title && slides.length === 0) {
    pptx.addSlide().addText("(空)", { x: 1, y: 3, w: 8, h: 1, fontFace: CJK_FONT });
  }
  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as any);
}

function slidesFromBlocks(spec: DocumentSpec): SlideSpec[] {
  const slides: SlideSpec[] = [];
  let cur: SlideSpec | null = null;
  for (const b of spec.blocks ?? []) {
    if (b.type === "heading" && (b.level ?? 1) <= 2) {
      if (cur) slides.push(cur);
      cur = { title: b.text, bullets: [] };
    } else if (cur) {
      if (b.type === "paragraph") cur.bullets!.push(b.text);
      else if (b.type === "list") cur.bullets!.push(...b.items);
      else if (b.type === "table") cur.table = b.table;
    }
  }
  if (cur) slides.push(cur);
  return slides;
}

// ── pdf ───────────────────────────────────────────────────────
export async function renderPdf(spec: DocumentSpec): Promise<Buffer> {
  const PDFDocument = requireAny("pdfkit");
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const font = resolveCjkFont();
  if (font) {
    doc.registerFont("cjk", font);
    doc.font("cjk");
  } else {
    doc.font("Helvetica");
    doc
      .text(
        "（未找到中文字体，PDF 中文可能无法显示。可设置环境变量 RAPTOR_CJK_FONT 指定 TTF 路径。）",
      )
      .moveDown(0.6);
  }
  const setFont = () => {
    if (font) doc.font("cjk");
  };
  setFont();

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;

  if (spec.title) {
    doc.fontSize(22).fillColor("black").text(spec.title, { align: "center" });
    doc.moveDown(0.6);
  }

  for (const b of spec.blocks ?? []) {
    setFont();
    doc.fillColor("black");
    if (b.type === "heading") {
      doc.moveDown(0.4);
      doc.fontSize(b.level === 1 ? 18 : b.level === 3 ? 13 : 15).text(b.text);
      doc.moveDown(0.3);
    } else if (b.type === "paragraph") {
      doc.fontSize(12).text(b.text, { align: "justify" });
      doc.moveDown(0.5);
    } else if (b.type === "list") {
      for (const it of b.items) {
        if (doc.y > bottom - 20) doc.addPage();
        setFont();
        doc.fontSize(12).text(`• ${it}`, left + 12, undefined, { indent: 0 });
      }
      doc.moveDown(0.4);
    } else if (b.type === "table") {
      ensureRoom(doc, bottom, 40);
      drawPdfTable(doc, b.table, left, right, bottom, !!font);
      doc.moveDown(0.6);
    } else if (b.type === "pagebreak") {
      doc.addPage();
    }
  }

  doc.end();
  return done;
}

function ensureRoom(doc: any, bottom: number, need: number): void {
  if (doc.y > bottom - need) {
    doc.addPage();
  }
}

function drawPdfTable(
  doc: any,
  table: TableSpec,
  left: number,
  right: number,
  bottom: number,
  hasCjk: boolean,
): void {
  const allRows: (string | number)[][] = table.headers
    ? [table.headers.map(String), ...table.rows.map((r) => r.map(String))]
    : table.rows.map((r) => r.map(String));
  const colCount = Math.max(...allRows.map((r) => r.length), 1);
  const avail = right - left;
  const colW = avail / colCount;
  const pad = 4;

  for (let ri = 0; ri < allRows.length; ri++) {
    const cells = allRows[ri];
    ensureRoom(doc, bottom, 24);
    const rowTop = doc.y;
    let maxBottom = rowTop;
    for (let ci = 0; ci < colCount; ci++) {
      const text = cells[ci] ?? "";
      const cellX = left + ci * colW;
      doc.fillColor("black").fontSize(10);
      if (hasCjk) doc.font("cjk");
      doc.text(String(text), cellX + pad, rowTop + pad, { width: colW - pad * 2, lineBreak: true });
      maxBottom = Math.max(maxBottom, doc.y);
    }
    // 画单元格边框（在文字之上叠细线，视觉即可）
    doc.lineWidth(0.5).strokeColor("#999999");
    for (let ci = 0; ci < colCount; ci++) {
      doc.rect(left + ci * colW, rowTop, colW, maxBottom - rowTop + pad).stroke();
    }
    if (table.headers && ri === 0) {
      doc.rect(left, rowTop, avail, maxBottom - rowTop + pad).stroke();
    }
    doc.strokeColor("#999999");
    doc.y = maxBottom + pad + 2;
    doc.x = left;
  }
}

// ── 编排 ──────────────────────────────────────────────────────
export async function renderDocument(
  spec: DocumentSpec,
): Promise<{ buffer: Buffer; baseName: string }> {
  const baseName = suggestBaseName(spec);
  switch (spec.format) {
    case "docx":
      return { buffer: await renderDocx(spec), baseName };
    case "xlsx":
      return { buffer: renderXlsx(spec), baseName };
    case "pptx":
      return { buffer: await renderPptx(spec), baseName };
    case "pdf":
      return { buffer: await renderPdf(spec), baseName };
    default:
      throw new Error(`不支持的格式: ${(spec as any).format}`);
  }
}
