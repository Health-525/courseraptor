---
name: export-schedule
description: >-
  课表图片导出技能（独立包，本地渲染）。把课表渲染成图片文件——第 N 周课表或
  整学期汇总，PNG/SVG，红头档案或彩色课格两种风格。当用户说「导出课表」
  「导出课表图片」「把课表导出来」「本周/这周课表图」「第 N 周课表图片」
  「整学期课表图」或任何想要课表图片文件的场景时使用。零登录零网络，
  从本地课表缓存直接渲染。
license: ISC
agent_created: true
---

# 课表图片导出（独立技能包）

把本地课表缓存渲染成图片：第 N 周课表或整学期汇总，PNG（2 倍宽高清）或
SVG（矢量），红头档案或彩色课格两种风格。与 CourseRaptor 网页端
「本周图片 / 整学期图片」按钮同一套渲染器，视觉一致。

> 本技能与任何学校官方无关。课表数据来自用户自己的缓存文件，只在本机渲染。

## 何时使用

- 触发词示例：「导出课表」「把我的课表导成图片」「导出本周课表图」
  「第 8 周的课表来一张图」「整学期课表图保存下来」「课表 PNG」。
- 用户想要的是**图片文件**（存手机、发 QQ、打印），不是文字版课表。

## 前置条件（首次配置，一次性）

1. **Node.js ≥ 18**。`node --version` 能正常输出即可。
2. **课表缓存**（`schedule-cache.json`，同学自己的），三选一：
   - 从本机 CourseRaptor（完整版）的 `data/` 目录拷 `schedule-cache.json`
     到本技能目录的 `data/` 下；
   - 或调用时用 `--cache <路径>` 直接指向那份文件；
   - 还没有缓存：先在 CourseRaptor 里查询一次课表（缓存自动落盘）再拷贝。

没有缓存时脚本会明确报错「还没有课表缓存」，不要凭空编造课表内容。

## 怎么调用

在本技能目录（SKILL.md 所在目录）执行：

```bash
node scripts/export.mjs [--mode week|term] [--week N] [--style classic|color]
                        [--format png|svg] [--out <目录|文件名>] [--cache <文件>]
```

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `--mode` | `week`（默认）/ `term` | 第 N 周课表 / 整学期汇总 |
| `--week` | 正整数 | 周次；缺省取当前教学周 |
| `--style` | `classic`（默认）/ `color` | 红头档案 / 彩色课格 |
| `--format` | `png`（默认）/ `svg` | PNG 为 2 倍宽高清 |
| `--out` | 目录或文件名 | 缺省落当前工作目录 |
| `--cache` | 文件路径 | 直接指定 schedule-cache.json |
| `--open` | 开关 | 导出后用默认浏览器打开预览（默认只导出，不弹窗） |
| `--serve` | 开关 | 导出后挂本地预览服务（127.0.0.1），供对话内嵌显示 |
| `--port` | 正整数 | 预览端口（默认 8917；被占用自动向后找） |
| `--idle-min` | 非负整数 | 预览服务空闲自动退出分钟数（默认 30；0=不退出） |

示例：

```bash
node scripts/export.mjs                                # 本周课表 PNG
node scripts/export.mjs --week 8 --style color         # 第 8 周彩色课格
node scripts/export.mjs --mode term --format svg       # 整学期 SVG
node scripts/export.mjs --cache D:/backup/schedule-cache.json --week 3
```

成功时最后一行输出 `已导出 <绝对路径>（…）`。交付以「图片卡片直接显示在对话
流里（消息下方）」为目标——实测多数对话流**不渲染 Markdown 图片**（CDN 回
链、localhost 地址都只显示成一行文本），要用工具的**图片输出机制**：

1. **首次导出**：输出目录保持不变，以后台任务运行
   `node scripts/export.mjs --week N --out <该目录> --serve`，从输出取
   「预览地址 http://127.0.0.1:<端口>/<文件名>」；
2. **把图作为图片卡片发进对话流（必做）**：ZCode 加载 browser-use:control-browser
   技能，用内置浏览器打开预览地址后
   `nodeRepl.emitImage(await tab.screenshot({ fullPage: true }))`；其他工具用
   等价的图片输出/附件机制；
3. 回复正文附文件路径链接（Markdown 内嵌可有可无，多数客户端不渲染）；
4. **再次导出**：服务还活着（空闲 30 分钟自动退出）就一次性导出到同一目录，
   对新文件名重复第 2 步；服务已退出则按 1 重启；
5. 服务起不来时退回：读图/附件工具 + 文件路径链接；用户明确要系统浏览器时
   加 `--open`。

## PNG 平台说明

- Windows x64：开箱即用（包内已带原生模块）。
- macOS / Linux：默认自动降级输出 SVG（同样能看）；想要 PNG，在本技能目录执行
  `npm install @resvg/resvg-js`（自动装对应平台二进制）后重试。
- PNG 渲染用系统字体：Windows / macOS 开箱即用；极简 Linux 无中文字体时
  文字可能异常，装一款中文字体即可。

## 报错语义（「拿不到」≠「没有」）

- `还没有课表缓存`：按「前置条件」引导用户配置，不要编造课表。
- `周次越界`：把输出里的有效范围（`1-N`）转告用户。
- `当前不在教学周内`：假期等场景，让用户补 `--week` 指定周次。
- 命令出错一律非零退出码，如实转述 stderr，不要吞错。

## 数据与隐私

- 只读 `schedule-cache.json`，除输出图片与 `data/` 缓存外不写其它位置。
- 缓存里有学号等个人信息，不要把它复述、截图或发送给他人。

## 与完整项目的关系

本包是开源项目 [CourseRaptor](https://github.com/Health-525/courseraptor)
课表渲染层的只读打包。查课表/成绩/考试、对话式 agent 等能力需要完整项目
（或配套的 njtech-jwgl 技能），不在本包内。
