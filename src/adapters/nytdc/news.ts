/**
 * NYTDC 教务处官网通知爬虫（WebplusPro CMS）
 *
 * 站点：https://jwc.nytdc.edu.cn ——公开可访问，不需要登录，也不像南工大那样
 * 限制校内 IP（实机验证：校外直连正常）。
 *
 * 版式与南工大的 webplus 不同，本文件按通达的 WebplusPro 结构解析：
 *   列表页  <li class="news ..."> + <span class="news_title"><a href='/2026/0923/c308a51277/page.htm' title='标题'> + <span class="news_meta">2026-09-23</span>
 *   文章页  <h1 class="arti_title">标题</h1>、<span class="arti_update">发布时间：…</span>、正文在 <div ... wp_articlecontent> 内
 *   附件    /_upload/article/files|cideos/… 下的 xlsx/docx/pdf/mp4 等，链接文本就是文件名
 *
 * 「通知公告」栏目本身没有独立列表页（/308/list.htm 报「找不到对应的栏目」），
 * 它的列表入口在首页的「更多」链接 /tzgg1/list.htm——这是本适配踩过的坑。
 */

import { RaptorError } from "../../core/errors";
import { fetchUrlText } from "../../core/http";
import { readJsonCache, writeJsonCache } from "../../core/json-cache";
import { logger } from "../../core/logger";
import type { NewsItem, SchoolArticle } from "../../core/model";

export const JWC_BASE = "https://jwc.nytdc.edu.cn";

/**
 * 抓取的板块。通知公告是主入口；其余三个栏目是学生最常翻的
 * （选课/重修安排、等级考试与考试安排表、学籍与转专业）。
 */
const TARGETS: Array<{ label: string; url: string }> = [
  { label: "通知公告", url: `${JWC_BASE}/tzgg1/list.htm` },
  { label: "课程管理", url: `${JWC_BASE}/523/list.htm` },
  { label: "考试管理", url: `${JWC_BASE}/524/list.htm` },
  { label: "学籍管理", url: `${JWC_BASE}/521/list.htm` },
];

/** 直连请求头：与浏览器一致，避免被官网 WAF 挡掉 */
const DIRECT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const NEWS_CACHE_FILE = "jwc-news-nytdc.json";

interface NewsCacheEnvelope {
  tag: "jwc-news-nytdc";
  items: NewsItem[];
  fetchedAt: number;
}

function isNewsCache(parsed: unknown): parsed is NewsCacheEnvelope {
  const e = parsed as NewsCacheEnvelope;
  return e?.tag === "jwc-news-nytdc" && Array.isArray(e.items) && typeof e.fetchedAt === "number";
}

// ── 列表解析 ──────────────────────────────────────────────────

/** 解析一页 WebplusPro 列表：li.news 块 → 标题 / 链接 / 发布时间 */
export function parseNewsList(html: string, category: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const block of html.matchAll(/<li[^>]*class="[^"]*\bnews\b[^"]*"[^>]*>[\s\S]*?<\/li>/gi)) {
    const seg = block[0];
    const a =
      seg.match(/<a[^>]*href=['"]([^'"]+)['"][^>]*title=['"]([^'"]*)['"][^>]*>/i) ??
      seg.match(/<a[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const href = a[1];
    const title = (a[2] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();
    if (!title || !href) continue;
    const date =
      seg
        .match(/<span[^>]*class="[^"]*news_meta[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1]
        ?.replace(/<[^>]+>/g, "")
        .trim() ?? "";
    let url: string;
    try {
      url = new URL(href, JWC_BASE).href;
    } catch {
      continue;
    }
    if (!/^https?:\/\/jwc\.nytdc\.edu\.cn\//i.test(url)) continue;
    out.push({ title, url, date, category });
  }
  return out;
}

// ── 通知列表抓取 ──────────────────────────────────────────────

/**
 * 抓取全部板块并合并（按发布日期倒序、URL 去重）。
 * 用一个板块全失败就整体失败会把「只有某栏目挂了」误报成官网不可用，
 * 因此只在**所有**板块都失败时抛错。
 */
export async function fetchJwcNewsDetailed(
  existing: NewsItem[] = [],
  maxItems = 20,
): Promise<NewsItem[]> {
  const seen = new Set(existing.map((i) => i.url));
  const merged: NewsItem[] = [...existing];
  const failures: string[] = [];

  for (const target of TARGETS) {
    try {
      const { status, text } = await fetchUrlText(target.url, {
        timeoutMs: 20_000,
        headers: DIRECT_HEADERS,
      });
      if (status >= 400 || !text) {
        failures.push(`${target.label}(HTTP ${status})`);
        continue;
      }
      for (const item of parseNewsList(text, target.label)) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        merged.push(item);
      }
    } catch (e) {
      failures.push(`${target.label}(${(e as Error).message.slice(0, 40)})`);
    }
  }

  if (failures.length === TARGETS.length) {
    throw new RaptorError("UPSTREAM", `教务处官网抓取失败：${failures.join("；")}`);
  }

  // 日期是 YYYY-MM-DD，字典序即时间序；缺日期的排最后
  merged.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (merged.length <= maxItems) return merged;
  return merged.slice(0, maxItems);
}

/** adapter 端口要求的形态：返回合并后的通知列表 */
export async function fetchJwcNews(existing?: NewsItem[], maxItems?: number): Promise<NewsItem[]> {
  return fetchJwcNewsDetailed(existing ?? [], maxItems ?? 20);
}

// ── 进程内快照 + 落盘兜底 ──────────────────────────────────────

const NEWS_MEMO_TTL_MS = 5 * 60_000;
let newsMemo: { items: NewsItem[]; at: number } | null = null;

/** 测试用：清掉进程内快照 */
export function clearNewsMemo(): void {
  newsMemo = null;
}

/**
 * 面板与 get_news 共用的短 TTL 快照：
 * 网页通知面板刚看过时，对话里再问不重复抓官网四页（公共数据，抓一次够用）。
 * 直连失败时回退上次成功抓取的落盘快照，并如实带出快照时间。
 */
export async function fetchJwcNewsMemo(
  maxItems = 20,
): Promise<{ items: NewsItem[]; staleAt?: number }> {
  if (newsMemo && Date.now() - newsMemo.at < NEWS_MEMO_TTL_MS) {
    return { items: newsMemo.items.slice(0, maxItems) };
  }
  try {
    const items = await fetchJwcNewsDetailed([], 30);
    newsMemo = { items, at: Date.now() };
    writeJsonCache(
      NEWS_CACHE_FILE,
      { tag: "jwc-news-nytdc", items, fetchedAt: Date.now() } satisfies NewsCacheEnvelope,
      "jwc-news-nytdc",
    );
    return { items: items.slice(0, maxItems) };
  } catch (e) {
    const cached = readJsonCache(NEWS_CACHE_FILE, isNewsCache);
    if (!cached) throw e;
    logger.warn("[jwc-news-nytdc] 直连失败，回退缓存快照", { error: (e as Error).message });
    return { items: cached.items.slice(0, maxItems), staleAt: cached.fetchedAt };
  }
}

// ── 通知正文抓取 ──────────────────────────────────────────────

export interface JwcArticle extends SchoolArticle {}

/**
 * 是否通达学院官网链接。教务处（jwc）与学院主站（www）以及基础教学部
 * （jcjxb）都是同一套 WebplusPro 版式，正文解析器通用，所以放宽到整个
 * nytdc.edu.cn——用户贴学院官网链接时也读得了。
 */
export function isJwcUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "nytdc.edu.cn" || h.endsWith(".nytdc.edu.cn");
  } catch {
    return false;
  }
}

/** 抓取一篇教务处通知的正文（WebplusPro 文章页） */
export async function fetchJwcArticle(url: string): Promise<JwcArticle> {
  if (!isJwcUrl(url)) {
    throw new Error("仅支持 nytdc.edu.cn 域名下的文章 URL");
  }
  const { status, text: html } = await fetchUrlText(url, {
    timeoutMs: 25_000,
    headers: DIRECT_HEADERS,
  });
  if (status >= 400 || !html) {
    throw new RaptorError("UPSTREAM", `文章页抓取失败（HTTP ${status}）`);
  }

  const title =
    cleanText(
      html.match(/<h1[^>]*class="[^"]*arti_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "",
    ) ||
    cleanText(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "") ||
    "";

  // 正文在 wp_articlecontent 容器内（div 有嵌套，必须配对计数提取）
  const containerHtml = extractDivBlock(
    html,
    /<div[^>]*class="[^"]*wp_articlecontent[^"]*"[^>]*>/i,
  );
  let text = containerHtml ? htmlToText(containerHtml) : "";
  if (text.length < 80) {
    // 容器缺失或过短（有的通知正文只放了一张图）→ 退到 entry 容器，再退整页
    const entryHtml = extractDivBlock(html, /<div[^>]*class="[^"]*entry[^"]*"[^>]*>/i);
    const fallback = entryHtml ? htmlToText(entryHtml) : htmlToText(html);
    if (fallback.length > text.length) text = fallback;
  }

  return { title, text, attachments: extractAttachments(html) };
}

/** 扫描整页的附件链接（正文容器内外都可能有；链接文本即文件名） */
export function extractAttachments(html: string): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  for (const m of html.matchAll(/<a[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const href = m[1];
    const name = cleanText(m[2]);
    const looksLikeFile =
      /_upload\/article\/(?:files|videos)\//i.test(href) ||
      /\.(xls|xlsx|csv|pdf|doc|docx|ppt|pptx|zip|rar|7z|mp4|wps)(?:[?#]|$)/i.test(href);
    if (!looksLikeFile) continue;
    // 官网的附件链接文字就是「附件1xxx.xlsx」这种，短的往往是图标/按钮
    if (!name || name.length < 2) continue;
    let full: string;
    try {
      full = new URL(href, JWC_BASE).href;
    } catch {
      continue;
    }
    if (!out.some((a) => a.url === full)) out.push({ name, url: full });
  }
  return out;
}

// ── HTML 工具 ─────────────────────────────────────────────────

/** 提取指定开标签 div 的完整内容（div 配对计数，正确处理嵌套） */
export function extractDivBlock(html: string, openRe: RegExp): string | null {
  const m = openRe.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const tokenRe = /<div\b|<\/div\s*>/gi;
  tokenRe.lastIndex = start;
  let depth = 1;
  for (let t = tokenRe.exec(html); t !== null; t = tokenRe.exec(html)) {
    depth += t[0].toLowerCase().startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return null;
}

/** 剥标签取纯文本（script/style 先整段丢掉，否则内联样式会混进正文） */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 单元格文本清理：剥标签 + 压空白（标题、文件名共用） */
function cleanText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
