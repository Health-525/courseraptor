# 网页对话界面（Web Chat UI）交接文档

> 交接人：ZCode · 日期：2026-08-30 · 涉及版本：courseraptor@0.1.0（工作区未提交改动）
> 2026-08-30 重构：UI 换「红头档案」风；历史升级为落盘多会话；工具调用独立建模。

## 一、这是什么

CourseRaptor 的网页对话前端：应用启动时自动在本地起一个 Web 服务（默认 `http://localhost:3210`），
浏览器打开即可和终端里的同一个教务 Agent 对话。地址会显示在 TUI 欢迎卡片底部
（「💬 网页对话：http://localhost:3210」一行，见 `src/tui/welcome.ts`）。

## 二、文件清单（全部改动）

| 文件 | 作用 |
|---|---|
| `src/web/chat-web.ts` | **核心文件**。HTTP 服务 + SSE 流式接口 + 前端单页（HTML/CSS/JS 全内联在这一个文件的 `chatPage()` 模板字符串里） |
| `src/chat-sessions.ts` | 多会话落盘存储（`data/chat-sessions.json`，原子写 + 读坏隔离）。建档/截断/上下文窗口都在这里，网页历史重启不丢 |
| `src/schedule-cache.ts` | 课表本地缓存（`data/schedule-cache.json`）。`get_schedule` 查通即落盘，TUI 启动面板直读免登录；**网页已不展示课表卡**（用户要求删除，问课表走对话） |
| `src/index.ts` | Agent 创建后调用 `setChatAgent(agent)` + `startChatWeb()` 启动网页服务 |
| `src/tui/welcome.ts` | 欢迎卡片显示网页地址 |
| `tests/chat-web.test.ts` | 10 个测试：页面渲染、SSE 流式、历史累积、重置、marked 静态路由、多会话隔离/CRUD、工具事件详情、设置端点（读/拒绝路径） |
| `tests/chat-sessions.test.ts` | 会话存储模块的 5 个测试（建档/标题/截断/上下文形状/删除） |
| `package.json` | 新增运行时依赖 `marked`（前端 Markdown 渲染，通过 `/vendor/marked.min.js` 从 node_modules 静态提供） |

测试命令：`npm run typecheck && npm test`（网页相关共 15 个；全量套件当前 128 个全过，含并行会话的天气测试）。

## 三、架构要点

- **零前端框架**：Node 内置 `http` 起服务，前端是单文件原生 JS，无构建步骤。改前端就是改 `chat-web.ts` 里的 `chatPage()` 模板字符串。
- **接口**：
  - `GET /` → 对话页面
  - `POST /api/chat` → 对话。请求体 `{ message, sessionId }`（不带 sessionId 走 `default` 档），响应是 SSE 流，事件格式 `data: {"t":"text|tool|err|end", ...}`
    - `tool` 事件带 `id`（toolCallId）、`phase`（start/end/error）、`args`（入参 JSON 预览，≤1200 字）、`out`（结果 JSON 预览）、`dur`、`brief`（一行摘要）
    - `end` 事件带 `dur`（本轮总耗时 ms）与 `sid`（服务端实际使用的会话 id，前端新起的 uuid 首条消息后由此认领）
  - `GET /api/sessions` → `{ sessions: [{id,title,updatedAt,count}] }`（按最近活跃排序）
  - `GET /api/sessions/:id` → 完整 `{id,title,messages:[{role,text,ts}]}`；非法/未知 id 一律 404，**不兜底成 default**（防串档）
  - `DELETE /api/sessions/:id` → 删除会话
  - `POST /api/reset` → 清空**全部**会话档案（UI 已不挂此按钮，留给测试与自救）
  - `GET /api/settings` → 配置状态（**只有脱敏摘要**：教务 `{configured,username,sourceLabel}`、DeepSeek `{configured,masked,sourceLabel}`、`model`），任何字段都不含密码/完整 Key
  - `POST /api/settings` → 部分更新：`{ jwglUsername, jwglPassword }` 必须成对提交（加密写 credentials.enc 并热更新 config 单例）；`{ apiKey }` 走 `setDeepSeekApiKey`（格式校验→热生效→加密落盘，与 `/key` 命令同一条路）。任一项失败整体 400，响应 `results[]` 逐项给话术
  - `GET /vendor/marked.min.js` → marked 的 UMD 构建
- **多会话历史（chat-sessions.ts）**：一条完整问答（`appendRound`）才落盘，中断/失败的半截不进历史（与旧口径一致）。两级上限：显示存档每会话 ≤200 条、总档案 ≤30 个会话；每轮发给 Agent 的上下文取该会话最后 40 条转成 ModelMessage。空会话不落库（客户端先出 uuid，首条消息到达才建档）。
- **前后端数据流**：服务端是历史的唯一事实源，前端 `msgs` 只是当前会话的内存镜像；本地 localStorage 只存一个 `raptor-web-active-session`（当前会话 id）。刷新/重启后从 `/api/sessions` 恢复。
- **流式中断**：关页面或点停止 → abort，半截回复不进历史也不落盘。
- **安全**：只绑 127.0.0.1；Markdown 渲染前整段转义 `&` 和 `<`（防 HTML 注入，同时不破坏 Markdown 的 `>` 语法——注意别把 `>` 也转义，块引用会坏）；sessionId 过 `/^[0-9a-fA-F-]{1,64}$/` 白名单。

## 四、界面现状（红头档案 · 编辑部排版风）

- 设计方向：**暖纸底 + 墨色字 + 单一朱砂红**的编辑部排版。报头楷体（KaiTi）红色题字、等宽小字数据行、圆形印章徽章（呼应教务红章）；**无渐变、无光斑、无玻璃拟态**（最早那版「深空极光」已整体删除，别加回来）。
- 所有颜色/字体令牌集中在 `chatPage()` CSS 的 `:root`（`--paper/--ink/--accent/--kai/--mono` 等），调色改令牌即可。
- Logo 🦖 仅剩一处：新会话空状态首屏那枚旋转 -7° 的双圈「印章」（呼应教务红章）。侧栏/顶栏徽章已按用户要求删除。
- 布局：桌面为「左档头 + 右正文」两栏。报头下一行是**「新会话」通栏朱砂主按钮**（用户要求置顶）；中间是**会话档案列表**（标题 + 时间/条数，行尾**常驻**半透明 ✕ 删除、悬停变实——早期悬停才出现，用户找不到删除入口，别再改回去）；**「设置」贴在侧栏最底部**（`margin-top:auto`，用户指定位置）。窄屏（≤860px）左栏隐藏，顶栏右侧为「新会话 · 设置」。侧栏无副标语、无页脚系统信息、无恐龙徽章、无学期读数卡、无导出按钮、**无今日课程卡**（均应用户要求做减法；`/api/brief` 端点随之整体下线，问课表直接问 Agent）。
- **布局焊死**：`body` 锁 `100dvh + overflow:hidden`，`#log/aside/main` 带 `min-height:0`——整页永不滚动，只有消息区内部滚，输入/发送条永远钉在视口底部（用户明确要求「固定不动」，别改回百分比高度）。
- **设置弹窗**（`.overlay/.dlg`）：红头标题「设置」+ 两节表单——教务系统（学号/密码，留空不改，只填学号会被拒）、模型服务（API Key，展示当前脱敏摘要与来源、模型名）。关闭方式：✕ / 取消 / 点遮罩 / ESC。保存结果逐行打在 `.setmsg`，全部成功自动关闭。
- **快速提问常驻在输入框上方**（「常用」小标 + 一排 chip），不再放侧栏/首屏，三档布局同一处。
- **输入区**：左侧楷体「留言」栏目标签（聚焦变红）、朱砂光圈、空内容时发送键自动落灰禁用（流式中永远是可点的「停止」）、下方等宽小字快捷键注脚（移动端隐藏）、自适应高度 ≤180px。
- 消息不做气泡：每轮是一行等宽小字题注（`你/助手 · 时间 · 总耗时`）+ 正文。用户消息 = 左侧朱砂竖线 + 纸片底；助手回复 = 通栏 Markdown 排版。
- **工具调用独立建模**：每次调用一张可展开的 `.tool` 卡片（原生 `details/summary`，零 JS 交互）：折叠态一行——状态位（▸/✓/✗）、工具名、结果摘要、耗时；展开态——`参数` 与 `结果` 两个等宽 pre 块（服务端各截断 1200 字）。SSE 的 end 事件不带配对保证，按 `id` 精确配对为主、同名 FIFO 兜底。非工具错误（网络失败/中断/agent err）仍是一条等宽 `.tline.bad`。
- 功能清单：SSE 流式回复（等宽光标 ▌）、停止、失败重试、复制、智能滚动 + 回到底部、**多会话历史（落盘、跨重启、侧栏可切换/删除）**、新会话（当前会话为空时不重复建档）、中文输入法 Enter 保护（`isComposing`/keyCode 229）、textarea 自适应（Shift+Enter 换行）、今日课程速览、快捷提问、后台完成标题提醒、移动端适配、`prefers-reduced-motion`。（导出按钮已按用户要求移除，需要存档可直接复制消息。）

## 五、踩过的坑（改 UI 前必读）

1. **chatPage 是外层 TS 模板字符串**：页面 JS 里的 `\n` 必须写成 `\\n`，否则被外层转义成真实换行直接产生语法错误、整个脚本不执行（症状：页面能开但所有按钮失效，`typeof send === "undefined"`）。页面代码禁用反引号模板串与 `${`。
2. **渲染函数保持"纯绘图"**：`addUser/addBotMessage/toolCard` 只画 DOM，不写 `msgs` 镜像；`msgs` 只在 send 流程（用户发送、本轮完整结束）和 openSession（整表替换）里变更。边遍历边往里 push 的老事故（消息指数复制撑爆页面）从根上没有了，别改回去。
3. **完成回复要定格在流式已有的气泡上**：不要另建一行，会留下空行 + 重复回复。
4. **无限动画会卡无头截图**：页面有常驻动画（光标 ▌ 的 blink）。自动化截图前注入 `animation-play-state: paused` 的临时样式，截完删掉。真实使用不受影响。
5. **改完页面必须在"渲染产物"上做语法自检**：直接 `node --check` 源码切片会漏判——模板求值前 `\\n` 也是合法 JS，求值后单写的 `\n` 会变成真实换行炸掉页面脚本（本仓踩过两次）。正确姿势：先把 `chatPage()` 模板区 `new Function` 求值成 HTML（或对运行中的服务 `curl -s localhost:3210/`），提取其中**每个** `<script>` 逐个 `node --check`。
6. **端口被占会静默退到随机端口**：3210 被占（常见于残留的测试进程）时服务会起在别的端口，欢迎卡片显示的是实际地址。`netstat -ano | grep :3210` 找占用者。
7. **改完代码必须重启主程序**：TUI/网页代码在进程内存里，不重启看到的永远是旧版（排查"改了没生效"先确认这一点）。
8. **会话 id 白名单要覆盖 `default`**：路由用 `/^[0-9A-Za-z_-]{1,64}$/` 挡垃圾 id。曾写成只收十六进制，而无 sessionId 的对话恰恰落 `default` 档——侧栏点它 404、页面静默无反应（用户视角=「历史记录点不动」）。测试已钉死这条（`default 会话可被侧栏点击读取`）。

## 六、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RAPTOR_WEB_PORT` | 3210 | 网页服务端口，被占自动退随机端口 |
| `RAPTOR_DATA_DIR` | `<项目>/data` | 数据目录（课表缓存、会话档案位置），测试用它隔离 |

## 七、已知取舍

- 网页会话与终端 TUI 的对话上下文互不相通（长期记忆、课表缓存、会话档案都是网页侧的）。
- 会话档案落在**运行 raptor 的那台机器**（`data/chat-sessions.json`）：换机器/直接开别人电脑上的网页看不到你的档案；从浏览器隐私模式打开 localStorage 连"当前会话 id"都存不住，但服务端历史仍在。
- 每轮发给 Agent 的上下文窗口 40 条：超长会话早期内容会被截出上下文（显示与档案仍完整）。
- `data/schedule-cache.json` 长期不更新时 TUI 启动面板显示的是最后已知课表；在对话里问一次课表即刷新（网页已不直接展示课表）。
