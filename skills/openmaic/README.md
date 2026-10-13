# openmaic — 上游课程技能集（原文入库）

> 来源：[THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) `skills/agent-runtime/`，**MIT License**（见同目录 `LICENSE`，Copyright (c) 2026 THU-MAIC）。
> 收编时间：2026-10-13，上游 commit `ec176e84`（v1.2.0-rc.2）。
> 形态：**原文照抄，一字未改**，供查阅与后续移植；本目录不参与代码构建（`skills/` 是自由层，也不进学生端安装包）。

## 这套 skill 是什么

OpenMAIC 是「把任何主题或文档变成互动式 AI 课堂」的开源平台，它的 agent 把**教学方法论写成 SKILL.md**（标准 Agent Skills 格式：YAML frontmatter + 提示词正文）按需加载。本项目把这套写法当**上游素材库**：能迁移的教学纪律与工程范式已经改进主干（见下表），原文留档便于对照。

## 24 个 skill 清单

| skill | 标题 | 干什么 |
|---|---|---|
| `stage-design` | 课堂设计 | 建一节课的基线流程：方案怎么定、工具调用顺序、roster 怎么写、何时重生成旁白 |
| `curriculum-planner` | 系列课规划 | 多节课系列：先确认完整课单再逐节落地 |
| `slide-dsl` | 页面数据结构 | slide DSL 字段手册：十种元素类型、单位、合法值、哪个字段真正上屏 |
| `slide-craft` | 页面设计 | 页面排版**法则**：画布几何、文字高度表、字号阶梯、对比度、间距节奏 |
| `stage-dsl` | 课堂文档结构 | 课堂文档的读取/改写路径图，路由到 quiz/widget/actions/PBL 的字段参考 |
| `page-clone` | 页面克隆 | 以现有页为模板复制出新页并逐槽位改写内容 |
| `pro-editing` | 专业编辑 | 改已存在的页面：修页面、调版式、修 quiz、改旁白 |
| `style-clone` | 名师复刻 | 把一份 deck 当版式库，在其设计语言里产出新内容 |
| `teacher-style-clone` | 名师风格 | 从课堂录像/讲义里提取教师表达风格 |
| `pptx-import` | PPT 导入 | 把上传的 .pptx 原样填进已建的课，保留排版 |
| `feynman-learning` | 费曼学习法 | 先解释→暴露缺口→追问重建→去术语→拆类比→迁移→学习记录 |
| `understanding-by-design` | 理解本位设计 UbD | 逆向设计：持久理解→基本问题→表现性任务→WHERETO 学习经历 |
| `spiral-curriculum` | 螺旋式课程设计 | 概念脊柱 + 升阶操作符，让核心概念跨课反复回来且每次更深 |
| `learning-to-learn` | 学会学习 | 把检索练习、自我解释、预测-反馈等学习策略作为平行目标嵌入 |
| `zone-of-proximal-development` | 最近发展区习题课 | 独立诊断→定向复习→支架练习→新鲜独立复检→证据化下一步 |
| `fact-check` | 事实核查 | 短名单筛选→只查短名单→A/B/C 三段式核查报告 |
| `deep-research` | 深度调研 | 先调研再出课，维护断言-来源台账（claim-to-source ledger） |
| `k12-core-literacy-planning` | 核心素养教学设计 | 中小学 2022 课标导向的真实情境与任务群设计 |
| `social-emotional-learning` | 社会情感学习 SEL | 把情绪管理、共情、合作等作为平行目标 |
| `lecture-style` | 大师讲授 | 一条连续讲解线：密页面、长旁白、跨案例论证、稀疏检查点 |
| `workshop-style` | 互动工作坊 | 每两页一练、幻灯片只做铺垫、收尾一个小项目 |
| `vocational` | 职业实训 | 按真实职业任务编排：操作流程、设备状态、安全边界、GO/STOP 判断 |
| `deep-interactive` | 深度交互 | 多数页面让学生动手操作机制（模拟/可拖拽图/可运行代码/3D） |
| `build-personal-skill` | 打造个人技能 | 从用户自己的历史记录里提炼专属可复用 Skill |

## 移植状态（本项目已吸收的）

| 上游 skill | 落到哪 | PR |
|---|---|---|
| `fact-check` | `basePrompt` 的「## 事实纪律」段：先筛后查、时效事实标待核实、不打断主流程、不改用户给定事实、查不到≠错、A/B/C 报告格式 | #324 |
| `slide-craft` | `src/core/tools/ppt.ts` 的 `LAYOUT_RULES`：**只迁法则不迁数字**（上游 1000×562.5px 画布与高度表绑死其自有 slide DSL，本项目 10×5.625 英寸 + 品牌色板） | #325 |
| `zone-of-proximal-development` | 第七篇参考 `diagnostic-drill`（习题课：诊断与补差），双形态同步 | #325 |
| `curriculum-planner` | 学习教练段「计划先签核后执行」 | #325 |
| `deep-research` | `manage_knowledge` 入库要求附「来源：…」行 | #325 |
| 工程模式（description 双向路由、分层互引、规划黑话红线、能力边界如实声明、验收清单） | `meta-learning` description 补 Do-not-use 负向语义 | #324 |

## 明确不移植的（结论已定，别重复评估）

- **`feynman-learning` / `understanding-by-design` / `spiral-curriculum` / `learning-to-learn`** —— 与本项目已内置的 `meta-learning`（认知科学元学习教练，MIT-0，changer-changer）**重复**。两套学习法提示词并行会互相打架，要学费曼技法用 `deep-understanding` 参考篇即可。
- **`stage-design` / `stage-dsl` / `slide-dsl` / `page-clone` / `pro-editing` / `style-clone` / `teacher-style-clone` / `pptx-import`** —— 绑死 OpenMAIC 的课堂文档模型（stage/scene/action）与工具链（`create_stage`/`patch_stage`/`read_stage`），本项目没有这套数据模型。
- **`k12-core-literacy-planning` / `social-emotional-learning` / `lecture-style` / `workshop-style` / `vocational` / `deep-interactive`** —— 场景不符：本项目是对话式校园 agent（课表/待办/知识/图谱/PPT/番茄钟），不是 K12 课堂产品，课型分野无意义。

## 顺带值得学的写法

1. **description 即路由**：每个 skill 的 frontmatter 都写清 Use when / Do not use when —— 这是 skill 能否被正确触发的关键。
2. **底层流程 + 主题 skill 两层**：`stage-design` 是地板，主题 skill 建在它之上并互相引用。
3. **规划语言红线**：`Concept Spine`、`revisit` 等教师侧黑话不得出现在学生可见内容里（本项目对应：图谱/PPT 产出物的内部标签不得外漏）。
4. **能力边界如实声明**：如「生成式页面无法实时判分」——不过度承诺。
5. **完成前逐条验收清单**：每个 skill 末尾一份 checklist。