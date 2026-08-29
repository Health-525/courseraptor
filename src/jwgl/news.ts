/**
 * NJTECH 教务处通知爬虫
 * 搬自 timetable/scripts/fetch_jwc_news.js，改为 TypeScript 函数化
 *
 * 爬取 https://jwc.njtech.edu.cn 三个页面
 * 无需认证（公开页面）
 */

import http from "http";
import https from "https";

import type { NewsItem } from "./types";

const BASE_URL = "https://jwc.njtech.edu.cn";

const TARGETS = [
  { label: "公告通知", url: `${BASE_URL}/index/ggtz.htm` },
  { label: "教学动态", url: `${BASE_URL}/index/jxdt.htm` },
  { label: "考试排课", url: `${BASE_URL}/jxgl/ksypk.htm` },
];

// ── HTML 抓取 ────────────────────────────────────────────────

/** 跟随重定向的上限：A↔B 互跳时没有上限就是无限请求 */
const MAX_REDIRECTS = 5;

function fetchHtml(
  url: string,
  timeout = 15000,
  hops = 0
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          Connection: "keep-alive",
        },
      },
      (res) => {
        // Handle redirects
        if (
          (res.statusCode ?? 0) >= 300 &&
          (res.statusCode ?? 0) < 400 &&
          res.headers.location
        ) {
          const redirectUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          // 必须把这次响应的数据读完（或销毁），否则 keep-alive 下 socket
          // 一直挂在半途，重定向链一长就把连接池耗光
          res.resume();
          if (hops >= MAX_REDIRECTS) {
            return reject(new Error(`重定向次数超过上限（${MAX_REDIRECTS}）：${url}`));
          }
          return fetchHtml(redirectUrl, timeout, hops + 1).then(resolve).catch(reject);
        }
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 400) {
          return reject(new Error(`HTTP ${res.statusCode ?? 0} for ${url}`));
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve(buf.toString("utf8"));
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(timeout, () =>
      req.destroy(new Error(`Timeout ${url}`))
    );
    req.on("error", reject);
  });
}

// ── HTML 解析 ────────────────────────────────────────────────

function parseNewsList(html: string, baseUrl: string): NewsItem[] {
  const items: NewsItem[] = [];

  // <ul class="my-list"><li><a href="...">标题</a><span class="date">日期</span></li></ul>
  const listMatch = html.match(
    /<ul[^>]*class="my-list"[^>]*>([\s\S]*?)<\/ul>/i
  );
  if (!listMatch) return items;

  const liRegex = /<li>([\s\S]*?)<\/li>/gi;
  let liMatch: RegExpExecArray | null;
  while ((liMatch = liRegex.exec(listMatch[1])) !== null) {
    const aMatch = liMatch[1].match(
      /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
    );
    if (!aMatch) continue;
    const title = aMatch[2].replace(/<[^>]+>/g, "").trim();
    if (title.length < 4) continue;

    const dateMatch = liMatch[1].match(
      /<span[^>]*class="date"[^>]*>([^<]+)<\/span>/i
    );
    const date = dateMatch ? dateMatch[1].trim() : "";

    let fullUrl: string;
    try {
      fullUrl = new URL(aMatch[1], baseUrl).href;
    } catch {
      fullUrl =
        baseUrl.replace(/\/[^/]*$/, "") +
        aMatch[1].replace(/^\.\./, "");
    }

    items.push({ title, url: fullUrl, date });
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
}

// ── 主函数 ──────────────────────────────────────────────────

/**
 * 抓取教务处通知
 * @param existingItems - 已有的通知列表（用于合并去重）
 * @param maxItems - 返回条数上限（默认 20）
 */
export async function fetchJwcNews(
  existingItems: NewsItem[] = [],
  maxItems = 20
): Promise<NewsItem[]> {
  const allItems: NewsItem[] = [];

  for (const { label, url } of TARGETS) {
    try {
      const html = await fetchHtml(url);
      const items = parseNewsList(html, url);
      for (const item of items) item.category = label;
      allItems.push(...items);
    } catch {
      // Skip failed category
    }
  }

  if (allItems.length > 0) {
    // Merge with existing, deduplicate by URL, keep latest
    const merged = [
      ...allItems,
      ...existingItems.filter(
        (e) => !allItems.some((n) => n.url === e.url)
      ),
    ];
    merged.sort((a, b) => b.date.localeCompare(a.date));
    return merged.slice(0, maxItems);
  }

  // No new items - return existing
  return existingItems;
}

// ── 通知正文抓取 ────────────────────────────────────────────

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
  const html = await fetchHtml(url);
  const title =
    html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim().replace(/-南京工业大学教务处.*$/, "") ?? "";

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
  for (const m of html.matchAll(
    /<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,150}?)<\/a>/gi
  )) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    const isDownload =
      href.includes("download.jsp") || href.includes("DownloadAttachUrl");
    const hasExt = /\.(xls|xlsx|pdf|doc|docx|zip|rar|wps)(?:[?#]|$)/i.test(href);
    if (!isDownload && !hasExt) continue;
    if (!text || text.length < 3) continue;
    try {
      const full = new URL(href, url).href;
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
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(html)) !== null) {
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
