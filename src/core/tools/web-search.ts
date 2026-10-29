/**
 * 联网搜索工具：web_search / web_fetch（DeepSeek 官方 Search / Fetch API）
 */

import { tool } from "ai";
import { z } from "zod";

import { fetchWebPage, searchWeb } from "../web-search";

export const webSearchTools = {
  /** 联网搜索 */
  web_search: tool({
    description:
      '联网搜索（DeepSeek 官方 Search API）：查时效性信息——新闻、政策与比赛/活动时间、软件版本、价格、课程之外的「最新/最近/今年」类问题，以及你训练数据截止之后发生的事。支持运算符：site: 限定站点（多个用 OR 连接）、"短语" 精确匹配、-词 排除、lang:zh,en 限定语言、after:2026-01-01 限定日期。稳定的知识（概念、公式、常识）不要搜，教务通知走 get_news、AI 行业新闻走 ai-news。一次一个聚焦的查询（搜索按次计费，别为同一问题反复刷）；换关键词重搜只试一次。结果带 authority（0-4 站点权威度，≥3 高可信）与 rerankScore（≥1.5 高相关），回答时按相关度取舍并附来源链接。需要某条结果的完整正文时再用 web_fetch。',
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(128)
        .describe("搜索词，1-128 字，可直接带 site:/lang:/after: 等运算符"),
      count: z.number().int().min(1).max(20).default(8).describe("结果条数，默认 8（最多 20）"),
    }),
    execute: async ({ query, count }) => {
      const r = await searchWeb(query, { count });
      if (!r.ok) {
        // 与课表/天气同一套契约：查不到 ≠ 没有相关信息，绝不让模型拿空结果编「网上没有」
        return {
          error: `联网搜索失败：${r.error}。请如实告知用户，不要凭印象编造「最新」信息。`,
        };
      }
      const { hits } = r.data;
      return {
        query: r.data.query,
        results: hits.map((h) => ({
          title: h.title,
          url: h.url,
          snippet: h.snippet,
          summary: h.summary,
          siteName: h.siteName,
          date: h.date,
          authority: h.authority,
          rerankScore: h.rerankScore,
        })),
        note: hits.length
          ? undefined
          : "没有搜到相关结果。可换一个关键词再试一次；仍没有就如实告知用户，不要编造。",
      };
    },
  }),

  /** 读网页正文 */
  web_fetch: tool({
    description:
      "读取网页正文（DeepSeek 官方 Fetch API）：把 URL 的页面转成 Markdown 返回。用户贴出具体链接让你读/总结/翻译时直接调用；web_search 命中后需要读某条来源的全文时也可用。超长正文会被截断（约 2 万字）。本校教务处官网内容不走它（get_news / read_notice 优先）。",
    inputSchema: z.object({
      url: z.string().url().describe("要读取的网页链接（http/https）"),
    }),
    execute: async ({ url }) => {
      const r = await fetchWebPage(url);
      if (!r.ok) {
        return { error: `网页读取失败：${r.error}。换一个来源，或让用户自己打开链接看。` };
      }
      return {
        title: r.data.title,
        url,
        content: r.data.content,
        truncated: r.data.truncated,
        note: r.data.truncated
          ? "正文超过长度上限已截断，后半部分没读到；需要完整内容时让用户打开原文链接。"
          : undefined,
      };
    },
  }),
};
