/**
 * 本地 API 令牌 — 给本机桌面客户端（Obsidian 插件等第四端入口）用的长期凭证
 *
 * 网页端的写请求靠 CSRF token 把门，但那个 token 每次进程启动随机生成、
 * 只嵌在本实例渲染的页面 meta 里——桌面客户端拿不到（也拿不到页面 DOM）。
 * 所以这里另发一个**长期稳定**的令牌：首次使用时生成、落盘 data/local-api.json，
 * 之后重启不变，客户端在设置里粘一次就能一直用。
 *
 * 信任边界与整份本地数据一致：令牌文件就在 data/ 里，能读到它的本机进程
 * 本来就能直接读会话与凭证，令牌不再额外设防；真正要挡的是浏览器里的
 * 恶意网页——它们读不到 data/ 也读不到这个文件的响应（无 CORS 头），拿
 * 不到令牌就伪造不出合法写请求。服务端校验见 chat-web.ts requestForbidden。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "./atomic-write";
import { dataDir } from "./paths";

const TOKEN_FILE = "local-api.json";

/** 进程内缓存：读盘一次，之后所有请求零 IO */
let cachedToken: string | null = null;

/** Obsidian 渲染进程的私有 origin：只有 Obsidian 自己会发出，网页伪造不出 */
export const OBSIDIAN_ORIGIN = "app://obsidian.md";

/** 首次调用生成并落盘，之后稳定不变；读盘失败（损坏）时换发新令牌 */
export function localApiToken(): string {
  if (cachedToken) return cachedToken;
  const file = path.join(dataDir(), TOKEN_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: unknown };
    if (typeof raw.token === "string" && /^[0-9a-f]{64}$/.test(raw.token)) {
      cachedToken = raw.token;
      return cachedToken;
    }
  } catch {
    /* 首次使用还没有文件：走生成 */
  }
  cachedToken = crypto.randomBytes(32).toString("hex");
  // 同步落盘：调用方拿到令牌时文件必须已经存在，持久性不留窗口期。
  // 写失败也照常返回进程内令牌（下次启动重试补写），不挡服务启动
  try {
    writeFileAtomicSync(file, `${JSON.stringify({ token: cachedToken }, null, 2)}\n`);
  } catch {
    /* 目录不可写等：保持内存态，别把启动带崩 */
  }
  return cachedToken;
}
