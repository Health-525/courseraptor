/**
 * 通知附件获取与解析
 *
 * 三级策略：
 * 1. 本地解析（默认）：docx/xlsx/xls/pdf 转纯文本直接返回给 agent 阅读
 *    （mammoth + SheetJS + pdf-parse，离线、零费用、数据不出本机）
 * 2. Firecrawl 云解析：配置 FIRECRAWL_API_KEY 且本地不支持的格式兜底
 * 3. 落盘：无法解析时下载到 downloads/ 返回路径
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import { config, PROJECT_ROOT } from "./config";

const require = createRequire(import.meta.url);
const FIRECRAWL_API = "https://api.firecrawl.dev/v1/scrape";
const TEXT_LIMIT = 12000;

export type AttachmentResult =
  | {
      mode: "parsed";
      format: string;
      text: string;
      charCount: number;
      truncated: boolean | undefined;
    }
  | {
      mode: "firecrawl";
      markdown: string;
      truncated: boolean | undefined;
    }
  | {
      mode: "download";
      path: string;
      size: number;
      contentType: string;
      hint?: string;
    };

// ── 本地解析 ──────────────────────────────────────────────────

async function parseLocally(
  buf: Buffer,
  filename: string
): Promise<{ format: string; text: string } | null> {
  const ext = filename.toLowerCase().match(/\.(docx|xlsx|xls|pdf)$/)?.[1];
  if (!ext) return null;
  try {
    if (ext === "pdf") {
      const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
        b: Buffer
      ) => Promise<{ text: string }>;
      const r = await pdfParse(buf);
      return { format: "pdf", text: r.text };
    }
    if (ext === "docx") {
      const mammoth = require("mammoth") as {
        extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }>;
      };
      const r = await mammoth.extractRawText({ buffer: buf });
      return { format: "docx", text: r.value };
    }
    // xlsx / xls（SheetJS，多 sheet 转 CSV 文本）
    const XLSX = require("xlsx") as typeof import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer" });
    const parts: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
      if (csv.trim()) parts.push(`【${sheetName}】\n${csv.trim()}`);
    }
    return { format: ext, text: parts.join("\n\n") };
  } catch {
    return null; // 解析失败走后续策略
  }
}

// ── Firecrawl 云解析 ──────────────────────────────────────────

async function firecrawlScrape(url: string): Promise<string> {
  const res = await fetch(FIRECRAWL_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.firecrawlApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Firecrawl HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    success?: boolean;
    data?: { markdown?: string };
    error?: string;
  };
  if (!data.success || !data.data?.markdown) {
    throw new Error(data.error || "Firecrawl 未返回 markdown");
  }
  return data.data.markdown;
}

// ── 下载（含 jwc 验证码自动识别）──────────────────────────────

/**
 * jwc 附件下载带图片验证码（webplus createimage.jsp）：
 * 首次请求返回验证码页 -> 拉验证码图 -> OCR 识别 -> 带 codeValue 重试。
 * 验证码存于 session，全程必须复用同一 cookie。识别失败自动换新码重试。
 */
async function downloadWithCaptcha(
  url: string
): Promise<{ buf: Buffer; contentType: string }> {
  let cookie = "";

  const get = async (u: string): Promise<{ buf: Buffer; type: string }> => {
    const res = await fetch(u, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(";")[0];
      const key = kv.split("=")[0];
      cookie = cookie
        .split("; ")
        .filter((x) => x && !x.startsWith(key + "="))
        .concat(kv)
        .join("; ");
    }
    return {
      buf: Buffer.from(await res.arrayBuffer()),
      type: res.headers.get("content-type") || "",
    };
  };

  const MAX_TRIES = 6;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const page = await get(url);
    if (!page.type.includes("html")) {
      return { buf: page.buf, contentType: page.type }; // 直链文件
    }
    const html = page.buf.toString("utf8");
    if (!html.includes("createimage.jsp")) {
      return { buf: page.buf, contentType: page.type }; // 非验证码页，走后续逻辑
    }

    // 验证码页：拉图 + OCR
    const imgUrl = new URL(
      "/system/resource/js/filedownload/createimage.jsp?randnum=" + Date.now(),
      url
    ).href;
    const img = await get(imgUrl);
    const code = await ocrCaptcha(img.buf);
    if (!code) continue;

    const file = await get(
      url + (url.includes("?") ? "&" : "?") + "codeValue=" + encodeURIComponent(code)
    );
    if (!file.type.includes("html")) {
      return { buf: file.buf, contentType: file.type };
    }
    // 识别错误 -> 下一轮换新验证码
  }
  throw new Error(`验证码识别失败（已重试 ${MAX_TRIES} 次）`);
}

/** tesseract OCR 验证码（数字+小写字母） */
async function ocrCaptcha(buf: Buffer): Promise<string> {
  try {
    const { createWorker } = require("tesseract.js") as typeof import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789abcdefghijklmnopqrstuvwxyz",
      } as Parameters<typeof worker.setParameters>[0]);
      const { data } = await worker.recognize(buf);
      return data.text.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
    } finally {
      await worker.terminate();
    }
  } catch {
    return "";
  }
}

// ── 主入口 ────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "attachment.bin";
}

/**
 * 获取附件：下载 -> 本地解析 -> Firecrawl 兜底 -> 落盘兜底
 * @param url  附件下载地址（webplus download.jsp 或直链）
 * @param name 附件文件名（含扩展名，来自 read_notice 的 attachments[].name；
 *             下载 URL 通常无后缀，格式识别依赖文件名）
 */
export async function fetchAttachment(
  url: string,
  name?: string,
  opts: { limit?: number } = {}
): Promise<AttachmentResult> {
  const textLimit = opts.limit ?? TEXT_LIMIT;
  // jwc 的 download.jsp 带验证码，走专门链路；其余直链
  const isJwcDownload =
    /jwc\.njtech\.edu\.cn\/system\/_content\/download\.jsp/.test(url);
  let buf: Buffer;
  let contentType: string;
  if (isJwcDownload) {
    const r = await downloadWithCaptcha(url);
    buf = r.buf;
    contentType = r.contentType;
  } else {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    contentType = res.headers.get("content-type") || "";
  }

  // 1. 本地解析
  const filename = name || decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  const parsed = await parseLocally(buf, filename);
  if (parsed && parsed.text.trim()) {
    return {
      mode: "parsed",
      format: parsed.format,
      text: parsed.text.slice(0, textLimit),
      charCount: parsed.text.length,
      truncated: parsed.text.length > textLimit || undefined,
    };
  }

  // 2. Firecrawl 云兜底
  if (config.firecrawlApiKey) {
    try {
      const markdown = await firecrawlScrape(url);
      return {
        mode: "firecrawl",
        markdown: markdown.slice(0, TEXT_LIMIT),
        truncated: markdown.length > TEXT_LIMIT || undefined,
      };
    } catch {
      /* 云失败转落盘 */
    }
  }

  // 3. 落盘
  const dir = path.join(PROJECT_ROOT, "downloads");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${sanitizeFilename(filename)}`);
  await fs.writeFile(file, buf);
  return {
    mode: "download",
    path: file,
    size: buf.length,
    contentType,
    hint: "该格式暂不支持本地解析，已保存到本地；可配置 FIRECRAWL_API_KEY 走云解析",
  };
}
