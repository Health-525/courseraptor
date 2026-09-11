<div align="center">

<img src="docs/courseraptor-logo.png" width="150" alt="CourseRaptor logo" />

# 🦖 CourseRaptor

### An open-source Campus Agent for university life.

课表 · 成绩 · 考试 · 通知 · 日历 · 文件 · 长期记忆，一句话搞定。

> **Currently supports NJTECH.** We're building an adapter architecture for more universities.

[English](README.en.md) · [功能参考](docs/features.md) · [贡献指南](CONTRIBUTING.md)

[![下载最新版](https://img.shields.io/github/v/release/Health-525/courseraptor?label=%E4%B8%8B%E8%BD%BD%E6%9C%80%E6%96%B0%E7%89%88&color=orange&style=for-the-badge)](https://github.com/Health-525/courseraptor/releases/latest)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Health-525/courseraptor?style=social)](https://github.com/Health-525/courseraptor)

</div>

## 🎬 Demo

![15 秒演示：查询课表、筛选相关通知、导出手机日历](docs/demo.gif)

*演示中的课程和通知均为虚构数据；没有展示账号、密码、API Key 或真实教务信息。*

## Why CourseRaptor?

大学生活的信息分散在教务系统、通知网页、文件和日历里。CourseRaptor 把它们接到一个可对话的本地 Agent：不必记菜单路径，可以直接问“明天有什么课”“哪些通知和我有关”“帮我导出到手机日历”。

它不仅是查课表的脚本，也面向校园日常任务：理解通知、处理表格与文档、保存偏好，并在 Web、CLI 和可选 QQ 入口之间复用能力。

## ✨ Features

| 场景 | 能力 |
|---|---|
| 教务信息 | 课表、成绩/GPA、考试、学籍、已选课程与选课状态 |
| 通知与文件 | 拉取教务通知与附件，分页阅读文档，筛选 Excel/CSV |
| 时间与日历 | 教学周、放假/调休、天气、`.ics` 课表和考试日历 |
| 学生交付物 | 从内容生成或转换 Word、Excel、PPT、PDF |
| 个性化 | 短期会话与长期记忆；可选 QQ 机器人入口 |

完整的工具清单、边界和配置项见 [功能参考](docs/features.md)。

## 🏗️ Architecture

```text
Web / CLI / QQ
      │
CourseRaptor Agent ── tools · memory · files · calendars
      │
University integration
      ├── NJTECH  ✅ supported today
      └── Your university  🧩 adapter architecture in progress
```

当前学校集成位于 [`src/jwgl/`](src/jwgl/)；目标是把学校登录、课表、成绩、考试和通知抽成可独立实现、可独立测试的 Adapter。设计方向和参与方式见 [Bring CourseRaptor to Your University](docs/writing-an-adapter.md)。

## 🚀 Quick Start

### Windows 便携包

从 [Releases](https://github.com/Health-525/courseraptor/releases/latest) 下载名称包含 **`portable-win-x64`** 的 zip，解压后运行 `start.bat`。安装包内含 Node.js 运行时；首次正式查询时再按引导配置自己的教务账号和模型 API Key。

### 开发环境

```bash
git clone https://github.com/Health-525/courseraptor.git
cd courseraptor
npm ci
npm run doctor
npm start
```

需要 Node.js 24+。正式模式会把提问及相关查询结果发送给你配置的模型服务，可能产生 API 费用；凭证只用于你自己的本地实例。详细配置见 [配置参考](docs/configuration.md)。

## 🎓 University Support

| 学校 | 状态 | 说明 |
|---|---|---|
| Nanjing Tech University (NJTECH) | ✅ 已支持 | 当前可用的教务系统集成 |
| 其他学校 | 🧩 Adapter 架构设计中 | 欢迎先提出学校系统类型、公开接口线索与测试场景 |

同为“正方教务”并不等于协议兼容。请不要提交真实账号、Cookie、成绩单或通知附件；我们会先为每个学校建立脱敏样例与独立测试，再标记为支持。

## 🤝 Contributing

想把 CourseRaptor 带到你的学校、改进学生体验或完善文档？先阅读 [贡献指南](CONTRIBUTING.md)，然后从一个可复现 Issue、学生场景或小型文档改进开始。

- [功能参考](docs/features.md)
- [产品路线图](docs/roadmap.md)
- [Adapter 设计说明](docs/writing-an-adapter.md)
- [学生使用指南](docs/student-guide.md)

项目以 [ISC License](LICENSE) 发布，与任何学校均无官方隶属或授权关系。请遵守本校制度及教务系统使用条款。
