# Star 增长执行包（待维护者手动发布）

[返回首页](../README.md) · [推广策略](promotion.md) · [首发帖](launch-post.md)

本页是 [`promotion.md`](promotion.md) 的执行层：**每个渠道一段可直接粘贴的定制文案**。发布账号属于维护者本人，发布时机与渠道由维护者决定；遵守各社区规则，**不要跨渠道复制同一段文字批量发帖**。

当前基线：17 stars（2026-09-24）。以下"预期影响"为社区经验值，不是承诺。

---

## 0. 已在本仓库内完成的动作（无需重复）

| 动作 | 状态 |
|---|---|
| README / README.en / 截图 / 徽章 / 落地页 / social preview | ✅ 已就绪 |
| Topics 补至 15 个（新增 cli / terminal / tui / chatbot / education / personal-assistant） | ✅ 2026-09-24 |
| Announcements 首发帖发布并置顶讨论区 | ✅ [discussions/69](https://github.com/Health-525/courseraptor/discussions/69) |
| GitHub Pages 落地页在线 | ✅ https://health-525.github.io/courseraptor |

## 1. 发布节奏（先内后外，别一次全发）

1. **第 1 周**：校内渠道（同学是最高转化率的 star 与真实用户来源）+ HelloGitHub 投稿（审核有周期，先排队）。
2. **第 2 周**：V2EX / Linux.do（错开 2-3 天发，两站用户重叠度高）。
3. **第 3 周起**：掘金/少数派长文 + awesome 列表 PR，长尾引流。

> GitHub Trending 的机制是**短窗口 star 增速**：某一天集中来 20-30 star 比一周均匀来 50 更容易上 Trending。所以大渠道帖尽量错峰但别拖太久。

## 2. HelloGitHub 投稿（优先级最高）

中文开源项目最大的曝光位之一，月刊收录后通常带来稳定star流入。以 issue 形式提交：<https://github.com/521xueweihan/HelloGitHub/issues>（用其模板，勾选"推荐项目"）。

可直接粘贴的内容（按模板字段裁剪）：

> **项目名称**：CourseRaptor
>
> **项目地址**：<https://github.com/Health-525/courseraptor>
>
> **项目简介**：开源校园智能助手，把课表、成绩、考试、教务通知、待办、日历、知识库与记忆变成一句话对话。终端 TUI / 网页 / QQ 机器人三种入口，全本地运行，凭证 AES-256-GCM 加密落盘，无遥测。内置免账号离线演示（`npm run demo`，虚构数据）。
>
> **推荐理由**：面向真实校园场景的完整 AI Agent 工程样例：Vercel AI SDK v7 ToolLoopAgent + DeepSeek + 自研正方新版教务协议适配层，31 个工具、两层记忆、附件云解析与 .ics 日历导出。架构上 core / adapters / channels 三层解耦，正在征集更多学校的适配共建。
>
> **适用人群**：南京工业大学在校学生；想学习本地 AI Agent 工程实现的开发者。
>
> **项目截图**：`docs/screenshots/tui.png`、`docs/screenshots/gui.png`（虚构演示数据）

## 3. V2EX「分享创造」

规则：<https://www.v2ex.com/go/create>，**同一项目只发一次**，标题不带链接（放正文）。

标题建议：`开源了一个给南工同学用的教务 AI 助手：课表成绩一句话`

正文：

> 做了个开源项目 CourseRaptor，给我自己（南京工业大学）也是给同学用的教务 AI 助手。
>
> 能干什么：一句话查课表 / 成绩 / 考试 / 学籍 / 教务通知，通知附件自动下载和表格筛选，待办到期提醒，课表导出 .ics 到手机日历，还能生成 Word/Excel/PPT/PDF。终端敲 `raptor` 直接聊，也能开网页版，接了个 QQ 官方机器人。
>
> 技术栈：TypeScript + Vercel AI SDK v7（ToolLoopAgent）+ DeepSeek，教务侧是正方新版的协议适配（RSA + CSRF 登录，选课接口逆向自官方前端）。架构分了 core / adapters / channels 三层，学校无关内核和学校适配层是解耦的——目前只适配了 NJTECH，欢迎其他学校的同学来共建适配层。
>
> 隐私方面比较较真：全本地运行，教务密码和 API Key 用 AES-256-GCM 加密落盘，无任何遥测。仓库里有免账号的离线演示（npm run demo，虚构数据），不想配 Key 也能先看效果。
>
> 免费帮同学干活但不是免费 API：正式对话走自己的 DeepSeek Key。抢课退课这类写操作只在交互模式里做且要二次确认，无头脚本不碰。
>
> 项目地址：https://github.com/Health-525/courseraptor
>
> 想听听大家对这类学生工具的需求，尤其是首次配置和通知截止提醒。

## 4. Linux.do

发在「开发调优」类板块，语气比 V2EX 更口语一点，可复用上文但**改写开头两段**（两站用户重叠高，避免同文检测与观感）。建议增加一段：

> 去防吞楼：项目纯本地、不收集任何数据，登录凭证加密存本机，源码可审计，欢迎扒代码。

## 5. 掘金 / 少数派长文（教程角度）

纯"我开源了 XX"的文章效果一般，**教程式长文**长尾流量好得多。建议标题：

- 《我用 Vercel AI SDK + DeepSeek 写了个教务 Agent，替自己守课表和成绩》
- 《给正方教务系统写一个 AI 适配层：协议逆向、限速与隐私设计》

大纲：动机（校园场景）→ 架构（三层解构图）→ 关键技术点（ToolLoopAgent 工具循环 / 正方登录协议 / 凭证加密 / 全局限速令牌桶 / 离线演示模式）→ 踩坑 → 效果截图（虚构数据）→ 求共建。文末放仓库与落地页链接。

## 6. Awesome 列表 PR（长尾）

向这些仓库提 PR（先读各自 CONTRIBUTING 与格式，按需修改措辞）：

| 目标仓库 | 建议条目 |
|---|---|
| [e2b-dev/awesome-ai-agents](https://github.com/e2b-dev/awesome-ai-agents) | `- [CourseRaptor](https://github.com/Health-525/courseraptor) - Open-source campus assistant agent for timetables, grades, exams and announcements (NJTECH, local-first).` |
| [deepseek-ai/Awesome-DeepSeek-Integration](https://github.com/deepseek-ai/Awesome-DeepSeek-Integration) | 按"Applications"分区格式提交，注明本地运行 + AI SDK v7 |
| [alebcay/awesome-cli-apps](https://github.com/alebcay/awesome-cli-apps) | `- [CourseRaptor](…) - Conversational campus/academic assistant in the terminal.`（归入 Productivity 类） |

## 7. 校内渠道（转化率最高）

- 年级群 / 班群 / 校园墙：发 `docs/launch-post.md` 的精简版（去掉 GitHub 内链，保留"先跑离线演示"钩子）+ 落地页链接。
- 强调三点对同学最有感知：**下载 zip 双击就能用（不用装 Node）、数据不出自己电脑、离线演示不用配任何东西**。
- 找 1-2 位同学先按 README 走一遍安装，把卡点修掉再大范围发（对应 promotion.md 的"首问失败率"优先原则）。

## 8. 不做的事

- 不买 star、不用小号互 star、不加互赞群——违反 GitHub ToS，且会被 star 历史曲线和 Explore 算法识别，得不偿失。
- 不向无关项目 issue/PR 里贴自己仓库链接（promotion.md 已定调）。
- 不在 README 或帖子中夸大适配范围与能力；star 是结果不是目标，可信度才是复利。
