# OpenMAIC 学习教练替换 + 课表卡片 + PPT 下线（设计）

**日期：** 2026-10-15  
**状态：** 已批准（对话确认）

## 目标

1. **删除** `meta-learning` 整套学习教练（目录、运行时内联、`read_learning_reference`、提示词大段、打包入口）。
2. 用 **OpenMAIC 学习类 skill**（分篇、不合并）经 `read_skill` **按需加载一篇**，作为新学习教练。
3. **skill 目录全部平级**（`skills/<id>/`），不再嵌套在 `skills/openmaic/<id>/`。
4. 运行时 **allowlist**：学习类 6 篇 + **`export-schedule`（课表卡片/课表图）**；其它平级 skill 留档不进 agent。
5. **PPT 从 agent 摘掉**（不注册工具、提示词不提）；`ppt.ts` / 渲染与预览代码 **本地保留**，便于以后开回。

## 运行时 allowlist

| id | 用途 |
|---|---|
| `feynman-learning` | 费曼循环 / 讲给外行听 |
| `learning-to-learn` | 学习策略与元认知嵌入 |
| `zone-of-proximal-development` | 习题诊断与补差 |
| `understanding-by-design` | UbD 逆向设计 |
| `spiral-curriculum` | 螺旋式复习 |
| `curriculum-planner` | 系列计划先签核 |
| `export-schedule` | 课表图/课表卡片（配合真实工具 `export_schedule_image`） |

## 目录

```
skills/
  <openmaic-skill-id>/   # 从 openmaic/ 平级迁出，原文保留
  export-schedule/       # 已有
  openmaic/              # 仅 LICENSE + 来源 README（或指向平级路径）
  （删除 meta-learning/）
```

上游克隆目录（`upstream-*`）、`njtech-jwgl` 不动。

## Agent 行为

- 系统提示词：短路由——学习类请求先 `read_skill` 选一篇再答；要课表图/卡片调 `export_schedule_image`；教务闲聊不套学习流程；一次一篇。
- 构建：`scripts/skill-library-source.ts` 只列 allowlist；`build-skill-library.ts` 从 `skills/<id>/SKILL.md` 读入并清洗。
- `export_schedule_image`：core 工具，读本地课表缓存渲染（与网页/export-schedule CLI 同渲染器），不走教务登录。

## PPT

- `coreTools` 不注册 `ppt_preview` / `ppt_save`；提示词删除 PPT 段。
- 保留源码与单测（可标 dormant / skip 依赖 coreTools 的接线测）。

## 明确不做

- 不把多篇 skill 揉成一篇超级学习教练。
- 不把讲法/课型/平台类 skill 本期进 allowlist。
- 不删 ppt 实现文件。
