<div align="center">

<img src="docs/courseraptor-mascot.png" width="260" alt="CourseRaptor mascot" />

# 🦖 CourseRaptor

**南京工业大学教务对话式 Agent**
课表 · 成绩 · 考试 · 学籍 · 教务通知 · 记忆，一句话搞定。

[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](#)
[![Vercel AI SDK](https://img.shields.io/badge/Vercel%20AI%20SDK-v7-black.svg)](https://ai-sdk.dev)
[![LLM](https://img.shields.io/badge/LLM-DeepSeek-4D6BFE.svg)](https://www.deepseek.com)
[![教务系统](https://img.shields.io/badge/%E6%95%99%E5%8A%A1-%E6%AD%A3%E6%96%B9%E6%96%B0%E7%89%88-success.svg)](#-技术栈)
[![Last Commit](https://img.shields.io/github/last-commit/Health-525/courseraptor?color=orange)](https://github.com/Health-525/courseraptor/commits/master)
[![Stars](https://img.shields.io/github/stars/Health-525/courseraptor?style=social)](https://github.com/Health-525/courseraptor)

**[✨ 能力总览](#-能力总览) · [🚀 快速开始](#-快速开始) · [📡 已知状态](#-已知状态-2026-09) · [🏗️ 技术栈](#-技术栈) · [⚠️ 免责声明](#️-免责声明)**

</div>

---

在终端里和一只迅猛龙对话，它会替你登录教务系统、查数据、读通知、记住你的偏好：

```text
$ raptor

你   这学期课表看一下
🦖   2026-2027学年第一学期，共 8 门课。周一 7-8 节「最优化方法」@仁智楼518；
     周三全天没课；操作系统原理第 14-17 周改上机（学院机房）。

你   我通识选修六类还缺哪几类？
🦖   已修：自然类 ✅ AI前沿 ✅ 创新创业 ✅ 人文 ✅；
     还差公共艺术类和社会类（各有最低学分要求）。

你   最近教务处有什么通知？
🦖   已读 3 条最新公告，重点：四六级成绩可查、转专业名单公示……

你   记住：体育课我都想选羽毛球
🦖   已存入长期记忆，下次选课我会提醒你。
```

选课季还能开抢课模式（见 [🎯 选课作战](#-选课作战默认关闭)）。

## ✨ 能力总览

Agent 默认可调用 **14 个工具**，覆盖教务查询、通知情报、两层记忆、QQ 接入四条线。

| 📚 教务查询 | 📰 通知情报 | 🧠 两层记忆 | 💬 QQ 接入 |
|---|---|---|---|
| 课表/成绩/考试/学籍一句话查 | 通知正文+附件（xlsx/docx/pdf）都能读 | 记住偏好和结论，跨会话不丢 | 官方机器人零封号，群里 @ 就能用 |

### 📚 教务查询

| 工具 | 说明 | 耗时 |
|---|---|---|
| `get_schedule` | 课表：自动探测最新学期（学期交界不查错），含节次时间段与当前周次；**带按周预分组索引**，问「第一周有什么课」直接查表不靠模型推算；也可指定如 `2026-2027-1` | ~3-5s |
| `get_grades` | 全部学期成绩 + GPA（NJTECH 绩点规则，重修取最高分）+ **通识选修六类统计** | ~10s |
| `get_exams` | 考试安排：科目 / 日期 / 考场 / 座位号 | ~3-5s |
| `get_student_info` | 学籍个人信息（学院/专业/班级/年级等档案字段，敏感字段自动打码） | ~3s |
| `get_enrolled_courses` | 已选课程教学班（课程/教师/时间/学分/必修选修） | ~3s |
| `get_retake_courses` | 可重修课程列表（历年开课记录，关键词过滤） | ~5s |
| `get_lab_grades` | 实验成绩（按学期探测） | ~3-5s |
| `check_selection_status` | 选课模块状态：是否开放、接口是否正常 | ~3s |
| `search_courses` | 按关键词搜可选课程，查余量与课程归属 | ~3-5s |
| `search_classes` | 查某门课**所有教学班**明细：各班教师 / 时间 / 地点 / 余量对比 | ~5s |

### 📰 通知情报

| 工具 | 说明 | 耗时 |
|---|---|---|
| `get_news` | 教务处官网（jwc.njtech.edu.cn）最新通知列表：公告通知 / 教学动态 / 考试排课；**按你的年级自动标相关度**（high=需本人行动 / low=其他年级或行政公示），不再平铺十几条让你自己挑 | ~5s |
| `read_notice` | 读通知**正文全文**（选课时间表、截止日期都在正文里）；也支持直接读用户贴的校园网链接 | ~3s |
| `fetch_attachment` | 通知附件解析：xlsx/docx/pdf 本地离线解析成文本（jwc 附件带验证码时可自动识别，可 `RAPTOR_DISABLE_CAPTCHA_OCR=1` 停用），其他格式下载到本地 | ~10-20s |

### 🧠 两层记忆

| 层 | 存储 | 机制 |
|---|---|---|
| **短期记忆** | `session.json`（本地） | 模型中间件逐轮捕获完整对话并落盘；下次启动注入上次会话**尾部**若干轮（避免已聊完的事挤占上下文），跨重启延续 |
| **长期记忆** | `memory.json`（本地） | agent 通过 `save_memory` 工具自主维护事实条目（偏好/结论/时间安排）；近似重复自动合并、可设过期时间、办完的事 `archive` 归档，只有生效中的条目会注入 |

说一次「记住××」，之后每次新会话它都记得。记忆文件在本地且已被 `.gitignore` 排除。

### 💬 QQ 接入（官方机器人）

除终端外，agent 还能挂到 QQ 上（腾讯官方开放平台路线，零封号风险）：

```bash
# 1. 在 https://q.qq.com 用主号实名注册 -> 创建机器人 -> 拿到 AppID / AppSecret
# 2. .env 填入 QQBOT_APP_ID / QQBOT_APP_SECRET / QQBOT_PASSCODE（自定激活暗号）
# 3. 启动：一条 raptor 全包（终端对话 + QQ 机器人同时在线，前台运行，Ctrl+C 退出）
raptor
#    只跑 QQ 桥（不开终端对话）：
npm run qq
# 4. QQ 里给机器人发第一条消息 = 激活暗号，完成授权
```

- **单聊**：直接和机器人对话；**群聊**：@机器人 触发
- **安全**：白名单制，未授权用户一律拒绝；授权 openid 落盘 `qq-allowlist.json`（gitignored）
- 官方平台给的是 openid 而非 QQ 号，所以用暗号激活代替加白名单
- 每用户独立会话历史（滑动窗口）；回复自动 Markdown 转纯文本 + 长消息分段
- 限制：官方机器人为被动回复（约 5 分钟窗口）

### 🎯 选课作战（默认关闭）

抢课/盯课是**真实选课提交操作**，平时隐藏，选课季在 `.env` 设 `RAPTOR_ENABLE_GRAB=1` 重启即启用：

| 工具 | 说明 |
|---|---|
| `watch_courses` | 盯课：限时轮询余量变化，只观察不提交 |
| `grab_course` | 抢课（单目标）：余量出现即自动提交，成功即停 |
| `grab_plan` | 分类抢课计划：每类抢到一门即停（不重复抢同类学分），满员自动切备选 |

选课协议已实战校准（2026-08-27 首轮正选实测）：加密串（`xkkz_xh`）、多轮次 tab、Display 页隐藏字段、平铺数据结构均已攻克。

### ⌨️ 终端交互

- **斜杠命令菜单**：输入框敲 `/` 即弹出候选命令（`/card` `/inline` `/key` `/update` `/exit`），↑/↓ 或滚轮选择、Tab 或回车补全，继续输入按前缀过滤；ESC 收起（收起后本行不再自动弹出，删空重来即可）
- **双 UI 运行时互切**：默认全屏卡片模式，`/inline` 切行内模式（输出进终端缓冲区，滚轮/选中复制可用），`/card` 切回
- 滚轮/↑↓ 滚动 · ESC 打断正在进行的回复（菜单弹出时 ESC 只收菜单）· Ctrl+C 退出

## 🚀 快速开始

### 方式一：下载安装包（推荐给同学）

维护者会把安装包和**个人激活密钥**一同私发给同学，然后：

1. 装 [Node.js](https://nodejs.org/zh-cn) LTS（装过可跳过）
2. 解压 zip，双击里面的 **`start.bat`**（首次自动装依赖并引导配置）

### 方式二：git 克隆（开发者）

```bash
# 1. 克隆 & 安装
git clone https://github.com/Health-525/courseraptor.git
cd courseraptor && npm install

# 2. 配置凭证
#    DeepSeek Key：cp .env.example .env 后编辑填入
#    教务账号：留空即可，首次启动 raptor 引导录入并加密保存本机

# 3. 注册全局命令（一次即可，任意目录可用）
npm link

# 4. 启动
raptor                 # 全局命令
npm run dev            # 或项目内开发模式
```

### 🔄 更新（给同学）

raptor **启动时会校验激活状态，并每 24 小时检查一次新版本**。有新版时标题栏会出现 `🔄 新版 vX.Y.Z，/update 可更新` 徽标，对话里直接输入：

```text
/update
```

即一键完成：下载新版 → 覆盖安装（你的凭证 / 记忆 / 会话 / QQ 授权名单不受影响）→ 自动装依赖，然后重启 raptor 即可。嫌下载进度看不清可以先 `/inline` 切行内模式再执行。

密钥和设备绑定会在每次启动时校验；如需换电脑，请联系维护者在 `/admin` 重置设备绑定后再启动。

不想要提醒：`.env` 里加 `RAPTOR_NO_UPDATE_CHECK=1`。

### 🛠️ 部署更新后台 + 发版（给维护者）

分发链路四件套：**授权后台**（个人密钥与设备绑定）、**更新后台**（同学端查版本/下载包）、**发版命令**（打 zip 并发布）、**客户端自更新**（`/update`）。后台使用 Node.js 24+ 的内置 SQLite，不需要额外数据库或 npm 依赖；任何能跑 Node 的机器（云服务器/宿舍旧电脑）都能部署：

```bash
# 0. 先把 server/nginx.conf.example 复制到服务器并替换 license.example.com；
#    用 Nginx + Let's Encrypt 对外提供 HTTPS。Node 服务默认只监听 127.0.0.1。

# 1. 部署后台（建议 pm2 常驻；两个密钥都必须是高强度随机值）
UPDATE_ADMIN_TOKEN=你的管理员密钥 LICENSE_SECRET=你的授权哈希密钥 HOST=127.0.0.1 PORT=8787 pm2 start server/update-server.mjs --name raptor-update
#    管理后台 https://license.你的域名.com/admin（生成/禁用/重置同学的激活密钥）

# 2. 本机 .env 配置 HTTPS 后台地址与发布密钥
#    UPDATE_SERVER_URL=https://license.你的域名.com
#    UPDATE_ADMIN_TOKEN=你的管理员密钥

# 3. 改完代码、提交后，一条命令发版（打包时会把 HTTPS 地址写入同学安装包）
npm run publish -- "本次更新说明"            # patch：0.1.0 -> 0.1.1（默认）
npm run publish -- minor "更新说明"          # 0.1.0 -> 0.2.0
npm run publish -- major "更新说明"          # 0.1.0 -> 1.0.0
```

发布成功后，同学端 raptor 下次启动即提示，`/update` 一键升级。打包自动排除 `.env` / `credentials.enc` / 会话记忆等本机隐私文件，`eng.traineddata`（验证码 OCR）随包分发。

其他配置：

- 客户端后台地址由 `npm run publish` 在打包时写入安装包；仅维护者本地可用 `.env` 的 `RAPTOR_UPDATE_SERVER` 覆盖
- 未配置后台仅视为源码开发模式；正式 zip 没有 HTTPS 授权地址将无法发版
- 后台数据在 `update-data/`（版本 zip、meta 与 `licenses.sqlite`），部署时记得备份、别删

<details>
<summary><b>⚙️ 环境变量</b></summary>

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（或启动后对话里输入 `/key sk-你的Key` 配置，加密保存、立即生效） |
| `JWGL_USERNAME` / `JWGL_PASSWORD` | 教务系统学号 / 密码（可选；留空则首次启动引导录入并 AES-256-GCM 加密保存） |
| `RAPTOR_MODEL` | 模型，默认 `deepseek-v4-flash`，可选 `deepseek-v4-pro`（可选） |
| `RAPTOR_ENABLE_GRAB` | 抢课模式开关：选课季设 `1` 启用抢课/盯课工具，平时留空（默认） |
| `FIRECRAWL_API_KEY` | Firecrawl 云解析通知附件（可选；本地已支持 xlsx/docx/pdf，仅作兜底） |
| `QQBOT_APP_ID` / `QQBOT_APP_SECRET` | QQ 官方机器人凭证（可选） |
| `QQBOT_PASSCODE` | QQ 授权暗号：首次给机器人发此暗号完成授权 |
| `RAPTOR_NO_UPDATE_CHECK` | 设 `1` 关闭启动时的版本更新检查（默认开启） |
| `RAPTOR_UPDATE_SERVER` | 仅维护者本地测试时覆盖授权后台地址；必须为 HTTPS，正式安装包由发版命令内置地址 |
| `UPDATE_SERVER_URL` / `UPDATE_ADMIN_TOKEN` / `LICENSE_SECRET` | 维护者配置：后台地址、管理员密钥、授权密钥哈希专用密钥；`LICENSE_SECRET` 上线后不得随意更换 |
| `DEEPSEEK_BASE_URL` | 自定义 API 地址（可选） |

</details>

## 📡 已知状态（2026-09）

- 选课系统协议已完整攻克：加密串（`xkkz_xh`）、多轮次、Display 隐藏字段，课程查询/提交全链路可用；下轮选课设 `RAPTOR_ENABLE_GRAB=1` 即可再战。
- 学期交界期课表/考试查询为**候选学期探测**，不依赖日历日期推断；开学日期按校历维护（未知学期按 9 月/3 月第一个周一估算并标注）。
- 教务线路偶发抖动：所有登录内置 5 次指数退避重试，单学期成绩查询带重试。

<details>
<summary><b>教务系统模块覆盖清单（55 个菜单模块）</b></summary>

- **已接入 14 个工具（+3 抢课季工具）**：课表 / 成绩 GPA / 考试 / 学籍 / 已选教学班 / 可重修 / 实验成绩 / 选课查询三件套 / 教务处通知三件套 / 记忆
- **学校侧停用**（返回「系统维护页面」，任何客户端不可用）：空闲教室、班级课表、学业情况、实验课表、培养方案、站内通知
- **申请/流程类**（提交表单操作，非查询，暂未接入）：学籍异动、转专业、重修报名、毕业学位申请、毕设流程等 30+ 项

</details>

## 🏗️ 技术栈

- **Agent**：[Vercel AI SDK v7](https://ai-sdk.dev)（`ToolLoopAgent` + `runAgentTUI` 终端对话 UI；`scripts/patch-tui.mjs` 给库的空屏打欢迎面板补丁，启动后自动展示今日课表/最新通知，`npm install` 时经 postinstall 自动生效）
- **LLM**：DeepSeek（默认 `deepseek-v4-flash`，可切换）
- **教务协议**：NJTECH 正方新版适配层（账号密码自动登录 RSA + CSRF；选课接口按官方前端 zzxkyzb.js 逆向 + 抢课实战校准）

## 📁 项目结构

```
├── bin/raptor.cjs      # 全局命令入口（npm link 后任意目录敲 raptor）
├── docs/               # 吉祥物 & 素材
└── src/
    ├── index.ts        #   入口：终端对话 UI（QQ 已配置时一并拉起）
    ├── agent.ts        #   agent 定义（系统提示词 + 装配，抢课能力按开关注入）
    ├── config.ts       #   .env 配置加载（按项目根解析，任意目录启动均可）
    ├── attachments.ts  #   附件获取与解析（本地 xlsx/docx/pdf + 验证码 OCR + Firecrawl 兜底）
    ├── memory/         #   两层记忆（长期事实条目 + 短期会话捕获恢复）
    ├── qq/             #   QQ 官方机器人桥（bridge + 消息格式化 + 文件日志）
    ├── jwgl/           #   教务协议层（登录 / 课表 / 成绩 / 选课 / 通知爬取）
    │   ├── auth.ts     #     登录（RSA + CSRF）
    │   ├── http.ts     #     带 Cookie 管理的 HTTP 客户端
    │   ├── crypto.ts   #     正方 RSA 密码加密
    │   ├── academics.ts#     课表 / 考试（学期探测 + 周次计算 + 节次时间）
    │   ├── grades.ts   #     成绩 + GPA + 通识六类统计
    │   ├── portal.ts   #     学籍 / 已选课 / 重修 / 实验成绩
    │   ├── news.ts     #     教务处官网通知（列表 / 正文 / 附件提取）
    │   ├── xk.ts       #     选课协议（加密串 / 多轮次 / 教学班 / 提交）
    │   └── types.ts
    └── tools/          #   agent 工具（默认 14 个，抢课季 +3）+ 会话缓存管理
```

## ⚠️ 免责声明

- 本项目**仅供个人学习与研究用途**（正方教务系统协议分析、LLM Agent 工程实践），与南京工业大学官方无关，也未获其授权或认可。
- 使用者需**自行承担全部风险**：请遵守学校相关规定及教务系统使用条款，因使用本工具产生的任何后果（包括但不限于账号受限、选课异常、成绩处理）由使用者本人负责。
- 选课功能（`RAPTOR_ENABLE_GRAB=1`）尤其注意：部分学校明确禁止使用第三方工具进行选课操作，违规可能影响成绩或学籍，**请自行评估并谨慎使用**。
- 请勿将本项目用于商业用途或大规模请求（传输层内置全局限速令牌桶，`RAPTOR_MAX_RPS` 只允许下调、请勿调高）。
- **关于验证码识别**：附件下载路径中的图形验证码由本地 tesseract 自动识别，这在技术上属于绕过网站的反自动化措施。此能力仅限用于获取**本人有权访问的通知附件**，重试上限 3 次；如需完全停用，设 `RAPTOR_DISABLE_CAPTCHA_OCR=1`。它不是本项目的能力卖点，本条声明对其单独生效。

## 🔐 安全提示

- `.env` 含教务密码与 API Key，已被 `.gitignore` 排除，**切勿提交或分享**（.env 明文保存教务密码，仅建议在个人设备使用；如需更高安全性可将密码留空、运行时交互输入）。
- 记忆/会话/授权文件（`memory.json` / `session.json` / `qq-allowlist.json`）均为本地数据，不入库。`session.json` 落盘完整对话（含学号、学籍、成绩），**请勿分享该文件**；QQ 桥为单用户设计，白名单只是准入控制，**不要把凭证共享给他人使用**。
- 学籍信息中的证件号/银行卡号/考生号在返回时自动打码，避免完整 PII 进入模型上下文。
- 抢课工具（`RAPTOR_ENABLE_GRAB=1` 时）会真实提交选课操作，agent 调用前会与你确认。
- 附件云解析（Firecrawl）仅用于公开网站内容；需要登录态的教务数据一律本地直连，不经第三方。

---

<div align="center">

**🦖 CourseRaptor** · 让迅猛龙替你守教务

[⬆ 回到顶部](#-courseraptor)

</div>
