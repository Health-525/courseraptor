# CourseRaptor 的 GitHub 展示与推广实践

目标是让合适的同学找到项目、看懂价值、成功体验，并让开发者能参与。没有一种排版可以保证 Star 增长；以下选择结合 GitHub 官方文档与项目当前阶段。

| 实践 | 对本项目的落实 | 为什么这样做 |
|---|---|---|
| 首屏回答用途、受众与如何开始 | 一句定位、品牌图、体验/指南/反馈入口 | 访客不用先读完工具手册。[README 官方建议](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) |
| 视觉服务于理解 | 品牌插画与真实 UI 截图分开，示例标注虚构 | 保留辨识度，同时让人知道真正使用时是什么样 |
| 图片与链接可分享 | 单独准备社交预览图；PNG/JPG/GIF 小于 1 MB，2:1 比例 | 仓库链接被分享时保持一致形象。[社交预览要求](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview) |
| Topics 匹配真实用途 | campus-agent、student-tools、timetable、academic-assistant、TypeScript 等 | 帮助相关学生与开发者发现项目，不添加无关热词。[Topics 官方说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics) |
| 信任来自可核对事实 | Stars/Forks/最近提交使用动态徽章，CI 展示真实运行结果 | 不使用虚构用户数、零风险承诺或手写永远绿色的测试徽章 |
| 社区入口职责清楚 | Discussions 用于交流；Issues 用于可复现错误与具体功能请求；提供贡献、安全和支持说明 | 降低参与门槛。[社区资料建议](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions) |
| 自动验证而非堆功能 | Windows/Linux CI、只读权限、固定 Action 提交 | 改动可验证，减少漂移。[Actions 安全实践](https://docs.github.com/en/actions/reference/security/secure-use) |
| 发布流程匹配承诺 | 本地功能验证后再同步 README 与源码，公开包排除个人数据 | 避免文档介绍的功能在仓库中找不到 |
| 先做小范围验证 | 自愿邀请同学完成安装、首问与日历导出 | 关注真实使用阻碍，再决定开发优先级 |

## 当前阶段不做的事情

- 不购买 Star、互刷数据或在无关仓库批量留言。
- 不把规划功能写成已经上线，不承诺未实现的能力永远可用。
- 不把热度图、访客计数器和动效堆到首屏，影响在手机和校园网中的加载。
- 不为凑齐社区评分而承诺无法履行的响应时限、隐私邮箱或全天支持。
- 不在没有独立账号隔离和部署设计时，把本机部署的服务开放给多人使用。

## 维护时看什么

安装是否成功、首次查询在哪里失败、同学是否真正完成日历导入、反馈能否复现。GitHub Stars 是可见度信号，不能代替实际使用体验。

每次重要功能更新，同时检查中英文 README、路线图、演示说明与相关截图。CI 徽章只反映它所链接的实际工作流状态。

## 2026-10-18 首屏改版记录

按「5 秒层 → 30 秒层 → 深读层」重排，并把三处会伤可信度的问题一起修掉：

| 改动 | 依据 |
|---|---|
| 中文 / 英文 README 首屏改为 **横幅 + 一句定位 + 徽章 + 五端口径 + 一次克制的 Star 请求**，第一张真实界面图提前到第 20 行内 | 访客先判断「与我有关吗」，再决定读不读工具手册（[About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)） |
| **换掉旧主截图**：原 `screenshots/gui.png` 侧栏含 29 条真实感会话标题（「记住国庆期间我需要将我…」「https://abao.alipay.com/…」），与 README 自己「截图均为虚构示例数据」的声明冲突。改为离线演示模式下重新截取的 `web-chat.png` / `web-hall.png` + 既有 `screenshot-demo.jpg` | 截图是承诺的一部分：声称虚构就必须真的虚构。旧图与未使用的 `qq-history-sidebar.png` 已从仓库移除 |
| **社交预览改真 JPEG**（1280×640 / 89 KB）。此前是 PNG 字节挂 `.jpg` 扩展名，GitHub 按内容识别能显示，但按 `Content-Type` 渲染的平台（X / 微信 / 即刻）会裂图 | [社交预览规范](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview) |
| **logo 1254² / 1.02 MB → 512² / 156 KB**，路径与文件名不变 | 首屏资源要跟着展示尺寸走：README 只显示 160px，favicon 上限 512px |
| **口径统一**：slogan 收敛为「校园日常，一句话。」（落地页标题同步）、端入口统一为「一个内核，五个入口」、工具数统一 19、厂商数 12、依赖方向统一 `local → channels → core` | 同一件事在 README / 落地页 / About / 推广文案里有 3–4 种说法时，访客第一眼就会觉得「没打磨」 |
| **About 描述重写**并补 6 个 Topics（campus / education / productivity / desktop-app / privacy / ai-assistant，共 16 个，上限 20） | 话题页与 Explore 是免费流量；描述前 60 字符决定搜索结果里的点击 |
| README 安装区按「下载 exe（同学）→ 离线演示 → 源码（开发者）→ 技能包」重排，Node ≥ 24 作为**前置声明**提到命令之前 | 39 个 star 对应 10 次下载，说明卡点是「从看到到用上」，不是曝光不够 |
| 许可证独立成末节，新增贡献与致谢 | 结构自检项 |
