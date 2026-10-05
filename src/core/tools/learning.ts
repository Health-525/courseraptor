/**
 * 学习教练工具：read_learning_reference
 *
 * 六篇认知科学方法论文档按需加载（内容常量在 core/learning.ts，源自
 * skills/meta-learning，MIT-0）。basePrompt 只带精简触发规则，模型在
 * 学习类对话中按场景读对应一篇——避免把全部方法论常驻系统提示词。
 */

import { tool } from "ai";
import { z } from "zod";

import { LEARNING_REFERENCES, learningReferenceMenu } from "../learning";

export const learningTools = {
  /** 学习教练方法论参考 */
  read_learning_reference: tool({
    description: `学习教练方法论参考（认知科学，六篇）。学习类对话中按需取一篇：${learningReferenceMenu()}。讲解/备考/出题/诊断薄弱点前先读对应篇目再组织回答，不要凭印象编方法论；一次只取当前需要的一篇。`,
    inputSchema: z.object({
      doc: z
        .enum(LEARNING_REFERENCES.map((r) => r.id) as [string, ...string[]])
        .describe("参考文档 id，见工具说明里的场景对照"),
    }),
    execute: async ({ doc }) => {
      const ref = LEARNING_REFERENCES.find((r) => r.id === doc);
      if (!ref) {
        return {
          error: `没有这篇参考（${doc}），可用：${LEARNING_REFERENCES.map((r) => r.id).join("、")}`,
        };
      }
      return { title: ref.title, content: ref.content };
    },
  }),
};
