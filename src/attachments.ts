/**
 * 附件/文件获取、缓存与解析（通知附件与本地文件共用一条流水线）
 *
 * 与旧版「整本转文本、12000 字符掐断」的区别：
 * - 下载一次即缓存（attachment-store）：重复读取不再走网络与验证码链路；
 * - 表格（xlsx/xls/csv/tsv）不再吐大文本，返回 sheet 概览（表头+前几行），
 *   具体行靠 spreadsheet.ts 引擎按 关键词/条件筛选/排序/去重/分页 取；
 * - 长文本（docx/pdf/txt/md）支持 offset 分页续读与 keyword 定位，
 *   全文长度 charCount 如实给出，模型知道还剩多少；
 * - Firecrawl 云解析仅作不支持格式的兜底（配置 FIRECRAWL_API_KEY 才启用）；
 * - 本地解析全部离线完成（mammoth + SheetJS + pdf-parse），数据不出本机。
 */

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  type AttachmentMeta,
  attachmentIdForSource,
  findByLocalPath,
  findByUrl,
  getMeta,
  putAttachment,
  readStoredBuffer,
  touchAttachment,
} from "./attachment-store";
import { config } from "./config";
import { isTableFilename, loadWorkbook, sheetOverview, type TableSheet } from "./spreadsheet";

const require = createRequire(import.meta.url);
const FIRECRAWL_API = "https://api.firecrawl.dev/v1/scrape";
/** 单次返回给模型的文本块上限（分页续读，不再当全文截断用） */
const CHUNK_LIMIT = 6000;
const MAX_CHUNK = 20000;
/** 本地文件大小护栏（再大的文件不该是教务附件） */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export type AttachmentResult =
  | {
      mode: "table";
      id: string;
      filename: string;
      format: string;
      totalDataRows: number;
      sheets: Array<ReturnType<typeof sheetOverview>>;
      hint: string;
    }
  | {
      mode: "text";
      id: string;
      filename: string;
      format: string;
      offset: number;
      charCount: number;
      text: string;
      hasMore: boolean;
      nextOffset: number | undefined;
    }
  | {
      mode: "search";
      id: string;
      filename: string;
      format: string;
      keyword: string;
      charCount: number;
      matchCount: number;
      matches: string[];
      note?: string;
    }
  | {
      mode: "firecrawl";
      markdown: string;
      truncated: boolean | undefined;
    }
  | {
      mode: "file";
      id: string;
      filename: string;
      path: string;
      size: number;
      contentType: string;
      hint: string;
    };

export interface AnalyzeOpts {
  /** 长文本续读起点（字符） */
  offset?: number;
  /** 长文本单页长度 */
  limit?: number;
  /** 关键词定位模式：只回含关键词的上下文片段 */
  keyword?: string;
  /** 跳过缓存强制重新下载 */
  refresh?: boolean;
  /** 表格概览每 sheet 预览行数 */
  previewRows?: number;
}

// ── 本地解析 ──────────────────────────────────────────────────

const TEXT_EXT_RE = /\.(docx|pdf|txt|md|log|json|html?)$/i;

/** docx/pdf 抽全文；txt/md 等直接解码。解析不出内容返回 null */
async function extractText(
  buf: Buffer,
  filename: string,
): Promise<{ format: string; text: string } | null> {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
  try {
    if (ext === "pdf") {
      const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
        b: Buffer,
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
    if (TEXT_EXT_RE.test(filename)) {
      return { format: ext, text: buf.toString("utf8") };
    }
    return null;
  } catch {
    return null; // 解析失败走后续策略
  }
}

/** 关键词定位：不区分大小写，返回带上下文的片段（重叠自动跳过） */
function searchText(
  text: string,
  keyword: string,
  radius = 160,
  maxMatches = 30,
): { matchCount: number; matches: string[] } {
  const hay = text.toLowerCase();
  const needle = keyword.trim().toLowerCase();
  const matches: string[] = [];
  let count = 0;
  let from = 0;
  while (needle) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    count++;
    if (matches.length < maxMatches) {
      const start = Math.max(0, at - radius);
      const end = Math.min(text.length, at + needle.length + radius);
      matches.push(
        `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`,
      );
    }
    from = at + needle.length;
  }
  return { matchCount: count, matches };
}

function textResult(
  meta: { id: string; filename: string; format: string },
  text: string,
  opts: AnalyzeOpts,
): AttachmentResult {
  const charCount = text.length;
  if (opts.keyword?.trim()) {
    const { matchCount, matches } = searchText(text, opts.keyword);
    return {
      mode: "search",
      id: meta.id,
      filename: meta.filename,
      format: meta.format,
      keyword: opts.keyword.trim(),
      charCount,
      matchCount,
      matches,
      note: matchCount
        ? matches.length < matchCount
          ? `共 ${matchCount} 处命中，仅显示前 ${matches.length} 处；片段可拼读，需要通读用 mode=text 分页`
          : undefined
        : `全文 ${charCount} 字中未出现「${opts.keyword.trim()}」；这是查过后的结论，不是没读全`,
    };
  }
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.max(500, Math.min(opts.limit ?? CHUNK_LIMIT, MAX_CHUNK));
  const text2 = text.slice(offset, offset + limit);
  const hasMore = offset + limit < charCount;
  return {
    mode: "text",
    id: meta.id,
    filename: meta.filename,
    format: meta.format,
    offset,
    charCount,
    text: text2,
    hasMore,
    nextOffset: hasMore ? offset + limit : undefined,
  };
}

/** 缓存文件的统一分析入口（下载与本地读取共用，纯函数不碰索引） */
async function analyzeBuffer(
  buf: Buffer,
  filename: string,
  source: { type: "url"; url: string } | { type: "local"; path: string },
  opts: AnalyzeOpts,
): Promise<AttachmentResult> {
  const id =
    source.type === "url"
      ? attachmentIdForSource("url", source.url)
      : attachmentIdForSource("local", source.path);

  // 已按同 id/同体积缓存过 = 内容没变：复用索引条目，不重写文件、不清零 hits
  const existing = getMeta(id);
  const reused = existing && existing.size === buf.length ? existing : null;
  const register = (
    input: Omit<Parameters<typeof putAttachment>[0], "id">,
  ): Promise<AttachmentMeta> =>
    reused ? Promise.resolve(reused) : putAttachment({ id, ...input });

  // 1) 表格：结构化概览（默认只给每 sheet 表头 + 前 15 行，读不完是设计而非事故）
  if (isTableFilename(filename)) {
    const sheets = loadWorkbook(buf, filename);
    if (sheets) {
      const meta = await register({
        filename,
        kind: "table",
        format: (filename.toLowerCase().match(/\.([a-z0-9]+)$/) ?? [undefined, "bin"])[1],
        source: source.type,
        ...(source.type === "url" ? { url: source.url } : { originPath: source.path }),
        buf,
        sheetNames: sheets.map((s) => s.name),
      });
      return tableResult(meta, sheets, opts);
    }
  }

  // 2) 文本类：全文缓存 + 分页/检索视图
  const parsed = await extractText(buf, filename);
  if (parsed?.text.trim()) {
    const meta = await register({
      filename,
      kind: "text",
      format: parsed.format,
      source: source.type,
      ...(source.type === "url" ? { url: source.url } : { originPath: source.path }),
      buf,
      textLength: parsed.text.length,
    });
    return textResult(meta, parsed.text, opts);
  }

  // 3) 不支持的格式：先落盘缓存，再 Firecrawl 云兜底
  const meta = await register({
    filename,
    kind: "other",
    format: (filename.toLowerCase().match(/\.([a-z0-9]+)$/) ?? [undefined, "bin"])[1],
    source: source.type,
    ...(source.type === "url" ? { url: source.url } : { originPath: source.path }),
    buf,
  });
  if (source.type === "url" && config.firecrawlApiKey) {
    try {
      const markdown = await firecrawlScrape(source.url);
      return {
        mode: "firecrawl",
        markdown: markdown.slice(0, CHUNK_LIMIT * 2),
        truncated: markdown.length > CHUNK_LIMIT * 2 || undefined,
      };
    } catch {
      /* 云失败转落盘 */
    }
  }
  return {
    mode: "file",
    id: meta.id,
    filename,
    path: meta.storedPath,
    size: meta.size,
    contentType: "",
    hint: "该格式暂不支持本地解析，已存入附件缓存目录（manage_attachments 可查删）。可配置 FIRECRAWL_API_KEY 走云解析，或用 read_local_file 让用户提供转换后的格式。",
  };
}

function tableResult(
  meta: AttachmentMeta,
  sheets: TableSheet[],
  opts: AnalyzeOpts,
): AttachmentResult {
  return {
    mode: "table",
    id: meta.id,
    filename: meta.filename,
    format: meta.format,
    totalDataRows: sheets.reduce((s, x) => s + x.rows.length, 0),
    sheets: sheets.map((s) => sheetOverview(s, opts.previewRows ?? 15)),
    hint: `表格已缓存（id=${meta.id}）。以上是概览，不要试图通读全表：用 query_table 按 keyword/where 筛选、sortBy 排序、action=values 看某列去重取值、offset 分页续取。`,
  };
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

// ── 下载（含 jwc 验证码自动识别，可整体停用）──────────────────

// 验证码是网站明确表达的「此处不欢迎自动化」。这个能力默认开启是为了
// 自己下载本人有权访问的通知附件，但它不该被当成卖点——所以留了总开关。
const CAPTCHA_OCR_ENABLED = process.env.RAPTOR_DISABLE_CAPTCHA_OCR !== "1";
/** 重试上限。之前是 6 次且每次重建 tesseract worker（重复加载 4MB 模型），收敛为 3 次 + worker 常驻 */
const CAPTCHA_MAX_TRIES = 3;

const CAPTCHA_DISABLED_MSG =
  "附件下载被图形验证码拦截，且验证码自动识别已关闭（RAPTOR_DISABLE_CAPTCHA_OCR=1）。" +
  "请在浏览器登录后手动下载该附件，或提供直链地址。";

/** tesseract worker 常驻复用：首次调用时加载一次模型，之后所有识别共享 */
let ocrWorkerPromise: Promise<Awaited<ReturnType<typeof createTesseractWorker>>> | null = null;

function createTesseractWorker() {
  const { createWorker } = require("tesseract.js") as typeof import("tesseract.js");
  return createWorker("eng");
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createTesseractWorker()
      .then(async (worker) => {
        await worker.setParameters({
          tessedit_char_whitelist: "0123456789abcdefghijklmnopqrstuvwxyz",
        } as Parameters<typeof worker.setParameters>[0]);
        return worker;
      })
      .catch((e) => {
        // 创建失败必须把缓存清掉：留着 rejected Promise 会让后续每一次
        // OCR 都直接 reject，附件下载从此静默失败且毫无提示
        ocrWorkerPromise = null;
        throw e;
      });
  }
  return ocrWorkerPromise;
}

/**
 * jwc 附件下载带图片验证码（webplus createimage.jsp）：
 * 首次请求返回验证码页 -> 拉验证码图 -> OCR 识别 -> 带 codeValue 重试。
 * 验证码存于 session，全程必须复用同一 cookie。识别失败自动换新码重试。
 */
async function downloadWithCaptcha(url: string): Promise<{ buf: Buffer; contentType: string }> {
  if (!CAPTCHA_OCR_ENABLED) {
    throw new Error(CAPTCHA_DISABLED_MSG);
  }
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
        .filter((x) => x && !x.startsWith(`${key}=`))
        .concat(kv)
        .join("; ");
    }
    return {
      buf: Buffer.from(await res.arrayBuffer()),
      type: res.headers.get("content-type") || "",
    };
  };

  for (let attempt = 1; attempt <= CAPTCHA_MAX_TRIES; attempt++) {
    const page = await get(url);
    if (!page.type.includes("html")) {
      return { buf: page.buf, contentType: page.type }; // 直链文件
    }
    const html = page.buf.toString("utf8");
    if (!html.includes("createimage.jsp")) {
      return { buf: page.buf, contentType: page.type }; // 非验证码页，走后续逻辑
    }

    // 验证码页：拉图 + OCR（worker 常驻，不重复加载模型）
    const imgUrl = new URL(
      `/system/resource/js/filedownload/createimage.jsp?randnum=${Date.now()}`,
      url,
    ).href;
    const img = await get(imgUrl);
    const code = await ocrCaptcha(img.buf);
    if (!code) continue;

    const file = await get(
      `${url + (url.includes("?") ? "&" : "?")}codeValue=${encodeURIComponent(code)}`,
    );
    if (!file.type.includes("html")) {
      return { buf: file.buf, contentType: file.type };
    }
    // 识别错误 -> 下一轮换新验证码
  }
  throw new Error(
    `验证码识别失败（已重试 ${CAPTCHA_MAX_TRIES} 次）。可在浏览器中下载后手动提供文件；` +
      `或确认该附件确属本人有权获取的内容后重试。`,
  );
}

/** tesseract OCR 验证码（数字+小写字母），worker 由 getOcrWorker 常驻复用 */
async function ocrCaptcha(buf: Buffer): Promise<string> {
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(buf);
    return data.text.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
  } catch {
    return "";
  }
}

// ── 主入口 ────────────────────────────────────────────────────

/** 下载文件名只收敛危险字符，保留扩展名（格式识别依赖它） */
function sanitizeFilenameKeepExt(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "attachment.bin";
}

/**
 * 获取附件：缓存命中直接分析 -> 下载 -> 缓存 -> 分析
 * @param url  附件下载地址（webplus download.jsp 或直链）
 * @param name 附件文件名（含扩展名，来自 read_notice 的 attachments[].name；
 *             下载 URL 通常无后缀，格式识别依赖文件名）
 */
export async function fetchAttachment(
  url: string,
  name?: string,
  opts: AnalyzeOpts = {},
): Promise<AttachmentResult> {
  // 0. 缓存优先：同一 URL 不重复下载（jwc 验证码链路尤其省）
  if (!opts.refresh) {
    const cached = findByUrl(url);
    if (cached) {
      const buf = readStoredBuffer(cached.id);
      if (buf) {
        touchAttachment(cached.id);
        return analyzeBuffer(buf, cached.filename, { type: "url", url }, opts);
      }
    }
  }

  // jwc 的 download.jsp 带验证码，走专门链路；其余直链
  const isJwcDownload = /jwc\.njtech\.edu\.cn\/system\/_content\/download\.jsp/.test(url);
  let buf: Buffer;
  try {
    if (isJwcDownload) {
      buf = (await downloadWithCaptcha(url)).buf;
    } else {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    }
  } catch (e) {
    // 下载失败但历史缓存还在 -> 用旧缓存继续干活（读得出比下得动重要）
    const stale = findByUrl(url);
    const staleBuf = stale ? readStoredBuffer(stale.id) : null;
    if (stale && staleBuf) {
      touchAttachment(stale.id);
      return analyzeBuffer(staleBuf, stale.filename, { type: "url", url }, opts);
    }
    throw e;
  }

  const filename = name || decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  return analyzeBuffer(buf, sanitizeFilenameKeepExt(filename), { type: "url", url }, opts);
}

/**
 * 读取本机文件（用户提供的路径）：与附件同一条解析/缓存流水线。
 * 只读不删；文件更新（体积变化）时自动重新入缓存。
 */
export async function openLocalFile(
  inputPath: string,
  opts: AnalyzeOpts = {},
): Promise<AttachmentResult> {
  const abs = path.resolve(inputPath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`文件不存在或无法访问：${abs}`);
  }
  if (!stat.isFile()) throw new Error(`不是文件：${abs}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB > 50 MB），不适合解析`);
  }
  if (stat.size === 0) throw new Error("文件为空");

  const filename = path.basename(abs);
  const source = { type: "local", path: abs } as const;

  // 缓存命中且体积未变 = 文件没动过；refresh 或体积变化都重新入缓存
  if (!opts.refresh) {
    const cached = findByLocalPath(abs);
    if (cached && cached.size === stat.size) {
      const buf = readStoredBuffer(cached.id);
      if (buf) {
        touchAttachment(cached.id);
        return analyzeBuffer(buf, cached.filename, source, opts);
      }
    }
  }
  const buf = await fs.readFile(abs);
  return analyzeBuffer(buf, filename, source, opts);
}

/** 从缓存按 id 重新出视图（query_table / 续读用，不重新下载） */
export async function viewCachedAttachment(
  id: string,
  opts: AnalyzeOpts,
): Promise<AttachmentResult | { error: string }> {
  const meta = getMeta(id);
  if (!meta)
    return { error: `缓存中不存在附件 ${id}（可能已清理）。用 fetch_attachment 重新获取。` };
  const buf = readStoredBuffer(meta.id);
  if (!buf) return { error: `缓存文件 ${id} 读取失败。` };
  touchAttachment(meta.id);
  const source =
    meta.source === "url" && meta.url
      ? ({ type: "url", url: meta.url } as const)
      : ({ type: "local", path: meta.originPath ?? meta.storedPath } as const);
  return analyzeBuffer(buf, meta.filename, source, opts);
}
