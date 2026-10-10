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
import { fetchJwcArticle, fetchJwcNewsMemo } from "../news";

// ── 通知相关性 ────────────────────────────────────────────────
// 教务处一次发十几条，其中大半跟具体某个学生无关。过去全靠模型逐条判断，
// 判断质量时好时坏；这里按「是否点名本年级 / 是否需本人行动」固化成规则。

// ── 工具定义 ─────────────────────────────────────────────────

export const newsTools = {
  /** 教务处官网通知 */
  get_news: tool({
    description:
      "查询南京工业大学教务处官网（jwc.njtech.edu.cn）的通知，涵盖三个板块：公告通知（含选课/考试/学籍等重要安排）、教学动态、考试排课。**默认走本地磁盘缓存不联网**（缓存由上一次显式刷新或首次运行建立）——反复直连官网既有被 WAF 盯上的风险、校外还会撞「限校内 IP」拦截。仅当用户明确说「刷新通知 / 有没有新的 / 重新抓一次 / 最新的通知」时才传 refresh=true 强制联网重抓并写回磁盘。用户问「最近有什么教务通知」「选课什么时候开始」「有没有关于××的通知」时调用。返回带 staleAt 时说明数据来自本地缓存快照，如实转述抓取时间。每条带 relevance：high=需本人行动（点名本年级或全校性必办）、medium=视个人情况（补修/重修/转专业等）、low=基本无关（其他年级或行政公示）。回答时优先讲 high 的，low 的一句带过，不要平铺全部。",
    inputSchema: z.object({
      category: z
        .enum(["公告通知", "教学动态", "考试排课"])
        .optional()
        .describe("只看某个板块（可选，默认全部）"),
      limit: z.number().int().min(1).max(30).default(10).describe("返回条数（默认 10）"),
      refresh: z
        .boolean()
        .optional()
        .describe(
          "true=清进程内快照并强制联网重抓官网三页（仅在用户明确说「刷新/有没有新的/重新抓/最新」时传）；不传或 false=优先返回本地磁盘缓存快照，缓存缺失才联网一次",
        ),
    }),
    execute: async ({ category, limit, refresh }) => {
      // refresh=true 透传给 fetchJwcNewsMemo，内部会清 memo 强制联网；
      // 默认路径下 memo 未命中会先读磁盘缓存，磁盘缺失才联网抓一次并写盘
      const { items: fetched, staleAt } = await fetchJwcNewsMemo(30, refresh === true);
      const filtered = category ? fetched.filter((i) => i.category === category) : fetched;
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
      // 通道说明：staleAt 表示本次返回的是磁盘缓存快照（默认路径或直连失败降级），
      // 抓取时间必须如实告知，不能当新鲜数据；用户明确要最新时应传 refresh=true
      const channelNote =
        staleAt !== undefined
          ? `ℹ️ 本次未联网，返回本地缓存的通知快照（抓取于 ${new Date(staleAt).toLocaleString("zh-CN")}），可能已过期。用户若明确说「刷新通知 / 有没有新的 / 最新的」，重新调用并传 refresh=true。`
          : "";
      return {
        total: filtered.length,
        /** 年级依据；取不到就退化成纯关键词判断 */
        gradeBasis: grade ?? undefined,
        mustSeeCount: mustSee,
        /** true = 本次未联网，数据来自本地磁盘缓存快照 */
        fromCache: staleAt !== undefined ? true : undefined,
        savedAt: staleAt,
        items: scored,
        note:
          filtered.length === 0
            ? "未抓到通知（官网结构可能变化或网络异常）"
            : [
                grade
                  ? `已按你所在「${grade} 级」标记相关性：high ${mustSee} 条需要你行动。回答时先给 high 的，low 的一条带过即可。`
                  : "未识别到你的年级，相关性按关键词粗判。",
                channelNote,
              ]
                .filter(Boolean)
                .join(" "),
      };
    },
  }),

  /** 通知正文阅读 */
  read_notice: tool({
    description:
      "读取学校官网任意文章页面的正文全文（webplus CMS 结构解析）。两种用法：① 读 get_news 列表里的通知（用 items[].url）；② 直接读用户贴出来的链接（如 https://jwc.njtech.edu.cn/info/1158/6876.htm，用户发来 jwc/学校官网链接时就用本工具读）。返回标题、正文全文与附件下载链接。正文内嵌 PDF 的通知（如放假安排）会自动下载 PDF 解析出全文，PDF 原件同时列入 attachments（超长时可用 fetch_attachment 分页续读）。",
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
