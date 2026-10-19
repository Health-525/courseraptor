# 开源一个大学生 AI 助手：导入课表，用一句话查课、记待办

课表在教务系统里，实验报告的截止时间在聊天里，学习笔记又在另一个软件里。想整理今天要做什么，常常得来回翻。

CourseRaptor 想先把这两件小事做好：**查自己的课表，记住自己的截止待办。**

![CourseRaptor 当前主界面与右侧功能大厅](https://raw.githubusercontent.com/Health-525/courseraptor/main/docs/screenshots/demo-overview.png)

*截图来自当前源码主界面，功能大厅和各功能面板在右侧栏内打开。数据为隔离的虚构示例，截图未调用模型。*

## 从这三句话开始

- “这周周三有哪些课？按时间和地点列出来。”
- “记一下，周五下午三点前交实验报告。”
- “结合课表和待办，整理一下今天的安排。”

导入课表后，可以在对话里查询课程、修改本地安排、保存截止事项，也可以打开功能大厅检查记录，导出课表图片或 `.ics` 日历。按需要，还能整理课程知识点，读取 PDF、Word 和表格，生成 Word、Excel 或 PDF。

课表导入不要求学校已适配；在线成绩、考试和教务通知等查询则取决于学校适配器。

## 怎么开始

**Windows 用户**可到 [Releases](https://github.com/Health-525/courseraptor/releases/latest) 下载桌面安装版或便携版，已内置 Node 运行环境。启动后在设置中填写自己的模型 API Key，再导入并核对课表。

**有 Node.js 24+ 和 Git 的用户**可以先看无需 Key 的离线演示：

```bash
git clone https://github.com/Health-525/courseraptor.git
cd courseraptor
npm ci
npm run demo
```

打开终端打印的本机地址；演示使用虚构数据和固定回答，不调用 AI。正式使用运行 `npm start`。它是个人电脑上的助手，当前不提供安装即用的手机 App。

## 使用前说明

个人记录保存在本机；正式 AI 对话所需内容会发送到你配置的模型服务商，可能产生 API 费用。提醒需要主程序保持运行，QQ 和 Obsidian 入口需另外配置。本项目非学校官方产品，重要安排以学校正式渠道为准。

## 想邀请同学帮忙验证

这次更想听到具体使用反馈：

1. 安装、模型配置、课表导入，哪一步最不顺手？
2. 有没有一件你愿意每周回来交给它处理的事情？
3. 你最常查的是课表，还是截止待办？

如果你是开发者，也欢迎拆解 TypeScript + Vercel AI SDK 的工具循环、记忆和多入口实现，或参与改进。

[项目与上手说明](https://github.com/Health-525/courseraptor#readme) · [同学指南](https://github.com/Health-525/courseraptor/blob/main/docs/student-guide.md) · [反馈问题](https://github.com/Health-525/courseraptor/issues/new/choose) · [参与贡献](https://github.com/Health-525/courseraptor/blob/main/CONTRIBUTING.md)

如果确实帮到了你，欢迎分享项目链接或点一个 Star。反馈时请勿上传密码、模型 Key、成绩单或完整个人日志。
