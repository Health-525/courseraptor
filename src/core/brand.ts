/**
 * 品牌资源 — 课表图等导出物共用的项目标识
 *
 * logo 与仓库同走（docs/courseraptor-logo.png），网页印章/标签页图标也是
 * 这一张。core 不 import channels 的代码，但这份品牌资产是仓库级文件，
 * 这里按相对路径直读（只读、读一次常驻），避免把图复制出第二份会漂移的副本。
 * 读取失败（比如裁剪过的安装缺文件）返回 null，调用方退回无 logo 的画法。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOGO_PNG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "courseraptor-logo.png",
);

let cached: string | null | undefined;

/** logo 的 data URI（base64 PNG）；缺文件时 null。供 <image> 直嵌 SVG */
export function loadLogoDataUri(): string | null {
  if (cached === undefined) {
    try {
      cached = `data:image/png;base64,${fs.readFileSync(LOGO_PNG).toString("base64")}`;
    } catch {
      cached = null;
    }
  }
  return cached;
}
