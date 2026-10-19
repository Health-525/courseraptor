/**
 * 技能库工具：read_skill
 *
 * allowlist 篇目按需加载（内容常量在 core/skill-library.ts，由
 * scripts/build-skill-library.ts 从 skills/<id>/ 生成）。系统提示词只带短路由。
 */

import { tool } from "ai";
import { z } from "zod";

import { SKILL_LIBRARY, skillLibraryMenu } from "../skill-library";

export const skillTools = {
  read_skill: tool({
    description: `学习、课表图与 AI 新闻技能库（${SKILL_LIBRARY.length} 篇，按需一篇）。学习类或 AI 新闻请求先读对应篇目再答：${skillLibraryMenu()}。一次只取当前需要的一篇，读完按它的流程与边界执行；教务查询与闲聊不要套用。课表图产出请调 export_schedule_image，不必为导出再读 export-schedule（除非要核对行为细节）。`,
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
        note: "按该 skill 划定的适用范围与「不要用于」边界执行",
      };
    },
  }),
};
