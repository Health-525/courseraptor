/**
 * 通知附件获取
 *
 * 两级策略：
 * 1. 配置了 FIRECRAWL_API_KEY 时走 Firecrawl 云（api.firecrawl.dev）
 *    把 PDF/DOC/XLS 附件解析成 markdown 直接返回给 agent 阅读
 * 2. 无 Key（或云解析失败）时下载到本地 downloads/ 目录，返回路径
 *
 * 注意：仅用于公开网站附件；需登录态的教务系统资源不走 Firecrawl 云。
 */

import fs from "node:fs/promises";
import path from "node:path";

import { config, PROJECT_ROOT } from "./config";

const FIRECRAWL_API = "https://api.firecrawl.dev/v1/scrape";
const MARKDOWN_LIMIT = 12000;

export type AttachmentResult =
  | {
      mode: "firecrawl";
      markdown: string;
      truncated: boolean | undefined;
    }
  | {
      mode: "download" | "download-fallback";
      path: string;
      size: number;
      contentType: string;
      hint?: string;
      error?: string;
    };

/** 调 Firecrawl scrape API，返回 markdown */
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

/** 下载文件到 downloads/ 目录 */
async function downloadFile(
  url: string
): Promise<{ path: string; size: number; contentType: string }> {
  const dir = path.join(PROJECT_ROOT, "downloads");
  await fs.mkdir(dir, { recursive: true });
  const rawName =
    decodeURIComponent(new URL(url).pathname.split("/").pop() || "") ||
    "attachment.bin";
  const safeName = rawName.replace(/[\\/:*?"<>|]/g, "_");
  const file = path.join(dir, `${Date.now()}-${safeName}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(file, buf);
  return {
    path: file,
    size: buf.length,
    contentType: res.headers.get("content-type") || "",
  };
}

/** 获取附件：Firecrawl 优先，本地下载兜底 */
export async function fetchAttachment(url: string): Promise<AttachmentResult> {
  if (config.firecrawlApiKey) {
    try {
      const markdown = await firecrawlScrape(url);
      return {
        mode: "firecrawl",
        markdown: markdown.slice(0, MARKDOWN_LIMIT),
        truncated: markdown.length > MARKDOWN_LIMIT || undefined,
      };
    } catch (e) {
      const dl = await downloadFile(url);
      return {
        mode: "download-fallback",
        ...dl,
        error: `Firecrawl 解析失败已转下载：${(e as Error).message.slice(0, 150)}`,
      };
    }
  }
  const dl = await downloadFile(url);
  return {
    mode: "download",
    ...dl,
    hint: "已保存到本地。在 .env 配置 FIRECRAWL_API_KEY 后可直接把附件解析成文本阅读",
  };
}
