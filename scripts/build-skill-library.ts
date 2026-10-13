/**
 * 生成 src/core/skill-library.ts —— 把 skills/openmaic/ 的教学法 skill
 * 内联成运行时常量，供 read_skill 工具按需调阅。
 *
 * 为什么要生成而不是运行时读文件：学生端安装包不带 skills/ 目录（见
 * package-policy.mjs 白名单），运行时读文件会缺源。core/learning.ts 已用
 * 同一手法内联七篇参考文档。
 *
 * 为什么用 JSON 转义而不是模板字符串：markdown 正文里有大量反引号与 ${}，
 * 塞进 TS 模板字符串会被外层截断或吃掉转义。
 *
 * 收录清单与清洗规则在 scripts/skill-library-source.ts（与测试共用）。
 * 用法：node --import tsx scripts/build-skill-library.ts
 * 改收录范围/清洗规则 → 重跑本脚本 → 提交生成物；tests/skill-library.test.ts
 * 会逐篇比对生成物与「原文经同一套规则清洗后的结果」，漂移即红。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_SOURCES, sanitizeBody, stripFrontmatter } from "./skill-library-source";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC_DIR = path.join(ROOT, "skills", "openmaic");
const OUT = path.join(ROOT, "src", "core", "skill-library.ts");

const entries = SKILL_SOURCES.map(({ id, when }) => {
  const raw = fs.readFileSync(path.join(SRC_DIR, id, "SKILL.md"), "utf8");
  const titleMatch = stripFrontmatter(raw).match(/^#\s+(.*)$/m);
  const title = titleMatch?.[1]?.trim() ?? id;
  const content = sanitizeBody(id, raw, SKILL_SOURCES);
  return `  {
    id: ${JSON.stringify(id)},
    title: ${JSON.stringify(title)},
    when: ${JSON.stringify(when)},
    content: ${JSON.stringify(content)},
  },`;
}).join("\n");

const file = `/**
 * 教学法技能库（内容常量）—— read_skill 工具的数据源
 *
 * ⚠️ 本文件由 scripts/build-skill-library.ts 生成，**不要手改**。
 * 改收录范围或清洗规则后重跑：node --import tsx scripts/build-skill-library.ts
 * tests/skill-library.test.ts 会逐篇比对生成物与清洗结果，防漂移。
 *
 * 原文来源：skills/openmaic/（THU-MAIC/OpenMAIC，MIT，见该目录 LICENSE），
 * 收录 ${SKILL_SOURCES.length} 篇教学法与讲法类 skill。原文在 skills/openmaic/
 * 一字未改；内联进这里前做了清洗——丢掉纯平台流程的章节、把 OpenMAIC 的
 * create_stage/read_stage 等工具名换成中文动作描述，避免模型据此编造
 * 不存在的工具调用（理由与规则见 scripts/skill-library-source.ts）。
 *
 * 与 core/learning.ts 的分工：那边是认知科学**方法论**（怎么教、怎么练、
 * 怎么诊断），这边是**教学流程与讲法**（怎么排一堂课、用哪种讲法推进）。
 * 两边都是纯提示词，按需取用，不要全塞进系统提示词。
 */

export interface SkillDoc {
  /** 稳定 id：与 skills/openmaic/<id>/ 同名 */
  id: string;
  title: string;
  /** 何时读它（拼进工具 description，指导模型按需选择） */
  when: string;
  content: string;
}

export const SKILL_LIBRARY: SkillDoc[] = [
${entries}
];

/** 工具 description 用的选篇指南（按「场景→读哪篇」拼装） */
export function skillLibraryMenu(): string {
  return SKILL_LIBRARY.map((s) => \`\${s.when}→\${s.id}\`).join("；");
}
`;

fs.writeFileSync(OUT, file, "utf8");
console.log(
  `已生成 ${path.relative(ROOT, OUT)}：${SKILL_SOURCES.length} 篇，${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`,
);
