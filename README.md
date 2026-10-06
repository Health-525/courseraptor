<div align="center">

<img src="docs/courseraptor-logo.png" width="200" alt="CourseRaptor logo" />

# 🦖 CourseRaptor

**大学教务对话式 Agent**
课表 · 成绩 · 考试 · 学籍 · 教务通知 · 待办 · 知识库 · 记忆，一句话搞定。

**也是一套可整体搬走的本地 Agent 工程样例**
Vercel AI SDK v7 · `SchoolAdapter` 端口-适配器架构 · 三端入口 · 本地优先。

[![CI](https://github.com/Health-525/courseraptor/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Health-525/courseraptor/actions/workflows/ci.yml)
[![下载最新版](https://img.shields.io/github/v/release/Health-525/courseraptor?label=%E4%B8%8B%E8%BD%BD%E6%9C%80%E6%96%B0%E7%89%88&color=orange)](https://github.com/Health-525/courseraptor/releases/latest)
[![License: MIT + 附加限制](https://img.shields.io/badge/License-MIT_附加限制-blue.svg)](LICENSE)
[![Vercel AI SDK](https://img.shields.io/badge/Vercel%20AI%20SDK-v7-black.svg)](https://ai-sdk.dev)
[![LLM](https://img.shields.io/badge/LLM-DeepSeek%20%C2%B7%20%E5%A4%9A%E5%8E%82%E5%95%86-4D6BFE.svg)](https://www.deepseek.com)
[![Stars](https://img.shields.io/github/stars/Health-525/courseraptor?style=social)](https://github.com/Health-525/courseraptor)
[![GitHubDaily](https://img.shields.io/badge/GitHubDaily-%E5%B7%B2%E6%8E%A8%E8%8D%90-1DA1F2?logo=x&logoColor=white)](https://x.com/github_daily/status/2105560876132757969)
[![独立开发者列表](https://img.shields.io/badge/%E7%8B%AC%E7%AB%8B%E5%BC%80%E5%8F%91%E8%80%85%E5%88%97%E8%A1%A8-%E5%B7%B2%E6%94%B6%E5%BD%95-9B59B6)](https://github.com/1c7/chinese-independent-developer/blob/master/.github/pages/README-Programmer-Edition.md)

**[简体中文](README.md) · [English](README.en.md)**

**[✨ 核心特性](#-核心特性) · [🖥️ 界面预览](#️-界面预览) · [🧰 工程样例](#-给开发者一套可整体搬走的本地-agent-工程) · [🚀 快速开始](#-快速开始) · [🏫 学校支持](#-学校支持) · [🔒 隐私与安全](#-隐私与安全) · [🧩 项目架构](#-项目架构) · [📚 文档](#-文档) · [❓ 常见问题](#-常见问题)**

</div>

---

把散落在教务系统各处的信息收进一句对话：问「这周课表」「我的 GPA」「最近的考试」「通识学分还缺哪几类」，agent 自动登录教务、抓取、结构化后回答。**终端敲 `raptor`、浏览器开 `localhost:3210`、QQ 里 @机器人**——三个入口共用同一个 Agent 内核与同一份记忆。

一切都在你自己的电脑上运行：凭证 AES-256-GCM 加密落盘、教务数据不经第三方；安装包内置匿名装机统计（仅随机设备号 + 版本 + 平台，不含学号、账号与对话内容，`RAPTOR_NO_TELEMETRY=1` 一键关闭，源码运行默认不上报）；接的是你自己的模型 API Key——默认 DeepSeek，共 **12 家国内厂商**可选：**通义千问、智谱 GLM、Kimi、豆包、混元、MiniMax、阶跃、文心、讯飞、硅基流动、移动云**，外加自定义 OpenAI 兼容端点，按量计费、用量透明。已对**南京工业大学全量适配**、**河北农业大学社区适配**，**其他学校开箱可用「手动课表」模式**。

正在写 Agent 的人，可以直接把它当参考实现读：`ToolLoopAgent` 多轮工具循环怎么组织 36 个工具、外部系统怎么用端口-适配器隔离（新增一所学校 = 新增一个自包含目录，内核零改动）、12 家厂商的模型层怎么用纯数据注册表装配——见下方 [🧰 工程样例](#-给开发者一套可整体搬走的本地-agent-工程) 一节。

---

## ✨ 核心特性

Agent 共装备 **36 个工具**（南工大默认配置；开启抢课后 40 个，其他学校按已接入能力自动裁剪）。完整参数表、耗时、环境变量与教务模块覆盖见 [📖 能力文档](docs/capabilities.md)。

- **教务全量查询** —— 课表、成绩与 GPA（重修取最高、通识六类统计）、考试、学籍、已选/重修/实验成绩，一句话直查；学期交界自动探测候选学期，不靠日历猜
- **选课分析（只读）** —— 搜课搜班看余量；多门课自动查各教学班明细，与已选课程做时间冲突检测，覆盖单双周与部分周重叠
- **通知情报** —— 教务处通知按你的年级标相关度，正文全文直读；附件下载一次即缓存，表格按问题筛选、文档分页续读或关键词定位
- **日历导出与订阅** —— 整学期 `.ics`（假期自动跳过、调休按周几补课、考试带提醒）导入手机日历；或发布到 Gitee / GitHub 拿订阅链接，课表更新自动刷新
- **文件与文档** —— 读本地 Word / PDF / Excel / TXT，千行大表按条件取行而非整本塞给模型；沙箱 JS 计算；生成 Word / Excel / PPT / PDF 及跨格式互转，中文原生
- **记忆 · 知识 · 待办** —— 两层记忆（会话跨重启延续 + 长期事实自主维护）；知识点对话自动沉淀、按课表真实课程归类；待办三端同步，到期桌面通知 + QQ 推送双提醒
- **手动课表（其他学校）** —— 粘贴课表文字（教务网页表格、Excel、其他课表 App 导出都行）或上传 Excel / CSV / PDF / Word / TXT，AI 解析成结构化课表，拿不准会追问，预览里逐行确认
- **三端入口** —— 终端 TUI（首屏即今日课表、待办、考试、通知速览）、本地网页「功能大厅」（十大面板、会话管理、文件上传）、QQ 官方机器人（白名单制、零封号）
- **多厂商模型** —— 12 家国内厂商 + 自定义 OpenAI 兼容端点任选：每家 Key 独立加密保存、切换不丢，型号列表实时拉取，网页端下拉即切
- **学习教练** —— 学习类对话自动切换教练模式：直觉先于形式、答错先给提示，备考按「模板 → 变式 → 整卷」编排，先查真实考试安排与历史成绩再定计划
- **更多** —— 用量统计（一年热力图）、番茄钟、天气与穿衣建议、自动更新；另有无头 CLI 可脚本化直查教务，不经模型、不耗 token

---

## 🖥️ 界面预览

> 截图均为虚构示例数据（演示模式），不代表真实教务信息。

**终端卡片 TUI** —— 敲 `raptor` 直接开聊，启动首屏即见今日课表、一周待办、临近考试与最新通知：

<p align="center"><img src="docs/screenshots/tui.png" width="800" alt="终端 TUI 首屏：今日课表、待办、考试与通知速览（虚构示例数据）"></p>

**网页对话** —— 浏览器打开 `http://localhost:3210` 即聊，思考过程与工具调用全程可见：

<p align="center"><img src="docs/screenshots/gui.png" width="800" alt="网页对话：思考卡片、工具调用与课表回复（虚构示例数据）"></p>

**动态演示** —— 从欢迎页、快捷提问到一句话发起查询的完整流程（虚构示例数据）：

<p align="center"><img src="docs/screenshots/gui-demo.gif" width="800" alt="网页端动态演示：快捷提问与一句话查询全流程（虚构示例数据）"></p>

---

## 🧰 给开发者：一套可整体搬走的本地 Agent 工程

> 在找「Vercel AI SDK 的生产级完整例子」，或者「Agent 怎么接一堆外部系统而不失控」？这个仓库是一份答案：三端入口跑在真实用户的日常使用里，每个设计都有源码可查、有测试兜底，MIT + 附加限制条款，欢迎拆走复用——但**禁止用于打比赛、交毕设/课程作业**（详见 [LICENSE](LICENSE)）。

| 你要解决的问题 | 这里的做法 | 源码 |
|---|---|---|
| Agent 主循环 | Vercel AI SDK v7 `ToolLoopAgent` + `runAgentTUI`：36 个工具的多轮循环，思考与工具调用全程透出 | [`src/core/agent.ts`](src/core/agent.ts) |
| 给 Agent 接外部系统 | `SchoolAdapter` 端口 + 每校一个自包含适配器目录；内核永不反向依赖实现，正方新版 / CAS+URP 的差异全部被适配器吃掉 | [`src/core/school.ts`](src/core/school.ts) · [`src/adapters/`](src/adapters/) |
| 多模型厂商接入 | 供应商注册表纯数据 + 模型工厂统一装配：12 家国内厂商 + 自定义 OpenAI 兼容端点，Key 独立加密、运行时热切 | [`src/core/providers.ts`](src/core/providers.ts) · [`src/core/models.ts`](src/core/models.ts) |
| 工具层设计 | 36 个工具的参数与返回契约，覆盖教务、通知、文件、文档、日历、记忆六域，可渐进式挂载 | [`src/core/tools/`](src/core/tools/) |
| 两层记忆 | 会话跨重启续聊 + 长期事实自主维护，全部本地 JSON、无数据库 | [`src/core/memory/`](src/core/memory/) |
| 多入口单内核 | 终端 TUI / 本地网页 / QQ 机器人共享同一内核与记忆；另有无头 CLI 不经 LLM、零 token | [`src/channels/`](src/channels/) · [`local/`](local/) · [`skills/njtech-jwgl/`](skills/njtech-jwgl/) |
| 本地优先安全 | 凭证 AES-256-GCM 绑定本机指纹；Web 仅回环监听 + Host/Origin/CSRF 校验；沙箱 JS 无网络无磁盘 | [`src/core/credentials.ts`](src/core/credentials.ts) · [`src/core/sandbox-js.ts`](src/core/sandbox-js.ts) |
| 工程化底盘 | TypeScript `strict` + node:test（覆盖率门槛只升不降）+ Biome + 双 OS 矩阵 CI | [`tsconfig.json`](tsconfig.json) · [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |

**适配器飞轮已经转过一圈**：河北农业大学适配器由外部贡献者 [@gzxb001-sketch](https://github.com/gzxb001-sketch) 按[适配指南](docs/adapter-guide.md)独立完成并合入（PR [#204](https://github.com/Health-525/courseraptor/pull/204)），他就是这所学校的署名维护者。你的学校还没人适配？照着[指南](docs/adapter-guide.md)写一个——正方系学校有完整参考实现可抄，PR 合并后上方学校表里写你的名字。

---

## 🚀 快速开始

三种用法按需选：**安装包**（推荐给同学，零开发环境）、**源码运行**（开发者）、**无头命令行**（自动化与二次封装）。无论哪种，思考过程、工具调用与每轮问答都会归档进会话历史。

### 先零门槛体验（可选）

还没配教务账号和 API Key？按下方方式二完成 `git clone` 与 `npm install` 后，一行命令进入离线演示：

```bash
npm run demo
```

- **虚构示例数据 + 剧本式回答**：不读本机凭证、不连教务、不调模型、对话不落盘
- 打开终端打印的地址（通常 `http://127.0.0.1:3211`），体验与正式版一致的界面和交互
- 想看真实 AI 对同样的虚构数据做分析：`.env` 配好 `DEEPSEEK_API_KEY` 后改跑 `npm run demo:live`（回复来自真实模型、工具仍返回虚构数据，API 用量可能产生费用；没配 Key 自动退回离线剧本）

### 方式一：下载安装包（推荐给同学，无需任何开发环境）

到 [Releases](https://github.com/Health-525/courseraptor/releases/latest) 下载任一安装包（约 116 MB，**已内置 Node 运行时**，不用装 Node.js、也不用联网装依赖）。别下页面最底部 GitHub 自动生成的 Source code 包。

- **`portable-win-x64.exe`（最省事，推荐）**：双击即用。exe 放哪、程序就装到哪——首次双击在旁边释放 `CourseRaptor` 文件夹（约 116 MB）后直接进入对话；之后秒开，删文件夹即卸载。**升级 = 新版 exe 放进原文件夹再双击**，账号、记忆、数据全部保留
- **`portable-win-x64.zip`（绿色版）**：解压后双击文件夹里的 `start.bat`，适合 U 盘携带或机房电脑

启动不在终端提问，直接进入界面；教务账号和模型 API Key（默认 DeepSeek，其他厂商在网页「设置 → AI 模型」里切换）都在网页「功能大厅 → 设置」里填写，加密存本机、之后免填。

> 双击没反应或被拦截：安装包未做代码签名（exe 是自释放启动器、zip 里的 `runtime\node.exe` 是 Node 官方运行时），SmartScreen 弹窗选「更多信息 → 仍要运行」，或把安装/解压目录加入杀软信任区。

### 方式二：git 克隆（开发者）

```bash
git clone https://github.com/Health-525/courseraptor.git
cd courseraptor
npm install        # 需 Node.js ≥ 24

# 模型 Key（默认 DeepSeek）：cp .env.example .env 后编辑填入；其余 11 家厂商与自定义端点可在网页设置里配
# 教务账号：留空即可，启动后在网页「设置 → 教务账号」里填写并加密保存本机

npm link           # 注册全局命令（一次即可，任意目录可用）
raptor             # 启动；项目内也可 npm run dev
```

常用脚本：`npm run doctor`（环境自检）· `npm test`（node:test）· `npm run test:coverage`（同测试，带覆盖率门槛）· `npm run typecheck && npm run lint`（类型 + Biome 检查）。

### 方式三：无头命令行（自动化 / 二次封装，不消耗 token）

仓库内置技能 [`skills/njtech-jwgl/`](skills/njtech-jwgl/SKILL.md) 把南京工业大学教务查询（课表 / 成绩 / 考试 / 通知 / 学籍 / 选课）封装成无头 CLI——**不经过 LLM 对话、不消耗 DeepSeek token**。需按方式二克隆源码并配好教务账号（无需 DeepSeek Key）。

```bash
npm run njtech -- schedule            # 课表
npm run njtech -- grades              # 成绩
npm run njtech -- news 公告通知 5      # 通知列表
npm run njtech -- search-courses 高等数学
```

12 个子命令：`schedule` · `grades` · `exams` · `lab-grades` · `news` · `student-info` · `enrolled-courses` · `retake-courses` · `selection-status` · `search-courses` · `search-classes` · `watch`。协议细节与安全红线见 [SKILL.md](skills/njtech-jwgl/SKILL.md) 与其 `references/`。

另附 [`skills/export-schedule/`](skills/export-schedule/) 独立技能包：把课表渲染成图片供下载，适配各平台聊天里直接发图看课表的场景。

另有 [`skills/meta-learning/`](skills/meta-learning/) 学习教练技能：认知科学驱动的元学习引擎（深度教学 / 知识结构诊断 / 考试型刻意练习编排），辅助期末备考，原作者 [changer-changer](https://github.com/changer-changer)（MIT-0，见文末[致谢](#-致谢)）。**raptor agent 已内置触发**——对话里说「帮我复习高数」「讲解一下傅里叶变换」自动进入学习教练模式（备考先查真实考试安排与历史成绩，方法论经 `read_learning_reference` 按需加载，详见 [docs/capabilities.md](docs/capabilities.md)）；`skills/` 目录这份是给其它 agent 工具（`~/.claude/skills/`、`~/.zcode/skills/` 等）的独立技能包形态，整目录拷走即用，或从 [Releases](https://github.com/Health-525/courseraptor/releases?q=meta-learning) 下载 zip（`npm run package:skill -- meta-learning` 构建）。

<details>
<summary><b>💻 系统要求</b>（点开查看）</summary>

| 项目 | 要求 |
|------|------|
| **操作系统** | Windows 10/11、macOS 12+、Linux (glibc 2.28+) |
| **Node.js** | ≥ 24（安装包已内置 Node 运行时，**无需预装**） |
| **内存** | ≥ 512 MB 可用（运行时约 150-300 MB） |
| **磁盘** | ≥ 300 MB（含运行时、依赖、本地数据） |
| **网络** | 首次配置需联网拉取模型 API（默认 DeepSeek，可换厂商）、教务系统；之后可离线使用已缓存数据 |

</details>

---

## 🏫 学校支持

| 学校 | 能力面 | 适配维护者 |
|------|--------|-----------|
| [南京工业大学](src/adapters/njtech/)（NJTECH） | 全部在线能力（课表/成绩/考试/学籍/通知/选课…） | [@Health-525](https://github.com/Health-525) |
| [河北农业大学](src/adapters/hebau/)（HEBAU） | 课表/成绩/考试（CAS 统一认证 + 正方 URP；动态码二次认证） | [@公子小白](https://github.com/gzxb001-sketch) |

设置第一栏先选学校：已适配学校填教务账号即可自动抓取；**其他学校走「手动课表」模式**——粘贴或上传课表，AI 解析成结构化课表，课表 / 今日日程 / 周次推算照常可用。

你的学校不在列表？三条路：先用**手动课表**顶着，**[请求适配](https://github.com/Health-525/courseraptor/issues/new?template=request-school.yml)**（把学校信息留给社区），或**[自己动手写一个](docs/adapter-guide.md)**——适配层完全自包含，正方系学校的登录与查询逻辑有现成参考实现，PR 合并后你就是这所学校的署名维护者。

---

## 🔒 隐私与安全

| 承诺 | 实现方式 |
|------|----------|
| 数据不出设备 | 教务查询、文件解析、文档生成、记忆与知识库存储均在本机完成 |
| 凭证加密存储 | 教务密码、API Key、QQ 机器人密钥均经 AES-256-GCM 加密写入 `credentials.enc`（密钥绑定本机指纹，拷走的文件在别的电脑解不开） |
| 匿名装机统计（仅安装包） | 每 24h 一次报随机设备号 + 版本 + 平台（`src/core/usage-ping.ts`）；不含学号、账号与对话内容，`RAPTOR_NO_TELEMETRY=1` 一键关闭；源码运行默认不上报 |
| 可审计 | 完全开源，`src/` 下所有网络请求、文件读写、加密逻辑均可直接阅读 |

安全细节：

- 网页服务仅监听 `127.0.0.1`：Host / Origin 校验、写请求须携带 CSRF token、仅认 `application/json`
- 学籍敏感字段（证件号/银行卡/考生号）返回时自动打码；沙箱 JS 无网络无磁盘、超时截断
- `.env`、`session.json`、`memory.json`、`data/chat-sessions.json` 等含个人数据的文件已被 `.gitignore` 排除，**切勿提交或分享**
- 「本地运行」不等于完全离线：提示词与相关查询结果会发给你配置的模型服务商；附件云解析仅用于公开网站，教务数据一律本地直连、不经第三方

---

## 🧩 项目架构

<p align="center">
  <!-- GitHub 按用户主题自动换图：暗色模式看深底版，浅色模式看白底版 -->
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/courseraptor-architecture.png">
    <img src="docs/courseraptor-architecture-white.png" width="880" alt="CourseRaptor 项目架构图：交互入口（终端 TUI / 本地网页 / QQ）、Agent 内核、两层记忆与知识库全部本机运行，教务系统与天气等外部服务按需访问">
  </picture>
</p>

**本地优先（Local-first）**：交互入口、Agent 内核、两层记忆与知识库全部跑在本机，数据不出电脑；教务系统、天气等外部服务仅在查询时按需访问。

**技术栈**：[Vercel AI SDK v7](https://ai-sdk.dev)（`ToolLoopAgent` + `runAgentTUI`）· 模型层：DeepSeek（默认 `deepseek-flash`，即 V4.1-Flash）+ 通义千问 / 智谱 GLM / Kimi / 豆包 / 混元 / MiniMax / 阶跃 / 文心 / 讯飞 / 硅基流动 / 移动云 + 自定义 OpenAI 兼容端点（供应商注册表纯数据、模型工厂统一装配）· TypeScript + Node 内置 HTTP（网页端零框架）· Biome + node:test

**项目结构**（完整树见 [能力文档](docs/capabilities.md#-项目结构完整树)）：

```
├── bin/raptor.cjs      # 全局命令入口
├── docs/               # 文档与素材
├── skills/njtech-jwgl/ # 教务无头查询技能（SKILL.md + references/ + scripts/query.ts）
├── src/                # 公用核心（与运行形态无关）
│   ├── core/           # 学校无关内核：agent/记忆/日历/文档/附件/知识库等 + 通用工具
│   ├── adapters/       # 学校适配层：core/school.ts 定义的 SchoolAdapter 端口
│   │   ├── njtech/     # 南京工业大学实现（登录/课表/成绩/考试/选课/通知 + 教务工具）
│   │   ├── hebau/      # 河北农业大学实现（CAS 统一认证 + 正方 URP，差异见能力文档）
│   │   └── custom/     # 其他学校（手动课表模式）
│   └── channels/       # 输出渠道：web（网页版）
└── local/              # 本地版入口：cli（终端 TUI）、qq（机器人）、demo（离线演示）
```

核心与适配层以 `SchoolAdapter` 端口解耦：`src/core/` 永不反向依赖任何学校实现，新增一所学校 = 新增一个自包含的 `src/adapters/<school>/` 目录。

---

## 📚 文档

| 想做什么 | 去哪里 |
|------|------|
| 查工具参数、耗时、环境变量、教务模块覆盖 | [能力文档](docs/capabilities.md) |
| 我是同学，想看图文上手指南 | [同学使用指南](docs/student-guide.md) |
| 查环境变量、凭证、QQ 机器人等配置项 | [配置参考](docs/configuration.md) |
| 给自己的学校写适配层 | [适配指南](docs/adapter-guide.md) |
| 看做了什么、接下来做什么 | [路线图](docs/roadmap.md) |
| 参与贡献 / 报安全问题 / 行为准则 | [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md) |
| 提问、交流、反馈 | [GitHub Discussions](https://github.com/Health-525/courseraptor/discussions) |

---

## ⚠️ 免责声明与使用建议

- 本项目基于 [MIT 许可证 + 附加限制条款](LICENSE) 授权：可自由使用、复制、修改和分发，但**禁止用于毕业论文、毕业设计、课程作业等学术成果和任何竞赛参赛作品**（详见 [LICENSE](LICENSE)）；本项目与南京工业大学官方无关，也未获其授权或认可。
- 使用者需**自行承担全部风险**：请遵守学校相关规定及教务系统使用条款，因使用本工具产生的任何后果（包括但不限于账号受限、成绩处理）由使用者本人负责。
- 请避免大规模或高频请求，尊重教务系统的承载能力（传输层内置全局限速令牌桶，`RAPTOR_MAX_RPS` 只允许下调、请勿调高）。
- **关于验证码识别**：附件下载路径中的图形验证码由本地 tesseract 自动识别，这在技术上属于绕过网站的反自动化措施。此能力仅限用于获取**本人有权访问的通知附件**，重试上限 3 次；如需完全停用，设 `RAPTOR_DISABLE_CAPTCHA_OCR=1`。

---

## ❓ 常见问题

**双击安装包没反应，或被系统 / 杀软拦截？**
安装包未做代码签名（exe 是自释放启动器、zip 里的 `runtime\node.exe` 是 Node 官方运行时），SmartScreen 弹窗选「更多信息 → 仍要运行」，或把安装 / 解压目录加入杀软信任区。

**没有模型 API Key，能先用吗？**
可以先跑上面的离线演示，零凭证体验界面。正式对话需要自己的 Key——默认 DeepSeek，也可换**其余 11 家国内厂商**（通义千问、智谱 GLM、Kimi、豆包、移动云等，共 12 家）任选一家，或填自定义 OpenAI 兼容端点；教务账号可以跳过，之后在网页「功能大厅 → 设置 → 教务账号」补填。

**网页打不开，或提示端口被占用？**
以终端启动时打印的实际地址为准（默认 `http://127.0.0.1:3210`，被占用会自动换端口）；页面表现异常先 `Ctrl+F5` 强刷缓存。

**课表 / 考试查出来是空的，或学期不对？**
学期交界期为候选学期探测，不依赖日历日期推断，可在对话里切换学期重查；开学日期按校历维护，未知学期按 9 月 / 3 月第一个周一估算并标注。放假 / 调休会在 agent 读到教务处通知后自动叠加进课表与日历。

**我的数据都存在哪，怎么彻底删除？**
全部在本机：`data/`、`credentials.enc`、`session.json`、`memory.json` 等。安装包版删除 `CourseRaptor` 文件夹即净卸载；源码版先 `npm unlink` 再删项目目录，本地数据清理步骤见[能力文档](docs/capabilities.md)「卸载与清理」一节。

**怎么把 agent 挂到 QQ 上？**
走腾讯官方机器人路线（零封号）：网页「功能大厅 → 设置」填 AppID / AppSecret / 激活暗号即可上线，QQ 里发暗号完成授权；细节见[能力文档](docs/capabilities.md)「QQ 接入」一节。

更多问题欢迎到 [GitHub Discussions](https://github.com/Health-525/courseraptor/discussions) 提问。

---

## 🙏 致谢

- **[changer-changer](https://github.com/changer-changer)** — 学习教练技能 [meta-learning](skills/meta-learning/) 的原作者（MIT-0）。感谢他的无私开放，本项目的「学习教练」能力（深度教学 / 知识结构诊断 / 考试型刻意练习编排，辅助同学期末备考）正是建立在他的认知科学方法论之上。

---

<div align="center">

**🦖 CourseRaptor** · 让迅猛龙替你守教务 · [MIT + 附加限制条款](LICENSE)

觉得好用？[点个 ⭐ Star](https://github.com/Health-525/courseraptor) 让更多同学看到它。写 Agent 的朋友参考这套工程做自己的项目时，也欢迎来 [Discussions](https://github.com/Health-525/courseraptor/discussions) 留个项目链接。遇到问题或有想法，欢迎开 [issue](https://github.com/Health-525/courseraptor/issues/new/choose) 聊聊。

[⬆ 回到顶部](#-courseraptor) · [English Version](README.en.md)

</div>
