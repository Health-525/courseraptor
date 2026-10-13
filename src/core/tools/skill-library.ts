/**
 * 教学法技能库工具：read_skill
 *
 * 11 篇教学法与讲法类 skill 按需加载（内容常量在 core/skill-library.ts，
 * 由 scripts/build-skill-library.ts 从 skills/openmaic/ 原文生成）。
 * basePrompt 只带一句路由，具体流程让模型按需取——避免 60KB 教学法常驻
 * 系统提示词。
 *
 * 与 read_learning_reference 的分工：那边是认知科学方法论（怎么教、怎么练、
 * 怎么诊断），这边是教学流程与讲法（怎么排一堂课、用哪种讲法推进）。
 */

import { tool } from "ai";
import { z } from "zod";

import { SKILL_LIBRARY, skillLibraryMenu } from "../skill-library";

export const skillTools = {
  /** 教学法技能库（教学流程与讲法，原文来自 OpenMAIC skill 集） */
  read_skill: tool({
    description: `教学法技能库（${SKILL_LIBRARY.length} 篇，教学流程与讲法）。用户要排一套课/系列复习、按某种讲法讲透某个主题、要费曼式讲给外行听、要动手实操带练、要机制演示或实训步骤时，先读对应篇目再组织回答：${skillLibraryMenu()}。与 read_learning_reference 配套但不重叠——那边管认知科学方法论（怎么教怎么练怎么诊断），这边管课堂流程与讲法编排。只收教学法与讲法，不含课堂文档构建；一次只取当前需要的一篇，读完按它的流程走，别凭印象编。`,
    inputSchema: z.object({
      skill: z
        .enum(SKILL_LIBRARY.map((s) => s.id) as [string, ...string[]])
        .describe("skill id，见工具说明里的场景对照"),
    }),
    execute: async ({ skill }) => {
      const doc = SKILL_LIBRARY.find((s) => s.id === skill);
      if (!doc) {
        return {
          error: `没有这篇 skill（${skill}），可用：${SKILL_LIBRARY.map((s) => s.id).join("、")}`,
        };
      }
      return {
        id: doc.id,
        title: doc.title,
        content: doc.content,
        note: "原文含该 skill 的适用范围与「不要用于」场景，按它划定的边界执行",
      };
    },
  }),
};
