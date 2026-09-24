/**
 * 通知情报工具：get_news / read_notice / fetch_attachment
 * 通知相关性评分（relevanceOf）在 core/notices，与网页通知面板共用。
 */

import { tool } from "ai";
import { z } from "zod";
import { fetchAttachment } from "../../../core/attachments";
import { config } from "../../../core/config";
import { loadUserGrade } from "../../../core/memory/longterm";
import { relevanceOf } from "../../../core/notices";
import { fetchJwcArticle, fetchJwcNews } from "../news";

// ── 通知相关性 ────────────────────────────────────────────────
// 教务处一次发十几条，其中大半跟具体某个学生无关。过去全靠模型逐条判断，
// 判断质量时好时坏；这里按「是否点名本年级 / 是否需本人行动」固化成规则。

// ── 工具定义 ─────────────────────────────────────────────────

export const newsTools = {
  /** 教务处官网通知 */
  get_news: tool({
    description:
      "抓取南京工业大学教务处官网（jwc.njtech.edu.cn）的最新通知，涵盖三个板块：公告通知（含选课/考试/学籍等重要安排）、教学动态、考试排课。公开页面无需登录。用户问「最近有什么教务通知」「选课什么时候开始」「有没有关于××的通知」时调用。每条带 relevance：high=需本人行动（点名本年级或全校性必办）、medium=视个人情况（补修/重修/转专业等）、low=基本无关（其他年级或行政公示）。回答时优先讲 high 的，low 的一句带过，不要平铺全部。",
    inputSchema: z.object({
      category: z
        .enum(["公告通知", "教学动态", "考试排课"])
        .optional()
        .describe("只看某个板块（可选，默认全部）"),
      limit: z.number().int().min(1).max(30).default(10).describe("返回条数（默认 10）"),
    }),
    execute: async ({ category, limit }) => {
      const items = await fetchJwcNews([], 30);
      const filtered = category ? items.filter((i) => i.category === category) : items;
      const grade = await loadUserGrade();
      const scored = filtered.slice(0, limit).map((i) => {
        const { level, reason } = relevanceOf(i.title, grade);
        return {
          title: i.title,
          date: i.date,
          category: i.category,
          /** high=需本人行动 / medium=视情况 / low=基本无关 */
          relevance: level,
          relevanceReason: reason,
          url: i.url,
          /** true=官网设置了访问权限：原文页与 read_notice 匿名都打不开，向用户如实说明，别当成工具故障 */
          restricted: i.restricted || undefined,
        };
      });
      const mustSee = scored.filter((i) => i.relevance === "high").length;
      return {
        total: filtered.length,
        /** 年级依据；取不到就退化成纯关键词判断 */
        gradeBasis: grade ?? undefined,
        mustSeeCount: mustSee,
        items: scored,
        note:
          filtered.length === 0
            ? "未抓到通知（官网结构可能变化或网络异常）"
            : grade
              ? `已按你所在「${grade} 级」标记相关性：high ${mustSee} 条需要你行动。回答时先给 high 的，low 的一条带过即可。`
              : "未识别到你的年级，相关性按关键词粗判。",
      };
    },
  }),

  /** 通知正文阅读 */
  read_notice: tool({
    description:
      "读取学校官网任意文章页面的正文全文（webplus CMS 结构解析）。两种用法：① 读 get_news 列表里的通知（用 items[].url）；② 直接读用户贴出来的链接（如 https://jwc.njtech.edu.cn/info/1158/6876.htm，用户发来 jwc/学校官网链接时就用本工具读）。返回标题、正文全文与附件下载链接。",
    inputSchema: z.object({
      url: z.string().describe("文章页 URL（jwc.njtech.edu.cn 或其他 njtech.edu.cn 子域）"),
    }),
    execute: async ({ url }) => {
      if (!/^https?:\/\/[a-z0-9.-]*\.njtech\.edu\.cn\//.test(url)) {
        return { error: "仅支持 njtech.edu.cn 域名下的文章 URL" };
      }
      try {
        const article = await fetchJwcArticle(url);
        const MAX = 6000;
        return {
          title: article.title,
          text: article.text.slice(0, MAX),
          truncated: article.text.length > MAX || undefined,
          attachments: article.attachments.length ? article.attachments : undefined,
          note:
            article.text.length === 0
              ? "正文为空（可能内容在附件里，见 attachments；或页面结构变化）"
              : undefined,
        };
      } catch (e) {
        return { error: `通知抓取失败：${(e as Error).message.slice(0, 100)}` };
      }
    },
  }),

  /** 附件获取（自动缓存，表格回概览、长文可分页/检索） */
  fetch_attachment: tool({
    description:
      "获取并解析通知的文件附件（URL 与文件名来自 read_notice 返回的 attachments）。自动落盘缓存：同一附件再查不用重新下载。xlsx/xls/csv 表格 → 回概览（表头+每 sheet 前 15 行+总行数），千行明细必须用 query_table 按关键词/条件筛选，别想着一口读完；docx/pdf/txt → 全文分页（offset/limit 续读）或直接 keyword 定位（返回含关键词的上下文段落，适合找「我的专业/班级/时间」）。问「附件里有哪些课」「网课目录读一下」时调用。",
    inputSchema: z.object({
      url: z.string().describe("附件下载 URL（read_notice 返回的 attachments[].url）"),
      name: z
        .string()
        .optional()
        .describe("附件文件名（read_notice 返回的 attachments[].name，含扩展名）"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("长文本续读起点（用上次返回的 nextOffset）"),
      limit: z
        .number()
        .int()
        .min(500)
        .max(20000)
        .optional()
        .describe("长文本单页长度（默认 6000）"),
      keyword: z.string().optional().describe("长文本关键词定位：只回含该词的上下文片段，省去通读"),
      refresh: z.boolean().optional().describe("忽略缓存强制重新下载（默认用缓存）"),
    }),
    execute: async ({ url, name, offset, limit, keyword, refresh }) => {
      const isNjtech = /^https?:\/\/[a-z0-9.-]*\.njtech\.edu\.cn\//.test(url);
      if (!isNjtech && !config.firecrawlApiKey) {
        return {
          error: "仅支持 njtech.edu.cn 域名的附件（未配置 FIRECRAWL_API_KEY 时）",
        };
      }
      try {
        return await fetchAttachment(url, name, { offset, limit, keyword, refresh });
      } catch (e) {
        return { error: `附件获取失败：${(e as Error).message.slice(0, 120)}` };
      }
    },
  }),
};
