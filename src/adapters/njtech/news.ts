/**
 * NJTECH 教务处通知爬虫
 * 搬自 timetable/scripts/fetch_jwc_news.js，改为 TypeScript 函数化
 *
 * 抓取 https://jwc.njtech.edu.cn 三个页面，无需认证（公开页面）。
 * 2026-09 起官网限制仅校内 IP 访问：校外直连只会拿到「本网站只能被
 * 校内IP地址访问」拦截页（HTTP 483），因此抓取走三级阶梯：
 *   直连（校内/学校放开限制时）→ WebVPN 代理（校外，需统一身份认证）
 *   → 上次成功抓取的落盘缓存（前两者都失败时兜底，注明快照时间）。
 */

import { fetchUrlText } from "../../core/http";
import { readJsonCache, writeJsonCache } from "../../core/json-cache";
import { logger } from "../../core/logger";
import type { NewsItem } from "../../core/model";
import { jwcUrlToPath, webvpnFetchJwc, webvpnUrlToPublic } from "./webvpn";

const BASE_URL = "https://jwc.njtech.edu.cn";

const TARGETS = [
  { label: "公告通知", url: `${BASE_URL}/index/ggtz.htm` },
  { label: "教学动态", url: `${BASE_URL}/index/jxdt.htm` },
  { label: "考试排课", url: `${BASE_URL}/jxgl/ksypk.htm` },
];

/** 校外拦截页签名：命中说明直连被拒，需要换 WebVPN 通道 */
const CAMPUS_ONLY_SIGNATURE = "本网站只能被校内IP地址访问";

const NEWS_CACHE_FILE = "jwc-news-cache.json";

interface NewsCacheEnvelope {
  tag: "jwc-news";
  items: NewsItem[];
  fetchedAt: number;
}

// ── HTML 抓取（直连，统一走 core/http 的 fetch 原语）──────────

/** 直连请求头：与浏览器一致，避免被官网 WAF 挡掉 */
const DIRECT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

// ── 抓取阶梯 ─────────────────────────────────────────────────

export interface JwcFetch {
  html: string;
  via: "direct" | "webvpn";
}

/**
 * 抓取 jwc 站点的一个页面：先直连，被校外拦截（或网络不通）时降级 WebVPN。
 * 两条路都失败时抛出后者（WebVPN）的错误——那里带着可操作的指引。
 */
async function fetchJwcHtml(path: string): Promise<JwcFetch> {
  try {
    // 重定向跟随（undici 内置 20 跳上限）与 15s 超时都在 fetchUrlText 里
    const { status, text } = await fetchUrlText(`${BASE_URL}${path}`, {
      timeoutMs: 15_000,
      headers: DIRECT_HEADERS,
    });
    // 校外被拦时官网回 483（或 200 拦截页）：按状态与页面签名识别后换通道
    if (status < 400 && !text.includes(CAMPUS_ONLY_SIGNATURE)) {
      return { html: text, via: "direct" };
    }
  } catch {
    /* 直连失败（断网/超时，RaptorError NETWORK）：换 WebVPN 通道 */
  }
  const html = await webvpnFetchJwc(path);
  return { html, via: "webvpn" };
}

// ── HTML 解析 ────────────────────────────────────────────────

function parseNewsList(html: string, baseUrl: string): NewsItem[] {
  const items: NewsItem[] = [];

  // <ul class="my-list"><li><a href="...">标题</a><span class="date">日期</span></li></ul>
  const listMatch = html.match(/<ul[^>]*class="my-list"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!listMatch) return items;

  const liRegex = /<li>([\s\S]*?)<\/li>/gi;
  for (
    let liMatch = liRegex.exec(listMatch[1]);
    liMatch !== null;
    liMatch = liRegex.exec(listMatch[1])
  ) {
    const aMatch = liMatch[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const title = aMatch[2].replace(/<[^>]+>/g, "").trim();
    if (title.length < 4) continue;

    const dateMatch = liMatch[1].match(/<span[^>]*class="date"[^>]*>([^<]+)<\/span>/i);
    const date = dateMatch ? dateMatch[1].trim() : "";

    let fullUrl: string;
    try {
      fullUrl = new URL(aMatch[1], baseUrl).href;
    } catch {
      fullUrl = baseUrl.replace(/\/[^/]*$/, "") + aMatch[1].replace(/^\.\./, "");
    }

    items.push({
      title,
      url: fullUrl,
      date,
      // 未静态化、设置了浏览权限的文章只有 article.jsp 动态入口，匿名打开
      // 一律 302 到 auth.htm「您无权访问此页面」；静态 info/*.htm 则全站可看
      restricted: /article\.jsp\?.*urltype=news\.NewsContentUrl/i.test(fullUrl) || undefined,
    });
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
}

// ── 列表抓取（主入口）────────────────────────────────────────

export interface JwcNewsResult {
  items: NewsItem[];
  /** 本次实际使用的通道；校外被拦时为 webvpn */
  via: "direct" | "webvpn";
  /** 非空表示本次返回的是落盘缓存快照（直连与 WebVPN 都失败了） */
  staleAt?: number;
}

/**
 * 抓取教务处通知（带通道与降级信息）。get_news 工具用这个版本，
 * 把「经 WebVPN 代理」「缓存快照」如实告诉模型与用户。
 */
export async function fetchJwcNewsDetailed(
  existingItems: NewsItem[] = [],
  maxItems = 20,
): Promise<JwcNewsResult> {
  const allItems: NewsItem[] = [];
  let usedWebvpn = false;
  let lastError: Error | null = null;

  for (const { label, url } of TARGETS) {
    try {
      const path = jwcUrlToPath(url) ?? new URL(url).pathname + new URL(url).search;
      const { html, via } = await fetchJwcHtml(path);
      if (via === "webvpn") usedWebvpn = true;
      const items = parseNewsList(html, url);
      for (const item of items) {
        item.category = label;
        // WebVPN 页面里的绝对链接带改写前缀，对外统一映射回公网地址
        item.url = webvpnUrlToPublic(item.url);
      }
      allItems.push(...items);
    } catch (e) {
      lastError = e as Error;
      // Skip failed category
    }
  }

  if (allItems.length > 0) {
    // Merge with existing, deduplicate by URL, keep latest
    const merged = [
      ...allItems,
      ...existingItems.filter((e) => !allItems.some((n) => n.url === e.url)),
    ];
    merged.sort((a, b) => b.date.localeCompare(a.date));
    const items = merged.slice(0, maxItems);
    writeJsonCache(
      NEWS_CACHE_FILE,
      { tag: "jwc-news", items, fetchedAt: Date.now() } satisfies NewsCacheEnvelope,
      "jwc-news",
    );
    return { items, via: usedWebvpn ? "webvpn" : "direct" };
  }

  // 全部板块失败：先看有没有可用的历史快照
  const cached = readJsonCache(NEWS_CACHE_FILE, isValidNewsCache);
  if (cached) {
    logger.warn("[jwc-news] 直连与 WebVPN 均失败，回退缓存快照", { error: lastError?.message });
    return { items: cached.items, via: "direct", staleAt: cached.fetchedAt };
  }

  throw lastError ?? new Error("教务处通知抓取失败（三个板块均无结果）");
}

function isValidNewsCache(parsed: unknown): parsed is NewsCacheEnvelope {
  const v = parsed as NewsCacheEnvelope | null;
  return (
    !!v &&
    v.tag === "jwc-news" &&
    Array.isArray(v.items) &&
    v.items.length > 0 &&
    typeof v.fetchedAt === "number"
  );
}

/**
 * 抓取教务处通知（兼容原契约：只回列表，不抛错）。
 * welcome 横幅与网页通知面板走这个入口，失败时按各自 UI 降级展示。
 */
export async function fetchJwcNews(
  existingItems: NewsItem[] = [],
  maxItems = 20,
): Promise<NewsItem[]> {
  try {
    return (await fetchJwcNewsDetailed(existingItems, maxItems)).items;
  } catch (e) {
    logger.error("[jwc-news] 抓取失败", { error: (e as Error).message });
    return existingItems;
  }
}

// ── 通知正文抓取 ──────────────────────────────────────────────

export interface JwcArticle {
  title: string;
  text: string;
  attachments: Array<{ name: string; url: string }>;
}

/**
 * 抓取一篇教务处通知的正文（webplus CMS 文章页）
 * 时间安排、开学/考试/选课日期都在正文里，列表页只有标题
 */
export async function fetchJwcArticle(url: string): Promise<JwcArticle> {
  const path = jwcUrlToPath(url);
  if (path === null) {
    throw new Error("仅支持 jwc.njtech.edu.cn 域名下的文章 URL");
  }
  const { html } = await fetchJwcHtml(path);
  // 权限文章匿名访问 302 到 auth.htm 后返回的仍是 HTTP 200 的鉴权提示页，
  // 不拦住的话这段「您无权访问此页面」会被当成正文往上转
  if (/您无权访问此页面/.test(html)) {
    throw new Error("该通知在官网设置了访问权限，匿名状态下读不到正文");
  }
  const title =
    html
      .match(/<title>([^<]*)<\/title>/i)?.[1]
      ?.trim()
      .replace(/-南京工业大学教务处.*$/, "") ?? "";

  // 正文在 v_news_content / vsb_content 容器内；容器有嵌套 div，
  // 必须做配对计数提取（正则非贪婪会在第一个 </div> 截断）
  let bodyHtml =
    extractDivBlock(html, /<div[^>]*class="[^"]*v_news_content[^"]*"[^>]*>/i) ??
    extractDivBlock(html, /<div[^>]*class="[^"]*vsb_content[^"]*"[^>]*>/i);
  if (!bodyHtml || htmlToText(bodyHtml).length < 200) {
    bodyHtml = html; // 容器缺失/过短时退化为整页剥离
  }

  // 附件扫描必须覆盖整页：webplus 的附件块在正文容器之外（页面尾部
  // <li>附件【<a href="/system/_content/download.jsp?...">名称.xlsx</a>】），
  // 且下载 URL 无文件后缀（文件名在链接文本里）
  const attachments: JwcArticle["attachments"] = [];
  for (const m of html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,150}?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    const isDownload = href.includes("download.jsp") || href.includes("DownloadAttachUrl");
    const hasExt = /\.(xls|xlsx|pdf|doc|docx|zip|rar|wps)(?:[?#]|$)/i.test(href);
    if (!isDownload && !hasExt) continue;
    if (!text || text.length < 3) continue;
    try {
      // 相对链接按公网文章地址拼全，保持对外 URL 的规范形态
      const full = webvpnUrlToPublic(new URL(href, url).href);
      if (!attachments.some((a) => a.url === full)) {
        attachments.push({ name: text, url: full });
      }
    } catch {
      /* 非法链接跳过 */
    }
  }

  return { title, text: htmlToText(bodyHtml), attachments };
}

/** 提取指定开标签 div 的完整内容（<div 配对计数，正确处理嵌套） */
function extractDivBlock(html: string, openRe: RegExp): string | null {
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

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
