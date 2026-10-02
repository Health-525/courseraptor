/**
 * 课表 SVG → PNG 光栅化
 *
 * 同学最终要的是「存手机相册直接看」的位图，QQ 里发的也是图片而不是
 * 文件。用 @resvg/resvg-js 本地转换（原生绑定、零浏览器依赖），中文走
 * 系统字体（Windows 微软雅黑/楷体、macOS PingFang/楷体皆在默认字体表内）。
 * fitTo 按目标宽度等比放大——2 倍出图，手机上放大看笔画不发虚。
 */

import { createRequire } from "node:module";

// 惰性加载（attachments.ts 的 jszip 同款约定）：独立技能包（skills/
// export-schedule）把 @resvg/resvg-js 标 external、原生二进制随包另发，
// 不进单文件 bundle；本地/服务器 node_modules 常驻，行为不变。
// createRequire 必须在函数内拿：模块级 const require 会与独立包 banner
// 注入的同名引导撞名（esbuild 的重命名看不到 banner）
type ResvgModule = typeof import("@resvg/resvg-js");
let resvgCtor: ResvgModule["Resvg"] | undefined;

function loadResvg(): ResvgModule["Resvg"] {
  resvgCtor ??= (createRequire(import.meta.url)("@resvg/resvg-js") as ResvgModule).Resvg;
  return resvgCtor;
}

/** 把课表 SVG 光栅化成 PNG Buffer；targetWidth 为输出像素宽（等比缩放） */
export function scheduleSvgToPng(svg: string, targetWidth: number): Buffer {
  const resvg = new (loadResvg())(svg, {
    fitTo: { mode: "width", value: Math.max(1, Math.round(targetWidth)) },
    font: { loadSystemFonts: true },
    // 课表是纯色块+文字，无渐变无遮罩，关闭抗锯齿以外的平滑开关不影响观感
    background: "rgba(0,0,0,0)",
  });
  return Buffer.from(resvg.render().asPng());
}
