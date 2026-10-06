/**
 * HEBAU 教务处通知爬虫（jiaowu.hebau.edu.cn，博达 webplus CMS）
 *
 * 结构与 NJTECH 教务处同族（栏目页 index/tzgg.htm + 文章页 info/<栏目>/<id>.htm），
 * 解析逻辑照 njtech/news.ts 改造；两处刻意差异：
 * 1. 无 WebVPN 降级阶梯——官网公网可访问（2026-10 实测直连正常），直连失败就
 *    如实报错回退缓存快照，不留一条实际用不上的通道；
 * 2. 列表解析不赌 `ul.my-list` 一个容器——本校模板的列表类名未逐页核对，
 *    先试 my-list，空了退化为「全页扫描 info/<digits>/<digits>.htm 锚点+日期」
 *    的通用策略，模板改版也不至于全线失效。
 */

import { pdfTextFromBuffer } from "../../core/attachments";
import { RaptorError } from "../../core/errors";
import { fetchUrlBuffer, fetchUrlText } from "../../core/http";
import { readJsonCache, writeJsonCache } from "../../core/json-cache";
import { logger } from "../../core/logger";
import type { NewsItem } from "../../core/model";
import type { SchoolNewsSnapshot } from "../../core/school";

const BASE_URL = "https://jiaowu.hebau.edu.cn";

const TARGETS = [
  { label: "通知公告", url: `${BASE_URL}/index/tzgg.htm` },
  { label: "教务动态", url: `${BASE_URL}/index/jwdt.htm` },
];

const NEWS_CACHE_FILE = "jiaowu-news-cache.json";

interface NewsCacheEnvelope {
  tag: "jiaowu-news";
  items: NewsItem[];
  fetchedAt: number;
}

/** 直连请求头：与浏览器一致，避免被官网 WAF 挡掉 */
const DIRECT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

/** 汉字与中文标点（判定软换行的字符集） */
const CJK_CLASS = "·—…“”‘’《》〈〉（）【】，。；：！？、\u4e00-\u9fff";

// ── HTML 抓取（直连）─────────────────────────────────────────

async function fetchHebauHtml(path: string): Promise<string> {
  const { status, text } = await fetchUrlText(`${BASE_URL}${path}`, {
    timeoutMs: 15_000,
    headers: DIRECT_HEADERS,
  });
  if (status >= 400) {
    throw new RaptorError("UPSTREAM", `教务处官网返回 HTTP ${status}（${path}）`);
  }
  return text;
}

// ── 内嵌 PDF 正文（webplus 把整篇通知做成 PDF 挂进页面）─────────

function isPdfBuffer(buf: Buffer): boolean {
  return buf.subarray(0, 4).toString("latin1") === "%PDF";
}

/**
 * 从页面片段里找内嵌 PDF 的站内路径：pdf.js viewer 的 file= 参数，
 * 或正文里直接挂的 /__local/*.pdf 链接。返回形如 /__local/B/56/xx.pdf 的路径。
 */
function findEmbeddedPdfPath(scope: string): string | null {
  const raw =
    scope.match(/viewer\.html\?file=([^"'&<>]+)/i)?.[1] ??
    scope.match(/(?:href|src)="(\/__local\/[^"'<>?\s]+\.pdf)"/i)?.[1];
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded.startsWith("/") ? decoded : null;
}

/** pdf-parse 输出排版噪声重（软换行/制表符/页标记），收敛成可读正文 */
function normalizePdfText(text: string): string {
  return (
    text
      .replace(/\r/g, "")
      .replace(/^-- \d+ of \d+ --$/gm, "") // pdf.js 的页标记
      .replace(/[ \t]{2,}/g, " ")
      // 中文软换行拼回：换行前是汉字/中文标点说明是折行而非分段
      //（后随空行=真分段，保留）
      .replace(new RegExp(`([${CJK_CLASS}])[ \\t]*\\n(?!\\n)`, "g"), "$1")
      .replace(new RegExp(`([${CJK_CLASS}])\\t+`, "g"), "$1")
      .replace(/\t/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ── HTML 解析 ────────────────────────────────────────────────

/** 从一个 <li> 片段里摘出（标题, 链接, 日期）；无 info 链接或标题过短的行跳过 */
function parseListItem(li: string, baseUrl: string): NewsItem | null {
  const aMatch = li.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!aMatch) return null;
  const href = aMatch[1];
  // 只收文章页链接：webplus 的静态 info/<栏目>/<文章>.htm，或设置了浏览权限的
  // article.jsp 动态入口（后者标 restricted，不能因为不匹配 info 形态就丢弃）
  const isArticle = /\/info\/\d+\/\d+\.htm/i.test(href) || /article\.jsp\?/i.test(href);
  if (!isArticle) return null;

  // 标题：优先 h1-h3 标题元素（本校模板是 <h2 class="l1">标题</h2>，锚文本里
  // 还混着日期与摘要，直接剥标签会把它们全拼进来）；无标题元素才退化锚文本。
  // 退化路径开头混入的「日 年.月」片段既要剥掉也要留着拼日期（真实日在这）
  const hMatch = aMatch[2].match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  let title: string;
  let fallbackDay: string | null = null;
  if (hMatch) {
    title = hMatch[1].replace(/<[^>]+>/g, "").trim();
  } else {
    const flat = aMatch[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const lead = flat.match(/^(\d{1,2})\s+(\d{4})[.](\d{1,2})\s*/);
    if (lead) {
      fallbackDay = lead[1];
      title = flat.slice(lead[0].length).trim();
    } else {
      title = flat;
    }
  }
  if (title.length < 4) return null;

  // 日期：本校模板是 mtdate 块（<span>20</span><p>2026.09</p> = 2026-09-20）；
  // 退化依次找标题前缀里的「日 年.月」、独立 YYYY-MM-DD、独立 YYYY.MM（补月初）
  let date = "";
  const mtdate = li.match(
    /<div[^>]*class="[^"]*mtdate[^"]*"[^>]*>[\s\S]*?<span[^>]*>(\d{1,2})<\/span>[\s\S]*?<p[^>]*>(\d{4})\.(\d{1,2})<\/p>/i,
  );
  const dash = li.match(/(\d{4}-\d{1,2}-\d{1,2})/);
  const ym = li.match(/(\d{4})\.(\d{1,2})/);
  if (mtdate) {
    date = `${mtdate[2]}-${mtdate[3].padStart(2, "0")}-${mtdate[1].padStart(2, "0")}`;
  } else if (fallbackDay && ym) {
    date = `${ym[1]}-${ym[2].padStart(2, "0")}-${fallbackDay.padStart(2, "0")}`;
  } else if (dash) {
    date = dash[1];
  } else if (ym) {
    date = `${ym[1]}-${ym[2].padStart(2, "0")}-01`;
  }

  let fullUrl: string;
  try {
    fullUrl = new URL(href, baseUrl).href;
  } catch {
    fullUrl = baseUrl.replace(/\/[^/]*$/, "") + href.replace(/^\.\./, "");
  }

  return {
    title,
    url: fullUrl,
    date,
    // 未静态化、设置了浏览权限的文章只有 article.jsp 动态入口，匿名打不开；
    // 静态 info/*.htm 则全站可看
    restricted: /article\.jsp\?.*urltype=news\.NewsContentUrl/i.test(fullUrl) || undefined,
  };
}

/** @internal 导出供离线单测注入真实页面片段 */
export function parseNewsList(html: string, baseUrl: string): NewsItem[] {
  const items: NewsItem[] = [];

  // 首选：与 njtech 同族的 my-list 容器
  const listMatch = html.match(/<ul[^>]*class="[^"]*my-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
  if (listMatch) {
    const liRegex = /<li>([\s\S]*?)<\/li>/gi;
    for (
      let liMatch = liRegex.exec(listMatch[1]);
      liMatch !== null;
      liMatch = liRegex.exec(listMatch[1])
    ) {
      const item = parseListItem(liMatch[1], baseUrl);
      if (item) items.push(item);
    }
  }

  // 退化：本校模板列表类名不同/改版时，全页扫 <li> 里的文章锚点。
  // 不依赖容器类名，只认「info 文章链接 + 标题」这对硬特征
  if (!items.length) {
    const liRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    for (let liMatch = liRegex.exec(html); liMatch !== null; liMatch = liRegex.exec(html)) {
      const item = parseListItem(liMatch[1], baseUrl);
      if (item) items.push(item);
    }
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

/**
 * 抓取教务处通知（带降级信息）。get_news 工具用这个版本。
 * 官网公网直连；直连全失败时回退落盘缓存快照（staleAt 标注）。
 */
export async function fetchHebauNewsDetailed(
  existingItems: NewsItem[] = [],
  maxItems = 20,
): Promise<SchoolNewsSnapshot> {
  const allItems: NewsItem[] = [];
  let lastError: Error | null = null;

  for (const { label, url } of TARGETS) {
    try {
      const html = await fetchHebauHtml(new URL(url).pathname + new URL(url).search);
      const items = parseNewsList(html, url);
      for (const item of items) item.category = label;
      allItems.push(...items);
    } catch (e) {
      lastError = e as Error;
      // 单个板块失败跳过，另一个板块还能出数据
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
      { tag: "jiaowu-news", items, fetchedAt: Date.now() } satisfies NewsCacheEnvelope,
      "jiaowu-news",
    );
    return { items };
  }

  // 全部板块失败：先看有没有可用的历史快照
  const cached = readJsonCache(NEWS_CACHE_FILE, isValidNewsCache);
  if (cached) {
    logger.warn("[jiaowu-news] 官网抓取失败，回退缓存快照", { error: lastError?.message });
    return { items: cached.items, staleAt: cached.fetchedAt };
  }

  throw lastError ?? new RaptorError("UPSTREAM", "教务处通知抓取失败（两个板块均无结果）");
}

function isValidNewsCache(parsed: unknown): parsed is NewsCacheEnvelope {
  const v = parsed as NewsCacheEnvelope | null;
  return (
    !!v &&
    v.tag === "jiaowu-news" &&
    Array.isArray(v.items) &&
    v.items.length > 0 &&
    typeof v.fetchedAt === "number"
  );
}

// ── 进程内 5 分钟快照：get_news 工具与网页通知面板共用 ────────────

const NEWS_MEMO_TTL_MS = 5 * 60_000;
let newsMemo: { result: SchoolNewsSnapshot; at: number } | null = null;
let newsMemoInflight: Promise<SchoolNewsSnapshot> | null = null;

export async function fetchNewsMemo(maxItems = 20): Promise<SchoolNewsSnapshot> {
  if (newsMemo && Date.now() - newsMemo.at < NEWS_MEMO_TTL_MS) {
    return newsMemo.result;
  }
  if (newsMemoInflight) return newsMemoInflight;
  newsMemoInflight = (async () => {
    const result = await fetchHebauNewsDetailed([], maxItems);
    if (result.staleAt === undefined) newsMemo = { result, at: Date.now() };
    return result;
  })();
  try {
    return await newsMemoInflight;
  } finally {
    newsMemoInflight = null;
  }
}

/** 测试用：清掉进程内快照与在途请求 */
export function clearNewsMemo(): void {
  newsMemo = null;
}

/**
 * 抓取教务处通知（兼容端口契约：只回列表，不抛错）。
 * welcome 横幅与网页通知面板走这个入口，失败时按各自 UI 降级展示。
 */
export async function fetchNews(
  existingItems: NewsItem[] = [],
  maxItems = 20,
): Promise<NewsItem[]> {
  try {
    return (await fetchHebauNewsDetailed(existingItems, maxItems)).items;
  } catch (e) {
    logger.error("[jiaowu-news] 抓取失败", { error: (e as Error).message });
    return existingItems;
  }
}

// ── 通知正文抓取 ──────────────────────────────────────────────

/**
 * 抓取一篇教务处通知的正文（webplus CMS 文章页）
 * 时间安排、开学/考试/选课日期都在正文里，列表页只有标题
 */
export async function fetchHebauArticle(url: string): Promise<{
  title: string;
  text: string;
  attachments: Array<{ name: string; url: string }>;
}> {
  if (!/^https?:\/\/[a-z0-9.-]*\.hebau\.edu\.cn\//i.test(url)) {
    throw new RaptorError("PARSE", "仅支持 hebau.edu.cn 域名下的文章 URL");
  }
  const u = new URL(url);
  const html = await fetchHebauHtml(u.pathname + u.search);
  // 权限文章匿名访问 302 到 auth.htm 后返回的仍是 HTTP 200 的鉴权提示页，
  // 不拦住的话这段「您无权访问此页面」会被当成正文往上转
  if (/您无权访问此页面/.test(html)) {
    throw new RaptorError("CAMPUS_ONLY", "该通知在官网设置了访问权限，匿名状态下读不到正文");
  }
  const title =
    html
      .match(/<title>([^<]*)<\/title>/i)?.[1]
      ?.trim()
      .replace(/-?河北农业大学教务处.*$/, "") ?? "";

  // 正文在 v_news_content / vsb_content 容器内；容器有嵌套 div，
  // 必须做配对计数提取（正则非贪婪会在第一个 </div> 截断）
  const containerHtml =
    extractDivBlock(html, /<div[^>]*class="[^"]*v_news_content[^"]*"[^>]*>/i) ??
    extractDivBlock(html, /<div[^>]*class="[^"]*vsb_content[^"]*"[^>]*>/i);
  let bodyHtml = containerHtml;
  if (!bodyHtml || htmlToText(bodyHtml).length < 200) {
    bodyHtml = html; // 容器缺失/过短时退化为整页剥离
  }

  // 附件扫描必须覆盖整页：webplus 的附件块在正文容器之外（页面尾部
  // <li>附件【<a href="/system/_content/download.jsp?...">名称.xlsx</a>】），
  // 且下载 URL 无文件后缀（文件名在链接文本里）
  const attachments: Array<{ name: string; url: string }> = [];
  for (const m of html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,150}?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    const isDownload = href.includes("download.jsp") || href.includes("DownloadAttachUrl");
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

  // 正文内嵌 PDF 的通知：下载抽文本替换导航壳，PDF 同时登记进
  // attachments（超长正文可让模型用 fetch_attachment 分页续读）
  let text = htmlToText(bodyHtml);
  const pdfPath = containerHtml
    ? (findEmbeddedPdfPath(containerHtml) ?? findEmbeddedPdfPath(html))
    : findEmbeddedPdfPath(html);
  if (pdfPath) {
    const pdfUrl = `${BASE_URL}${pdfPath}`;
    if (!attachments.some((a) => a.url === pdfUrl)) {
      attachments.push({ name: `${title || "通知正文"}.pdf`, url: pdfUrl });
    }
    try {
      const { buf } = await fetchUrlBuffer(`${BASE_URL}${pdfPath}`, {
        timeoutMs: 30_000,
        headers: DIRECT_HEADERS,
      });
      if (!isPdfBuffer(buf)) {
        throw new RaptorError("PARSE", "内嵌 PDF 下载失败：通道返回的不是 PDF 文件");
      }
      const parsed = await pdfTextFromBuffer(buf);
      if (parsed === null) {
        throw new RaptorError("PARSE", "PDF 文本抽取失败（文件损坏或扫描件）");
      }
      const pdfText = normalizePdfText(parsed);
      if (pdfText) text = pdfText;
    } catch (e) {
      logger.warn("[jiaowu-news] 内嵌 PDF 下载/解析失败，正文暂为页面壳文本", {
        error: (e as Error).message,
      });
    }
  }

  return { title, text, attachments };
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
