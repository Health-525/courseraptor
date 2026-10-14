/**
 * PPT 几何面：SVG 路径解析、线条路径生成、元素包围盒、颜色工具。
 *
 * 照抄 OpenMAIC 的 slide 几何管线（MIT / THU-MAIC）：
 * - `svgPathToPoints`：SVG path 的 d → pptxgenjs custGeom 的 points
 *   （圆弧经 svg-arc-to-cubic-bezier 转三次贝塞尔；S/T 简写命令不
 *   支持，畸形路径返回空数组由调用方跳过该元素——与上游同款防御）；
 * - `lineElementPath` / `elementRange`：线条元素的
 *   start/end + broken/broken2/curve/cubic → SVG path 与包围盒；
 * - 颜色工具：十六进制解析（含透明度）、渐变混色、图表色板的
 *   类似色扩展（tinycolor analogous 的轻量实现，不引依赖）。
 */

import arcToBezier from "svg-arc-to-cubic-bezier";
import { SVGPathData } from "svg-pathdata";

// ── SVG path → points ───────────────────────────────────────

export type SvgCurve =
  | { type: "cubic"; x1: number; y1: number; x2: number; y2: number }
  | { type: "quadratic"; x1: number; y1: number };

export type SvgPoint =
  | { x: number; y: number; type: "M" | "L" }
  | { x: number; y: number; curve: SvgCurve; type: "C" | "Q" }
  | { close: true; type: "Z" };

const SVG_TYPE_MAP: Record<number, string> = {
  1: "Z",
  2: "M",
  4: "H",
  8: "V",
  16: "L",
  32: "C",
  64: "S",
  128: "Q",
  256: "T",
  512: "A",
};

/**
 * 解析 SVG path 的 d 为点序列（绝对坐标，圆弧已转贝塞尔）。
 * 畸形路径返回 []——调用方跳过该元素，不让一页坏路径拖垮整份课件
 * （上游同款契约：LLM 偶尔会吐花路径）。
 */
export function svgPathToPoints(d: string): SvgPoint[] {
  let pathData: SVGPathData;
  try {
    pathData = new SVGPathData(d);
  } catch {
    return [];
  }
  const points: SvgPoint[] = [];
  for (const item of pathData.commands) {
    if (item.type === 2 || item.type === 16) {
      points.push({ x: item.x, y: item.y, type: SVG_TYPE_MAP[item.type] as "M" | "L" });
    } else if (item.type === 32) {
      points.push({
        x: item.x,
        y: item.y,
        curve: { type: "cubic", x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2 },
        type: "C",
      });
    } else if (item.type === 128) {
      points.push({
        x: item.x,
        y: item.y,
        curve: { type: "quadratic", x1: item.x1, y1: item.y1 },
        type: "Q",
      });
    } else if (item.type === 512) {
      const last = points[points.length - 1];
      // 圆弧前必须有点可依附；没有就跳过（保持「畸形路径不炸」契约）
      if (!last || "close" in last || !["M", "L", "Q", "C"].includes(last.type)) continue;
      const beziers = arcToBezier({
        px: last.x,
        py: last.y,
        cx: item.x,
        cy: item.y,
        rx: item.rX,
        ry: item.rY,
        xAxisRotation: item.xRot,
        largeArcFlag: Boolean(item.lArcFlag),
        sweepFlag: Boolean(item.sweepFlag),
      });
      for (const cb of beziers) {
        points.push({
          x: cb.x,
          y: cb.y,
          curve: { type: "cubic", x1: cb.x1, y1: cb.y1, x2: cb.x2, y2: cb.y2 },
          type: "C",
        });
      }
    } else if (item.type === 1) {
      points.push({ close: true, type: "Z" });
    }
    // H/V/S/T：上游同样不映射，静默跳过
  }
  return points;
}

/** SVG path 的包围盒（畸形路径返回全 0，调用方按空处理） */
export function svgPathRange(d: string): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const zero = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  try {
    const { minX, minY, maxX, maxY } = new SVGPathData(d).getBounds();
    if ([minX, minY, maxX, maxY].some((v) => v == null || !Number.isFinite(v))) return { ...zero };
    return { minX, minY, maxX, maxY };
  } catch {
    return { ...zero };
  }
}

// ── 线条元素几何 ────────────────────────────────────────────

/** 折线走向判定：保留上游的「端点偏移路由」规则（决定双折线的弯向） */
function isHorizontalElbow(start: [number, number], end: [number, number]): boolean {
  return Math.max(start[0], end[0]) >= Math.max(start[1], end[1]);
}

/** 线条元素 → SVG path 的 d（start/end 是相对 left/top 的局部坐标） */
export function lineElementPath(el: {
  start: [number, number];
  end: [number, number];
  broken?: [number, number];
  broken2?: [number, number];
  curve?: [number, number];
  cubic?: [[number, number], [number, number]];
}): string {
  const s = el.start;
  const e = el.end;
  const start = `${s[0]},${s[1]}`;
  const end = `${e[0]},${e[1]}`;
  if (el.broken) return `M${start} L${el.broken[0]},${el.broken[1]} L${end}`;
  if (el.broken2) {
    if (isHorizontalElbow(s, e))
      return `M${start} L${el.broken2[0]},${s[1]} L${el.broken2[0]},${e[1]} ${end}`;
    return `M${start} L${s[0]},${el.broken2[1]} L${e[0]},${el.broken2[1]} ${end}`;
  }
  if (el.curve) return `M${start} Q${el.curve[0]},${el.curve[1]} ${end}`;
  if (el.cubic)
    return `M${start} C${el.cubic[0][0]},${el.cubic[0][1]} ${el.cubic[1][0]},${el.cubic[1][1]} ${end}`;
  return `M${start} L${end}`;
}

/** 元素包围盒（线条算控制点，矩形算旋转外扩） */
export function elementRange(el: {
  type: string;
  left: number;
  top: number;
  width: number;
  height?: number;
  rotate?: number;
  start?: [number, number];
  end?: [number, number];
  broken?: [number, number];
  broken2?: [number, number];
  curve?: [number, number];
  cubic?: [[number, number], [number, number]];
}): { minX: number; maxX: number; minY: number; maxY: number } {
  if (el.type === "line" && el.start && el.end) {
    const xs = [el.start[0], el.end[0]];
    const ys = [el.start[1], el.end[1]];
    if (el.broken) {
      xs.push(el.broken[0]);
      ys.push(el.broken[1]);
    } else if (el.broken2) {
      if (isHorizontalElbow(el.start, el.end)) xs.push(el.broken2[0]);
      else ys.push(el.broken2[1]);
    } else if (el.curve) {
      xs.push(el.curve[0]);
      ys.push(el.curve[1]);
    } else if (el.cubic) {
      xs.push(el.cubic[0][0], el.cubic[1][0]);
      ys.push(el.cubic[0][1], el.cubic[1][1]);
    }
    return {
      minX: el.left + Math.min(...xs),
      maxX: el.left + Math.max(...xs),
      minY: el.top + Math.min(...ys),
      maxY: el.top + Math.max(...ys),
    };
  }
  if (el.rotate) {
    const { left, top, width, height = 0, rotate } = el;
    const radius = Math.sqrt(width * width + height * height) / 2;
    const aux = (Math.atan(height / width) * 180) / Math.PI;
    const r1 = ((180 - rotate - aux) * Math.PI) / 180;
    const r2 = ((aux - rotate) * Math.PI) / 180;
    const mx = left + width / 2;
    const my = top + height / 2;
    const xs = [
      mx + radius * Math.cos(r1),
      mx + radius * Math.cos(r2),
      mx - radius * Math.cos(r1),
      mx - radius * Math.cos(r2),
    ];
    const ys = [
      my - radius * Math.sin(r1),
      my - radius * Math.sin(r2),
      my + radius * Math.sin(r1),
      my + radius * Math.sin(r2),
    ];
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }
  return {
    minX: el.left,
    maxX: el.left + el.width,
    minY: el.top,
    maxY: el.top + (el.height ?? 0),
  };
}

// ── 颜色工具 ────────────────────────────────────────────────

export interface ParsedColor {
  /** RRGGBB（大写，无 #） */
  hex: string;
  /** 0..1 */
  alpha: number;
}

/**
 * 解析颜色字符串：主题色名（纸墨朱砂色板）/ #RGB / #RRGGBB / #RRGGBBAA /
 * 裸 RRGGBB / 裸 RRGGBBAA。取不到返回 null。
 */
const THEME_COLORS: Record<string, string> = {
  paper: "FDFCF9",
  paperDeep: "F0EDE4",
  ink: "25221C",
  ink2: "5A554A",
  ink3: "6E6656",
  accent: "AD392C",
  accentDeep: "852B22",
  rule: "E1DCCF",
  onAccent: "FDFCF9",
  onAccentDim: "E9C8C2",
};

export function parseColor(value: string): ParsedColor | null {
  const v = value.trim();
  const named = THEME_COLORS[v];
  if (named) return { hex: named, alpha: 1 };
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (!m) return null;
  const h = (m[1] ?? "").toUpperCase();
  if (h.length === 3) {
    const hex = h.replace(/./g, (c) => c + c);
    return { hex, alpha: 1 };
  }
  if (h.length === 8) {
    const a = Number.parseInt(h.slice(6, 8), 16) / 255;
    return { hex: h.slice(0, 6), alpha: Math.round(a * 1000) / 1000 };
  }
  return { hex: h, alpha: 1 };
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const t = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [t(h + 1 / 3) * 255, t(h) * 255, t(h - 1 / 3) * 255];
}

/** 两个颜色混色（渐变降级为纯色时用；t=0 全取 a，t=1 全取 b） */
export function mixColors(a: ParsedColor, b: ParsedColor, t = 0.5): ParsedColor {
  const [r1, g1, b1] = hexToRgb(a.hex);
  const [r2, g2, b2] = hexToRgb(b.hex);
  return {
    hex: rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t),
    alpha: a.alpha + (b.alpha - a.alpha) * t,
  };
}

/**
 * 图表色板扩展到 n 个：给定 1..n 个主题色，按色相在 ±30° 内铺开
 * （tinycolor analogous 的轻量替代，图表同一系列内配色和谐即可）。
 */
export function expandChartColors(colors: string[] | undefined, n: number): string[] {
  const base = (colors ?? []).filter((c) => parseColor(c));
  if (base.length === 0) {
    // 没有任何合法色：退回品牌朱砂的类似色
    base.push("#AD392C");
  }
  const out: string[] = [];
  const spread = 30; // 总展开角度（度）
  for (let i = 0; i < n; i++) {
    const src = parseColor(base[i % base.length] ?? "#AD392C") ?? { hex: "AD392C", alpha: 1 };
    const offsetCount = Math.min(n, 10);
    const idx = i % offsetCount;
    const shiftDeg = ((idx - (offsetCount - 1) / 2) * spread) / Math.max(1, offsetCount - 1);
    const [r, g, b] = hexToRgb(src.hex);
    const [h, s, l] = rgbToHsl(r, g, b);
    const h2 = (h * 360 + shiftDeg + 360) % 360;
    const [r2, g2, b2] = hslToRgb(h2 / 360, s, l);
    out.push(rgbToHex(r2, g2, b2));
  }
  return out;
}

/** 相对亮度（0..1），用于决定品牌页脚用深色还是浅色 */
export function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = hexToRgb(hex).map((v) => v / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
