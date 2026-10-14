/**
 * PPT 幻灯片 DSL：模型直接输出 slide JSON（照抄 OpenMAIC 的页面对象模型，
 * MIT / THU-MAIC），取代旧的「写代码 + node:vm 沙箱录音」管线。
 *
 * 与上游的差异（有意为之）：
 * - 画布保持上游的 1000 × 562.5 px（渲染时 ÷100 换英寸），安全边距 50px；
 * - 元素类型收敛到七种：text / shape / line / chart / table / latex / code。
 *   image / video / audio 依赖媒体池，本管线没有图片来源，暂不开放；
 * - id 改为可选（本管线没有编辑器，不需要稳定 id）；默认值由 zod 补；
 * - 颜色除 #RRGGBB 外接受品牌色板名（accent/ink/paper…），解析时归一；
 * - 每页可选 motif（cover/section/plain）：选品牌母版（大印章封面 /
 *   朱砂章节页 / 内容页页脚），这是「纸墨朱砂」签名 motif 的入口；
 * - 每页可选 notes：口播台词进演讲者备注，不上页面。
 *
 * 校验分两层：parseSlideDeck 是硬闸（zod，形状不对整体拒绝），
 * checkSlideDeck 是软闸（照抄上游 Pre-Output Checklist 的 P0/P1 规则，
 * 产出一串中文警告，ppt_preview 原样返回给模型改）。
 */

import { z } from "zod";
import { parseHtml } from "./ppt-html";
import { elementRange, parseColor, svgPathToPoints } from "./ppt-svg";

// ── 画布与上限 ───────────────────────────────────────────────

/** 画布宽（px）；高 = 宽 × 0.5625 = 562.5px */
export const CANVAS_W = 1000;
export const CANVAS_H = 562.5;
/** 四边安全边距（px）：live area = left∈[50,950], top∈[50,512.5] */
export const CANVAS_MARGIN = 50;

export const PPT_DSL_LIMITS = {
  slides: 60,
  elements: 60,
  textLen: 2000,
  notesLen: 2000,
  rows: 40,
  cols: 12,
  cellLen: 300,
  chartLabels: 24,
  chartSeries: 12,
  chartPoints: 24,
  latexLen: 1000,
  /** MathML 预览串上限（temml 产物可达 LaTeX 的数倍） */
  mathmlLen: 8000,
  codeLines: 40,
  codeLineLen: 200,
} as const;

/**
 * 文本高度查表（照抄上游 system.md）：行高 1.5、含四周 10px 内边距。
 * key 字号 px，value 1-5 行的高度。写文本 height 必须查这张表。
 */
export const TEXT_HEIGHT_TABLE: Record<number, [number, number, number, number, number]> = {
  14: [43, 64, 85, 106, 127],
  16: [46, 70, 94, 118, 142],
  18: [49, 76, 103, 130, 157],
  20: [52, 82, 112, 142, 172],
  24: [58, 94, 130, 166, 202],
  28: [64, 106, 148, 190, 232],
  32: [70, 118, 166, 214, 262],
  36: [76, 130, 184, 238, 292],
};

/** 字号阶梯（照抄上游 type scale，px） */
export const TYPE_SCALE = {
  title: [32, 36],
  subtitle: [24, 28],
  points: [18, 20],
  body: [16, 18],
  caption: [14, 16],
} as const;

// ── zod 基础件 ───────────────────────────────────────────────

const num = z.number().finite();
const posNum = num.nonnegative();

/** 颜色：#RRGGBB / #RGB 或品牌色板名；解析时归一为 "#RRGGBB" */
const colorSchema = z.string().transform((v, ctx) => {
  const c = parseColor(v);
  if (!c) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `颜色不合法："${v}"（用 #RRGGBB 或色板名 paper/paperDeep/ink/ink2/ink3/accent/accentDeep/rule/onAccent/onAccentDim）`,
    });
    return z.NEVER;
  }
  return `#${c.hex}`;
});

const shadowSchema = z.object({
  h: num,
  v: num,
  blur: posNum,
  color: colorSchema,
});

const outlineSchema = z.object({
  style: z.enum(["solid", "dashed", "dotted"]).optional(),
  width: posNum.max(20).optional(),
  color: colorSchema.optional(),
});

const gradientSchema = z.object({
  type: z.enum(["linear", "radial"]).optional(),
  colors: z
    .array(z.object({ pos: num.min(0).max(1), color: colorSchema }))
    .min(2)
    .max(5),
  rotate: num.optional(),
});

const backgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("solid"), color: colorSchema }),
  z.object({ type: z.literal("gradient"), gradient: gradientSchema }),
]);

/** 元素通用字段（照抄上游 PPTBaseElement；line 例外，见其 schema） */
const baseFields = {
  id: z.string().max(64).optional(),
  left: num,
  top: num,
  width: posNum,
  height: posNum,
  rotate: num.min(-360).max(360).optional(),
};

// ── 元素 schema ──────────────────────────────────────────────

const textElementSchema = z.object({
  type: z.literal("text"),
  ...baseFields,
  content: z
    .string()
    .max(PPT_DSL_LIMITS.textLen, `文本最长 ${PPT_DSL_LIMITS.textLen} 字符：删词或拆页`),
  defaultFontName: z.string().max(40).optional(),
  defaultColor: colorSchema.optional(),
  /** 文本框底色（与页面背景配对） */
  fill: colorSchema.optional(),
  lineHeight: num.min(1).max(3).optional(),
  wordSpace: num.min(0).max(50).optional(),
  opacity: num.min(0).max(1).optional(),
  paragraphSpace: num.min(0).max(100).optional(),
  vAlign: z.enum(["top", "middle", "bottom"]).optional(),
  shadow: shadowSchema.optional(),
  outline: outlineSchema.optional(),
});

const shapeElementSchema = z.object({
  type: z.literal("shape"),
  ...baseFields,
  /** SVG viewBox，如 [1000, 1000] 表示 "0 0 1000 1000" */
  viewBox: z.tuple([posNum, posNum]).refine(([w, h]) => w > 0 && h > 0, "viewBox 必须为正"),
  /** SVG path 的 d；矩形 "M 0 0 L 1 0 L 1 1 L 0 1 Z"、圆形用 A 命令 */
  path: z.string().max(4000),
  /** 填充色；空字符串 = 无填充（渐变存在时被渐变覆盖） */
  fill: z.union([colorSchema, z.literal("")]).optional(),
  gradient: gradientSchema.optional(),
  outline: outlineSchema.optional(),
  opacity: num.min(0).max(1).optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  shadow: shadowSchema.optional(),
  /** 形状内文本（垂直对齐） */
  text: z
    .object({
      content: z.string().max(PPT_DSL_LIMITS.textLen),
      defaultColor: colorSchema.optional(),
      defaultFontName: z.string().max(40).optional(),
      align: z.enum(["top", "middle", "bottom"]).optional(),
    })
    .optional(),
});

const lineElementSchema = z.object({
  type: z.literal("line"),
  id: z.string().max(64).optional(),
  left: num,
  top: num,
  /** 线宽 = 描边粗细（2-6），不是线条长度；长度由 start/end 决定 */
  width: posNum.max(20),
  /** 起点（相对 left/top 的局部坐标） */
  start: z.tuple([num, num]),
  end: z.tuple([num, num]),
  style: z.enum(["solid", "dashed", "dotted"]).optional(),
  color: colorSchema.optional(),
  /** [起点样式, 终点样式]："" | "arrow" | "dot" */
  points: z.tuple([z.enum(["", "arrow", "dot"]), z.enum(["", "arrow", "dot"])]).optional(),
  /** 折线控制点（两段直角折线） */
  broken: z.tuple([num, num]).optional(),
  /** 阶梯连接线控制点（自动生成三段直角路径） */
  broken2: z.tuple([num, num]).optional(),
  /** 二次曲线控制点 */
  curve: z.tuple([num, num]).optional(),
  /** 三次曲线两个控制点 */
  cubic: z.tuple([z.tuple([num, num]), z.tuple([num, num])]).optional(),
  shadow: shadowSchema.optional(),
});

const chartElementSchema = z.object({
  type: z.literal("chart"),
  ...baseFields,
  chartType: z.enum(["bar", "column", "line", "pie", "ring", "area", "radar", "scatter"]),
  data: z.object({
    labels: z.array(z.string().max(60)).min(1).max(PPT_DSL_LIMITS.chartLabels),
    legends: z.array(z.string().max(60)).max(PPT_DSL_LIMITS.chartSeries),
    series: z.array(z.array(num).max(PPT_DSL_LIMITS.chartPoints)).max(PPT_DSL_LIMITS.chartSeries),
  }),
  /** 主题色板（不足 10 个按类似色自动补） */
  themeColors: z.array(colorSchema).max(PPT_DSL_LIMITS.chartSeries).default([]),
  textColor: colorSchema.optional(),
  fill: colorSchema.optional(),
  outline: outlineSchema.optional(),
  options: z
    .object({ lineSmooth: z.boolean().optional(), stack: z.boolean().optional() })
    .optional(),
});

const tableCellStyleSchema = z.object({
  bold: z.boolean().optional(),
  em: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  color: colorSchema.optional(),
  backcolor: colorSchema.optional(),
  /** 字号（px 数字字符串，如 "14"） */
  fontsize: z.string().max(8).optional(),
  fontname: z.string().max(40).optional(),
  align: z.enum(["left", "center", "right", "justify"]).optional(),
});

const tableCellSchema = z.object({
  colspan: z.number().int().min(1).max(PPT_DSL_LIMITS.cols).default(1),
  rowspan: z.number().int().min(1).max(PPT_DSL_LIMITS.rows).default(1),
  /** 纯文本；不放公式和标记 */
  text: z.string().max(PPT_DSL_LIMITS.cellLen),
  style: tableCellStyleSchema.optional(),
});

const tableElementSchema = z.object({
  type: z.literal("table"),
  ...baseFields,
  outline: outlineSchema.optional(),
  theme: z
    .object({
      color: colorSchema,
      rowHeader: z.boolean().default(false),
      rowFooter: z.boolean().default(false),
      colHeader: z.boolean().default(false),
      colFooter: z.boolean().default(false),
    })
    .optional(),
  /** 列宽占比，如 [0.3, 0.5, 0.2]；总和应为 1 */
  colWidths: z.array(num.min(0.01)).min(1).max(PPT_DSL_LIMITS.cols),
  cellMinHeight: posNum.max(200).optional(),
  data: z.array(z.array(tableCellSchema).max(PPT_DSL_LIMITS.cols)).min(1).max(PPT_DSL_LIMITS.rows),
});

const latexElementSchema = z.object({
  type: z.literal("latex"),
  ...baseFields,
  /** LaTeX 源码（不带 $ 定界符）；页内所有公式必须走这个元素 */
  latex: z.string().min(1).max(PPT_DSL_LIMITS.latexLen),
  align: z.enum(["left", "center", "right"]).optional(),
  /**
   * 网页预览载荷：服务端用 temml 生成的 MathML（浏览器原生渲染公式）。
   * 模型输入里写这一栏没有意义——buildSlidesPreview 才填； schema 放行
   * 是为了让校验闸（web-ppt-preview）原样带回前端。
   */
  mathml: z.string().max(PPT_DSL_LIMITS.mathmlLen).optional(),
});

const codeElementSchema = z.object({
  type: z.literal("code"),
  ...baseFields,
  language: z.string().max(30).optional(),
  lines: z
    .array(z.object({ content: z.string().max(PPT_DSL_LIMITS.codeLineLen) }))
    .min(1)
    .max(PPT_DSL_LIMITS.codeLines),
  fileName: z.string().max(60).optional(),
  showLineNumbers: z.boolean().optional(),
  fontSize: num.min(8).max(28).optional(),
});

export const pptElementSchema = z.discriminatedUnion("type", [
  textElementSchema,
  shapeElementSchema,
  lineElementSchema,
  chartElementSchema,
  tableElementSchema,
  latexElementSchema,
  codeElementSchema,
]);

const slideSchema = z.object({
  background: backgroundSchema.optional(),
  /** 品牌母版：cover=朱砂大印章封面 / section=朱砂章节页 / plain=内容页页脚 */
  motif: z.enum(["cover", "section", "plain"]).optional(),
  notes: z
    .string()
    .max(PPT_DSL_LIMITS.notesLen, `演讲者备注最长 ${PPT_DSL_LIMITS.notesLen} 字符`)
    .optional(),
  elements: z
    .array(pptElementSchema)
    .max(PPT_DSL_LIMITS.elements, `每页元素最多 ${PPT_DSL_LIMITS.elements} 个：拆页`),
});

export const slideDeckSchema = z.object({
  slides: z
    .array(slideSchema)
    .min(1, "slides 至少要有一页")
    .max(PPT_DSL_LIMITS.slides, `slides 最多 ${PPT_DSL_LIMITS.slides} 页：拆成多份课件`),
});

// ── 导出类型 ─────────────────────────────────────────────────

export type SlideDeck = z.infer<typeof slideDeckSchema>;
export type DeckSlide = z.infer<typeof slideSchema>;
export type DeckElement = z.infer<typeof pptElementSchema>;
export type DeckBackground = z.infer<typeof backgroundSchema>;

// ── 硬闸：解析 ───────────────────────────────────────────────

/** zod issue → 中文人话（模型改输入的导航） */
function friendlyIssue(issue: z.core.$ZodIssue): string {
  const at = issue.path.length ? `（${issue.path.join(".")}）` : "";
  switch (issue.code) {
    case "invalid_type":
      return `${at} 类型不对：${issue.message}`;
    case "invalid_value":
      return `${at} 取值不合法：${issue.message}`;
    case "too_small":
      return `${at} ${issue.message}`;
    case "too_big":
      return `${at} ${issue.message}`;
    case "invalid_union":
      return `${at} 不匹配任何元素类型（type 必须是 text/shape/line/chart/table/latex/code 之一，字段见工具说明）`;
    default:
      return `${at} ${issue.message}`;
  }
}

/** 解析模型输出的 slide deck；形状不对返回中文错误（供模型修） */
export function parseSlideDeck(
  raw: unknown,
): { ok: true; deck: SlideDeck } | { ok: false; error: string } {
  const parsed = slideDeckSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return { ok: false, error: "slide deck 不合法：未知错误" };
    return { ok: false, error: `slide deck 不合法${friendlyIssue(issue)}` };
  }
  return { ok: true, deck: parsed.data };
}

// ── 软闸：设计法则检查（照抄上游 Pre-Output Checklist） ──────

const MAX_WARNINGS = 50;
const LATEX_IN_TEXT_RE =
  /\\(frac|lim|int|sum|sqrt|prod|alpha|beta|gamma|pi|theta|partial|infty|cdot|times|leq|geq|neq)|\^|_\{/;

/** 取一段 HTML 里出现过的最大字号（px）；没有显式字号返回 undefined */
function maxFontSizeIn(html: string): number | undefined {
  let max: number | undefined;
  for (const m of html.matchAll(/font-size\s*:\s*(\d{1,3})(?:\.\d+)?px/gi)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && (max === undefined || v > max)) max = v;
  }
  return max;
}

/** 估算一段 HTML 的折行数（每个块级标签一段，超宽按字符数折行） */
function estimateLines(html: string, charsPerLine: number): number {
  const nodes = parseHtml(html);
  let lines = 0;
  const walk = (list: typeof nodes) => {
    for (const n of list) {
      if (n.type === "text") {
        const chars = n.content.replace(/\s+/g, " ").trim().length;
        if (chars > 0) lines += Math.max(1, Math.ceil(chars / Math.max(1, charsPerLine)));
        continue;
      }
      if (n.type === "comment") continue;
      if (n.tag === "br") {
        lines += 1;
        continue;
      }
      if (n.tag === "p" || n.tag === "div" || n.tag === "li") lines += 1;
      walk(n.children);
    }
  };
  walk(nodes);
  return Math.max(1, lines);
}

function heightTableCheck(size: number, lines: number): { ok: boolean; expect: number } {
  const row = TEXT_HEIGHT_TABLE[size];
  if (!row) return { ok: true, expect: 0 }; // 非阶梯字号不强求
  const clamped = Math.min(Math.max(1, Math.round(lines)), 5);
  return { ok: false, expect: row[clamped - 1] ?? row[4] };
}

/**
 * 软性检查：把上游的 P0/P1 检查单程序化。返回中文警告列表（截断到
 * MAX_WARNINGS）。警告不拦截落盘，但模型应当先改干净。
 */
export function checkSlideDeck(deck: SlideDeck): string[] {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(msg);
  };

  deck.slides.forEach((slide, si) => {
    const page = `第 ${si + 1} 页`;
    if (slide.elements.length === 0) warn(`${page}没有任何元素：空白页删掉或补内容`);

    slide.elements.forEach((el, ei) => {
      const at = `${page} ${el.type}#${ei + 1}`;
      const range = elementRange(el as Parameters<typeof elementRange>[0]);
      if (
        range.minX < CANVAS_MARGIN ||
        range.minY < CANVAS_MARGIN ||
        range.maxX > CANVAS_W - CANVAS_MARGIN ||
        range.maxY > CANVAS_H - CANVAS_MARGIN
      ) {
        warn(
          `${at}超出 ${CANVAS_MARGIN}px 安全边距：left=${Math.round(range.minX)} top=${Math.round(range.minY)} right=${Math.round(range.maxX)} bottom=${Math.round(range.maxY)}（画布 ${CANVAS_W}×${CANVAS_H}）`,
        );
      }

      if (el.type === "text") {
        if (LATEX_IN_TEXT_RE.test(el.content)) {
          warn(`${at}的文本里出现 LaTeX 语法：公式必须单独用 latex 元素，文本里会原样显示反斜杠`);
        }
        const size = maxFontSizeIn(el.content) ?? 16;
        if (size < 12) warn(`${at}字号 ${size}px 小于 12px：这是内容放多了，删词，不要继续缩字号`);
        const charsPerLine = Math.max(1, (el.width - 20) / size);
        const lines = estimateLines(el.content, charsPerLine);
        const { expect } = heightTableCheck(size, lines);
        if (expect > 0 && Math.abs(el.height - expect) > 0.5) {
          warn(
            `${at}高度 ${el.height} 不在高度查表：${size}px × ${lines} 行应为 ${expect}（改高度或删词）`,
          );
        }
      }

      if (el.type === "line") {
        if (el.width > 6) {
          warn(
            `${at}线宽 ${el.width} 超过 6：line 的 width 是描边粗细不是长度（2-6），长度由 start/end 决定`,
          );
        }
        const span = Math.hypot(el.end[0] - el.start[0], el.end[1] - el.start[1]);
        if (el.width > 6 && Math.abs(el.width - span) < 2) {
          warn(
            `${at}线宽 ${el.width} ≈ 起终点距离 ${Math.round(span)}：你把线宽当成长度写了，width 只能是 2-6`,
          );
        }
      }

      if (el.type === "shape") {
        if (svgPathToPoints(el.path).length === 0) {
          warn(
            `${at}的 path 解析失败（${el.path.slice(0, 40)}…）：该形状不会渲染，检查 SVG path 语法`,
          );
        }
      }

      if (el.type === "chart") {
        const labelCount = el.data.labels.length;
        el.data.series.forEach((s, i) => {
          if (s.length !== labelCount) {
            warn(
              `${at}的 series[${i}] 有 ${s.length} 个点，但 labels 只有 ${labelCount} 个：对不上会错位`,
            );
          }
        });
      }

      if (el.type === "table") {
        const sum = el.colWidths.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > 0.02) {
          warn(`${at}的 colWidths 总和是 ${sum.toFixed(2)} 不是 1：列宽是按占比算的`);
        }
        const widest = Math.max(...el.data.map((r) => r.length));
        if (el.colWidths.length !== widest) {
          warn(`${at}的 colWidths 有 ${el.colWidths.length} 列，数据最宽行有 ${widest} 列`);
        }
        for (const row of el.data) {
          for (const cell of row) {
            if (LATEX_IN_TEXT_RE.test(cell.text)) {
              warn(`${at}的单元格里出现 LaTeX 语法：表格单元格只放纯文本，公式单独用 latex 元素`);
            }
          }
        }
      }

      if (el.type === "code") {
        const size = el.fontSize ?? 14;
        const need = 32 + el.lines.length * size * 1.5;
        if (el.height < need) {
          warn(
            `${at}高度 ${el.height} 不够：代码块要 32px 标题栏 + 每行 ${size * 1.5}px，至少 ${Math.ceil(need)}px`,
          );
        }
      }
    });
  });

  return warnings;
}
