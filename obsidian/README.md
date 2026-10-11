# CourseRaptor for Obsidian

[CourseRaptor](https://github.com/Health-525/courseraptor) 的 Obsidian 插件——本机教务 Agent 的第四个入口。在 Obsidian 里直接问课表、成绩、考试、教务通知，并把今日日程与待办一键插进笔记。

> 前置条件：本机正在运行 CourseRaptor（终端敲 `raptor`，或双击 Releases 里的安装包）。插件是瘦客户端，对话与查询全部由本机的 CourseRaptor 完成，数据不出电脑。

## 功能

- **对话侧栏** —— 右侧栏一句话查教务：与网页端同一内核、同一份记忆，SSE 流式回显，思考过程与工具调用全程可见；多会话切换、快捷提问、随时停止
- **插入今日日程** —— 命令面板「插入今日日程到当前笔记」：今天的课表（时间/地点/教师）+ 临近考试，写日记时顺手一插
- **插入待办清单** —— 命令面板「插入待办清单到当前笔记」：未完成待办变成 Obsidian 任务复选框
- **状态栏** —— 常驻 🦖 连接标识，点击直达对话侧栏

## 安装

两种方式任选：

**A. 手动安装（现在就能用）**

1. 克隆本仓库并在 `obsidian/` 目录执行 `npm install && npm run build`（或仓库根目录 `npm run obsidian:build`），得到 `obsidian/main.js`、`obsidian/manifest.json`、`obsidian/styles.css`
2. 三个文件复制到你的库：`<你的库>/.obsidian/plugins/courseraptor/`
3. Obsidian → 设置 → 第三方插件 → 关闭安全模式 → 启用 CourseRaptor

**B. BRAT（推荐给不想手动复制的同学）**

安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 后，用 `Add Beta plugin` 填入本仓库地址 `Health-525/courseraptor`（路径 `obsidian`），后续更新随 BRAT 自动拉取。

## 配置（默认零步）

**什么都不用填**：只要本机在运行 CourseRaptor，插件启用后会自动用默认地址 `127.0.0.1:3210` 连接并自动获取本地 API 令牌——状态栏出现「🦖 已连接」即就绪，设置里也可点「检测连接」确认。

仅有一种情况需要动手：默认端口被占用、CourseRaptor 自动换了端口。这时以终端欢迎卡片（或浏览器地址栏）显示的实际地址为准，填进插件设置的「服务地址」即可（令牌仍可留空自动获取）。

> 令牌也支持手动填写，用于覆盖自动获取的值；令牌等同本机访问凭证，请勿分享。CourseRaptor 重装/重置后插件会自动重新取令牌，无需理会。

## 隐私

- 插件只连接你自己的本机服务，不与任何第三方通信
- 对话内容、教务数据、笔记内容都不经过插件开发者或任何服务器
- 插件源码在仓库 `obsidian/` 目录，MIT 许可证，可直接审计

## 开发

```bash
cd obsidian
npm install
npm run dev    # watch 模式，main.js 实时产出
npm run build  # 类型检查 + 生产构建
```

用 Obsidian 加载调试版：把 `manifest.json`、`styles.css`、`main.js` 链接或复制进测试库的 `.obsidian/plugins/courseraptor/`，重载插件即可看到改动。
