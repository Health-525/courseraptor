# CourseRaptor 项目介绍与推广素材

[返回首页](../README.md) · [发布介绍稿](launch-post.md)

## 一句话定位

**大学生的开源 AI 课表与待办助手。导入课表，用一句话查课、记待办、整理本周安排。**

先面向愿意使用电脑助手、愿意配置模型的大学生，尤其是计算机、AI 社团与个人知识管理爱好者。第一轮宣传围绕课表和截止待办，其他功能按需要展开。面向开发者的工程介绍单独写，不让学生先读架构说明。

## GitHub About 与软件包简介

> 大学生的开源 AI 课表与待办助手：导入课表，用一句话查课、记待办、整理本周安排。本地保存，自选模型；支持网页、终端及可选的 QQ / Obsidian 入口。

网站摘要使用同一定位，补上“正式 AI 对话需要自己的模型 API Key”。不以工具数量、厂商数量或代码行数作为学生介绍的主标题。

## 发给同学的介绍

> 课表和截止日期散在不同地方，查询时总要来回翻。CourseRaptor 是一个开源 AI 课表与待办助手：把课表导进去，之后可以直接问“这周周三在哪上课”，也可以说“记一下，周五下午三点前交实验报告”。还能看今日安排、导出课表图，把知识点按课程保存。
>
> 它运行在自己的电脑上。Windows 有安装包，正式对话需要配置自己的模型 API Key，调用可能产生费用；相关内容会发送到你选的模型服务。想先看看界面，可以看演示截图，或在 Node.js 环境运行无需 Key 的离线演示。
>
> 想找几位同学试试课表导入和截止待办，尤其想知道第一次使用卡在哪里、过一周是否还会打开。
>
> [项目与下载](https://github.com/Health-525/courseraptor)

## 开发者社区介绍

> 开源了 CourseRaptor，一个从课表与待办切入的大学生 AI 助手。用户导入课表后，可以通过对话查询课程、保存截止事项、整理今日安排，并按需使用知识库与 Word / Excel / PDF 文档能力。
>
> 技术上采用 TypeScript + Vercel AI SDK，包含多轮工具调用、会话与长期记忆、模型厂商装配，以及网页、终端和可选的 QQ / Obsidian 入口。分层检查和 Windows / Linux CI 随仓库提供，适合实际运行后拆解其实现。
>
> 个人记录本地保存，模型请求发往用户配置的服务商。仓库提供虚构数据的离线剧本演示；正式对话需要自己的模型 Key。欢迎分享具体使用场景、可复现问题和改进。
>
> [源码](https://github.com/Health-525/courseraptor) · [参与贡献](../CONTRIBUTING.md)

## English introduction

> CourseRaptor is an open-source AI timetable and todo assistant for university students. Import your timetable, then ask about classes, record deadlines and review your week. It also supports study notes and Word, Excel or PDF output.
>
> Personal records are stored locally. Live conversations require your own model API key, send relevant content to that provider and may incur API charges. Windows packages and a fictional-data offline demo are available.
>
> For developers, the TypeScript + Vercel AI SDK implementation is a runnable example of tool loops, memory, provider assembly and multiple entry points.
>
> [Repository](https://github.com/Health-525/courseraptor)

## 第一段视频：只讲一个完整场景

建议 60–90 秒；时间只是素材长度目标，不是安装速度或处理速度承诺。

| 顺序 | 画面 | 要说明什么 |
|---|---|---|
| 开场 | 一张虚构课表和两条示例截止事项 | “课表和待办分散，想查的时候要来回找。” |
| 导入 | 正式版导入虚构课表，展示逐行确认 | “导入后先核对，再保存。” |
| 查询 | 问“这周周三有哪些课？” | 展示具体课程、时间和地点 |
| 记录 | 说“周五下午三点前交实验报告”，再打开待办核对 | 证明有保存结果，保留真实等待过程 |
| 结尾 | 下载入口、Key 要求与费用说明 | 邀请试用并反馈第一次使用的卡点 |

录制正式操作时，只使用自备虚构材料或已获准且脱敏的数据。`npm run demo` 是固定剧本，只适合展示界面；不能用它证明真实 AI 导入、保存或生成文件的效果，也不要把脚本回答称为模型实测。可用 `demo:live` 展示真实模型回答，但工具数据仍为虚构，且不等同于正式版的文件生成和持久化能力。

可试的标题：

- 我做了一个能记住课表和待办的大学生 AI 助手
- 导入课表后，试试用一句话整理本周安排
- 开源一个校园助手：从课表导入到截止待办，完整演示

## 一个小规模试用计划

以下数字是建议的试验目标，不是已有成绩或行业基准。

| 阶段 | 做什么 | 记录什么 |
|---|---|---|
| 先找 10–20 人 | 从熟悉的同学、计算机或 AI 社团开始，观察自主上手 | 安装、模型配置、课表导入分别在哪一步失败 |
| 第一周 | 帮助解决实际卡点，记录用户是否完成课表导入与首条待办 | 完成首次有效操作的人数，以及需要多少人工帮助 |
| 第二周 | 回访是否主动再次使用 | 回来的原因、重复使用的任务，以及没回来的原因 |
| 再决定渠道 | 用一段真实演示试发 B 站或学生社区；技术拆解发开发者社区 | 从内容观看到实际开始使用的转化，而非只看 Star |

样本目标可先定为：邀请 20 人、10 人完成首次有效操作、5 人在第二周主动再用。达不到时先定位问题，不靠继续增加功能掩盖卡点。不需要先增加遥测；可通过用户同意的回访和人工记录验证。

## 可用素材与表达边界

- [README 界面截图](screenshots/demo-overview.png)：当前源码主界面与右侧功能大厅；课表、今日安排、待办和知识库均在侧栏内打开。数据为隔离的虚构示例，截图未调用模型。
- [中文 README](../README.md) / [English README](../README.en.md)：使用定位、下载与上手路径。
- [发布介绍稿](launch-post.md)：可复制的正文草稿，未自动发布到任何社区。
- [同学指南](student-guide.md)：正式使用与常见问题。

宣传时说明本地存储与模型联网的区别，不写“所有数据永不出电脑”；说明模型需要自备 Key，不承诺固定月费。在线教务能力依赖学校适配器，不写“所有学校成绩考试开箱即用”。AI 新闻作为进阶补充单独介绍，并说明 Python 依赖与安装包版本范围。

对外发布使用仓库链接或干净安装包，不传播含个人数据的使用目录。平台帖子、群消息与合作邀请由维护者自行选择渠道和时间，本文件只准备素材。
