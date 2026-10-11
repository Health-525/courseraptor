/** 网页静态资产：marked UMD、logo、PWA 清单与进程级「读一次常驻内存」缓存。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 前端 Markdown 渲染器（marked 的 UMD 构建，静态吐给浏览器） */
export const MARKED_UMD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "node_modules",
  "marked",
  "lib",
  "marked.umd.js",
);

/** 项目 logo（随仓库放在 docs/）：浏览器标签页图标与首屏那枚印章共用同一张 */
export const LOGO_PNG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "courseraptor-logo.png",
);

/** PWA 清单：iOS「添加到主屏幕」与 Android「安装」的元数据。
 *  图标直接复用 logo（1254² 方图，浏览器自行缩放）；主题色取纸面深一档，
 *  与对话页顶栏同色。display=standalone 让安装后没有浏览器地址栏。 */
export const WEB_MANIFEST = JSON.stringify({
  name: "CourseRaptor",
  short_name: "CourseRaptor",
  description: "课表、成绩、考试、通知，一句话查询",
  start_url: "/",
  display: "standalone",
  background_color: "#F6F4ED",
  theme_color: "#F0EDE4",
  icons: [
    { src: "/logo.png", sizes: "192x192", type: "image/png" },
    { src: "/logo.png", sizes: "512x512", type: "image/png" },
  ],
});

/** 静态资源进程启动后不会变，读一次常驻内存即可——请求路径上不再碰盘，
 * 同进程还挂着 SSE 流式对话，同步 IO 阻塞事件循环会放大流式延迟 */
const staticCache = new Map<string, Buffer | null>();

export function loadStaticOnce(absolutePath: string): Buffer | null {
  if (!staticCache.has(absolutePath)) {
    try {
      staticCache.set(absolutePath, fs.readFileSync(absolutePath));
    } catch {
      // 读取失败也缓存住（null），避免后续请求反复重试丢盘
      staticCache.set(absolutePath, null);
    }
  }
  return staticCache.get(absolutePath) ?? null;
}
