/**
 * 生成 src/core/skill-library.ts —— 把 skills/<id>/ 的 allowlist skill
 * 内联成运行时常量，供 read_skill 工具按需调阅。
 *
 * 为什么要生成而不是运行时读文件：学生端安装包不带 skills/ 目录（见
 * package-policy），运行时读文件会缺源。
 *
 * 收录清单与清洗规则在 scripts/skill-library-source.ts（与测试共用）。
 * 用法：node --import tsx scripts/build-skill-library.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_SOURCES, sanitizeBody, stripFrontmatter } from "./skill-library-source";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILLS_DIR = path.join(ROOT, "skills");
const OUT = path.join(ROOT, "src", "core", "skill-library.ts");

const entries = SKILL_SOURCES.map(({ id, when }) => {
  const raw = fs.readFileSync(path.join(SKILLS_DIR, id, "SKILL.md"), "utf8");
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
 * 技能库（内容常量）—— read_skill 工具的数据源
 *
 * ⚠️ 本文件由 scripts/build-skill-library.ts 生成，**不要手改**。
 * 改收录范围或清洗规则后重跑：node --import tsx scripts/build-skill-library.ts
 * tests/skill-library.test.ts 会逐篇比对生成物与清洗结果，防漂移。
 *
 * 原文平级存放于 skills/<id>/（OpenMAIC 学习类来自 THU-MAIC/OpenMAIC，MIT，
 * 见 skills/openmaic/LICENSE）。当前 allowlist：学习类 6 篇 + export-schedule。
 * 入库前清洗：丢掉纯平台/外部 CLI 章节、替换 OpenMAIC 工具名为中文动作描述。
 */

export interface SkillDoc {
  /** 稳定 id：与 skills/<id>/ 同名 */
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
