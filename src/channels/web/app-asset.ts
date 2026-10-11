/** 前端应用脚本（assets/chat-app.js）的字节内容加载器。
 * 正式服务与离线演示的 /app.js 端点共用：读一次常驻内存，请求路径上
 * 不碰盘——同进程挂着 SSE 流式对话，同步 IO 会放大流式延迟。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "assets", "chat-app.js");

let cache: Buffer | null | undefined;

/** 读不到返回 null（调用方回 404，页面在控制台明确报因，不渲染死页面） */
export function appJsAsset(): Buffer | null {
  if (cache === undefined) {
    try {
      cache = fs.readFileSync(APP_JS);
    } catch {
      cache = null;
    }
  }
  return cache;
}
