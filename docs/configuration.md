# 配置参考

[返回首页](../README.md) · [同学使用指南](student-guide.md)

首次使用直接运行 `npm start` 进入界面，API Key 在网页「设置」里加密保存。需要手动配置时，复制 `.env.example` 为 `.env`；不要覆盖已有文件，也不要把真实 Key 写进聊天。

| 配置项 | 默认 / 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 正式对话需要；可在网页「设置 → AI 模型」里填写，或对话里输入无参数 `/key` 配置。联网搜索（web_search / web_fetch）复用同一把 Key、直连官方 Search API（不受 `DEEPSEEK_BASE_URL` 影响，按成功请求计费 $0.75/千次） |
| `RAPTOR_MODEL` | 源码默认 `deepseek-flash`（V4.1-Flash）；官方已停用 `deepseek-chat` / `deepseek-reasoner` 别名、退役 `deepseek-v4-flash` 系列，本地存有旧型号时启动自动迁移到当前默认。网页「设置」里选过的型号会加密记在本机并优先于本项。须确认自己的服务账户支持所选模型 |
| `DEEPSEEK_BASE_URL` | 可选，自定义模型服务地址；对话内容会发往这个服务 |
| `RAPTOR_WEB_PORT` | 正式网页首选端口，默认 3210，占用后自动选择空闲端口 |
| `RAPTOR_TUI_INLINE` | `1` 使用终端行内模式；默认全屏卡片模式 |
| `RAPTOR_MAX_RPS` | 外部请求频率上限，1-3 的整数（默认 3，只允许下调，启动时校验） |
| `RAPTOR_BURST` | 限速令牌桶突发容量，1-64 的整数（默认 8，启动时校验） |
| `FIRECRAWL_API_KEY` | 可选，公开网页附件的云解析兜底；本地解析无需此项 |
| `RAPTOR_CJK_FONT` | 可选，中文 PDF 使用的本机字体绝对路径 |
| `RAPTOR_AI_NEWS_PYTHON` | 可选，AI 新闻技能使用的 Python 3.11+ 解释器完整路径；默认自动探测。新闻引擎仅使用标准库，缺少 Python 时仅此功能不可用 |
| `QQBOT_APP_ID` / `QQBOT_APP_SECRET` / `QQBOT_PASSCODE` | 可选，QQ 官方机器人凭证与准入暗号 |
| `QQBOT_PUSH_OPENIDS` | 可选，QQ 主动推送目标 openid（逗号分隔）：待办到期提醒只发给这些人；不配置则不发推送，白名单里的其他授权用户收不到你的提醒 |
| `GITHUB_TOKEN` / `GITEE_TOKEN` | 可选，将课表日历发布到公开仓库；分享范围需本人确认 |
| `RAPTOR_NO_UPDATE_CHECK` | `1` 关闭启动时版本检查 |
| `RAPTOR_NO_TELEMETRY` | `1` 关闭安装包内置的匿名装机统计（每 24h 报随机设备号 + 版本 + 平台，不含个人数据与对话内容；源码运行默认不上报） |
| `RAPTOR_LOG_LEVEL` | 后台诊断日志级别 `debug\|info\|warn\|error`（默认 `info`），写入 `data/raptor.log`，超 5MB 自动轮转 |
| `RAPTOR_NO_TODO_REMINDERS` | `1` 关闭待办到期自动提醒（默认开启：距到期 ≤ 7 天每天一次，Windows 桌面通知 + QQ 推送） |
| `RAPTOR_UPDATE_SERVER` | 维护者本地覆盖 HTTPS 更新服务地址；分发包可内置地址 |
| `UPDATE_SERVER_URL` / `UPDATE_ADMIN_TOKEN` | 仅维护者发版需要，见[维护指南](maintainers.md) |

`RAPTOR_DEMO_PORT` 默认 3211。演示入口不加载 `.env`，需在终端环境变量中指定，例如 Windows PowerShell：

```powershell
$env:RAPTOR_DEMO_PORT = "3212"
npm run demo
```

### 演示接入真实模型（`--live`）

`npm run demo` 是零配置离线剧本（不调用 AI）。想让演示回答由真实模型实时生成，改用：

```bash
npm run demo:live   # 等价于 npm run demo -- --live
```

- 回答由 DeepSeek 实时生成（真思考、真工具循环、真流式输出，会产生 API 费用），但工具返回的课表/待办/知识条目仍是虚构示例，不需要配置任何账号。
- Key 来源：先看 shell 环境的 `DEEPSEEK_API_KEY`，没有再从项目根 `.env` 取同名键（仅取 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `RAPTOR_MODEL` 三个键）；模型默认 `deepseek-flash`，可用 `RAPTOR_MODEL` 覆盖。演示不读取 `credentials.enc`。
- 找不到 Key 时自动回退离线剧本并在终端提示，页面照常可用。
- 适合录制演示视频或现场展示 AI 分析能力；正式使用请运行 `npm start` 配置自己的 Key。

## AI 新闻技能

在对话中说「看看今天的 AI 新闻」「查看 AI 突发简报」或「总结最近七天 AI 趋势」即可。日报由当前配置的模型撰写，采集、事件排序和校验由本地 Python 引擎完成，无需 OpenClaw 或飞书。首次采集需要访问配置好的公开新闻源；当天来源冻结后重复读取复用快照。历史日期只查询已有记录，不能补造过去的新闻。

首次使用需要 Python 3.11+。解释器不在 PATH 时设置 `RAPTOR_AI_NEWS_PYTHON`，之后重启应用。可用 `python scripts/ai-news/news.py doctor` 检查版本和公开来源配置；该命令只读，不访问远端。便携安装包会携带新闻脚本与公开来源配置，Python 解释器仍需本机提供，或由分发者放在应用的 `runtime/python/` 下。

来源快照、摘要草稿、冻结 Markdown 日报及 SQLite 缓存保存在 `data/ai-news/`（随 `RAPTOR_DATA_DIR` 变化）。工具仅返回分页记录，日报全量校验通过后才冻结；突发与趋势仅基于实际采集数据。不会发送群消息、发布到外部平台、下载媒体或获取字幕。

日报只收精选记录，避免一天上百条逐条写摘要：每个事件取一条；低证据来源与已超出 24 小时的补录记录仅在紧急告警时保留；同一来源最多 3 条，单一来源类型不超过 40%；总数默认上限 40，可用环境变量 `AI_NEWS_DIGEST_LIMIT`（5–100）调整。采集历史与趋势统计仍保留全量，日报头部会注明「从 N 条采集记录中精选 M 条」。过期超过 7 天的网页缓存在每次采集后自动清理。

## 凭证优先级

- API Key：通过 `/key` 明确设置的加密覆盖值优先，其次环境变量，再其次加密存储中的旧值。
- 加密存储依赖当前机器和系统用户信息，不是系统密码保险箱；不能防御同机同用户运行的恶意程序。

完整 Key 不应出现在命令参数中。正确方式是输入 `/key`，再按隐藏输入提示录入。
