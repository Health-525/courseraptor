# GitHub 与校园推广建议

[返回首页](../README.md) · [路线图](roadmap.md)

定位建议：**南京工业大学学生的开源教务助手，把课表、成绩、考试和通知变成一句话查询。**

目前没有用户访谈、转化率或留存数据。以下是待验证的推广方案，不把 Star 数、用户数或使用效果写成已有成绩。

## README 要完成的事

1. 首屏让同学知道“适合谁、能帮什么忙”，提供真实界面预览。
2. 把低门槛演示放在账号配置前，给 GitHub 访客一个可以马上尝试的入口。
3. 明确 Node 版本、模型 Key、可能的 API 费用、支持学校与数据去向。
4. 把工具参数、机器人配置、发版流程放进独立文档，让学生读完主页面即可开始。
5. 用独立的“已实现”和“规划中”列表保持可信度；避免零风险、全链路可用、绝不丢等保证。

本轮已按以上结构修改 README。界面截图来自离线演示，均为虚构数据。

## 可以直接使用的介绍文案

> 做了一个给南工同学用的开源教务助手 CourseRaptor：一句话查课表、成绩、考试和教务通知，还能整理通识修读情况、导出手机日历。可以先运行离线演示看看效果，正式查询需要配置自己的教务账号和模型 API Key。项目目前支持南京工业大学，欢迎反馈最希望解决的使用问题。
>
> 项目地址：[Health-525/courseraptor](https://github.com/Health-525/courseraptor)

仓库 About 已更新为面向南工学生的具体用途说明，Topics 已配置，Discussions 已开启。后续使用范围变化时同步更新，避免把其他学校误列为兼容。

## 可以直接使用的素材

| 素材 | 文件 / 入口 | 用途 |
|---|---|---|
| 品牌横幅 | [hero-banner.png](hero-banner.png) | README 首屏，深蓝与薄荷绿的小恐龙品牌图 |
| 社交分享卡片 | [social-preview.jpg](social-preview.jpg) | 1280×640，约 70 KB；用于 GitHub Social preview |
| 演示截图 | [screenshot-demo.jpg](screenshot-demo.jpg) | 真实产品界面，全部虚构数据 |
| 英文介绍 | [README.en.md](../README.en.md) | 帮助国际开发者理解项目与当前学校适配范围 |
| 仓库首发帖 | [launch-post.md](launch-post.md) | 发布到本仓库 Announcements 的正文 |
| 最佳实践依据 | [github-best-practices.md](github-best-practices.md) | 官方文档依据、具体实施与后续维护标准 |

品牌图使用内置 imagegen，以现有 logo 为参考；提示词见[生成记录](brand-prompt.md)。社交图由同一横幅按分享卡片尺寸渲染导出，产品界面截图与品牌插画分开使用。

### 中文社区 / 开发者分享稿

> 开源了一个给南工学生用的教务 AI 助手 CourseRaptor。技术上是 TypeScript + Vercel AI SDK，连接课表、成绩、考试和教务通知，并支持本地日历与文档导出。这次补上免凭证离线演示、学业概览、数据保护和 CI。
>
> 项目目前只适配南京工业大学，正式查询需要配置自己的教务账号和模型 Key。想听听大家对学生工具的需求，尤其是首次配置、通知截止提醒和培养方案核对。
>
> [源码与使用说明](https://github.com/Health-525/courseraptor)

### English developer introduction

> CourseRaptor is an open-source academic AI assistant for Nanjing Tech University students. It brings timetables, grades, exams, announcements, and calendar exports into a browser or terminal conversation.
>
> Built with TypeScript and the Vercel AI SDK. A credential-free offline demo uses fictional data and scripted responses. Live use requires the student's own university credentials and model API key. The current integration supports NJTECH only; feedback and contributions are welcome.
>
> [Repository](https://github.com/Health-525/courseraptor)

以上校外文案是可选发布材料。是否向具体社区提交，应遵循该社区规则；不要批量重复发帖或向无关项目留言。

## 一段短演示怎么录

使用 `npm run demo`，保持“虚构数据”提示可见：

- 打开网页，点击“这周课表”。
- 点击“我的成绩和 GPA”，展示已获学分与待确认课程的区别。
- 点击“通识学分还缺哪些”，展示分类表和培养方案核对提示。
- 点击“导出课表到手机日历”，解释正式版的导入流程。
- 结束画面给出仓库地址与“先演示，再配置自己的账号”。

演示是固定剧本，不展示虚假的实时查询速度；日历演示不会生成文件，录制正式导出需使用经本人允许且已脱敏的测试材料。

## 推广节奏和验证

| 阶段 | 要做的事 | 观察什么 |
|---|---|---|
| 小范围试用 | 邀请几位同学按 README 自助安装，维护者记录卡点 | 多少人能完成首次查询，配置最常在哪一步失败 |
| 第一次发布 | 发布经过内容检查的干净安装包、说明变化与已知限制 | 下载后是否能启动，是否需要大量一对一支持 |
| 校园分享 | 在允许分享的班群/社团渠道介绍真实用途和演示 | 是否有人完成日历导入，最常重复问什么 |
| GitHub 协作 | 保持 Issue 表单、可复现测试和路线图同步 | 有多少可复现问题和具体使用需求，问题是否被解决 |

以上消息和发布动作需由维护者决定时间与渠道。代码改动本身不会自动带来传播效果；先降低首问失败率，比新增更多工具更容易验证。
