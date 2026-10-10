# export-schedule · 课表图片导出（独立技能包）

把课表渲染成图片文件：第 N 周课表或整学期汇总，PNG（2 倍宽高清）或 SVG，
红头档案（classic）或彩色课格（color）两种风格。零登录零网络，从本地课表
缓存直接渲染，与 [CourseRaptor](https://github.com/Health-525/courseraptor)
网页端「本周图片 / 整学期图片」按钮同一套渲染器。

单文件脚本（`scripts/export.mjs`），解压即用，不需要安装完整项目。

## 安装

1. 安装 [Node.js](https://nodejs.org/) ≥ 18。
2. 解压本包。只想命令行用：任意目录即可。要作为 agent 技能：把
   `export-schedule/` 整个文件夹放进你所用工具的技能目录——

   | 工具 | 技能目录 |
   | --- | --- |
   | Claude Code | `~/.claude/skills/`（或项目内 `.claude/skills/`） |
   | ZCode | `~/.zcode/skills/`（或项目内 `.zcode/skills/`） |
   | WorkBuddy | `~/.workbuddy/skills/` |
   | 其他支持 Agent Skills 规范的工具 | 多数认 `~/.agents/skills/`，详见各工具文档 |

   放好后无需重启配置，对话里说「导出课表」即可触发。

## 首次配置：准备课表缓存

脚本只读本地缓存 `schedule-cache.json`（你自己的课表数据），三选一：

- **拷贝**：从本机 CourseRaptor（完整版）的 `data/` 目录拷 `schedule-cache.json`
  到本包的 `data/` 目录下（没有就新建）；
- **指定**：调用时加 `--cache <路径>` 直接指向那份文件；
- **还没有**：先在 CourseRaptor 里查询一次课表（缓存自动落盘），再回来拷贝。

## 使用

```bash
node scripts/export.mjs                                # 本周课表 PNG（红头档案）
node scripts/export.mjs --week 8 --style color         # 第 8 周 · 彩色课格
node scripts/export.mjs --mode term                    # 整学期汇总 PNG
node scripts/export.mjs --mode term --format svg       # 整学期 SVG（矢量）
node scripts/export.mjs --out D:/课表                  # 指定输出目录
node scripts/export.mjs --open                         # 导出后用默认浏览器打开
node scripts/export.mjs --week 5 --serve               # 导出并挂本地预览服务
node scripts/export.mjs --help                         # 完整参数说明
```

默认只导出文件、不弹窗；`--open` 导出后用默认浏览器打开预览。

`--serve` 导出后把输出目录挂到 `http://127.0.0.1:<端口>/`（默认 8917，只绑
本机回环，空闲 30 分钟自动退出，`--port`/`--idle-min` 可调）——聊天客户端
普遍不渲染 `file://` 本地图，**本地 http 地址才能内嵌进对话框**，agent 技能
就靠它把课表图直接显示在对话里。

输出文件名形如 `schedule-week5-2026-1.png`、`schedule-term-2026-1.png`
（color 风格带 `-color` 后缀）。

## PNG 平台说明

- **Windows x64**：开箱即用（包内已带原生渲染模块）。
- **macOS / Linux**：PNG 需要原生模块，包内未带；默认会**自动降级输出 SVG**
  （浏览器直接打开，效果相同）。想要 PNG：在本包目录执行
  `npm install @resvg/resvg-js`（自动安装对应平台二进制）后重试。
- PNG 用系统字体渲染中文：Windows / macOS 开箱即用；极简 Linux 需自装
  一款中文字体。

## 配置文件（可选）

本包根目录可放 `.env`（参考 `.env.example`）：

- `RAPTOR_DATA_DIR`：缓存目录（默认本包 `data/`）；
- `RAPTOR_SCHOOL`：学校适配器（默认按缓存记录的学校自动选择，一般不用动）。

## 常见问题

- **报「还没有课表缓存」**：见上文「首次配置」。
- **报「周次越界」/「当前不在教学周内」**：加 `--week N` 指定周次
  （报错信息里带有效范围）。
- **导出图没有「今天」标记**：刻意设计——静态图片上的「今天」只在导出
  当天成立，隔天再看反而误导。

## 免责声明

本包与任何学校官方无关，也未获其授权或认可。课表数据由使用者自己的缓存
提供，仅在本机渲染。使用者需自行承担全部风险，请遵守学校相关规定。

## 许可

ISC（随 CourseRaptor 主项目）。
