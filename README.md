<div align="center">

<img src="docs/courseraptor-mascot.png" width="260" alt="CourseRaptor mascot" />

# 🦖 CourseRaptor

**南京工业大学教务对话式 Agent**
抢课 · 课表 · 成绩 · 考试 · 教务通知，一句话搞定。

[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](#)
[![Vercel AI SDK](https://img.shields.io/badge/Vercel%20AI%20SDK-v7-black.svg)](https://ai-sdk.dev)
[![LLM](https://img.shields.io/badge/LLM-DeepSeek-4D6BFE.svg)](https://www.deepseek.com)
[![教务系统](https://img.shields.io/badge/%E6%95%99%E5%8A%A1-%E6%AD%A3%E6%96%B9%E6%96%B0%E7%89%88-success.svg)](#已知状态-2026-08)

</div>

---

在终端里和一只迅猛龙对话，它会替你登录教务系统、查数据、盯余量、抢课、读通知：

```text
$ raptor

你   这学期课表看一下
🦖   2026-2027学年第一学期，共 11 门课。周一 7-8 节「最优化方法」@仁智楼518；
     周三全天没课；操作系统原理第 14-17 周改上机（学院机房）。

你   最近教务处有什么通知？选课什么时候开始？
🦖   已读《本科生选课通知》（南工教〔2026〕83号）：
     第一轮正选 8月27日 09:00 开始，必修/专选至 8月30日 24:00；
     通识选修按年级错峰：2023级 10:00 / 2024级 12:00 / 2025级 14:00。

你   羽毛球课还有名额吗
你   盯着人工智能导论 60 秒，有名额告诉我
你   开抢！目标：羽毛球（周三班），跑 3 分钟
```

## ✨ 能力总览

Agent 可调用 **11 个工具**，覆盖选课作战、教务查询、通知情报三条线。

### 🎯 选课作战

| 工具 | 说明 | 耗时 |
|---|---|---|
| `get_xk_status` | 选课模块状态：是否开放（iskxk）、接口是否被防爬拦截 | ~3s |
| `search_courses` | 按关键词搜课程，查各教学班余量 | ~3s |
| `search_jxb` | 查某门课**所有教学班**明细：各班教师 / 时间 / 地点 / 余量对比 | ~5s |
| `watch_courses` | 盯课：限时轮询余量变化，只观察不提交 | 指定时长 |
| `grab_course` | 抢课：余量出现即自动提交选课，成功即停（真实操作，调用前会确认） | 指定时长 |

### 📚 教务查询

| 工具 | 说明 | 耗时 |
|---|---|---|
| `get_schedule` | 课表：自动探测最新学期（学期交界不查错），含节次时间段与当前周次；也可指定如 `2026-2027-1` | ~3-5s |
| `get_grades` | 全部学期成绩 + GPA（NJTECH 绩点规则，重修取最高分） | ~10s |
| `get_exams` | 考试安排：科目 / 日期 / 考场 / 座位号 | ~3-5s |

### 🧠 两层记忆

| 层 | 存储 | 机制 |
|---|---|---|
| **短期记忆** | `session.json`（本地） | 模型中间件逐轮捕获完整对话并落盘；下次启动自动把上次会话转写注入提示词，跨重启延续 |
| **长期记忆** | `memory.json`（本地） | agent 通过 `save_memory` 工具自主维护事实条目（偏好/目标课程/时间结论），启动时全量注入 |

说一次「记住我想抢羽毛球周三班」，之后每次新会话它都记得。记忆文件在本地且已被 `.gitignore` 排除。

### 📰 通知情报

| 工具 | 说明 | 耗时 |
|---|---|---|
| `get_jwc_news` | 教务处官网（jwc.njtech.edu.cn）最新通知列表：公告通知 / 教学动态 / 考试排课 | ~5s |
| `read_jwc_notice` | 读通知**正文全文**（选课时间表、截止日期都在正文里） | ~3s |
| `fetch_attachment` | 通知附件（PDF/DOC/XLS）：配 `FIRECRAWL_API_KEY` 时解析成文本，否则下载到本地 `downloads/` | ~5s |
| `save_memory` | 长期记忆维护（跨会话事实条目：偏好/目标/结论，增删改查） | 即时 |

## 🚀 快速开始

```bash
# 1. 克隆 & 安装
git clone https://github.com/Health-525/courseraptor.git
cd courseraptor && npm install

# 2. 配置凭证（教务账号 + DeepSeek Key）
cp .env.example .env   # 编辑 .env 填入

# 3. 注册全局命令（一次即可，任意目录可用）
npm link

# 4. 启动
raptor                 # 全局命令
npm run dev            # 或项目内开发模式
```

<details>
<summary><b>⚙️ 环境变量</b></summary>

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填） |
| `JWGL_USERNAME` / `JWGL_PASSWORD` | 教务系统学号 / 密码（必填） |
| `RAPTOR_MODEL` | 模型，默认 `deepseek-v4-flash`，可选 `deepseek-v4-pro`（可选） |
| `FIRECRAWL_API_KEY` | Firecrawl 云解析通知附件为文本（可选；未配置则附件下载到本地） |
| `DEEPSEEK_BASE_URL` | 自定义 API 地址（可选） |

</details>

## 📡 已知状态（2026-08）

- **选课临近**：第一轮正选 **8 月 27 日 09:00** 开始（详见教务处 8-23 通知），当前系统 `iskxk=0` 尚未开放。
- 课程查询接口存在「加密串错误」防爬拦截（已复刻浏览器时序：csrftoken + Display 预热 + gnmkdm），选课开放后若仍拦截需进一步对策。
- 学期交界期课表/考试查询已改为**候选学期探测**，不依赖日历日期推断。
- 教务线路偶发抖动：所有登录内置 5 次指数退避重试。

## 🏗️ 技术栈

- **Agent**：[Vercel AI SDK v7](https://ai-sdk.dev)（`ToolLoopAgent` + `runAgentTUI` 终端对话 UI）
- **LLM**：DeepSeek（默认 `deepseek-v4-flash`，可切换）
- **教务协议**：NJTECH 正方新版适配层（账号密码自动登录 RSA + CSRF；选课接口按官方前端 zzxkyzb.js 逆向校准）

## 📁 项目结构

```
├── bin/raptor.cjs      # 全局命令入口（npm link 后任意目录敲 raptor）
├── docs/               # 吉祥物 & 素材
└── src/
    ├── index.ts        #   入口：终端对话 UI
    ├── agent.ts        #   agent 定义（系统提示词 + 装配）
    ├── config.ts       #   .env 配置加载（按项目根解析，任意目录启动均可）
    ├── attachments.ts  #   附件获取（Firecrawl 云解析 / 本地下载）
    ├── jwgl/           #   教务协议层（登录 / 课表 / 成绩 / 选课 / 通知爬取）
    │   ├── auth.ts     #     登录（RSA + CSRF）
    │   ├── http.ts     #     带 Cookie 管理的 HTTP 客户端
    │   ├── crypto.ts   #     正方 RSA 密码加密
    │   ├── academics.ts#     课表 / 考试（学期探测 + 周次计算 + 节次时间）
    │   ├── grades.ts   #     成绩 + GPA 计算
    │   ├── news.ts     #     教务处官网通知（列表 / 正文 / 附件）
    │   ├── xk.ts       #     选课（搜索 / 教学班 / 提交，官方 JS 逆向校准）
    │   └── types.ts
    └── tools/          #   agent 工具（11 个）+ 会话缓存管理
```

## 🔐 安全提示

- `.env` 含教务密码与 API Key，已被 `.gitignore` 排除，**切勿提交或分享**。
- `grab_course` 会真实提交选课操作，agent 调用前会与你确认目标课程。
- 附件云解析（Firecrawl）仅用于公开网站内容；需要登录态的教务数据一律本地直连，不经第三方。

---

<div align="center">

**🦖 CourseRaptor** · 让迅猛龙替你守教务

</div>
