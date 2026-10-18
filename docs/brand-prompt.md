# 宣传视觉生成记录

## README 横幅

- 文件：`hero-banner.png`
- 方式：SVG 手绘编辑排版（米纸底 + 朱砂双线框）→ `@resvg/resvg-js` 渲染 PNG。生成脚本 `outputs/gen-hero-banner.mjs` 本地留档（不入库），logo 以 data URI 内嵌进 SVG 圆章。
- 定位：宣传插画，不是产品截图，不包含用户数据。
- 文案口径（与 README 主口径一致，不含任何学校名称与教务字样）：
  - 顶部小字：开源校园 Agent
  - 副标语：校园日常，一句话。
  - 能力清单：课表 · 待办 · 知识库 · 文档 · 记忆
  - 底部：本地优先 · 数据不出电脑 ｜ Web · TUI · QQ · Obsidian
- `social-preview.jpg`：同一横幅的原字节另存为 `.jpg`（内容为 PNG，GitHub 社交预览按内容识别显示），1280×640，满足 GitHub 社交预览大小要求。

## README 架构图

- 文件：`courseraptor-architecture.png`（深色）/ `courseraptor-architecture-white.png`（浅色），SVG 源同目录同名 `.svg`。
- 方式：SVG 手绘排版 → `@resvg/resvg-js` 渲染，脚本 `outputs/gen-architecture.mjs` 本地留档。
- 口径：本地 Agent 内核 + 通用工具（17 个）+ 课表/校历工具（2 个）；外部服务仅腾讯 QQ、模型 API、天气。
