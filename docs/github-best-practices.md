# CourseRaptor 的 GitHub 展示与推广实践

目标是让合适的同学找到项目、看懂价值、成功体验，并让开发者能参与。没有一种排版可以保证 Star 增长；以下选择结合 GitHub 官方文档与项目当前阶段。

| 实践 | 对本项目的落实 | 为什么这样做 |
|---|---|---|
| 首屏回答用途、受众与如何开始 | 一句定位、品牌图、体验/指南/反馈入口 | 访客不用先读完工具手册。[README 官方建议](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) |
| 视觉服务于理解 | 品牌插画与真实 UI 截图分开，示例标注虚构 | 保留辨识度，同时让人知道真正使用时是什么样 |
| 图片与链接可分享 | 单独准备社交预览图；PNG/JPG/GIF 小于 1 MB，2:1 比例 | 仓库链接被分享时保持一致形象。[社交预览要求](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview) |
| Topics 匹配真实用途 | NJTECH、student-tools、timetable、academic-assistant、TypeScript 等 | 帮助相关学生与开发者发现项目，不添加无关热词。[Topics 官方说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics) |
| 信任来自可核对事实 | Stars/Forks/最近提交使用动态徽章，CI 展示真实运行结果 | 不使用虚构用户数、零风险承诺或手写永远绿色的测试徽章 |
| 社区入口职责清楚 | Discussions 用于交流；Issues 用于可复现错误与具体功能请求；提供贡献、安全和支持说明 | 降低参与门槛。[社区资料建议](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions) |
| 自动验证而非堆功能 | Windows/Linux CI、只读权限、固定 Action 提交 | 改动可验证，减少漂移。[Actions 安全实践](https://docs.github.com/en/actions/reference/security/secure-use) |
| 发布流程匹配承诺 | 本地功能验证后再同步 README 与源码，公开包排除个人数据 | 避免文档介绍的功能在仓库中找不到 |
| 先做小范围验证 | 自愿邀请同学完成安装、首问与日历导出 | 关注真实使用阻碍，再决定开发优先级 |

## 当前阶段不做的事情

- 不购买 Star、互刷数据或在无关仓库批量留言。
- 不把规划功能写成已经上线，不承诺考试/选课实时接口永远可用。
- 不把热度图、访客计数器和动效堆到首屏，影响在手机和校园网中的加载。
- 不为凑齐社区评分而承诺无法履行的响应时限、隐私邮箱或全天支持。
- 不在没有独立账号隔离和部署设计时，把个人教务服务开放给多人使用。

## 维护时看什么

安装是否成功、首次查询在哪里失败、同学是否真正完成日历导入、反馈能否复现。GitHub Stars 是可见度信号，不能代替实际使用体验。

每次重要功能更新，同时检查中英文 README、路线图、演示说明与相关截图。CI 徽章只反映它所链接的实际工作流状态。
