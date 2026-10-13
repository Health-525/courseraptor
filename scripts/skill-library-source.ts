/**
 * 教学法技能库的**收录清单与原文清洗规则**——生成器与测试共用同一份，
 * 免得两边各写一套导致漂移。
 *
 * 为什么要清洗：OpenMAIC 的 skill 正文里通篇是它自己工具链的调用步骤
 * （create_stage / set_roster / generate_scene / read_stage…）。原样喂给
 * 本项目的模型，它会照着去调**不存在的工具**——这是最典型的 agent 幻觉
 * 来源。所以入库时做两件事，且只做这两件：
 *   1. 丢掉纯平台流程的章节（它们对教学法零贡献）；
 *   2. 把剩下的工具名换成中文动作描述，保留教学原意。
 * 教学原则、页面节奏、验收清单等一律原样保留。
 *
 * skills/openmaic/ 里的**原文一字未改**，清洗只发生在内联进运行时的常量里。
 */

export interface SkillSource {
  /** 与 skills/openmaic/<id>/ 同名 */
  id: string;
  /** 何时读它（拼进工具 description） */
  when: string;
  /** 整节丢弃的章节标题（纯平台流程，教学上无贡献） */
  dropSections: string[];
}

export const SKILL_SOURCES: SkillSource[] = [
  {
    id: "feynman-learning",
    when: "费曼学习法/讲给外行听/暴露理解缺口",
    dropSections: ["搭建与验收"],
  },
  {
    id: "understanding-by-design",
    when: "逆向设计一堂课/大概念与基本问题/表现性任务",
    dropSections: [],
  },
  {
    id: "spiral-curriculum",
    when: "螺旋式复习/概念跨课升阶/多课概念重访",
    // 第二层是逐页生成课堂的工具调用序列；第一层架构设计保留（已替换工具名）
    dropSections: ["第二层：Generate Lessons"],
  },
  {
    id: "learning-to-learn",
    when: "把学习策略与元认知嵌进某次讲解",
    dropSections: [],
  },
  {
    id: "lecture-style",
    when: "大师讲透/系统讲解一条线/讲透某个主题",
    dropSections: ["Carrying the style into the generators"],
  },
  {
    id: "workshop-style",
    when: "动手实操/边做边学/工作坊式带练",
    dropSections: ["Carrying the style into the generators"],
  },
  { id: "vocational", when: "职业技能实训/实验操作步骤/安全边界与判断", dropSections: [] },
  { id: "deep-interactive", when: "机制动手/模拟与可操作演示/理化生编程", dropSections: [] },
  {
    id: "social-emotional-learning",
    when: "学习情绪与压力管理/拖延与自控",
    dropSections: [],
  },
  {
    id: "build-personal-skill",
    when: "从我的记录提炼个人偏好/专属学习法",
    // Workflow 章节保留：它就是真正的操作流程，只需把工具名换成中文动作描述
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

/** 原文 → 可入内联常量���正文 */
export function sanitizeBody(id: string, raw: string, sources: SkillSource[]): string {
  const src = sources.find((s) => s.id === id);
  if (!src) throw new Error(`未登记的 skill：${id}`);
  let body = stripFrontmatter(raw.replace(/\r\n/g, "\n"));
  body = dropSections(body, src.dropSections);
  for (const [from, to] of TOOL_RENAMES) {
    body = body.split(from).join(to || from);
  }
  // 清掉因丢节留下的悬空小标题引用行（如「先加载 `/stage-design`」）
  body = body
    .split("\n")
    .filter((l) => !/先加载\s*`?\/?(stage-design|curriculum-planner|slide-dsl|stage-dsl)/.test(l))
    .join("\n");
  const ghosts = GHOST_TOOLS.filter((g) => body.includes(g));
  if (ghosts.length) {
    throw new Error(`${id}: 清洗后仍残留 OpenMAIC 工具名 ${ghosts.join("、")}`);
  }
  return body.replace(/\n{3,}/g, "\n\n").trim();
}
