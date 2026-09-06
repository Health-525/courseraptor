/**
 * 中文字体解析（PDF 用）
 *
 * pdfkit 内建字体不含 CJK 字形，中文会渲染成空白/乱码。做法：注册一份系统里
 * 已有的 TTF/TTC，pdfkit 会自动子集化嵌入。优先黑体 simhei.ttf（纯 TTF、最稳），
 * 再退宋体/雅黑。允许 RAPTOR_CJK_FONT 指定绝对路径覆盖（非 Windows 或自带字体场景）。
 *
 * 注意：这里只「读取」系统字体文件，不写不删，符合红线。
 */

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const CANDIDATES = [
  "C:/Windows/Fonts/simhei.ttf",
  "C:/Windows/Fonts/simsun.ttc",
  "C:/Windows/Fonts/msyh.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/usr/share/fonts/truetype/arphic/uming.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
];

/** 返回可用的中文字体绝对路径；找不到返回 null（调用方决定降级策略） */
export function resolveCjkFont(): string | null {
  const override = process.env.RAPTOR_CJK_FONT?.trim();
  if (override && fs.existsSync(override)) return override;
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * .ttc/.otc 是字体集合：pdfkit 内部走 `fontkit.create(src, family)`，不传 family
 * 时拿到的是集合对象，没有 createSubset，于是报
 * 「this.font.createSubset is not a function」（Windows 的 simhei.ttf 是纯 TTF，
 * 所以本地一直正常，Linux CI 命中 Noto CJK 的 .ttc 才暴露）。
 *
 * 这里替它挑一个集合内的简体中文字体，返回其 postscriptName；纯字体文件返回 undefined。
 */
export function resolveCjkFontFamily(path: string): string | undefined {
  if (!/\.(ttc|otc)$/i.test(path)) return undefined;
  try {
    // fontkit 无类型声明，沿用 render.ts 的 createRequire + any 约定
    const fontkit = require("fontkit") as {
      openSync(file: string): {
        fonts?: { postscriptName: string; familyName?: string }[];
      };
    };
    const collection = fontkit.openSync(path);
    const fonts = collection.fonts ?? [];
    if (fonts.length === 0) return undefined;
    const preferred =
      fonts.find((f) =>
        /sc|simhei|heiti|simsun|song|pingfang|yahei|uming/i.test(
          `${f.postscriptName} ${f.familyName ?? ""}`,
        ),
      ) ?? fonts[0];
    return preferred.postscriptName;
  } catch {
    return undefined;
  }
}
