/** AI 新闻工具：复用当前对话模型写摘要，采集和校验由 Python 引擎负责。 */
import { tool } from "ai";
import { z } from "zod";

import { runAiNews } from "../ai-news";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("YYYY-MM-DD，省略按上海今天；历史日期只读已有记录");
const offset = z.number().int().min(0).max(100_000).default(0);
const limit = z.number().int().min(1).max(20).default(8);

export const aiNewsTools = {
  prepare_ai_news: tool({
    description:
      "采集并冻结今日 AI 新闻来源，或分页读取已冻结来源。先 read_skill(ai-news)。不会生成摘要或发送消息；重复调用复用当天快照。按 next_offset 继续读取，不能只读第一页就声称覆盖全天。",
    inputSchema: z.object({ date, offset, limit }),
    execute: async (input, { abortSignal }) => runAiNews("prepare", input, abortSignal),
  }),
  save_ai_news_digest: tool({
    description:
      "分批保存 AI 新闻来源摘要；每条必须来自自己的 source_text。携带 prepare 返回的来源指纹，使用来源原始 url。finalize=false 保存草稿；全部来源处理完后 finalize=true 校验并冻结本地 Markdown 日报。0–6 条重点，仅可选 recommended_highlight=true 的不同事件。校验失败先修正，不要绕过。",
    inputSchema: z.object({
      date,
      source_set_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      entries: z
        .array(
          z.object({
            url: z.string().url(),
            summary: z
              .string()
              .min(1)
              .max(2500)
              .describe(
                "单段中文来源摘要，数字须有来源支持；不可用项精确保留原因；补录项加发布日期前缀",
              ),
            highlight: z.boolean().default(false),
          }),
        )
        .max(20),
      finalize: z.boolean().default(false),
    }),
    execute: async (input, { abortSignal }) => runAiNews("save", input, abortSignal),
  }),
  query_ai_news: tool({
    description:
      "查询已保存的 AI 日报、冻结来源中的突发简报，或本地采集历史的 2–31 天趋势。daily 返回全部重点与分页记录；breaking 附本条证据；trend 仅反映实际采集历史。缺历史或日报尚未生成时如实说明。不会自动联网采集。",
    inputSchema: z.object({
      kind: z.enum(["daily", "breaking", "trend"]).default("daily"),
      date,
      days: z.number().int().min(2).max(31).default(7),
      offset,
      limit,
    }),
    execute: async (input, { abortSignal }) => runAiNews("query", input, abortSignal),
  }),
};
