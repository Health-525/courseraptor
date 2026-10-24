# ai-news · AI 新闻精选日报（独立技能包）

采集官方发布、行业媒体、开源雷达、模型库和视频频道，按事件去重、证据等级和新鲜度排序，
**只留下高质量的一小批**（默认最多 40 条），再让你的 Agent 依据来源原文逐条写中文摘要，
生成带来源链接、数字校验的日报。另有突发简报和基于本地采集历史的趋势。

纯 Python 标准库，解压即用，不需要安装完整项目，也不需要任何模型密钥。

## 安装

1. 安装 [Python](https://www.python.org/) ≥ 3.11（命令行里 `python --version` 能输出）。
2. 解压本包，把 `ai-news/` 整个文件夹放进你所用工具的技能目录：

   | 工具 | 技能目录 |
   | --- | --- |
   | Claude Code | `~/.claude/skills/`（或项目内 `.claude/skills/`） |
   | ZCode | `~/.zcode/skills/`（或项目内 `.zcode/skills/`） |
   | WorkBuddy | `~/.workbuddy/skills/` |
   | 其他支持 Agent Skills 规范的工具 | 多数认 `~/.agents/skills/`，详见各工具文档 |

3. 自检（只读，不联网）：

   ```bash
   python scripts/news.py doctor
   ```

放好后对 Agent 说「看看今天的 AI 新闻」即可。

## 精选规则

采集仍覆盖全部来源，但冻结给日报、需要逐条写摘要的只有精选记录：

- 每个事件只取一条；
- 低证据来源、已超出 24 小时的补录记录，只在紧急告警时保留；
- 来源文本不可读的记录，只在「紧急 + 一方来源」时保留；
- 排名分低于 60 的不收（推荐重点除外）；
- 同一来源最多 3 条，单一来源类型不超过总数的 40%。

实测一天约 190 条采集记录精选为 37 条左右，需要模型阅读的来源文本减少约 85%。想要更多
或更少，设置环境变量 `AI_NEWS_DIGEST_LIMIT`（5–100，默认 40）。日报头部会写明
「从 N 条采集记录中精选 M 条」，采集历史与趋势统计仍保留全量。

## 命令

所有命令输出一行 UTF-8 JSON。

```bash
python scripts/news.py doctor                                  # 自检
python scripts/news.py prepare                                 # 采集并冻结今天的精选来源
python scripts/news.py prepare --offset 8 --limit 8            # 分页读取
python scripts/news.py save --request-file request.json        # 保存摘要草稿 / 冻结日报
python scripts/news.py query --kind daily                      # 读取已冻结日报
python scripts/news.py query --kind breaking                   # 突发简报
python scripts/news.py query --kind trend --days 7             # 近 7 天趋势
```

`--date YYYY-MM-DD` 指定日期（历史日期只能查已有记录）。保存摘要时用 `--request-file`
传 UTF-8 JSON，避免各 shell 的中文转义问题。完整的写作规则见 `SKILL.md`。

## 数据与网络

- 状态（来源快照、摘要草稿、冻结日报、SQLite 采集历史）保存在本包 `data/` 目录，
  `AI_NEWS_STATE_DIR` 可改位置。超过 7 天的网页缓存会自动清理。
- 首次采集会访问公开来源：各厂商官方站点和 RSS、行业媒体 RSS、GitHub（Trending 与安全
  公告）、Hugging Face、YouTube 频道 RSS 等；可选 `AI_NEWS_GITHUB_TOKEN`、
  `AI_NEWS_HUGGINGFACE_TOKEN` 提高接口额度。
- 不发送消息、不发布到外部平台、不下载媒体或字幕。

## 常见问题

- **报「当天没有冻结来源」**：今天先运行 `prepare`；历史日期只能查已采集的记录。
- **来源部分失败**：`prepare` 返回里的 `source_health` 会列出各来源族的状态；官方来源
  成功率低于阈值时质量门禁会拒绝出日报，如实转述即可。
- **想看更多条目**：调大 `AI_NEWS_DIGEST_LIMIT`，删掉当天 `data/reports/*_rss_sources.json`
  后重新 `prepare`（已冻结的日报不会被改动）。

## 免责声明

新闻内容来自第三方公开来源，摘要由你的 Agent 依据来源文本生成，请以原文为准。本包与所列
来源方无关联，也未获其授权或认可。

## 许可

MIT。引擎移植自 Health-525/ai-news-skills，来源说明见 `scripts/NOTICE.md`。
