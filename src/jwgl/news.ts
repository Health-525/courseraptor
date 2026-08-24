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

function fetchHtml(url: string, timeout = 15000): Promise<string> {
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
          return fetchHtml(redirectUrl, timeout).then(resolve).catch(reject);
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
