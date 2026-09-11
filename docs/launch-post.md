# 🦖 CourseRaptor：教务琐事，一句话。

欢迎来到 CourseRaptor！这是面向南京工业大学同学的开源教务 AI 助手。

早八在哪上、最近什么时候考试、通识修了哪些类别、教务通知要做什么——可以直接在浏览器或终端里提问。

![CourseRaptor](https://raw.githubusercontent.com/Health-525/courseraptor/master/docs/social-preview.jpg)

## 先体验，再配置

准备 Node.js 24 或更高版本，下载项目后，在项目目录运行：

```bash
npm ci
npm run demo
```

演示默认打开 `http://127.0.0.1:3211`，无需教务账号或 API Key。全部为虚构数据和固定示例回答，不调用模型或学校接口。

正式使用运行 `npm start`，Windows 也可以双击 `start.bat`，按提示配置自己的教务账号和 DeepSeek API Key。

## 这次完善了什么

- 学业概览：已获学分、未通过课程、待确认课程。
- 修正未知成绩、未通过通识课程与重修记录的统计问题。
- 免账号离线演示、启动自检和更清晰的学生使用指南。
- 安装包排除本地个人数据，更新时保护聊天、附件和个人校历。
- 更直观的中英文 README、功能路线图和反馈表单。

正式对话会把提问与所需查询结果发送到模型服务，可能产生 API 费用。项目为非官方个人工具，当前仅适配南京工业大学。学分要求、考试安排和通知截止日期请以本人教务记录和学校原文为准。

## 想听听你最需要什么

欢迎在这条讨论下面分享：

1. 你最想让它帮忙解决的教务琐事是什么？
2. 安装、配置或第一次提问，哪一步最不顺手？
3. 今日日程、截止提醒、变更提示、学分核对，你更想先用到哪个？

请勿上传学号、成绩单、密码、Key 或完整日志。可复现错误请使用 [Issue 表单](https://github.com/Health-525/courseraptor/issues/new/choose)。

[开始使用](https://github.com/Health-525/courseraptor#readme) · [同学指南](https://github.com/Health-525/courseraptor/blob/master/docs/student-guide.md) · [路线图](https://github.com/Health-525/courseraptor/blob/master/docs/roadmap.md) · [参与贡献](https://github.com/Health-525/courseraptor/blob/master/CONTRIBUTING.md)

如果确实帮到了你，欢迎 Star，或者把仓库地址分享给同学，让对方配置自己的账号。
