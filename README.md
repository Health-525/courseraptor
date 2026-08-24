# 🦖 CourseRaptor

南京工业大学教务对话式 agent——抢课、课表、成绩、考试，一句话搞定。

在终端里直接对话：

```
你: 这学期课表看一下
你: 羽毛球课还有名额吗
你: 盯着人工智能导论 60 秒，有名额告诉我
你: 开抢！目标：羽毛球（周三班），跑 3 分钟
你: 最近教务处有什么通知
```

agent（DeepSeek）自动调用工具完成登录、查询、监控、提交。

## 技术栈

- **Agent**: [Vercel AI SDK v7](https://ai-sdk.dev)（`ToolLoopAgent` + `runAgentTUI` 终端对话 UI）
- **LLM**: DeepSeek（默认 `deepseek-v4-flash`，可切换）
- **教务协议**: 从 [ScholarFlow](https://github.com) 移植的 NJTECH 正方教务适配层——
  账号密码自动登录（RSA + CSRF）、选课接口按官方前端 JS（zzxkyzb.js）逆向校准

## 快速开始

```bash
# 1. 配置凭证（教务账号已预填的话只需补 DeepSeek Key）
cp .env.example .env   # 或直接编辑 .env

# 2. 注册全局命令（只需一次，任意目录可用 raptor）
npm link

# 3. 启动（二选一）
raptor          # 全局命令，任意目录
npm run dev     # 项目内开发模式
```

`.env` 需要的字段：

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填） |
| `JWGL_USERNAME` / `JWGL_PASSWORD` | 教务系统学号/密码（必填） |
| `RAPTOR_MODEL` | 模型，默认 `deepseek-v4-flash`（可选） |

## 工具清单（模型可调用）

| 工具 | 说明 | 耗时 |
|---|---|---|
| `get_xk_status` | 选课模块状态（是否开放 / 接口是否被拦截） | ~3s |
| `search_courses` | 按关键词搜课程、查各教学班余量 | ~3s |
| `search_jxb` | 查某门课所有教学班明细（各班教师/时间/地点/余量对比） | ~5s |
| `watch_courses` | 限时盯课监控（只观察不提交），返回余量事件流 | 指定时长 |
| `grab_course` | 抢课：余量出现即自动提交选课，成功即停 | 指定时长 |
| `get_schedule` | 课表（自动探测最新学期，交界期不查错；可指定如 2026-2027-1） | ~3-5s |
| `get_grades` | 全部成绩 + GPA | ~10s |
| `get_exams` | 考试安排（自动探测最新学期，可指定学期） | ~3-5s |
| `get_jwc_news` | 教务处官网最新通知（公告通知 / 教学动态 / 考试排课，无需登录） | ~5s |
| `read_jwc_notice` | 读某篇通知的正文全文 + 附件链接（时间安排都在正文里） | ~3s |

## 已知状态（2026-08）

- 选课轮次**未开放**（教务入口页 `iskxk=0`），选课开放后 `get_xk_status` 会第一时间反映。
- 课程查询接口存在「加密串错误」防爬拦截（已复刻浏览器时序：csrftoken + Display 预热 + gnmkdm），选课开放后若仍拦截需进一步对策。
- 教务线路偶发抖动：所有登录内置 5 次指数退避重试。

## 项目结构

```
├── bin/raptor.cjs  # 全局命令入口（npm link 后任意目录敲 raptor）
└── src/
    ├── index.ts    #   入口：终端对话 UI
    ├── agent.ts    #   agent 定义（系统提示词 + 装配）
    ├── config.ts   #   .env 配置加载（按项目根解析，任意目录启动均可）
    ├── jwgl/       #   教务协议层（移植自 ScholarFlow 并实战校准）
    │   ├── auth.ts     #   登录（RSA + CSRF）
    │   ├── http.ts     #   带 Cookie 管理的 HTTP 客户端
    │   ├── crypto.ts   #   正方 RSA 密码加密
    │   ├── academics.ts#   课表 / 考试抓取（学期探测 + 周次计算 + 节次时间）
    │   ├── grades.ts   #   成绩 + GPA 计算
    │   ├── news.ts     #   教务处官网通知爬取（公开页面）
    │   ├── xk.ts       #   选课（搜索/余量/提交，官方 JS 逆向校准）
    │   └── types.ts
    └── tools/      #   agent 工具（10 个）+ 会话缓存管理
```

## 安全提示

- `.env` 含教务密码与 API Key，已被 `.gitignore` 排除，**切勿提交或分享**。
- `grab_course` 会真实提交选课操作，agent 调用前会与你确认目标课程。
