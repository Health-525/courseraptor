/**
 * slide deck → .pptx 渲染器（照抄 OpenMAIC 的 use-export-pptx.ts 映射，
 * MIT / THU-MAIC，适配「纸墨朱砂」品牌）。
 *
 * 与上游导出器的对应关系：
 * - 元素逐个映射：text → addText(runs)、shape/line → addShape("custGeom",
 *   points)、chart → addChart、table → addTable(colW/colspan/theme)、
 *   latex → addFormula 同款 OMML（上游是 pptxgenjs fork，这里是 zip
 *   后处理注入，块结构照抄其 gen-xml）、code → 卡片（上游只做屏幕渲染，
 *   导出侧按同一视觉用 rect + 等宽文本拼）；
 * - 坐标换算：DSL 是 1000×562.5 px，÷100 得英寸、×0.75 得磅，全部在
 *   这里发生——模型面对的画布数字与上游完全一致；
 * - 品牌差异（有意为之）：不挂母版，每页按 DSL background 上底色；页脚
 *   （细线 + COURSERAPTOR + 页码 + 落款 logo）与印章 motif 由 motif
 *   字段驱动，深色底自动换浅色——签名 motif 不断档；
 * - image / video / audio 元素本管线不产出（无媒体源），遇到即跳过。
 */

import { createRequire } from "node:module";
import { CANVAS_H, CANVAS_W, type DeckElement, type DeckSlide, type SlideDeck } from "./ppt-dsl";
import { htmlToPlainText, htmlToRuns } from "./ppt-html";
import { latexToOmml } from "./ppt-latex";
import {
  elementRange,
  expandChartColors,
  lineElementPath,
  luminance,
  mixColors,
  parseColor,
  svgPathToPoints,
} from "./ppt-svg";
import {
  addSeal,
  dedupeMedia,
  newPptxDeck,
  PPT_THEME,
  type PptxDeck,
  type PptxSlide,
} from "./pptx-theme";

const require = createRequire(import.meta.url);
const requireAny = require as unknown as (id: string) => unknown;

/** 1000px 画布 = 10 英寸；1px = 0.75pt（96dpi） */
const INCH_PER_PX = 0.01;
const PT_PER_PX = 0.75;

/** 统一中文字体（与 spec 路径同款；上游默认也是 Microsoft YaHei） */
const FONT = "Microsoft YaHei";
const FONT_MONO = "Consolas";
/** 公式回退文本的字色（OMML 转换失败时） */
const INK = PPT_THEME.ink;

// ── pptxgenjs points（custGeom 用，单位英寸） ─────────────────

type PptPoint =
  | { x: number; y: number; moveTo?: boolean }
  | {
      x: number;
      y: number;
      curve:
        | { type: "cubic"; x1: number; y1: number; x2: number; y2: number }
        | { type: "quadratic"; x1: number; y1: number };
    }
  | { close: true };

/** viewBox 坐标的点 → 英寸（按 viewBox→元素框的缩放） */
function pointsToInches(
  points: ReturnType<typeof svgPathToPoints>,
  scale: { x: number; y: number },
  origin = { x: 0, y: 0 },
): PptPoint[] {
  return points.map((p) => {
    if ("close" in p) return { close: true };
    const x = (p.x - origin.x) * scale.x * INCH_PER_PX;
    const y = (p.y - origin.y) * scale.y * INCH_PER_PX;
    if ("curve" in p) {
      if (p.curve.type === "cubic") {
        return {
          x,
          y,
          curve: {
            type: "cubic" as const,
            x1: (p.curve.x1 - origin.x) * scale.x * INCH_PER_PX,
            y1: (p.curve.y1 - origin.y) * scale.y * INCH_PER_PX,
            x2: (p.curve.x2 - origin.x) * scale.x * INCH_PER_PX,
            y2: (p.curve.y2 - origin.y) * scale.y * INCH_PER_PX,
          },
        };
      }
      return {
        x,
        y,
        curve: {
          type: "quadratic" as const,
          x1: (p.curve.x1 - origin.x) * scale.x * INCH_PER_PX,
          y1: (p.curve.y1 - origin.y) * scale.y * INCH_PER_PX,
        },
      };
    }
    return { x, y, moveTo: p.type === "M" };
  });
}

// ── 阴影 / 边框选项 ──────────────────────────────────────────

function shadowOption(shadow: {
  h: number;
  v: number;
  blur: number;
  color: string;
}): Record<string, unknown> {
  const c = parseColor(shadow.color) ?? { hex: "000000", alpha: 1 };
  const { h, v } = shadow;
  let offset = 4;
  let angle = 45;
  if (h === 0 && v === 0) {
    offset = 4;
    angle = 45;
  } else if (h === 0) {
    offset = Math.abs(v);
    angle = v > 0 ? 90 : 270;
  } else if (v === 0) {
    offset = Math.abs(h);
    angle = h > 0 ? 1 : 180;
  } else if (h > 0 && v > 0) {
    offset = Math.max(h, v);
    angle = 45;
  } else if (h > 0 && v < 0) {
    offset = Math.max(h, -v);
    angle = 315;
  } else if (h < 0 && v > 0) {
    offset = Math.max(-h, v);
    angle = 135;
  } else {
    offset = Math.max(-h, -v);
    angle = 225;
  }
  return {
    type: "outer",
    color: c.hex,
    opacity: c.alpha,
    blur: shadow.blur * PT_PER_PX,
    offset: offset * PT_PER_PX,
    angle,
  };
}

const DASH_MAP: Record<string, string> = {
  solid: "solid",
  dashed: "dash",
  dotted: "sysDot",
};

function outlineOption(outline: {
  style?: string;
  width?: number;
  color?: string;
}): Record<string, unknown> {
  const c = parseColor(outline.color ?? "#000000") ?? { hex: "000000", alpha: 1 };
  return {
    color: c.hex,
    transparency: (1 - c.alpha) * 100,
    width: (outline.width ?? 1) * PT_PER_PX,
    dashType: outline.style ? DASH_MAP[outline.style] : "solid",
  };
}

/** 颜色字符串（DSL 里已归一为 #RRGGBB）→ pptxgenjs 的 {color, transparency} */
function fillOption(color: string | undefined, opacity = 1): Record<string, unknown> {
  const c = color ? parseColor(color) : null;
  if (!c) return { type: "none" };
  return { color: c.hex, transparency: (1 - c.alpha * opacity) * 100 };
}

// ── 品牌页脚 / 印章 ──────────────────────────────────────────

/**
 * 每页的品牌 chrome，由 motif 驱动（对齐旧三张母版的视觉）：
 * - cover：朱砂大印章居中页头，无页脚无页码（旧封面母版）；
 * - section：右下角小印章 + 浅色页码（旧章节母版）；
 * - plain：页脚细线 + COURSERAPTOR + 落款 logo + 页码（旧内容母版）；
 * 深色底（亮度 < 0.4）自动把页脚换成浅色、给 logo 加纸色圆托。
 */
function addBrandChrome(
  slide: PptxSlide,
  s: DeckSlide,
  index: number,
  logo: string | null,
  bgHex: string,
): void {
  const dark = luminance(bgHex) < 0.4;
  const motif = s.motif ?? "plain";
  if (motif === "cover") {
    if (logo) addSeal(slide, 5, 1.08, 1.24, logo, PPT_THEME.onAccent, PPT_THEME.accent);
    return;
  }
  if (motif === "section") {
    if (logo) addSeal(slide, 9.06, 4.98, 0.52, logo, PPT_THEME.onAccent, PPT_THEME.accent);
    slide.addText(String(index + 1), {
      x: 8.4,
      y: 5.36,
      w: 0.5,
      h: 0.22,
      fontSize: 9,
      color: PPT_THEME.onAccentDim,
      align: "right",
      fontFace: FONT,
      margin: 0,
    });
    return;
  }
  const ruleColor = dark ? PPT_THEME.accentDeep : PPT_THEME.rule;
  const footColor = dark ? PPT_THEME.onAccentDim : PPT_THEME.ink3;
  slide.addShape("rect", {
    x: 0.55,
    y: 5.33,
    w: 8.4,
    h: 0.008,
    fill: { color: ruleColor },
  });
  slide.addText("COURSERAPTOR", {
    x: 0.55,
    y: 5.36,
    w: 2.6,
    h: 0.22,
    fontSize: 8.5,
    charSpacing: 2,
    color: footColor,
    fontFace: FONT,
    margin: 0,
  });
  if (logo) {
    if (dark) {
      // 深色底上的浅色圆托：印章落款不消失
      slide.addShape("ellipse", {
        x: 9.14,
        y: 5.1,
        w: 0.34,
        h: 0.34,
        fill: { color: PPT_THEME.paper },
      });
    }
    slide.addImage({ data: logo, x: 9.18, y: 5.14, w: 0.26, h: 0.26, rounding: true });
  }
  slide.addText(String(index + 1), {
    x: 8.55,
    y: 5.36,
    w: 0.45,
    h: 0.22,
    fontSize: 9,
    color: footColor,
    align: "right",
    fontFace: FONT,
    margin: 0,
  });
}

// ── 公式注入（zip 后处理） ───────────────────────────────────

interface FormulaPatch {
  slideIndex: number;
  /** 占位文本里的唯一标记（私用区字符，不会与内容撞号） */
  marker: string;
  omml: string;
  fontSize: number;
  align: "left" | "center" | "right";
}

/**
 * 公式的 slide XML 块（照抄上游 gen-xml 的 formula 分支）：现代
 * PowerPoint 走 mc:Choice 里的 a14:m OMML（可编辑公式），旧版走
 * mc:Fallback 的 [Formula] 文本。命名空间内联声明——pptxgenjs 的
 * slide 根只声明 a/r/p，a14/mc/m 由本块自带。
 */
function formulaBlock(p: FormulaPatch, xfrm: string): string {
  const sz = Math.round(p.fontSize * 100);
  const jc = p.align === "left" ? "l" : p.align === "right" ? "r" : "ctr";
  const sp = (inner: string) =>
    `<p:sp> <p:nvSpPr> <p:cNvPr id="9001" name="Formula"/> <p:cNvSpPr/> <p:nvPr/> </p:nvSpPr> <p:spPr> ${xfrm} <a:prstGeom prst="rect"><a:avLst/></a:prstGeom> </p:spPr> <p:txBody> <a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr> <a:lstStyle/> <a:p>${inner}</a:p> </p:txBody> </p:sp>`;
  const choiceInner =
    `   <a:pPr><a:defRPr sz="${sz}"/></a:pPr>` +
    `   <a14:m>` +
    `    <m:oMathPara>` +
    `     <m:oMathParaPr><m:jc m:val="${jc}"/></m:oMathParaPr>` +
    `     ${p.omml}` +
    `    </m:oMathPara>` +
    `   </a14:m>`;
  const fallbackInner = `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>[公式]</a:t></a:r>`;
  return (
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
    `xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" ` +
    `xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">` +
    `<mc:Choice Requires="a14">${sp(choiceInner)}</mc:Choice>` +
    `<mc:Fallback>${sp(fallbackInner)}</mc:Fallback>` +
    `</mc:AlternateContent>`
  );
}

/** 把含标记的占位 <p:sp> 整块替换成公式块（xfrm 从占位块里原样搬过来） */
function injectFormula(xml: string, p: FormulaPatch): string {
  const spRe = new RegExp(`<p:sp>(?:(?!</?p:sp>)[\\s\\S])*?${p.marker}[\\s\\S]*?</p:sp>`);
  const m = spRe.exec(xml);
  if (!m) return xml;
  const xfrm = /<a:xfrm>[\s\S]*?<\/a:xfrm>/.exec(m[0])?.[0] ?? "";
  return xml.replace(m[0], () => formulaBlock(p, xfrm));
}

// ── 元素渲染 ─────────────────────────────────────────────────

function addTextElement(slide: PptxSlide, el: Extract<DeckElement, { type: "text" }>): void {
  const runs = htmlToRuns(el.content);
  const options: Record<string, unknown> = {
    x: el.left * INCH_PER_PX,
    y: el.top * INCH_PER_PX,
    w: el.width * INCH_PER_PX,
    h: el.height * INCH_PER_PX,
    fontSize: 16 * PT_PER_PX,
    fontFace: el.defaultFontName || FONT,
    color: (el.defaultColor ?? `#${INK}`).replace("#", ""),
    valign: el.vAlign ?? "top",
    margin: 10 * PT_PER_PX,
    paraSpaceBefore: 5 * PT_PER_PX,
    lineSpacingMultiple: (el.lineHeight ?? 1.5) / 1.25,
    autoFit: true,
  };
  if (el.rotate !== undefined) options.rotate = el.rotate;
  if (el.wordSpace) options.charSpacing = el.wordSpace * PT_PER_PX;
  if (el.paragraphSpace !== undefined) options.paraSpaceBefore = el.paragraphSpace * PT_PER_PX;
  if (el.fill) options.fill = fillOption(el.fill, el.opacity ?? 1);
  if (el.opacity !== undefined) options.transparency = (1 - el.opacity) * 100;
  if (el.shadow) options.shadow = shadowOption(el.shadow);
  if (el.outline?.width) options.line = outlineOption(el.outline);
  slide.addText(
    runs.map((r) => ({ text: r.text, options: runToPptOptions(r) })),
    options,
  );
}

function runToPptOptions(r: ReturnType<typeof htmlToRuns>[number]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (r.breakLine) o.breakLine = true;
  if (r.fontSize !== undefined) o.fontSize = r.fontSize;
  if (r.color) o.color = r.color;
  if (r.bold) o.bold = true;
  if (r.italic) o.italic = true;
  if (r.underline) o.underline = { color: r.color ?? "000000", style: "sng" };
  if (r.strike) o.strike = "sngStrike";
  if (r.superscript) o.superscript = true;
  if (r.subscript) o.subscript = true;
  if (r.align) o.align = r.align;
  if (r.fontFace) o.fontFace = r.fontFace;
  if (r.highlight) o.highlight = r.highlight;
  if (r.charSpacing !== undefined) o.charSpacing = r.charSpacing;
  return o;
}

function addShapeElement(slide: PptxSlide, el: Extract<DeckElement, { type: "shape" }>): void {
  const raw = svgPathToPoints(el.path);
  if (raw.length === 0) return; // 畸形路径：跳过（软警告已提示模型）
  const scale = { x: el.width / el.viewBox[0], y: el.height / el.viewBox[1] };
  const points = pointsToInches(raw, scale);

  let fill = el.fill ? parseColor(el.fill) : null;
  if (el.gradient && el.gradient.colors.length >= 2) {
    const stops = el.gradient.colors;
    const first = parseColor(stops[0]?.color ?? "");
    const last = parseColor(stops[stops.length - 1]?.color ?? "");
    if (first && last) fill = mixColors(first, last);
  }
  const shapeOptions: Record<string, unknown> = {
    x: el.left * INCH_PER_PX,
    y: el.top * INCH_PER_PX,
    w: el.width * INCH_PER_PX,
    h: el.height * INCH_PER_PX,
    fill: fill ? fillOption(`#${fill.hex}`, el.opacity ?? 1) : { type: "none" },
    points,
  };
  if (el.rotate !== undefined) shapeOptions.rotate = el.rotate;
  if (el.flipH) shapeOptions.flipH = true;
  if (el.flipV) shapeOptions.flipV = true;
  if (el.shadow) shapeOptions.shadow = shadowOption(el.shadow);
  if (el.outline?.width) shapeOptions.line = outlineOption(el.outline);
  slide.addShape("custGeom", shapeOptions);

  // 形状内文本：与形状同框，垂直对齐（照抄上游的 overlay 语义）
  if (el.text) {
    const runs = htmlToRuns(el.text.content);
    slide.addText(
      runs.map((r) => ({ text: r.text, options: runToPptOptions(r) })),
      {
        x: el.left * INCH_PER_PX,
        y: el.top * INCH_PER_PX,
        w: el.width * INCH_PER_PX,
        h: el.height * INCH_PER_PX,
        fontSize: 16 * PT_PER_PX,
        fontFace: el.text.defaultFontName || FONT,
        color: (el.text.defaultColor ?? `#${INK}`).replace("#", ""),
        valign: el.text.align ?? "middle",
        margin: 10 * PT_PER_PX,
        paraSpaceBefore: 5 * PT_PER_PX,
        lineSpacingMultiple: 1.2,
        ...(el.rotate !== undefined ? { rotate: el.rotate } : {}),
      },
    );
  }
}

function addLineElement(slide: PptxSlide, el: Extract<DeckElement, { type: "line" }>): void {
  const path = lineElementPath(el);
  const raw = svgPathToPoints(path);
  if (raw.length === 0) return;
  const range = elementRange(el);
  // custGeom 的 points 相对自身包围盒原点（包围盒未必从 left/top 起算）
  const points = pointsToInches(
    raw,
    { x: 1, y: 1 },
    { x: range.minX - el.left, y: range.minY - el.top },
  );
  const c = parseColor(el.color ?? `#${INK}`) ?? { hex: INK, alpha: 1 };
  const marker = (v: "" | "arrow" | "dot") =>
    v === "arrow" ? "arrow" : v === "dot" ? "oval" : "none";
  const lineOptions: Record<string, unknown> = {
    x: range.minX * INCH_PER_PX,
    y: range.minY * INCH_PER_PX,
    w: (range.maxX - range.minX) * INCH_PER_PX,
    h: (range.maxY - range.minY) * INCH_PER_PX,
    line: {
      color: c.hex,
      transparency: (1 - c.alpha) * 100,
      width: el.width * PT_PER_PX,
      dashType: DASH_MAP[el.style ?? "solid"] ?? "solid",
      beginArrowType: marker(el.points?.[0] ?? ""),
      endArrowType: marker(el.points?.[1] ?? ""),
    },
    points,
  };
  if (el.shadow) lineOptions.shadow = shadowOption(el.shadow);
  slide.addShape("custGeom", lineOptions);
}

function addChartElement(slide: PptxSlide, el: Extract<DeckElement, { type: "chart" }>): void {
  const chartData = el.data.series.map((values, i) => ({
    name: el.data.legends[i] ?? `Series ${i + 1}`,
    labels: el.data.labels,
    values,
  }));
  const seriesCount = el.data.series.length;
  // 饼/环一色一分类，其余一色一系列（照抄上游的取色规则）
  const colorCount =
    el.chartType === "pie" || el.chartType === "ring" ? el.data.labels.length : seriesCount;
  const chartColors = expandChartColors(el.themeColors, colorCount);
  const textColor = (el.textColor ? parseColor(el.textColor) : null)?.hex ?? INK;

  const chartOptions: Record<string, unknown> = {
    x: el.left * INCH_PER_PX,
    y: el.top * INCH_PER_PX,
    w: el.width * INCH_PER_PX,
    h: el.height * INCH_PER_PX,
    chartColors,
    catAxisLabelColor: textColor,
    valAxisLabelColor: textColor,
    catAxisLabelFontSize: 14 * PT_PER_PX,
    valAxisLabelFontSize: 14 * PT_PER_PX,
  };
  if (el.fill) chartOptions.plotArea = { fill: { color: parseColor(el.fill)?.hex } };
  if (el.outline?.width) {
    chartOptions.plotArea = {
      ...(chartOptions.plotArea as object),
      border: { pt: el.outline.width * PT_PER_PX, color: parseColor(el.outline.color ?? "")?.hex },
    };
  }
  if (seriesCount > 1 || el.chartType === "pie" || el.chartType === "ring") {
    chartOptions.showLegend = true;
    chartOptions.legendPos = "b";
    chartOptions.legendColor = textColor;
    chartOptions.legendFontSize = 14 * PT_PER_PX;
  }

  let type = "bar";
  if (el.chartType === "bar") {
    type = "bar";
    chartOptions.barDir = "col";
    if (el.options?.stack) chartOptions.barGrouping = "stacked";
  } else if (el.chartType === "column") {
    type = "bar";
    chartOptions.barDir = "bar";
    if (el.options?.stack) chartOptions.barGrouping = "stacked";
  } else if (el.chartType === "line") {
    type = "line";
    if (el.options?.lineSmooth) chartOptions.lineSmooth = true;
  } else if (el.chartType === "area") type = "area";
  else if (el.chartType === "radar") type = "radar";
  else if (el.chartType === "scatter") {
    type = "scatter";
    chartOptions.lineSize = 0;
  } else if (el.chartType === "pie") type = "pie";
  else if (el.chartType === "ring") {
    type = "doughnut";
    chartOptions.holeSize = 60;
  }
  slide.addChart(type, chartData, chartOptions);
}

function addTableElement(slide: PptxSlide, el: Extract<DeckElement, { type: "table" }>): void {
  // 合并单元格：被 colspan/rowspan 覆盖的格子不推送（上游同款处理）
  const hidden = new Set<string>();
  el.data.forEach((row, i) => {
    row.forEach((cell, j) => {
      if (cell.colspan > 1 || cell.rowspan > 1) {
        for (let r = i; r < i + cell.rowspan; r++) {
          for (let c = r === i ? j + 1 : j; c < j + cell.colspan; c++) hidden.add(`${r}_${c}`);
        }
      }
    });
  });

  const theme = el.theme;
  const themeColor = theme ? parseColor(theme.color) : null;
  const subColors = themeColor
    ? [
        { hex: themeColor.hex, alpha: 0.3 },
        { hex: themeColor.hex, alpha: 0.1 },
      ]
    : [];

  const rows = el.data.map((row, i) => {
    const out: Array<{ text: string; options: Record<string, unknown> }> = [];
    row.forEach((cell, j) => {
      if (hidden.has(`${i}_${j}`)) return;
      const style = cell.style ?? {};
      const options: Record<string, unknown> = {
        colspan: cell.colspan,
        rowspan: cell.rowspan,
        bold: style.bold ?? false,
        italic: style.em ?? false,
        underline: { style: style.underline ? "sng" : "none" },
        align: style.align ?? "left",
        valign: "middle",
        fontFace: style.fontname || FONT,
        fontSize: (Number(style.fontsize) || 14) * PT_PER_PX,
      };
      if (theme && themeColor) {
        // 斑马纹：偶数行浅、奇数行深；表头/表尾/首列/末列上主题色
        let c = i % 2 === 0 ? subColors[1] : subColors[0];
        if (theme.rowHeader && i === 0) c = themeColor;
        else if (theme.rowFooter && i === el.data.length - 1) c = themeColor;
        else if (theme.colHeader && j === 0) c = themeColor;
        else if (theme.colFooter && j === row.length - 1) c = themeColor;
        if (c) options.fill = { color: c.hex, transparency: (1 - c.alpha) * 100 };
      }
      if (style.backcolor) options.fill = fillOption(style.backcolor);
      if (style.color) options.color = parseColor(style.color)?.hex;
      if (style.strikethrough) options.strike = "sngStrike";
      out.push({ text: htmlToPlainText(cell.text), options });
    });
    return out;
  });

  const tableOptions: Record<string, unknown> = {
    x: el.left * INCH_PER_PX,
    y: el.top * INCH_PER_PX,
    w: el.width * INCH_PER_PX,
    h: el.height * INCH_PER_PX,
    colW: el.colWidths.map((ratio) => el.width * ratio * INCH_PER_PX),
    valign: "middle",
    autoPage: false,
  };
  if (el.outline?.width && el.outline.color) {
    tableOptions.border = {
      type: el.outline.style === "solid" ? "solid" : "dash",
      pt: el.outline.width * PT_PER_PX,
      color: parseColor(el.outline.color)?.hex,
    };
  }
  slide.addTable(rows, tableOptions);
}

function addLatexElement(
  slide: PptxSlide,
  el: Extract<DeckElement, { type: "latex" }>,
  slideIndex: number,
  patches: FormulaPatch[],
  bgHex: string,
): void {
  // 行数由 \\ 断行估算；渲染高度 ≈ 行数 × 1.5 × 字号 → 反推字号（上游同款）
  const lineBreaks = (el.latex.match(/\\\\/g) || []).length;
  const lines = lineBreaks + 1;
  const boxHeightPt = el.height / PT_PER_PX;
  const fontSize = Math.max(6, Math.round(boxHeightPt / (lines * 3)));
  const align = el.align ?? "center";
  const omml = latexToOmml(el.latex, fontSize);
  const box = {
    x: el.left * INCH_PER_PX,
    y: el.top * INCH_PER_PX,
    w: el.width * INCH_PER_PX,
    h: el.height * INCH_PER_PX,
    align,
    margin: 0,
  };
  if (omml) {
    // 占位文本（与背景同色、1pt，注入失败也看不见），zip 后处理整块替换
    const marker = `\uE000f${patches.length}\uE001`;
    patches.push({ slideIndex, marker, omml, fontSize, align });
    slide.addText(marker, { ...box, fontSize: 1, color: bgHex.replace("#", ""), fontFace: FONT });
  } else {
    // OMML 转换失败：降级为等宽纯文本（公式源码可读，不破坏文件）
    slide.addText(el.latex, {
      ...box,
      fontSize: Math.min(24, fontSize),
      color: INK,
      fontFace: FONT_MONO,
      valign: "middle",
    });
  }
}

function addCodeElement(slide: PptxSlide, el: Extract<DeckElement, { type: "code" }>): void {
  const size = el.fontSize ?? 14;
  const headerH = 32; // px，标题栏高度（照上游「fixed light card」视觉）
  const lineH = size * 1.5;
  const x = el.left * INCH_PER_PX;
  const y = el.top * INCH_PER_PX;
  const w = el.width * INCH_PER_PX;
  const h = el.height * INCH_PER_PX;

  // 卡片：纸底 + 细 rule 边（浅色卡，不随页面深浅主题化——上游同款）
  slide.addShape("rect", {
    x,
    y,
    w,
    h,
    fill: { color: PPT_THEME.paper },
    line: { color: PPT_THEME.rule, width: 1 * PT_PER_PX },
  });
  if (el.fileName || el.language) {
    slide.addShape("rect", {
      x,
      y,
      w,
      h: headerH * INCH_PER_PX,
      fill: { color: PPT_THEME.paperDeep },
    });
    slide.addShape("line", {
      x,
      y: (headerH - 1) * INCH_PER_PX,
      w,
      h: 0.008,
      line: { color: PPT_THEME.rule, width: 1 },
    });
    slide.addText(el.fileName || el.language || "", {
      x: x + 8 * INCH_PER_PX,
      y: y + 4 * INCH_PER_PX,
      w: w - 16 * INCH_PER_PX,
      h: 24 * INCH_PER_PX,
      fontSize: 12 * PT_PER_PX,
      color: PPT_THEME.ink2,
      fontFace: FONT,
      margin: 0,
      valign: "middle",
    });
  }
  const startY = y + (el.fileName || el.language ? headerH : 8) * INCH_PER_PX;
  const numW = el.showLineNumbers === false ? 0 : 28;
  el.lines.forEach((line, i) => {
    const ly = startY + i * lineH * INCH_PER_PX;
    if (numW > 0) {
      slide.addText(String(i + 1), {
        x: x + 8 * INCH_PER_PX,
        y: ly,
        w: numW * INCH_PER_PX,
        h: lineH * INCH_PER_PX,
        fontSize: size * PT_PER_PX * 0.85,
        color: PPT_THEME.ink3,
        fontFace: FONT_MONO,
        align: "right",
        margin: 0,
        valign: "middle",
      });
    }
    slide.addText(line.content, {
      x: x + (8 + numW + 8) * INCH_PER_PX,
      y: ly,
      w: w - (16 + numW + 8) * INCH_PER_PX,
      h: lineH * INCH_PER_PX,
      fontSize: size * PT_PER_PX,
      color: PPT_THEME.ink,
      fontFace: FONT_MONO,
      margin: 0,
      valign: "middle",
      wrap: false,
    });
  });
}

// ── 单页 / 整册 ──────────────────────────────────────────────

function renderSlide(
  pptx: PptxDeck,
  s: DeckSlide,
  index: number,
  logo: string | null,
  patches: FormulaPatch[],
): void {
  const slide = pptx.addSlide();
  // 背景：solid 直接用；gradient 取首尾混色（pptx 背景只吃纯色）；缺省纸底
  let bgHex = `#${PPT_THEME.paper}`;
  if (s.background?.type === "solid") bgHex = s.background.color;
  else if (s.background?.type === "gradient" && s.background.gradient.colors.length >= 2) {
    const stops = s.background.gradient.colors;
    const first = parseColor(stops[0]?.color ?? "");
    const last = parseColor(stops[stops.length - 1]?.color ?? "");
    if (first && last) bgHex = `#${mixColors(first, last).hex}`;
  }
  slide.background = { color: bgHex.replace("#", "") };
  addBrandChrome(slide, s, index, logo, bgHex);

  for (const el of s.elements) {
    switch (el.type) {
      case "text":
        addTextElement(slide, el);
        break;
      case "shape":
        addShapeElement(slide, el);
        break;
      case "line":
        addLineElement(slide, el);
        break;
      case "chart":
        addChartElement(slide, el);
        break;
      case "table":
        addTableElement(slide, el);
        break;
      case "latex":
        addLatexElement(slide, el, index, patches, bgHex);
        break;
      case "code":
        addCodeElement(slide, el);
        break;
    }
  }
  if (s.notes) slide.addNotes(s.notes);
}

/** 整册渲染：deck → pptx 字节（含公式注入与媒体去重） */
export async function renderSlidesDeck(deck: SlideDeck): Promise<Buffer> {
  const { pptx, logo } = newPptxDeck();
  const patches: FormulaPatch[] = [];
  for (const [i, s] of deck.slides.entries()) renderSlide(pptx, s, i, logo, patches);
  const out = await pptx.write({ outputType: "nodebuffer" });
  const raw = Buffer.isBuffer(out) ? out : Buffer.from(new Uint8Array(out as ArrayBuffer));
  return finalizeDeck(raw, patches);
}

/** 收尾：公式注入（替换占位 sp）→ 媒体去重（印章 logo 合并） */
async function finalizeDeck(buf: Buffer, patches: FormulaPatch[]): Promise<Buffer> {
  let out = buf;
  if (patches.length > 0) {
    const JSZip = requireAny("jszip") as typeof import("jszip");
    const zip = await JSZip.loadAsync(buf);
    for (const p of patches) {
      const name = `ppt/slides/slide${p.slideIndex + 1}.xml`;
      const file = zip.file(name);
      if (!file) continue;
      const xml = injectFormula(await file.async("string"), p);
      zip.file(name, xml);
    }
    out = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  }
  return dedupeMedia(out);
}

/** 画布常量再导出（调用方少引一个模块） */
export { CANVAS_H, CANVAS_W };
