/** 网页静态资产：marked UMD、logo、PWA 清单与进程级「读一次常驻内存」缓存。 */

import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appJsAsset } from "./app-asset";

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

/** 四个静态端点（前端脚本 / marked / logo / PWA 清单）的统一伺服。
 * 正式对话与演示页共用同一份资产与响应头，此前各写了一遍。 */
export function serveStaticAsset(url: string, res: ServerResponse): boolean {
  if (url === "/app.js") {
    const buf = appJsAsset();
    if (buf) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        // no-cache 而非长缓存：开发期改前端必须立刻生效，localhost 全量拉取无感
        "cache-control": "no-cache",
      });
      res.end(buf);
    } else {
      res.writeHead(404);
      res.end('console.error("前端脚本缺失：src/channels/web/assets/chat-app.js 不可读");');
    }
    return true;
  }
  if (url === "/vendor/marked.min.js") {
    const buf = loadStaticOnce(MARKED_UMD);
    if (buf) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=86400",
      });
      res.end(buf);
    } else {
      res.writeHead(404);
      res.end("// marked 不可用，页面会退回纯文本渲染");
    }
    return true;
  }
  if (url === "/logo.png" || url === "/favicon.ico") {
    const buf = loadStaticOnce(LOGO_PNG);
    if (buf) {
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      });
      res.end(buf);
    } else {
      // 图没了也只是没图标，不能连累页面
      res.writeHead(404);
      res.end();
    }
    return true;
  }
  if (url === "/manifest.webmanifest") {
    res.writeHead(200, {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "public, max-age=86400",
    });
    res.end(WEB_MANIFEST);
    return true;
  }
  return false;
}
