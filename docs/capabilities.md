# CourseRaptor 能力详细清单

> 本文档为 README 的补充，列出所有工具参数、环境变量等完整细节。README 仅保留核心能力卡片。

---

## 🗓️ 课表与校历工具（3 个）

> 课表**导入**不是 agent 工具，而是网页端的独立流程：`POST /api/schedule/import`（解析并返回逐行可编辑的预览）→ `POST /api/schedule/import/commit`（确认入库）。解析结果交给模型，拿不准的字段会先追问（最多 3 个关键问题）而不是瞎猜；提交时做时间冲突检测。课表缓存落在 `data/`，之后 `get_schedule` 只读本地缓存、不联网；教务通知调课、换教室换教师时，`edit_schedule` 可直接改这份缓存（首次修改前留有原始快照，`revert` 可整体还原；重新导入或在线刷新会以官方课表覆盖本地手改）。

| 工具 | 说明 | 典型耗时 |
|------|------|----------|
| `get_schedule` | 课表查询：按教学周取当天 / 本周 / 指定周的课程，含节次时间段与当前周次；**带按周预分组索引**，问「第一周有什么课」直接查表不靠模型推算；也可指定学期如 `2026-2027-1`。只读本地导入的课表缓存 | <1s |
| `edit_schedule` | 调课 / 换教室换教师 / 加课 / 退课，直写本地课表缓存（对 `get_schedule` 与今日页立即生效）。先 `list` 拿时段 id 再 `update` / `add` / `delete`；目标时段与已有课冲突会先报出来（单双周不算冲突），用户明确确认才可 `allowConflict` 覆盖；`revert` 整体还原最初导入的课表 | <1s |
| `set_holidays` | 把**放假 / 调休安排**逐日落盘到 `data/term-holidays.json`（放假日标 `holiday`、调休补课日记「按周几上课」），之后 `get_schedule`、课表页与日历导出会自动叠加假期与补课 | ~1s |

课表相关的两个网页入口不走模型、纯本地渲染：`/schedule` 页的「本周图片 / 整学期图片」按钮（`GET /api/schedule/image`，PNG 红头档案风或彩色课格，手机长按、电脑右键即可存图）与待办条目上的 `.ics` 导出链接（`GET /api/reminders/<id>.ics`）。

---

## 📁 文件与数据工具（4 个）

| 工具 | 说明 |
|------|------|
| `read_local_file` | 读用户给出路径的本机文件：docx/pdf/txt/md 全文分页，xlsx/csv 转表格查询。只读入缓存**副本**，绝不改动用户文件 |
| `query_table` | Excel 筛选查询：`keyword` 全列检索、`where` 多条件（contains/eq/数值比较/正则/空值）、`sortBy` 排序、`columns` 选列、`values` 某列去重计数、`offset/limit` 分页——千行大表按问题取行，不再整本塞给模型 |
| `run_js` | 沙箱 JS 计算台：去重/计数/分组求和/正则摘取。无网络无磁盘，3 秒超时、输出截断 |
| `manage_attachments` | 附件缓存管理：list / delete / delete_all。只认缓存索引，agent 只能删自己下载/读入的副本，用户本机文件永远删不到 |

---

## ✍️ 文档写作工具（2 个）

| 工具 | 说明 | 典型耗时 |
|------|------|----------|
| `generate_document` | 按结构化内容直接生成 **Word / Excel / PDF** 成品文件，中文原生可写（PDF 自动嵌入系统中文字体）。docx·pdf 给 `blocks`（标题/正文/列表/表格/分页）、xlsx 给 `sheets`。成品写进本机 `data/generated/`，返回完整路径；QQ 里会自动把文件回传给你。PPT 课件不走这里——见下方 PPT 工具 | ~1-3s |
| `convert_document` | 跨格式转换重排：把已有内容（`fetch_attachment` 读入的附件 id、或本机文件路径、或一段文本）转成 Word/Excel/PPT/PDF。源文件**只读不动**，成品写 `data/generated/` | ~1-3s |

> 改写润色（换词、调结构）由模型在文本层完成，改好后交给 `generate_document` 出稿；`convert_document` 专注跨格式搬运与排版。

---

## 📊 PPT 课件工具（2 个，输出 slide deck JSON）

模型直接输出 slide JSON（`{slides:[{background?, motif?, notes?, elements}]}`，画布 1000×562.5px、安全边距 50px），由渲染器映射为 pptx——不写代码、不跑沙箱。自动套**品牌课件模板**「纸墨朱砂」（每页可选 motif：封面/章节页朱砂整版大印章、内容页页脚细线 + COURSERAPTOR + 落款 logo + 页码），网页端内嵌可翻页预览（与成品同一份坐标语义）。

> **暂未对 agent 开放**：`ppt_preview` / `ppt_save` 源码与网页预览管线仍保留，当前不注册进工具表。交付物请用 Word / Excel / PDF。

---

## 📅 课表图（课表卡片）

| 工具 | 说明 | 典型耗时 |
|------|------|----------|
| `export_schedule_image` | 读本地课表缓存渲染 PNG/SVG（红头档案 / 彩色课格；单周或整学期），与网页「本周图片」同渲染器 | ~1s |

独立技能包见 [`skills/export-schedule/`](../skills/export-schedule/)。

---

## 🕐 时间 · 天气工具（2 个）

| 工具 | 说明 | 典型耗时 |
|------|------|----------|
| `get_time` | 当前日期 / 星期 / 时刻 / 时区换算，外加**本学期教学周**（第几周、本周一~周日日期、距开学倒计时）。agent 没有内置时钟，回答任何时间问题前都要先调它拿真实时间 | <1s |
| `get_weather` | 实况 + 未来 1-14 天预报（默认 7 天）：天气码已译成中文，自带**带伞与穿衣建议**。说「老家天气」「海口呢」就自动换城市；数据源 Open-Meteo，**免密钥、不用配 .env** | ~1-2s |

---

## 🧠 两层记忆

| 层 | 存储 | 机制 |
|----|------|------|
| **短期记忆** | `session.json`（本地） | 模型中间件逐轮捕获完整对话并落盘；下次启动注入上次会话**尾部**若干轮（避免已聊完的事挤占上下文），跨重启延续。**仅终端/QQ 注入**——网页每轮自带本会话历史，不注入（否则别的会话内容会串进来） |
| **长期记忆** | `memory.json`（本地） | agent 通过 `save_memory` 工具自主维护事实条目（偏好/结论/时间安排）；近似重复自动合并、可设过期时间、办完的事 `archive` 归档，只有生效中的条目会注入 |

说一次「记住××」，之后每次新会话它都记得。记忆文件在本地且已被 `.gitignore` 排除。

---

## 📝 待办与提醒

随口说的安排直接变成待办，落在本地 `data/web-workspace.json`，对话、课表页、网页功能大厅三个入口共用同一份数据：

| 入口 | 说明 |
|------|------|
| `manage_todos` 工具 | 对话里说出待办即批量记录（一次说几件记几件；相对日期先 `get_time` 换算，没给截止时间会先问一句）；问「我有哪些待办」用 list，完成 / 删除用 update / delete |
| 功能大厅待办面板 | 逾期置顶、按今天 / 明天分组，可直接手动添加、勾选完成、删除；与课表页 `/today` 待办卡片同步 |
| 课表页待办卡片 | `/today` 本周课表下方常驻：未完成按截止排序、逾期朱砂红 ⚠、勾选完成、确认删除 |
| 到期自动提醒 | 待办进入「距到期 ≤ 7 天」窗口后**每天提醒一次**：Windows 桌面通知 + QQ 推送到白名单账号；早 8 点前不弹、单轮至多 5 条、启动即补查，完成或删除即停。`RAPTOR_NO_TODO_REMINDERS=1` 关闭 |

提醒依赖应用（或 `npm run qq` 的桥）在运行中；终端欢迎面板另有「一周内待办」速览段（含逾期标记）。

---

## 📚 知识库

知识库先记后用：**用户问知识类问题（概念/公式/方法/课程内容，或让讲解、复习、出题）时，agent 回答前先用关键词检索本地知识库**，命中相关条目就按用户记过的口径作答并标明出处，没有或不够才按常规方式回答；对话里说出的知识点会自动沉淀：agent 判断消息里的概念、公式、方法、结论值不值得记，值得就写进本地 `data/knowledge.json`，并**优先按课表里真实存在的课程归类**——对得上就归入该课程（「高数」这类俗称也能对上）；给的 subject 对不上课程时以 subject 为**自定义分类**（如「编程技术」「TypeScript」）；完全看不出归属才落「未分类」：

| 入口 | 说明 |
|------|------|
| `manage_knowledge` 工具 | 答前检索 + 沉淀：问知识类问题先 list 按关键词检索（多个关键词任一命中即返回），命中以其为依据回答（用户记过的口径优先于模型自己的讲法）；对话里分享知识即记录（一次说几条记几条，同名知识自动更新不堆积）；问「我记过哪些知识」也用 list（可按分类/关键词筛），改内容或归属用 update，删用 delete。闲聊、提问、待办不会误入库，拿不准时 agent 会先问一句 |
| 课表页知识卡片 | `/today` 待办卡下方常驻：最近 5 条速览（标题 + 分类徽章 + 日期 + 内容两行摘录）、总数统计、「查看全部」链到独立页 |
| 独立知识库页 | `/knowledge`：flomo 式单川流——左侧栏（关键词搜索 + 标签列表带计数），主列卷首概览（条数 / 标签数 / 连续记录 + 近 16 周朱砂热力带看记录密度）+ 发布框（首行标题、Ctrl+Enter 记下）+ 按日分组的卡片川流，条目原地编辑、两步删除；聊天页侧栏「知识库」直达 |
| 大厅知识库面板 | 功能大厅里按课程归类、可搜可展开全文，条目支持直接删除 |

与待办一样，QQ 渠道说出知识点同样会记录（走同一个 agent 工具）。

---

## 🧠 学习辅导（OpenMAIC 学习类 skill，按需一篇）

学习类请求时 agent 先调 `read_skill` 加载对应篇目再答（一次一篇；教务查询与闲聊不套）。原文平级存放于 `skills/<id>/`，来源 [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)（MIT）。

本期 allowlist：

| skill | 场景 |
|-------|------|
| `feynman-learning` | 费曼循环 / 讲给外行听 |
| `learning-to-learn` | 学习策略与元认知 |
| `zone-of-proximal-development` | 习题诊断与补差 |
| `understanding-by-design` | UbD 逆向设计 |
| `spiral-curriculum` | 螺旋式复习 |
| `curriculum-planner` | 系列计划先签核 |
| `export-schedule` | 课表图说明（产出请调 `export_schedule_image`） |

讲透的知识点、用户认可的错题归因，可经 `manage_knowledge` 沉淀。

---

## 💬 QQ 接入（官方机器人）

除终端外，agent 还能挂到 QQ 上（腾讯官方开放平台路线，零封号风险）：

```bash
# 1. 在 https://q.qq.com 用主号实名注册 -> 创建机器人 -> 拿到 AppID / AppSecret
#    （机器人能力勾选「群聊（@消息）」，单聊需用户先添加机器人为好友）
# 2. 凭证二选一填法：
#    a. 网页「功能大厅 → 设置」（推荐）：AppID / AppSecret / 激活暗号三项填好保存，
#       AES-256-GCM 加密存本机，桥自动上线，不用碰任何文件
#    b. .env 填入 QQBOT_APP_ID / QQBOT_APP_SECRET / QQBOT_PASSCODE（自定激活暗号）
# 3. 启动：一条 raptor 全包（终端对话 + QQ 机器人同时在线，前台运行，Ctrl+C 退出）
raptor
#    只跑 QQ 桥（不开终端对话）：
npm run qq
# 4. QQ 里给机器人发第一条消息 = 激活暗号，完成授权
```

- **单聊**：直接和机器人对话；**群聊**：@机器人 触发
- **安全**：白名单制，未授权用户一律拒绝；授权 openid 落盘 `qq-allowlist.json`（gitignored）
- 官方平台给的是 openid 而非 QQ 号，所以用暗号激活代替加白名单
- 每用户独立上下文（内存滑动窗口 40 条，只用于喂模型）；回复自动 Markdown 转纯文本 + 长消息分段
- **QQ 对话同时进网页历史记录**：每轮问答另外归档到 `data/chat-sessions.json`，私聊每人一档、群聊每群一档，标题带「QQ｜」/「QQ群｜」前缀，网页侧栏点开即可回看。这条线**只写不读**——在网页里删除或改名这些档案，不影响 QQ 那边正在进行的对话
- **待办到期提醒主动推送**：距到期 7 天内每天一次，桌面通知之外同步推送到白名单 QQ（受官方平台主动消息频率限制，尽力送达）
- 限制：官方机器人以被动回复为主（约 5 分钟窗口）

---

## 🖥️ 网页版 · 功能大厅

网页侧栏收敛为一个「**功能大厅**」：点开后是宫格主页，点任意面板，内容从右侧整列推出、把对话区往左推（真 push 布局，不是盖在上面的弹层）。面板按三组摆放：

| 学习安排 | 效率工具 | 系统 |
|----------|----------|------|
| 📅 今日日程 · 🗓️ 课表 | ✅ 待办 · 📚 知识库 | 💡 提示词模板 · 📈 用量统计 · ⚙️ 设置 |

- **对话自动联动**：在对话框里说「打开课表」「展开待办」这类话，agent 会调 `open_panel` 把对应面板自动从右侧推出来（任意面板都行，不限于设置）；工具改动数据（记待办、起番茄钟等）时已打开的面板自动刷新；凭证未配置等服务端点名的场景自动弹出设置；面板也能从侧栏红点角标一眼看出有没有新东西
- **今日简报**：课表时间线、今天到期的待办会交叉着给结论，还可以建议空档放个番茄钟
- **待办面板**：逾期置顶、按今天/明天分组，可直接手动添加、勾选完成、删除
- **番茄钟**：对话里说「开始 25 分钟番茄钟」即可；对话时间线出现倒计时卡片（时间到翻朱砂底 + 提示音 + 桌面通知 + 标题提醒），刷新页面后进行中的计时会恢复成时间线顶部的实时卡片；时间到可一键「再来一轮 / 休息 5 分钟」接龙，取消等服务端确认后才置灰（宫格入口已隐藏，计时全部在对话里完成）
- **知识库面板**：按课程归类、关键词搜索、展开全文，条目可直接删除
- **提示词模板面板**：输入框上方「提示词」清单的自定义管理
- **对话即可增删改**：课表、考试、待办、知识库、提示词模板（以及手动课表模式下的成绩）都能在对话里创建、修改、删除（`edit_schedule` / `edit_exams` / `manage_todos` / `manage_knowledge` / `manage_prompts` / `edit_grades`），改完已打开的面板自动刷新；教务已适配学校的成绩以官方查询为准、本地不可改；教务通知、用量统计、设置里的凭证保持只读/手动填写
- **用量统计面板**：一年 53 周 GitHub 式热力图（非零日按分位升档着色，默认滚到今天）+ 今日 / 近 7 天 / 近 30 天 / 近一年四格摘要 + 各模型用量分布与占比条，数据来自 `data/token-usage.json`（按天/按模型聚合，保留 371 天）
- **设置面板**：三栏（AI 模型 / QQ 机器人 / 本地数据），栏头状态点一眼看出配没配（未配朱砂实心）；课表导入入口在「本地数据」栏；危险操作走两步确认。agent 也能应你一句「打开设置」自己调 `open_settings` 推出面板
- **会话互相独立**：每个会话只带自己的历史（新开一页/新会话不会被上一次聊过什么带跑），多标签页互不干扰；要接上之前的对话，从侧栏切回那个会话即可
- **小细节**：面板内搜索、操作乐观更新、`#panel` hash 深链直达；窄屏自动退回滑入抽屉 + 遮罩

---

## ⌨️ 终端交互

- **斜杠命令菜单**：输入框敲 `/` 即弹出候选命令（`/card` `/inline` `/key` `/update` `/exit`），↑/↓ 或滚轮选择、Tab 或回车补全，继续输入按前缀过滤；ESC 收起
- **双 UI 运行时互切**：默认全屏卡片模式，`/inline` 切行内模式（输出进终端缓冲区，滚轮/选中复制可用），`/card` 切回
- 滚轮/↑↓ 滚动 · ESC 打断正在进行的回复 · Ctrl+C 退出

---

## ⚙️ 完整环境变量表

| 变量 | 说明 | 必填 |
|------|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（或启动后对话里输入 `/key sk-你的Key` 配置，加密保存、立即生效） | 是 |
| `RAPTOR_MODEL` | 模型，默认 `deepseek-flash`（V4.1-Flash），可选 `deepseek-v4-pro` 等；网页设置里选过的型号加密保存并优先于此项 | 否 |
| `RAPTOR_TUI_INLINE` | 设 `1` 让终端默认走行内渲染，等价对话里的 `/inline` | 否 |
| `RAPTOR_WEB_PORT` | 网页版端口，默认 `3210`（被占用时自动选空闲端口） | 否 |
| `FIRECRAWL_API_KEY` | Firecrawl 云解析附件（可选；本地已支持 xlsx/docx/pdf/pptx/txt，仅作兜底，且只用于公开网站） | 否 |
| `QQBOT_APP_ID` / `QQBOT_APP_SECRET` | QQ 官方机器人凭证（可选；也可在网页「功能大厅 → 设置」里填写，AES 加密保存且保存后桥自动上线。两边都配时 `.env` 优先） | 否 |
| `QQBOT_PASSCODE` | QQ 授权暗号：首次给机器人发此暗号完成授权（同样可在网页设置里设置） | 否 |
| `QQBOT_PUSH_OPENIDS` | QQ 主动推送目标（openid，逗号分隔）：待办到期等提醒只发给显式列出的 openid（宿主本人）；不配置则关闭主动推送，避免把本机待办广播给全部授权用户 | 否 |
| `RAPTOR_NO_TODO_REMINDERS` | 设 `1` 关闭待办到期自动提醒（默认开启） | 否 |
| `RAPTOR_NO_UPDATE_CHECK` | 设 `1` 关闭启动时的版本更新检查（默认开启） | 否 |
| `RAPTOR_NO_TELEMETRY` | 设 `1` 关闭安装包内置的匿名装机统计（默认每 24h 上报一次随机设备号 + 版本 + 平台，不含学号、账号与对话内容；源码运行默认不上报） | 否 |
| `RAPTOR_UPDATE_SERVER` | 仅维护者本地测试时覆盖更新后台地址；必须为 HTTPS，正式安装包由发版命令内置地址 | 否 |
| `UPDATE_SERVER_URL` / `UPDATE_ADMIN_TOKEN` | 维护者配置：更新后台地址与发布管理员密钥 | 否 |
| `DEEPSEEK_BASE_URL` | 自定义 API 地址（可选） | 否 |

---

## 🧰 开箱工具分层

- **内核**（`src/core/tools/`，与学校无关）：文件与数据四件套（`read_local_file` / `query_table` / `run_js` / `manage_attachments`）、文档写作与转换（`generate_document` / `convert_document`）、`export_schedule_image`、`edit_schedule`、`edit_exams`、`edit_grades`（仅手动课表模式）、`manage_prompts`、`save_memory`、`manage_todos`、`manage_knowledge`、`manage_pomodoro`、`read_skill`、`open_settings`、`open_panel`、`get_weather`、`get_time`
- **课表与校历**：`get_schedule`（只读本地导入的课表缓存）、`set_holidays`（放假 / 调休落盘）

合计 19 个工具挂载进 agent（内核 17 + 课表与校历 2），全部只读写本地数据：课表来自网页端导入缓存（可经 `edit_schedule` 本地调课），其余走本机文件、沙箱计算与本地 JSON。PPT 工具源码保留、暂未挂入 agent（不计入上数）。

---

## 🏗️ 技术栈细节

- **Agent**：[Vercel AI SDK v7](https://ai-sdk.dev)（`ToolLoopAgent` + `runAgentTUI` 终端对话 UI；`scripts/patch-tui.mjs` 给库的空屏打欢迎面板补丁，启动后自动展示今日课表与本周待办，`npm install` 时经 postinstall 自动生效）
- **LLM**：DeepSeek（默认 `deepseek-flash`，即 V4.1-Flash），另有 11 家国内厂商（通义千问 / 智谱 GLM / Kimi / 豆包 / 混元 / MiniMax / 阶跃 / 文心 / 讯飞 / 硅基流动 / 移动云，共 12 家）+ 自定义 OpenAI 兼容端点，网页设置里热切、每家 Key 独立加密保存
- **课表数据**：用户在网页端导入（粘贴文字或上传 Excel / CSV / PDF / Word / TXT），解析后经模型追问澄清、预览逐行确认再入库，缓存在本地 `data/`；`get_schedule` 只读这份缓存

---

## 📁 项目结构完整树

```
├── bin/raptor.cjs           # 全局命令入口（npm link 后任意目录敲 raptor）
├── docs/                    # 文档与素材（能力清单 / 配置参考 / 使用指南等）
├── skills/                  # 平级 skill：学习类 OpenMAIC + export-schedule（课表图）等
├── src/                     # 公用核心（与运行形态无关）
│   ├── core/                # 内核
│   │   ├── agent.ts         # agent 定义（系统提示词 + 工具装配）
│   │   ├── config.ts        # .env 配置加载（按项目根解析，任意目录启动均可）
│   │   ├── school.ts        # 校内数据接入的端口契约（学期规则、节次作息等）
│   │   ├── credentials.ts   # 凭证加密读写（AES-256-GCM，落盘 credentials.enc）
│   │   ├── http.ts          # 通用 HTTP 客户端（线性退避重试 2 次 + 全局限速令牌桶；早失败胜过转圈）
│   │   ├── attachments.ts / attachment-store.ts  # 附件与本地文件流水线（缓存 + 表格概览 + 长文分页/关键词定位；不做验证码识别）
│   │   ├── spreadsheet.ts   # 表格引擎（xlsx/xls/csv 结构化：筛选/排序/去重统计/分页）
│   │   ├── sandbox-js.ts    # run_js 沙箱（node:vm 裸上下文，限时限量，无网络磁盘）
│   │   ├── weather.ts       # 天气（Open-Meteo 免密钥：地名两轮解析 + WMO 码中文化 + 带伞穿衣建议）
│   │   ├── todo-reminders.ts # 待办到期提醒（每小时扫描 7 天窗口：去重落盘 + 桌面 toast + QQ 主动推送）
│   │   ├── knowledge.ts     # 知识库（对话沉淀的知识条目：课表课程归类 + subject 自定义分类 + 本地存储）
│   │   ├── pomodoro.ts      # 番茄钟引擎（计时落盘 + 进行中/最近记录查询）
│   │   ├── calendar/        # 校历（放假/调休落盘 + 整学期 .ics 导出）
│   │   ├── document/        # 文档生成（Word/Excel/PPT/PDF 渲染 + 跨格式转换）
│   │   ├── memory/          # 两层记忆（长期事实条目 + 短期会话捕获恢复）
│   │   └── tools/           # 内核 agent 工具（文档/文件/知识库/记忆/待办提醒/番茄钟/设置/时间/天气）
│   └── channels/
│       └── web/             # 网页版：聊天页 + 功能大厅 + /today 日程页 + /knowledge 知识库页 + 今日简报
└── local/                   # 本地版入口
    ├── cli/                 # 终端 TUI（raptor 命令；QQ 已配置时一并拉起）
    ├── qq/                  # QQ 官方机器人桥（bridge + 消息格式化 + 主动推送 + 会话归档）
    └── demo/                # 离线演示（虚构数据 + 剧本回答，复用正式网页视图）
```

> 顶层其余目录为分发与文档辅助，不影响本地运行，不在此展开。

---

## 🔐 安全与隐私补充

- `.env` 含模型 API Key，已被 `.gitignore` 排除，**切勿提交或分享**
- 网页服务仅监听 127.0.0.1，多层请求防线：Host/Origin 校验、写请求必须携带 CSRF token、请求体只认 application/json
- 记忆/会话/授权文件（`memory.json` / `session.json` / `qq-allowlist.json`）均为本地数据，不入库。`session.json` 落盘完整对话（含课表、待办与知识条目），**请勿分享该文件**；`data/chat-sessions.json` 同时存着网页与 QQ 两个渠道的完整对话，同样是本地敏感数据，**请勿分享该文件**
- 附件云解析（Firecrawl）仅用于公开网站内容，其余一律本地解析

---

## 🗑️ 卸载与清理

```bash
# 1. 取消全局命令
npm unlink

# 2. 删除项目目录（含安装包解压目录）
rm -rf courseraptor

# 3. 清理本地数据（可选，包含凭证/记忆/会话/待办/知识库/日历/附件缓存）
rm -rf data/
rm -f credentials.enc
rm -f session.json memory.json qq-allowlist.json
```

> ⚠️ 执行第 3 步前请确认已备份重要记忆/会话/待办数据。

---

## ❓ 常见问题 (FAQ)

详见 [GitHub Discussions](https://github.com/Health-525/courseraptor/discussions) 或 `docs/faq.md`（待建立）。