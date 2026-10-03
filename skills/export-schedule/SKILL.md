---
name: export-schedule
description: >-
  把本地课表缓存渲染成课表图片（第 N 周或整学期，PNG/SVG，红头档案或彩色课格两种风格）。
  当用户说「导出课表」「导出课表图片」「把课表导出来」「本周/这周课表图」「第 N 周
  课表图片」「整学期课表图」或任何想要课表图片文件的场景时使用。与网页端
  「本周图片/整学期图片」按钮、AI 工具 export_schedule_image 同一套渲染器。
license: ISC
agent_created: true
---

# 课表图片导出（CourseRaptor 技能）

把本地课表缓存（`data/schedule-cache.json`）渲染成图片文件，**零登录零网络**。
渲染器就是项目里的 `src/core/schedule-svg.ts`，与网页 `/schedule` 页的
「本周图片 / 整学期图片」按钮、AI 工具 `export_schedule_image` 完全同一套，
视觉一致：classic 红头档案（CourseRaptor 招牌）/ color 彩色课格。

## 仓库内调用

在项目根目录（本 SKILL.md 的上上级）：

```bash
npx tsx skills/export-schedule/scripts/export.ts [参数]
```

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `--mode` | `week`（默认）/ `term` | 第 N 周课表 / 整学期汇总 |
| `--week` | 正整数 | 周次；缺省取当前教学周 |
| `--style` | `classic`（默认）/ `color` | 红头档案 / 彩色课格 |
| `--format` | `png`（默认）/ `svg` | PNG 为 2 倍宽高清 |
| `--out` | 目录或文件名 | 缺省落当前工作目录 |
| `--cache` | 文件路径 | 直接指定 schedule-cache.json（缺省读 `data/`） |
| `--open` | 开关 | 导出后用默认浏览器打开预览（默认只导出，不弹窗） |

示例：

```bash
# 本周课表（最常用）
npx tsx skills/export-schedule/scripts/export.ts

# 第 8 周、彩色课格、指定输出目录
npx tsx skills/export-schedule/scripts/export.ts --week 8 --style color --out D:/课表

# 整学期汇总、SVG 矢量
npx tsx skills/export-schedule/scripts/export.ts --mode term --format svg
```

成功时最后一行输出 `已导出 <绝对路径>（…）`。交付以「用户在对话里直接看到图」
为目标，按序执行：

1. **用 Read 工具读取导出的图片文件**——读取结果会把图片直接显示在对话流里；
2. 回复正文内嵌 `![课表](file:///<绝对路径>)`（支持 Markdown 图片的客户端直接
   渲染），并附文件路径链接兜底；
3. 用户明确要在浏览器打开时加 `--open`（或点路径链接）。默认不弹窗。

## 报错语义（「拿不到」≠「没有」）

- `还没有课表缓存`：缓存不存在或损坏。转告用户三种来源（拷贝 / `--cache` /
  先查询一次课表落缓存），不要凭空编造课表。
- `周次越界` / `当前不在教学周内`：把输出里的有效范围转告用户，让其指定 `--week`。

## 行为细节

- 导出图**不标注「今天」**：静态存档只对导出当天成立，这是刻意设计；
  网页实时课表的当天高亮不受影响。
- 周次换算真值在 `core/calendar/week-plan.ts`：放假清空、调休换表、单双周过滤。

## 打成独立技能包（供他人下载）

```bash
npm run package:skill -- export-schedule
```

产物在 `dist/`：`dist/skill/export-schedule/`（可直接拷走的技能目录）与
`dist/export-schedule-skill-v<版本>.zip`（下载分发用，解压即上述目录）。
独立包是单文件 bundle（`scripts/export.mjs`），不依赖本仓库，用法参数与上面
完全一致（把 `npx tsx …/export.ts` 换成 `node scripts/export.mjs`）。
打包细节与多平台 PNG 说明见 `scripts/package-skill.mjs` 头注释与
`package/README.md`。
