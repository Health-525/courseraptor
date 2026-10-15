# openmaic — 上游来源说明

> 来源：[THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) `skills/agent-runtime/`，**MIT License**（见同目录 `LICENSE`）。
> 收编后各 skill 已**平级迁到** `skills/<id>/`（如 `skills/feynman-learning/`），本目录只保留许可证与来源说明。

## 运行时加载（CourseRaptor agent）

仅 allowlist 进 `read_skill`（见 `scripts/skill-library-source.ts`）：

- 学习类：`feynman-learning`、`learning-to-learn`、`zone-of-proximal-development`、`understanding-by-design`、`spiral-curriculum`、`curriculum-planner`
- 另加：`export-schedule`（课表图/卡片，配合工具 `export_schedule_image`）

其余平级 skill 留档，不进 agent。
