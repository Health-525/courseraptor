/**
 * 运行时技能库的**收录清单与原文清洗规则**——生成器与测试共用同一份。
 *
 * 目录约定：skills/<id>/SKILL.md 平级存放（OpenMAIC 原文已从 openmaic/ 迁出）。
 * 为什么要清洗：OpenMAIC 正文里通篇是它自己工具链的调用步骤；原样喂给
 * 本项目模型会去调不存在的工具。清洗只做两件事：
 *   1. 丢掉纯平台流程的章节；
 *   2. 把剩下的工具名换成中文动作描述。
 *
 * 本期 allowlist：学习类 6 篇 + export-schedule（课表卡片）+ ai-news。
 */

export interface SkillSource {
  /** 与 skills/<id>/ 同名 */
  id: string;
  /** 何时读它（拼进工具 description） */
  when: string;
  /** 整节丢弃的章节标题（纯平台流程 / 外部 CLI 话术） */
  dropSections: string[];
}

/** 当前进 agent 的 skill（改这里 → 重跑 build-skill-library） */
export const SKILL_SOURCES: SkillSource[] = [
  {
    id: "feynman-learning",
    when: "费曼学习法/讲给外行听/暴露理解缺口",
    dropSections: ["搭建与验收"],
  },
  {
    id: "learning-to-learn",
    when: "把学习策略与元认知嵌进某次讲解",
    dropSections: [],
  },
  {
    id: "zone-of-proximal-development",
    when: "习题诊断/讲题补差/最近发展区带练",
    dropSections: ["落到 OpenMAIC 页面"],
  },
  {
    id: "understanding-by-design",
    when: "逆向设计一堂课/大概念与基本问题/表现性任务",
    dropSections: [],
  },
  {
    id: "spiral-curriculum",
    when: "螺旋式复习/概念跨课升阶/多课概念重访",
    dropSections: ["第二层：Generate Lessons"],
  },
  {
    id: "curriculum-planner",
    when: "系列复习/多日学习计划/先签核再执行",
    dropSections: ["`ask_user` ends the run", "The execution loop", "When something fails"],
  },
  {
    id: "export-schedule",
    when: "导出课表图/课表卡片/本周或整学期课表图片",
    dropSections: ["仓库内调用", "打成独立技能包（供他人下载）"],
  },
  {
    id: "ai-news",
    when: "AI 新闻/模型动态/开源雷达/行业日报/突发简报/近期趋势",
    dropSections: [],
  },
];

/** OpenMAIC 专有工具名 → 中文动作描述（顺序敏感：长名在前） */
const TOOL_RENAMES: Array<[string, string]> = [
  ["read_stage_outline", "读取课堂大纲"],
  ["declareAssetReferenceTracking", ""],
  ["materialFacts", "材料事实"],
  ["generate_actions", "补写旁白"],
  ["generate_scene", "生成页面"],
  ["generate_tts", "合成语音"],
  ["duplicate_scene", "复制页面"],
  ["import_pptx", "导入 PPT"],
  ["list_materials", "列出材料"],
  ["read_material", "读取材料"],
  ["create_folder", "建系列文件夹"],
  ["set_roster", "设定课堂角色"],
  ["list_scenes", "列出页面"],
  ["patch_stage", "改写课堂"],
  ["create_stage", "建课堂"],
  ["read_stage", "读取课堂"],
  ["web_search", "联网检索"],
  ["fetch_url", "抓取网页"],
  ["ask_user", "向用户确认"],
];

/** 出现即视为「原文没清洗干净」，生成器与测试都拿它当哨兵 */
export const GHOST_TOOLS = [
  "create_stage",
  "set_roster",
  "generate_scene",
  "generate_actions",
  "generate_tts",
  "list_scenes",
  "read_stage",
  "patch_stage",
  "duplicate_scene",
  "import_pptx",
  "create_folder",
  "ask_user",
  "web_search",
  "fetch_url",
];

/** 去掉 frontmatter，返回正文（生成器与测试都用这个） */
export function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!m) throw new Error("找不到 frontmatter");
  return raw.slice(m[0]?.length ?? 0);
}

/** 按标题整节丢弃（## 与 ### 都支持，含该节全部正文直到下一同级或更高级标题） */
function dropSections(body: string, titles: string[]): string {
  if (!titles.length) return body;
  const lines = body.split("\n");
  const kept: string[] = [];
  let dropping = false;
  let dropLevel = 0;
  for (const line of lines) {
    const h = line.match(/^(#{2,6})\s+(.*)$/);
    if (h) {
      const level = h[1]?.length ?? 0;
      const title = (h[2] ?? "").trim();
      if (dropping && level <= dropLevel) dropping = false;
      if (!dropping && titles.includes(title)) {
        dropping = true;
        dropLevel = level;
        continue;
      }
    }
    if (!dropping) kept.push(line);
  }
  return kept.join("\n");
}

/** 原文 → 可入内联常量的正文 */
export function sanitizeBody(id: string, raw: string, sources: SkillSource[]): string {
  const src = sources.find((s) => s.id === id);
  if (!src) throw new Error(`未登记的 skill：${id}`);
  let body = stripFrontmatter(raw.replace(/\r\n/g, "\n"));
  body = dropSections(body, src.dropSections);
  for (const [from, to] of TOOL_RENAMES) {
    body = body.split(from).join(to || from);
  }
  body = body
    .split("\n")
    .filter((l) => !/先加载\s*`?\/?(stage-design|curriculum-planner|slide-dsl|stage-dsl)/.test(l))
    .join("\n");

  if (id === "export-schedule") {
    body = `${body}

## CourseRaptor 对话内用法

在本产品对话中**不要跑 CLI / 不要开浏览器截图**。用户要课表图或课表卡片时，直接调用工具 \`export_schedule_image\`（读本地课表缓存渲染，与网页「本周图片 / 整学期图片」同一渲染器）。缺缓存时如实告诉用户先导入或查询课表，不要编造课表。`;
  }

  const ghosts = GHOST_TOOLS.filter((g) => body.includes(g));
  if (ghosts.length) {
    throw new Error(`${id}: 清洗后仍残留 OpenMAIC 工具名 ${ghosts.join("、")}`);
  }
  return body.replace(/\n{3,}/g, "\n\n").trim();
}
