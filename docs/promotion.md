# Campus Agent 宣传执行手册

[返回首页](../README.md) · [发布文章草稿](launch-post.md) · [Adapter 设计说明](writing-an-adapter.md)

## 定位

> **CourseRaptor 是面向大学生活的开源 Campus Agent。**
>
> 用一句话处理课表、成绩、考试、通知、日历、文件和长期记忆；目前支持 NJTECH，并在建立可扩展的 University Adapter 架构。

不要把项目称为“适用于所有学校”，也不要把同一教务供应商当成兼容证据。当前的可信叙事是：**一个已有 NJTECH 实现的校园 Agent，正在公开定义跨校适配边界。**

## 已准备的发布素材

| 素材 | 用途 |
|---|---|
| [15 秒 Demo GIF](demo.gif) | README、文章和社区首帖的首屏演示；全部为虚构数据 |
| [社交分享卡片](social-preview.jpg) | GitHub Social preview、文章封面 |
| [功能参考](features.md) | 从 README 移出的完整工具细节与边界 |
| [Adapter 设计说明](writing-an-adapter.md) | 面向外校开发者的参与入口 |
| [发布文章草稿](launch-post.md) | 公众号、掘金、知乎或社区帖的可编辑初稿 |

## 30 天节奏

| 周次 | 目标 | 可交付物 | 完成标准 |
|---|---|---|---|
| 第 1 周 | 改定位 | GitHub description、精简 README、Demo GIF、功能详情外置 | 访客在首屏看到 Campus Agent、当前学校范围与下一步入口 |
| 第 2 周 | 打开跨校入口 | Adapter 设计、学校适配 Issue 模板、独立测试策略 | 陌生开发者能判断能否参与，且不会被索要隐私数据 |
| 第 3 周 | 发布故事，而非求 Star | 一篇长文 + 分渠道短文案 | 每条内容都以真实使用场景和 Adapter 邀请收尾 |
| 第 4 周 | 获得第一次陌生协作 | 回应学校适配 Issue、整理反馈、邀请小范围验证 | 至少形成一个可继续讨论的外部 Issue 或 PR |

发布时每隔 2～3 天选择一个合适社区即可。遵守社区规则，不批量复制粘贴，也不要在无关项目下留言推广。

## 可直接使用的短文案

### 中文开发者社区

> 我把自己做的 NJTECH 教务 Agent 开源成了 CourseRaptor。它把课表、成绩、考试、通知、日历、文件和记忆接进一个对话入口，Web 和 CLI 都能用。
>
> 现在我更想验证一件事：能不能把它做成一个真正可参与的 Campus Agent 框架，而不只是某个学校的查课表工具。NJTECH 是第一个实现；跨校 Adapter 的边界正在公开设计。
>
> 如果你也做过自己学校的教务接口，欢迎看看 Adapter 设计并提一个学校适配 Issue。请不要分享账号、Cookie 或个人成绩数据。

### English developer community

> CourseRaptor is an open-source Campus Agent for university life: schedules, grades, exams, notices, calendars, files, and memory in one conversation.
>
> NJTECH is the first working integration. The next goal is a safe, testable University Adapter boundary so developers can bring it to their own university without sharing credentials or private academic data.
>
> If you have worked with an academic portal, feedback on the Adapter design is especially welcome.

## 首次陌生协作的沟通原则

先研究对方的项目和公开资料，再围绕共同的技术问题交流。例如：

> 我在把一个 NJTECH 教务 Agent 的学校集成抽成 Adapter。看到你们也处理过 XX 学校的课表/成绩接口，想请教你们的学期与节次数据是否也有类似的差异？

对方有兴趣后，再给出 [Adapter 设计说明](writing-an-adapter.md)。不要索要登录材料，也不要把推广消息发送给无关项目。

## 30 天 KPI

| 指标 | 30 天目标 |
|---|---:|
| Stars | 30 |
| Forks | 3 |
| 外部 Issues | 3 |
| 外部 PR | 1 |
| 陌生贡献者 | +1 |
| 支持学校 | 1 个已支持 + 1 个实验性 Adapter |

Star 不是唯一结果。若只有 28 个 Star，但有陌生开发者提交了经过测试的学校 Adapter，这比单纯数字增长更接近项目目标。
