/** 成品文件伺服：GET /files/ 只服务 data/generated 的下载与预览（MIME 白名单、
 *  inline/attachment 分流），路径穿越与目录外文件一律 404。 */

import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { generatedDir } from "../../core/document/save";
import { isInsideDir } from "../../core/paths";

// ── 成品文件下载：只服务 data/generated，别处一律 404 ──────────

const FILE_MIME: Record<string, string> = {
  ".ics": "text/calendar; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
};

/** 这些类型浏览器能直接看：聊天里点开是预览而不是塞进下载夹（图片长按/右键即存） */
const INLINE_MIME = new Set(["image/png", "image/svg+xml; charset=utf-8", "application/pdf"]);

/** 工具产物路径是否确实落在 generated 目录内（与 QQ 桥 sendFile 同一道护栏） */
export function insideGenerated(filePath: string): boolean {
  return isInsideDir(generatedDir(), filePath);
}

/** GET /files/ 的统一 404：明确 text/plain，绝不兜底吐 HTML 页面骗 200 */
export function fileNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

/**
 * GET /files/<文件名>：下载本轮工具产出的成品（ics/文档）。
 * 文件名先 basename 再解析校验，路径穿越（../）到不了目录外。
 */
export async function serveGeneratedFile(rawName: string, res: http.ServerResponse): Promise<void> {
  let name = "";
  try {
    name = path.basename(decodeURIComponent(rawName));
  } catch {
    // 半截百分号编码：当非法名处理
  }
  if (!name) {
    fileNotFound(res);
    return;
  }
  const root = path.resolve(generatedDir());
  const target = path.resolve(root, name);
  if (!isInsideDir(root, target)) {
    fileNotFound(res);
    return;
  }
  try {
    const buf = await fs.promises.readFile(target);
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) throw new Error("not a file");
    const mime = FILE_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
    // 文件名常含中文：ASCII 兜底 + RFC 5987 编码双写；图片/PDF 用 inline 让浏览器直接看
    const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
    const disposition = INLINE_MIME.has(mime) ? "inline" : "attachment";
    res.writeHead(200, {
      "content-type": mime,
      "content-length": buf.length,
      "content-disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
    });
    res.end(buf);
  } catch {
    fileNotFound(res);
  }
}
