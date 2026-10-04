/**
 * PPT 品牌主题引擎：「纸墨朱砂」课件模板
 *
 * 版式与品牌既有导出物同构（课表图 classic 页头是参照系）：
 * - 签名 motif：朱砂印章（圆形裁切 logo + 描边圈、整章旋转 -7°）——
 *   封面页头一枚大印，章节页右下浅圈印，内容页页脚小圆 logo 落款，每页在场；
 * - 封面：朱砂整版 + 居中大印章 + 楷体大标题浅字（官方三明治「深」端）；
 * - 章节页：朱砂整版浅字（只有标题没有正文的页自动成为章节页）；
 * - 内容页：暖纸浅底、墨色标题、朱砂深底表头表格，页脚细线 + 页码；
 * - 不用「AI 味」装饰：无标题下划线、无满宽色带/侧边条，分组靠留白与对齐；
 * - 色板与网页端（chat-page.ts 的 :root）、课表导出（schedule-svg.ts）同源。
 *
 * planPptSlides 是唯一事实源：pptx 渲染（renderPptxThemed）与网页预览载荷
 * （buildPptPreview）都从同一份版式计划出发，保证「预览所见 = 成品所得」。
 * 画布 10 × 5.625 英寸（16:9），字号按 13.33" 画布规范 ×0.75 换算。
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { loadLogoDataUri } from "../brand";
import type { PptOp, PptProgram } from "./ppt-program";
import type { DocumentSpec, SlideSpec, TableSpec } from "./types";

const require = createRequire(import.meta.url);
const requireAny = require as unknown as (id: string) => any;

/** 统一中文字体名（pptx 里作为引用写入，阅读器回退到本机同名字体） */
const FONT = "Microsoft YaHei";

/** 与网页 :root / 课表导出同源的品牌色板（去掉 # 的 6 位十六进制） */
export const PPT_THEME = {
  paper: "FDFCF9", // 纸面（内容页底色，投影仪上比深纸更稳）
  paperDeep: "F0EDE4", // 压深的纸（表格斑马纹）
  ink: "25221C",
  ink2: "5A554A",
  ink3: "6E6656",
  accent: "AD392C", // 朱砂（封面/章节页整版、表头）
  accentDeep: "852B22",
  rule: "E1DCCF", // 细线
  onAccent: "FDFCF9", // 朱砂底上的浅字
  onAccentDim: "E9C8C2", // 朱砂底上的次级浅字（页码/日期）
} as const;

export type PptSlideKind = "cover" | "section" | "content";

/** 版式计划：一页的呈现形态（渲染与预览共用） */
export interface PlannedPptSlide {
  kind: PptSlideKind;
  title: string;
  subtitle?: string;
  /** 封面署名 */
  author?: string;
  bullets?: string[];
  table?: TableSpec;
  notes?: string;
  /** 内容页正文字号（按要点/行数自适应，预览侧同款缩小） */
  bodySize: number;
}

/** blocks → slides 的自动分页（原 render.ts 内实现，随主题引擎一并收拢） */
export function slidesFromBlocks(spec: DocumentSpec): SlideSpec[] {
  const slides: SlideSpec[] = [];
  // 组装期间 bullets 由构造保证存在；接口类型保持可选（展示方可空）
  let cur: (SlideSpec & { bullets: string[] }) | null = null;
  for (const b of spec.blocks ?? []) {
    if (b.type === "heading" && (b.level ?? 1) <= 2) {
      if (cur) slides.push(cur);
      cur = { title: b.text, bullets: [] };
    } else if (cur) {
      if (b.type === "paragraph") cur.bullets.push(b.text);
      else if (b.type === "list")
        cur.bullets.push(...b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : it)));
      else if (b.type === "table") cur.table = b.table;
    }
  }
  if (cur) slides.push(cur);
  return slides;
}

function bulletsBodySize(n: number): number {
  if (n <= 6) return 16;
  if (n <= 9) return 15;
  if (n <= 12) return 14;
  return 13;
}

function tableBodySize(rows: number): number {
  if (rows <= 6) return 13;
  if (rows <= 9) return 11.5;
  return 10.5;
}

/**
 * 把 spec 排成版式计划：有主标题则首页为封面；只有标题、没有正文要点的
 * 幻灯片视为章节页；其余为内容页。字号按内容量自适应，避免溢出。
 */
export function planPptSlides(spec: DocumentSpec): PlannedPptSlide[] {
  const planned: PlannedPptSlide[] = [];
  if (spec.title) {
    planned.push({
      kind: "cover",
      title: spec.title,
      ...(spec.author ? { author: spec.author } : {}),
      bodySize: 0,
    });
  }
  for (const s of spec.slides ?? slidesFromBlocks(spec)) {
    const hasBody = !!(s.bullets?.length || s.table || s.subtitle);
    planned.push({
      kind: hasBody ? "content" : "section",
      title: s.title,
      ...(s.subtitle ? { subtitle: s.subtitle } : {}),
      ...(s.bullets?.length ? { bullets: s.bullets } : {}),
      ...(s.table ? { table: s.table } : {}),
      ...(s.notes ? { notes: s.notes } : {}),
      bodySize: s.table
        ? tableBodySize(s.table.rows.length)
        : bulletsBodySize(s.bullets?.length ?? 0),
    });
  }
  if (planned.length === 0) planned.push({ kind: "content", title: "(空)", bodySize: 18 });
  return planned;
}

// ── 网页预览载荷 ───────────────────────────────────────────────
/** 预览载荷的体量上限：SSE 每轮对话都过一遍，全文留在成品文件里 */
export const PREVIEW_SLIDE_CAP = 30;
const PREVIEW_BULLET_CAP = 12;
const PREVIEW_ROW_CAP = 8;
/** free 页元素在预览载荷里的上限 */
export const PREVIEW_ELEM_CAP = 30;
const PREVIEW_ELEM_TEXT_CAP = 120;

/** 预览页种类：三种品牌版式页 + 自由版式页（代码工具的 blank 页） */
export type PptPreviewKind = PptSlideKind | "free";

/** 自由页元素（预览形态）：与渲染元素同构，前端按画布 10 × 5.625 英寸归一化定位 */
export interface PptPreviewElement {
  kind: "text" | "rect" | "ellipse" | "line" | "logo";
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  size?: number;
  color?: string;
  bold?: true;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  font?: "kai";
  fill?: string;
  line?: string;
  lineW?: number;
  rotate?: number;
}

export interface PptPreviewSlide {
  kind: PptPreviewKind;
  /** free 页可以没有标题，其余版式页恒有 */
  title?: string;
  subtitle?: string;
  author?: string;
  bullets?: string[];
  /** 被截断的要点数（>0 时前端显示「+N」） */
  bulletCut?: number;
  table?: { headers?: string[]; rows: (string | number)[][]; rowCut?: number };
  notes?: string;
  /** free 页：自由元素（截到 PREVIEW_ELEM_CAP，超出记 elemCut） */
  elements?: PptPreviewElement[];
  elemCut?: number;
}

export interface PptPreview {
  /** 成品实际总页数（预览数组可能少于它） */
  count: number;
  slides: PptPreviewSlide[];
}

/** 单页版式计划 → 预览页（截断规则集中在这，两条构建路径共用） */
function previewOfPlanned(s: {
  kind: PptSlideKind;
  title: string;
  subtitle?: string;
  author?: string;
  bullets?: string[];
  table?: TableSpec;
  notes?: string;
}): PptPreviewSlide {
  const out: PptPreviewSlide = { kind: s.kind, title: s.title };
  if (s.subtitle) out.subtitle = s.subtitle;
  if (s.author) out.author = s.author;
  if (s.notes) out.notes = s.notes;
  if (s.bullets?.length) {
    out.bullets = s.bullets.slice(0, PREVIEW_BULLET_CAP);
    const cut = s.bullets.length - out.bullets.length;
    if (cut > 0) out.bulletCut = cut;
  }
  if (s.table) {
    const rows = s.table.rows.slice(0, PREVIEW_ROW_CAP);
    out.table = {
      ...(s.table.headers ? { headers: s.table.headers } : {}),
      rows,
    };
    const cut = s.table.rows.length - rows.length;
    if (cut > 0) out.table.rowCut = cut;
  }
  return out;
}

/** 从 spec 构建网页预览载荷（与渲染同一份版式计划） */
export function buildPptPreview(spec: DocumentSpec): PptPreview {
  const planned = planPptSlides(spec);
  return {
    count: planned.length,
    slides: planned.slice(0, PREVIEW_SLIDE_CAP).map(previewOfPlanned),
  };
}

/** 从代码工具的 op 程序构建预览载荷（renderPptxProgram 的同一份输入） */
export function buildProgramPreview(program: PptProgram): PptPreview {
  const slides: PptPreviewSlide[] = [];
  for (const op of program.ops.slice(0, PREVIEW_SLIDE_CAP)) {
    slides.push(previewOfOp(op));
  }
  return { count: program.ops.length, slides };
}

function previewOfOp(op: PptOp): PptPreviewSlide {
  if (op.op === "cover")
    return previewOfPlanned({
      kind: "cover",
      title: op.title,
      author: op.author,
      notes: op.notes,
    });
  if (op.op === "section")
    return previewOfPlanned({ kind: "section", title: op.title, notes: op.notes });
  if (op.op === "bullets")
    return previewOfPlanned({
      kind: "content",
      title: op.title,
      subtitle: op.subtitle,
      bullets: op.points,
      notes: op.notes,
    });
  if (op.op === "table")
    return previewOfPlanned({
      kind: "content",
      title: op.title,
      subtitle: op.subtitle,
      table: { headers: op.headers, rows: op.rows },
      notes: op.notes,
    });
  const out: PptPreviewSlide = { kind: "free" };
  if (op.title) out.title = op.title;
  if (op.notes) out.notes = op.notes;
  if (op.elements.length) {
    out.elements = op.elements.slice(0, PREVIEW_ELEM_CAP).map((e) => {
      const el: PptPreviewElement = {
        kind: e.kind,
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
      };
      if (e.kind === "text") {
        el.text =
          e.text.length > PREVIEW_ELEM_TEXT_CAP
            ? `${e.text.slice(0, PREVIEW_ELEM_TEXT_CAP)}…`
            : e.text;
        if (e.size !== undefined) el.size = e.size;
        if (e.color) el.color = e.color;
        if (e.bold) el.bold = e.bold;
        if (e.align) el.align = e.align;
        if (e.valign) el.valign = e.valign;
        if (e.font) el.font = e.font;
      } else if (e.kind !== "logo") {
        if (e.fill) el.fill = e.fill;
        if (e.line) el.line = e.line;
        if (e.lineW !== undefined) el.lineW = e.lineW;
        if (e.rotate !== undefined) el.rotate = e.rotate;
      }
      return el;
    });
    const cut = op.elements.length - out.elements.length;
    if (cut > 0) out.elemCut = cut;
  }
  return out;
}

const ELEM_KINDS = new Set(["text", "rect", "ellipse", "line", "logo"]);
const HEX = /^[0-9A-F]{6}$/;

/** free 页元素逐个校验：形状不对整份载荷拒绝（与幻灯片同款严格闸） */
function previewElemOf(raw: unknown): PptPreviewElement | null {
  if (typeof raw !== "object" || raw == null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.kind !== "string" || !ELEM_KINDS.has(e.kind)) return null;
  for (const k of ["x", "y", "w", "h"] as const) {
    const v = e[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < -0.01 || v > 10.01) return null;
  }
  const out: PptPreviewElement = {
    kind: e.kind as PptPreviewElement["kind"],
    x: e.x as number,
    y: e.y as number,
    w: e.w as number,
    h: e.h as number,
  };
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.length <= max ? v : undefined;
  const hexOf = (v: unknown) => (typeof v === "string" && HEX.test(v) ? v : undefined);
  if (e.kind === "text") {
    const text = str(e.text, 300);
    if (!text) return null;
    out.text = text;
    if (typeof e.size === "number" && e.size > 0 && e.size <= 100) out.size = e.size;
    const color = hexOf(e.color);
    if (color) out.color = color;
    if (e.bold === true) out.bold = true;
    const align = str(e.align, 10);
    if (align === "left" || align === "center" || align === "right") out.align = align;
    const valign = str(e.valign, 10);
    if (valign === "top" || valign === "middle" || valign === "bottom") out.valign = valign;
    if (e.font === "kai") out.font = "kai";
  } else if (e.kind !== "logo") {
    const fill = hexOf(e.fill);
    if (fill) out.fill = fill;
    const line = hexOf(e.line);
    if (line) out.line = line;
    if (typeof e.lineW === "number" && Number.isFinite(e.lineW)) out.lineW = e.lineW;
    if (typeof e.rotate === "number" && Number.isFinite(e.rotate)) out.rotate = e.rotate;
  }
  return out;
}

/**
 * 从工具结果里提取合法的预览载荷（chat-web SSE 透传前的校验闸）。
 * 与 pomodoroOfToolOutput 同款职责：形状不对就返回 null，绝不把模型
 * 伪造/畸形的 ppt 字段透到前端渲染。
 */
export function pptPreviewOfToolOutput(output: unknown): PptPreview | null {
  if (typeof output !== "object" || output == null || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  if (typeof o.ppt !== "object" || o.ppt == null || Array.isArray(o.ppt)) return null;
  const p = o.ppt as Record<string, unknown>;
  if (!Array.isArray(p.slides) || p.slides.length === 0) return null;
  const KINDS = new Set(["cover", "section", "content", "free"]);
  const slides: PptPreviewSlide[] = [];
  for (const raw of p.slides.slice(0, PREVIEW_SLIDE_CAP)) {
    if (typeof raw !== "object" || raw == null) return null;
    const s = raw as Record<string, unknown>;
    if (!KINDS.has(String(s.kind))) return null;
    const isFree = s.kind === "free";
    // free 页标题可选，其余版式页必须有标题
    if (!isFree && typeof s.title !== "string") return null;
    if (s.title !== undefined && typeof s.title !== "string") return null;
    const slide: PptPreviewSlide = { kind: s.kind as PptPreviewKind };
    if (typeof s.title === "string" && s.title) slide.title = s.title;
    if (typeof s.subtitle === "string") slide.subtitle = s.subtitle;
    if (typeof s.author === "string") slide.author = s.author;
    if (typeof s.notes === "string") slide.notes = s.notes;
    if (Array.isArray(s.bullets)) {
      const bullets = s.bullets.filter((b): b is string => typeof b === "string");
      if (bullets.length) slide.bullets = bullets.slice(0, PREVIEW_BULLET_CAP);
    }
    if (typeof s.table === "object" && s.table != null && !Array.isArray(s.table)) {
      const t = s.table as Record<string, unknown>;
      if (Array.isArray(t.rows)) {
        const rows = t.rows
          .filter((r): r is (string | number)[] => Array.isArray(r))
          .slice(0, PREVIEW_ROW_CAP)
          .map((r) => r.slice(0, 8));
        slide.table = {
          ...(Array.isArray(t.headers)
            ? {
                headers: t.headers.filter((h): h is string => typeof h === "string").slice(0, 8),
              }
            : {}),
          rows,
        };
      }
    }
    if (Array.isArray(s.elements)) {
      const elements: PptPreviewElement[] = [];
      for (const rawEl of s.elements.slice(0, PREVIEW_ELEM_CAP)) {
        const el = previewElemOf(rawEl);
        if (!el) return null;
        elements.push(el);
      }
      if (elements.length) slide.elements = elements;
    }
    slides.push(slide);
  }
  const count = typeof p.count === "number" && p.count >= slides.length ? p.count : slides.length;
  return { count, slides };
}

// ── pptx 渲染 ─────────────────────────────────────────────────
/** 字号按官方规范（10" 画布）：封面 44/40/34/28、内容页标题 36/28 */
function coverTitleSize(title: string): number {
  const n = title.length;
  if (n <= 10) return 44;
  if (n <= 16) return 40;
  if (n <= 24) return 34;
  return 28;
}

function contentTitleSize(title: string): number {
  return title.length > 16 ? 28 : 36;
}

function zhDate(d = new Date()): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 封面主标题用楷体（课表导出 classic 页头同款），正文仍用雅黑 */
const FONT_KAI = "KaiTi";

/** pptxgenjs 实例/页的最小结构面：渲染函数只用这些成员，选项都是宽 Record
 *  （pptxgenjs 自带类型过重，CJS require 拿到的也是 any，这里收窄成结构闸） */
interface PptxSlide {
  background: { color: string };
  addText(
    text: string | Array<{ text: string; options: Record<string, unknown> }>,
    opts?: Record<string, unknown>,
  ): void;
  addShape(kind: string, opts?: Record<string, unknown>): void;
  addImage(opts: Record<string, unknown>): void;
  addTable(rows: unknown[], opts?: Record<string, unknown>): void;
  addNotes(text: string): void;
}

interface PptxDeck {
  layout: string;
  defineSlideMaster(def: Record<string, unknown>): void;
  addSlide(opts?: { masterName?: string }): PptxSlide;
  write(opts: { outputType: string }): Promise<unknown>;
}

/**
 * 朱砂印章：圆形裁切 logo + 描边圈、整章旋转 -7°——课表导出 classic 页头
 * 的同款印章，PPT 的签名 motif。logo 缺失时跳过，不破坏版式。
 */
function addSeal(
  slide: PptxSlide,
  cx: number,
  cy: number,
  dia: number,
  logo: string,
  ringColor: string,
  fillColor: string,
): void {
  const r = dia / 2;
  const rot = { rotate: -7 };
  slide.addShape("ellipse", {
    x: cx - r,
    y: cy - r,
    w: dia,
    h: dia,
    fill: { color: fillColor },
    line: { color: ringColor, width: 2.5 },
    ...rot,
  });
  const img = dia * 0.8;
  slide.addImage({
    data: logo,
    x: cx - img / 2,
    y: cy - img / 2,
    w: img,
    h: img,
    rounding: true,
    ...rot,
  });
}

/**
 * 媒体去重：印章 motif 让同一份 logo 被 pptxgenjs 重复嵌入多份（它不合并
 * 相同的 data URI），6 页小课件能膨胀到 5MB+。按内容哈希合并重复媒体，
 * 并把所有 .rels 指回保留的那份——体积回到单份 logo 的量级。
 * 注意 rels 里是相对目标（../media/xxx.png），替换必须按 media/ 段匹配，
 * 只删文件不修 rels 会留下悬空引用，PowerPoint 打开就是破损图片。
 */
async function dedupeMedia(buf: Buffer): Promise<Buffer> {
  const JSZip = requireAny("jszip");
  const zip = await JSZip.loadAsync(buf);
  const keepByHash = new Map<string, string>();
  const rename = new Map<string, string>(); // 待删名 → 保留名
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/media\/[^/]+$/.test(name)) continue;
    const data = await zip.files[name].async("nodebuffer");
    const hash = createHash("md5").update(data).digest("hex");
    const keep = keepByHash.get(hash);
    if (keep) rename.set(name, keep);
    else keepByHash.set(hash, name);
  }
  if (rename.size === 0) return buf;
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith(".rels")) continue;
    let xml = await zip.files[name].async("string");
    for (const [dup, keep] of rename) {
      xml = xml
        .split(`media/${dup.slice("ppt/media/".length)}`)
        .join(`media/${keep.slice("ppt/media/".length)}`);
    }
    zip.file(name, xml);
  }
  for (const dup of rename.keys()) zip.remove(dup);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

/** 品牌画布：pptxgenjs 实例 + 三张母版（封面/章节/内容）+ 印章 logo */
function newBrandDeck(): { pptx: PptxDeck; logo: string | null } {
  const PptxGenJS = requireAny("pptxgenjs");
  const Ctor = PptxGenJS.default ?? PptxGenJS;
  const pptx = new Ctor() as PptxDeck;
  pptx.layout = "LAYOUT_16x9";
  const logo = loadLogoDataUri();

  // 内容页母版：页脚细线（功能性分隔，不是装饰色带）+ 品牌字 + 圆形小 logo 落款 + 页码
  pptx.defineSlideMaster({
    title: "PPT_CONTENT",
    background: { color: PPT_THEME.paper },
    objects: [
      { rect: { x: 0.55, y: 5.33, w: 8.4, h: 0.008, fill: { color: PPT_THEME.rule } } },
      {
        text: {
          text: "COURSERAPTOR",
          options: {
            x: 0.55,
            y: 5.36,
            w: 2.6,
            h: 0.22,
            fontSize: 8.5,
            charSpacing: 2,
            color: PPT_THEME.ink3,
            fontFace: FONT,
          },
        },
      },
      ...(logo
        ? [{ image: { data: logo, x: 9.18, y: 5.14, w: 0.26, h: 0.26, rounding: true } }]
        : []),
    ],
    slideNumber: {
      x: 8.55,
      y: 5.36,
      w: 0.45,
      h: 0.22,
      fontSize: 9,
      color: PPT_THEME.ink3,
      fontFace: FONT,
      align: "right",
    },
  });
  // 章节页母版：朱砂整版 + 浅字页码（印章在页内画，母版只管底色与页码）
  pptx.defineSlideMaster({
    title: "PPT_SECTION",
    background: { color: PPT_THEME.accent },
    slideNumber: {
      x: 8.4,
      y: 5.36,
      w: 0.5,
      h: 0.22,
      fontSize: 9,
      color: PPT_THEME.onAccentDim,
      fontFace: FONT,
      align: "right",
    },
  });
  // 封面母版：朱砂整版（官方三明治结构的「深」端）
  pptx.defineSlideMaster({
    title: "PPT_COVER",
    background: { color: PPT_THEME.accent },
  });
  return { pptx, logo };
}

interface CoverInput {
  title: string;
  author?: string;
  notes?: string;
}

function addCoverSlide(pptx: PptxDeck, s: CoverInput, logo: string | null): void {
  // 官方规范的「深色封面」端：朱砂整版 + 居中大印章 + 楷体大标题浅字
  const slide = pptx.addSlide({ masterName: "PPT_COVER" });
  slide.background = { color: PPT_THEME.accent };
  if (logo) addSeal(slide, 5, 1.08, 1.24, logo, PPT_THEME.onAccent, PPT_THEME.accent);
  slide.addText(s.title, {
    x: 0.7,
    y: 2.15,
    w: 8.6,
    h: 1.45,
    fontSize: coverTitleSize(s.title),
    bold: true,
    color: PPT_THEME.onAccent,
    align: "center",
    valign: "bottom",
    fontFace: FONT_KAI,
  });
  if (s.author) {
    slide.addText(s.author, {
      x: 0.8,
      y: 3.72,
      w: 8.4,
      h: 0.4,
      fontSize: 15,
      color: PPT_THEME.onAccentDim,
      align: "center",
      fontFace: FONT,
    });
  }
  slide.addText(zhDate(), {
    x: 0.8,
    y: 4.2,
    w: 8.4,
    h: 0.3,
    fontSize: 10.5,
    color: PPT_THEME.onAccentDim,
    align: "center",
    fontFace: FONT,
  });
  if (s.notes) slide.addNotes(s.notes);
}

function addSectionSlide(
  pptx: PptxDeck,
  s: { title: string; notes?: string },
  logo: string | null,
): void {
  const slide = pptx.addSlide({ masterName: "PPT_SECTION" });
  slide.background = { color: PPT_THEME.accent };
  slide.addText(s.title, {
    x: 0.95,
    y: 2.15,
    w: 8.1,
    h: 1.4,
    fontSize: s.title.length > 14 ? 28 : 34,
    bold: true,
    color: PPT_THEME.onAccent,
    valign: "middle",
    fontFace: FONT,
  });
  // 朱砂底上的印章换浅色圈（同款旋转，签名 motif 不断档）
  if (logo) addSeal(slide, 9.06, 4.98, 0.52, logo, PPT_THEME.onAccent, PPT_THEME.accent);
  if (s.notes) slide.addNotes(s.notes);
}

interface ContentInput {
  title: string;
  subtitle?: string;
  bullets?: string[];
  table?: TableSpec;
  notes?: string;
  bodySize: number;
}

function addContentSlide(pptx: PptxDeck, s: ContentInput): void {
  const slide = pptx.addSlide({ masterName: "PPT_CONTENT" });
  slide.background = { color: PPT_THEME.paper };
  slide.addText(s.title, {
    x: 0.55,
    y: 0.4,
    w: 8.9,
    h: 0.85,
    fontSize: contentTitleSize(s.title),
    bold: true,
    color: PPT_THEME.ink,
    valign: "bottom",
    fontFace: FONT,
    margin: 0,
  });
  let y = 1.75;
  if (s.subtitle) {
    slide.addText(s.subtitle, {
      x: 0.55,
      y: 1.34,
      w: 8.9,
      h: 0.36,
      fontSize: 13.5,
      italic: true,
      color: PPT_THEME.ink2,
      fontFace: FONT,
      margin: 0,
    });
    y = 1.98;
  }
  if (s.bullets?.length) {
    // 官方规范「每页要有视觉元素」：要点 ≤6 且无表格时排成数字圆圈行
    // （朱砂圆 + 白色序号 + 行文字），否则回退紧凑列表
    if (!s.table && s.bullets.length <= 6) {
      const n = s.bullets.length;
      const step = n <= 4 ? 0.82 : 0.66;
      const top = Math.max(y, (y + 5.05 - n * step + 0.5) / 2);
      s.bullets.forEach((t, i) => {
        const cy = top + i * step;
        slide.addText(String(i + 1), {
          shape: "ellipse",
          x: 0.62,
          y: cy,
          w: 0.36,
          h: 0.36,
          fill: { color: PPT_THEME.accent },
          color: "FFFFFF",
          bold: true,
          fontSize: 13,
          align: "center",
          valign: "middle",
          fontFace: FONT,
          margin: 0,
        });
        slide.addText(t, {
          x: 1.18,
          y: cy - 0.09,
          w: 8.2,
          h: 0.54,
          fontSize: s.bodySize,
          color: PPT_THEME.ink,
          valign: "middle",
          fontFace: FONT,
          margin: 0,
        });
      });
    } else {
      // 项目符号按规范精修：小方块 + 12pt 悬挂缩进 + 段后距，不用行距撑开；
      // 要点与表格同页时给要点限高，表格接在其后，避免两者叠压
      const h = s.table ? Math.min(2.2, 5.15 - y) : 5.15 - y;
      slide.addText(
        s.bullets.map((t) => ({
          text: t,
          options: { bullet: { code: "25AA", indent: 12 }, breakLine: true },
        })),
        {
          x: 0.6,
          y,
          w: 8.8,
          h,
          fontSize: s.bodySize,
          color: PPT_THEME.ink,
          valign: "top",
          fontFace: FONT,
          paraSpaceAfter: 8,
          margin: 0,
        },
      );
      if (s.table) y += h + 0.1;
    }
  }
  if (s.table) {
    const headerRow = s.table.headers;
    const bodyRows = s.table.rows;
    const rows = [
      ...(headerRow
        ? [
            headerRow.map((c) => ({
              text: String(c ?? ""),
              options: {
                fill: { color: PPT_THEME.accentDeep },
                color: PPT_THEME.onAccent,
                bold: true,
                fontFace: FONT,
              },
            })),
          ]
        : []),
      ...bodyRows.map((r, i) =>
        r.map((c) => ({
          text: String(c ?? ""),
          options: {
            fill: { color: i % 2 === 0 ? PPT_THEME.paper : PPT_THEME.paperDeep },
            color: PPT_THEME.ink,
            fontFace: FONT,
          },
        })),
      ),
    ];
    slide.addTable(rows, {
      x: 0.55,
      y,
      w: 8.9,
      fontSize: s.bodySize,
      border: { pt: 0.5, color: PPT_THEME.rule },
      fontFace: FONT,
      valign: "middle",
      autoPage: false,
    });
  }
  if (s.notes) slide.addNotes(s.notes);
}

/** 自由版式页：内容页母版打底（页脚/页码品牌感不断档），元素按代码任意排布 */
function addBlankSlide(
  pptx: PptxDeck,
  op: Extract<PptOp, { op: "blank" }>,
  logo: string | null,
): void {
  const slide = pptx.addSlide({ masterName: "PPT_CONTENT" });
  slide.background = { color: PPT_THEME.paper };
  if (op.title) {
    slide.addText(op.title, {
      x: 0.55,
      y: 0.4,
      w: 8.9,
      h: 0.85,
      fontSize: contentTitleSize(op.title),
      bold: true,
      color: PPT_THEME.ink,
      valign: "bottom",
      fontFace: FONT,
      margin: 0,
    });
  }
  for (const e of op.elements) {
    if (e.kind === "text") {
      slide.addText(e.text, {
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        fontSize: e.size ?? 14,
        color: e.color ?? PPT_THEME.ink,
        bold: e.bold === true,
        align: e.align ?? "left",
        valign: e.valign ?? "top",
        fontFace: e.font === "kai" ? FONT_KAI : FONT,
        margin: 0,
        ...(e.wrap === false ? { wrap: false } : {}),
      });
    } else if (e.kind === "logo") {
      if (logo) slide.addImage({ data: logo, x: e.x, y: e.y, w: e.w, h: e.h, rounding: true });
    } else if (e.kind === "line") {
      slide.addShape("line", {
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        line: { color: e.line ?? PPT_THEME.rule, width: e.lineW ?? 1 },
      });
    } else {
      slide.addShape(e.kind, {
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        ...(e.fill ? { fill: { color: e.fill } } : { fill: { type: "none" } }),
        ...(e.line || (!e.fill && e.kind === "rect")
          ? {
              line: {
                color: e.line ?? PPT_THEME.rule,
                width: e.lineW ?? 1,
              },
            }
          : {}),
        ...(e.rotate !== undefined ? { rotate: e.rotate } : {}),
      });
    }
  }
  if (op.notes) slide.addNotes(op.notes);
}

/** 主题化渲染：版式计划 → pptx 字节（pptxgenjs，16:9 = 10 × 5.625"） */
export async function renderPptxThemed(spec: DocumentSpec): Promise<Buffer> {
  const { pptx, logo } = newBrandDeck();
  for (const s of planPptSlides(spec)) {
    if (s.kind === "cover") addCoverSlide(pptx, s, logo);
    else if (s.kind === "section") addSectionSlide(pptx, s, logo);
    else addContentSlide(pptx, s);
  }
  return writeDeck(pptx);
}

/** 代码工具路径：op 程序 → pptx 字节（与 spec 路径同一套母版/印章/去重） */
export async function renderPptxProgram(program: PptProgram): Promise<Buffer> {
  const { pptx, logo } = newBrandDeck();
  for (const op of program.ops) {
    switch (op.op) {
      case "cover":
        addCoverSlide(pptx, op, logo);
        break;
      case "section":
        addSectionSlide(pptx, op, logo);
        break;
      case "bullets":
        addContentSlide(pptx, {
          title: op.title,
          subtitle: op.subtitle,
          bullets: op.points,
          notes: op.notes,
          bodySize: bulletsBodySize(op.points.length),
        });
        break;
      case "table":
        addContentSlide(pptx, {
          title: op.title,
          subtitle: op.subtitle,
          table: { headers: op.headers, rows: op.rows },
          notes: op.notes,
          bodySize: tableBodySize(op.rows.length),
        });
        break;
      case "blank":
        addBlankSlide(pptx, op, logo);
        break;
    }
  }
  return writeDeck(pptx);
}

async function writeDeck(pptx: PptxDeck): Promise<Buffer> {
  const out = await pptx.write({ outputType: "nodebuffer" });
  const raw = Buffer.isBuffer(out) ? out : Buffer.from(out as any);
  return dedupeMedia(raw);
}
