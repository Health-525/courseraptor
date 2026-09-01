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
