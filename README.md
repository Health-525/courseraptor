<div align="center">

# 🦖 CourseRaptor

<img src="docs/courseraptor-logo.png" width="104" alt="CourseRaptor 小恐龙标识" />

[![CI](https://github.com/Health-525/courseraptor/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Health-525/courseraptor/actions/workflows/ci.yml)
[![下载最新版](https://img.shields.io/github/v/release/Health-525/courseraptor?label=release&color=orange)](https://github.com/Health-525/courseraptor/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Health-525/courseraptor?style=social&v=2)](https://github.com/Health-525/courseraptor)

**面向大学生的本地优先智能学习工作台：以 AI 为核心，统一连接课表、待办、课程资料与知识沉淀，让每一天的学习安排都清晰可控。**

[下载 Windows 版](https://github.com/Health-525/courseraptor/releases/latest) · [第一次使用](#第一次使用) · [源码与演示](#源码与离线演示) · [English](README.en.md)

</div>

课表在教务系统里，截止日期散在聊天和备忘录里。CourseRaptor 把你导入的课表、说过的待办和保存的知识放到同一个助手中，让你查询时少翻几个地方。

你可以问「这周周三在哪上课」，也可以说「记一下，周五下午三点前交实验报告」。课表、待办和生成的文件保存在本机，模型由你选择。**正式 AI 对话需要自己的模型 API Key，相关内容会发送到该模型服务，可能产生调用费用。**

[能帮你做什么](#能帮你做什么) · [界面一览](#界面一览) · [下载与运行要求](#下载与运行要求) · [第一次使用](#第一次使用) · [常见问题](#常见问题) · [数据与使用边界](#数据与使用边界) · [给开发者](#给开发者) · [参与贡献](#参与贡献)

## 能帮你做什么

先从课表和待办开始，再按需要使用其他能力。以下每一条都对应当前源码中实际注册的 Agent 工具，而不是规划中的功能。

- **查课与调课**：按教学周查看课程、时间和地点；通过对话修改本地课表，导出课表图片（SVG / PNG）或 `.ics` 日历文件。
- **记截止待办**：说出事项和截止时间即可保存；主程序运行时每小时检查一次，临近截止每天提醒一次，支持 Windows 桌面通知，配置 QQ 后可同时推送到 QQ。
- **整理今日安排**：结合课表和待办回答「今天有什么安排」；功能大厅提供今日安排、课表、待办、知识库等独立面板，不开对话也能查。
- **留下学习记录**：按课程整理知识点，借助费曼学习法、螺旋复习等内置学习技能辅助消化；重要偏好和结论可存入长期记忆，跨会话自动生效。
- **处理课程材料**：上传、粘贴或拖入本地 PDF、Word、表格等附件（单个文件不超过 25 MB），让 AI 阅读、筛选和计算，生成 Word、Excel、PDF 文件或转换成 PPT，产物保存在本机。
- **在常用入口继续用**：网页（默认 `127.0.0.1:3210`）、终端 TUI，以及可选的 QQ 机器人、Obsidian 插件入口，复用同一台电脑上的助手状态；QQ 与插件需要另行配置。

不需要先适配学校教务系统才能开始：公开仓库默认内置「手动导入课表」模式，任何学校都能直接使用。在线成绩、考试、教务通知查询依赖学校适配器，公开仓库当前不随附任何学校的在线适配器。

<details>
<summary>也关注 AI 行业动态？</summary>

源码 `main` 已接入 [AI 新闻技能](skills/ai-news/SKILL.md)：可以生成带来源的中文日报和突发简报，并查询本地留存的采集历史，额外需要 Python 3.11+。它是按需触发的工作流，不会在后台定时自动推送；首次采集访问配置好的公开来源，之后当天复用快照。现有安装包是否包含此能力，以对应发布说明为准。见[配置说明](docs/configuration.md#ai-新闻技能)。

</details>

## 界面一览

主界面从左到右依次是会话列表、对话区和功能大厅：

<p align="center"><img src="docs/screenshots/demo-overview.png" width="960" alt="CourseRaptor 当前主界面：左侧会话列表、中间对话区和右侧功能大厅" /></p>

<p align="center"><sub>当前源码实际界面，使用隔离的虚构示例数据。功能大厅及各功能面板均在右侧栏内打开；截图未调用 AI。</sub></p>

功能大厅里的常用面板（同样为虚构示例数据，点击标题可查看原图）：

<details>
<summary>展开查看：课表、今日安排、待办与知识库</summary>

| [周课表](docs/screenshots/demo-schedule.png) | [今日安排](docs/screenshots/demo-today.png) |
|---|---|
| <img src="docs/screenshots/demo-schedule.png" width="440" alt="功能大厅课表侧栏，按星期列出示例课程、时间和地点" /> | <img src="docs/screenshots/demo-today.png" width="440" alt="功能大厅今日日程侧栏，展示示例课程时间与上课状态" /> |
| [截止待办](docs/screenshots/demo-todos.png) | [课程知识库](docs/screenshots/demo-knowledge.png) |
| <img src="docs/screenshots/demo-todos.png" width="440" alt="功能大厅待办侧栏，按截止时间分组并展示完成状态" /> | <img src="docs/screenshots/demo-knowledge.png" width="440" alt="功能大厅知识库侧栏，按课程筛选和搜索示例知识点" /> |

</details>

## 下载与运行要求

| 运行方式 | 需要准备什么 | 入口 |
|---|---|---|
| Windows x64 桌面版，推荐给同学 | Windows 10/11；已内置 Node.js，正式对话需要模型 Key | [下载最新版](https://github.com/Health-525/courseraptor/releases/latest)，选择 `desktop-win-x64-setup.exe` 结尾的文件 |
| Windows x64 便携版 | 已内置 Node.js；正式对话需要模型 Key | 同一发布页中选择 `portable-win-x64.exe` 或 `.zip` 结尾的文件 |
| Windows / macOS / Linux 源码版 | Node.js 24+、Git；首次安装依赖需要联网 | [源码与离线演示](#源码与离线演示) |

当前预编译安装包面向 Windows x64；macOS 和 Linux 请使用源码版。不要把发布页底部的 **Source code** 包当作 Windows 安装器。附加功能有各自依赖：中文 PDF 需要可用的中文字体，AI 新闻需要 Python。

## 第一次使用

1. **启动应用，配置模型。** Windows 桌面安装版安装后启动；便携版按发布说明运行。在「功能大厅 → 设置 → AI 模型」填写自己的 API Key，保存后检测连接。默认支持 DeepSeek，也可选择其他内置厂商或自定义兼容端点。
2. **导入并核对课表。** 在设置中选择「导入 / 重新导入课表」，粘贴文字或上传 Excel、CSV、PDF、Word、TXT。检查解析预览中的周次、节次和地点，确认后保存。
3. **先完成两件小事。** 问「这周课表」，核对一门课；再说「记一下，周五下午三点前交实验报告」，检查待办的具体日期和时间。

不知道 API Key 是什么，或不想现在配置？可以先看上面的截图；有 Node.js 环境时也可运行[无需 Key 的离线演示](#源码与离线演示)。正式使用流程见[同学指南](docs/student-guide.md)。

### 可以直接这样问

| 你想做什么 | 试着这样说 |
|---|---|
| 查课程地点 | 这周周三有哪些课？按时间和地点列出来。 |
| 记一个截止日期 | 记一下，周五下午三点前交实验报告。 |
| 查看待办 | 我有哪些还没完成的待办？ |
| 看今日安排 | 结合课表和待办，整理一下今天的安排。 |
| 导出课表图片 | 导出本周课表图片。 |
| 保存学习记录 | 记下这个知识点，归到高等数学。 |

提醒需要主程序保持运行并具备通知权限；QQ 推送还需要配置机器人和接收对象。手机可以接收你导出的课表图片或导入 `.ics` 文件；当前没有安装即用的手机 App，也不提供默认跨设备云同步。

## 源码与离线演示

**前置要求：Node.js 24+ 和 Git。** 安装依赖需要网络；离线演示不需要模型 Key。

```bash
git clone https://github.com/Health-525/courseraptor.git
cd courseraptor
npm ci
npm run demo
```

打开终端打印的地址，通常为 `http://127.0.0.1:3211`。演示使用虚构数据和固定回答，不调用 AI，不读取个人凭证，也不把演示会话写入个人档案。它用于了解界面，不能用于评价模型表现；按 `Ctrl+C` 退出。

准备正式使用时运行：

```bash
npm run doctor
npm start
```

在打开的界面中配置模型并导入课表。网页通常位于 `http://127.0.0.1:3210`；以启动提示为准，保持主程序运行。已有 DeepSeek Key、希望用虚构数据体验真实模型回答时，可运行 `npm run demo:live`，模型调用可能产生费用。

## 常见问题

<details>
<summary>为什么不能直接像手机课表 App 一样打开就用？</summary>

这是运行在个人电脑上的开源助手。安装包内置运行环境，但正式 AI 对话仍需你选择模型服务、配置自己的 Key 并导入课表；不是托管的免费聊天服务。只想看现有课表时，可使用功能大厅的课表视图，无需每次都发起模型对话。

</details>

<details>
<summary>课表解析错了，或者学校不在列表里怎么办？</summary>

不依赖教务适配器的通用入口是课表导入。尽量提供课程名、星期、节次、周次、地点，在保存前逐行校正；开学日期也应按学校校历核对。在线成绩、考试和通知查询需要对应适配器，导入课表不会自动获得这些能力。

</details>

<details>
<summary>我的数据保存在哪里？</summary>

源码版默认保存在仓库的 `data/` 目录，可用环境变量 `RAPTOR_DATA_DIR` 指到别处；Windows 桌面版保存在 `%APPDATA%\CourseRaptor\data`。会话、课表、待办、知识库和加密后的模型凭证都在其中，备份数据就是备份这个目录；不要把使用过的整个目录原样转发给他人。

</details>

<details>
<summary>怎么升级到新版本？</summary>

Windows 桌面安装版内置自动更新，也可以直接下载新版安装包覆盖安装；个人数据与程序本体分开存放，升级不受影响。便携版重新运行新版文件即可。源码版在仓库目录执行 `git pull` 后重启；终端斜杠命令 `/update` 的自更新需要额外配置更新服务端，个人使用不必开启。

</details>

<details>
<summary>启动、模型连接或导入遇到问题怎么办？</summary>

先看[同学指南](docs/student-guide.md#常见问题)和[配置参考](docs/configuration.md)。源码版可运行 `npm run doctor` 检查本地前提；它不会替你检查模型账户余额。安装包未做代码签名，Windows 可能提示未知发布者；请核对下载来源并自行决定是否运行。可复现问题请提交 [Issue](https://github.com/Health-525/courseraptor/issues/new/choose)，不要附带密码、Key 或完整个人日志。

</details>

## 数据与使用边界

- **本地保存，模型按需联网。** 会话、课表、待办和知识库存放在本机；AI 对话所需的提示词、相关查询结果和附件内容会发送到你配置的模型服务商。此外，天气查询、版本更新检查等少量功能会访问对应公共服务，可选的新闻采集与网页抓取只在启用时联网。本地优先不等于所有内容永远不离开电脑。
- **凭证加密保存。** 模型 Key 等凭证使用 AES-256-GCM 加密后单独保存在本机，与代码和会话记录分开存放；分享项目时发仓库链接或干净安装包，不要转发已经使用过的整个目录。
- **使用统计可关闭。** 源码直接运行时使用统计为空实现、不发送任何数据；正式安装包可能内置匿名使用统计，可用环境变量 `RAPTOR_NO_TELEMETRY=1` 关闭。
- **每个人使用自己的数据。** 多入口复用同一台电脑上的状态；QQ 白名单只限制谁能对话，不提供多用户数据隔离。需要多人独立使用时，请各自安装和配置。
- **结果需要核对。** 本项目为非官方个人工具。课程变更、考试和其他重要安排以学校正式渠道为准；生成内容与解析结果应由使用者确认。

网络、附件解析和凭证处理的细节见 [SECURITY.md](SECURITY.md)。

## 给开发者

学生用途之外，CourseRaptor 也是一个完整可运行的本地 Agent 参考项目：TypeScript 与 Vercel AI SDK 组成的多轮工具调用循环（`ToolLoopAgent`，当前注册二十余个核心工具），源码由 tsx 直接解释执行、无编译产物，模型接入覆盖 DeepSeek 官方 API、十余家 OpenAI 兼容厂商与自定义端点。

| 想研究什么 | 从哪里开始 |
|---|---|
| 模型与多轮工具调用 | [`src/core/agent.ts`](src/core/agent.ts) |
| 可扩展工具集 | [`src/core/tools/`](src/core/tools/) |
| 模型厂商与端点装配 | [`src/core/providers.ts`](src/core/providers.ts) |
| 会话与长期记忆 | [`src/core/memory/`](src/core/memory/) |
| 学校能力与端口边界 | [`src/core/school.ts`](src/core/school.ts) |
| 对话内按需加载 Skill | [`skills/`](skills/) 与 [`src/core/tools/skill-library.ts`](src/core/tools/skill-library.ts) |
| 桌面和 Obsidian 入口 | [`desktop/`](desktop/) · [`obsidian/`](obsidian/) |

依赖方向为 `local → channels → core`，由 CI 的分层检查强制；个人状态使用本地 JSON 文件，AI 新闻引擎另用本地 SQLite 保存采集历史，无需部署任何数据库服务。

```bash
npm run doctor          # 本地环境体检
npm run check           # 类型、代码规范、分层检查
npm run test:coverage   # 全量测试与覆盖率门禁（行覆盖 80%）
npm run package:skill   # 将技能打包为可分发 zip
```

CI 在 Ubuntu 与 Windows 双系统执行安装体检、类型检查、代码规范、重复度、分层、覆盖率与生产依赖审计。课表图可[打包为独立技能](skills/export-schedule/package/README.md)，学习技能的来源与许可见 [`skills/openmaic/`](skills/openmaic/)，AI 新闻的移植来源见[引擎说明](scripts/ai-news/NOTICE.md)。

## 文档与参与贡献

<a id="参与贡献"></a>

[同学指南](docs/student-guide.md) · [配置参考](docs/configuration.md) · [能力文档](docs/capabilities.md) · [Obsidian 插件](obsidian/README.md) · [路线图](docs/roadmap.md)

欢迎告诉我们你最常重复处理的校园小事，以及安装、模型配置或课表导入卡在哪一步。Issue 区提供「使用问题」「学生功能建议」「请求适配我的学校」三类表单，使用想法可到 [Discussions](https://github.com/Health-525/courseraptor/discussions) 交流；代码与文档贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)。

如果它帮到了你，欢迎 Star 或分享项目链接，让有同样需求的同学找到它。

## 许可证

[MIT](LICENSE)。本项目为非官方的个人学习工具，按「现状」提供，不作任何明示或默示担保。
