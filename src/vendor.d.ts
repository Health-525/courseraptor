/**
 * 无类型第三方包的声明（都能找到源码，类型面很小，不值得引 @types）：
 * - svg-arc-to-cubic-bezier：SVG 圆弧 → 三次贝塞尔控制点（MIT）
 */

declare module "svg-arc-to-cubic-bezier" {
  interface ArcToBezierInput {
    px: number;
    py: number;
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    xAxisRotation: number;
    largeArcFlag: boolean;
    sweepFlag: boolean;
  }
  interface CubicSegment {
    x: number;
    y: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }
  export default function arcToBezier(input: ArcToBezierInput): CubicSegment[];
}
