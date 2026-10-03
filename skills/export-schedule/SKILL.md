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
| `--serve` | 开关 | 导出后挂本地预览服务（127.0.0.1），供对话内嵌显示 |
| `--port` | 正整数 | 预览端口（默认 8917；被占用自动向后找） |
| `--idle-min` | 非负整数 | 预览服务空闲自动退出分钟数（默认 30；0=不退出） |

示例：

```bash
# 本周课表（最常用）
npx tsx skills/export-schedule/scripts/export.ts

# 第 8 周、彩色课格、指定输出目录
npx tsx skills/export-schedule/scripts/export.ts --week 8 --style color --out D:/课表

# 整学期汇总、SVG 矢量
npx tsx skills/export-schedule/scripts/export.ts --mode term --format svg
```

成功时最后一行输出 `已导出 <绝对路径>（…）`。交付以「用户当场看到图」为目标
（实测多数对话流**不渲染 Markdown 图片**——CDN 回链、localhost 地址都只显示成
一行文本），可靠路径是**工具界面内的浏览器面板**，按序执行：

1. **本会话首次导出**：输出目录整个会话保持不变（仓库内建议用工作区外的
   固定目录，如 `D:\work\raptor-preview\`），以后台任务运行
   `npx tsx skills/export-schedule/scripts/export.ts --week N --out <该目录> --serve`，
   从输出取「预览地址 http://127.0.0.1:<端口>/<文件名>」一行；
2. **用界面内浏览器打开预览地址**（必做，用户立即可见）：ZCode 里用 browser-use
   插件的内置浏览器——先 `Skill: browser-use:control-browser`，再在 node_repl 里
   `agent.browsers.open(<预览地址>)`，确认加载后 `markDeliverable()` 保持标签页
   可见；其他工具用等价的界面内预览手段；
3. 回复正文同时内嵌 `![课表](<预览地址>)` 并附文件路径链接（能渲染图片的
   客户端白赚，不能渲染也不影响 2）；
4. **同会话再次导出**：预览服务还活着就直接一次性导出到同一目录（不带
   `--serve`，服务挂着整个目录），用界面内浏览器打开新文件名对应地址；
   服务已退出（空闲 30 分钟自动关）则按 1 重启；
5. 预览服务起不来（端口被禁等）时退回：Read 图片文件 + 文件路径链接；
6. 用户明确要在系统浏览器打开时加 `--open`（或点路径链接）。

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
