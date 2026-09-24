# 维护与分发

[返回首页](../README.md) · [贡献指南](../CONTRIBUTING.md) · [安全说明](../SECURITY.md)

## 发布前验证

```bash
npm ci
npm run doctor
npm run typecheck
npm run lint
npm test
npm run demo
```

用虚构数据验证首次进入、快捷提问、会话切换与小屏布局。学校查询另用自己的账号人工抽查；离线测试通过不能证明校方接口和模型服务实时可用。

## 代码结构导览

依赖方向：channels → core ← adapters。core 定义 SchoolAdapter 端口（`src/core/school.ts`）并只依赖端口；adapters 实现端口并可自由使用 core；channels（终端/网页/QQ）只做装配与展示，不 import 任何学校适配器。core 与 channels 里 import `adapters/njtech` 视为架构违规。

| 目录/模块 | 职责 |
|---|---|
| `src/channels/cli/index.ts` | 终端主入口：装配学校适配器（`import "../adapters"`）、凭证引导、拉起 QQ 桥 / 网页服务 / 待办调度、TUI 循环 |
| `src/channels/web/` | 网页服务与页面（聊天/大厅/日程/课表/待办/知识库） |
| `src/channels/qq/` | QQ 官方机器人桥 |
| `src/core/agent.ts` | agent 组装：core 通用工具 + 学校适配器贡献的教务工具合并；提示词骨架在 `src/core/prompt.ts`，教务段由适配器提供（校历段运行时渲染自 `data/term-dates.json`，不在代码里硬编码） |
| `src/core/tools/` | 通用工具聚合（文件/文档/记忆/待办/知识库/番茄钟/设置/天气/时间） |
| `src/adapters/njtech/` | 南京工业大学适配器：登录/课表/成绩/考试/学籍/选课/通知抓取与教务工具（`index.ts` 组装成 SchoolAdapter；`session.ts` 是登录 cookie / 选课会话缓存，经端口供 UI 使用） |
| `src/adapters/index.ts` | 装配点：按 `RAPTOR_SCHOOL` 注册默认适配器；新增学校在这里登记 |
| `src/core/memory/` | 两层记忆（短期 session.json / 长期 memory.json） |
| `src/core/paths.ts` | 项目根、`dataDir()`、`isInsideDir()` 路径护栏、`migratedDataPath()` 状态文件归位——**全项目唯一实现，不要在别处重写** |
| `src/core/json-cache.ts` | 免登录 JSON 缓存骨架（schedule/exam-cache 的公共约定） |
| `src/core/repo-publish.ts` | Gitee/GitHub 日历发布三步流程骨架，平台差异在各自 publish 模块 |
| `src/core/fetch-result.ts` | 统一抓取结果类型（教务适配器与 weather 共用） |
| `src/core/workspace-data.ts` | 待办 / 上传文件的跨层共享存储 |

状态文件（session.json、memory.json、qq-allowlist.json、qq-bridge.log）统一放 `data/` 下；旧版本散在项目根的文件会在首次运行时自动搬过去。`credentials.enc` 仍留在项目根（安全考量，支持 `RAPTOR_CREDENTIALS_FILE` 重定向）。

## 安装包内容

`scripts/package-policy.mjs` 定义包内容：应用源码、入口、脚本、测试、依赖锁文件与选定的公开文档/素材。新增需要随包分发的文档时同步更新该清单。

`data/`、`outputs/`、下载、日志、环境文件和根目录凭证不进入安装包。公共校历基础值在 `src/jwgl/term-dates.ts`；学生自己的校历修正保存在本地并在升级时保留。如果需要全体同步校历，后续应设计专用的公共校历数据源，不能直接分发个人 `data/term-dates.json`。

发版前检查最终 zip 的文件清单，确认没有私密文件；不要直接压缩已使用的项目目录转发给同学。历史安装包若由旧打包脚本生成，应由维护者检查是否夹带个人文件，再决定撤回或替换。

## 更新后台

后台入口为 `server/update-server.mjs`，数据保存在 `update-data/`。Node 默认监听本机，通过 Nginx 和 HTTPS 对外提供服务；参考 `server/nginx.conf.example`。

需要维护者配置 `UPDATE_ADMIN_TOKEN`、`HOST`、`PORT`。密钥使用自己的高强度随机值，通过部署环境注入，不写进 README、Issue 或示例文件。

客户端未配置更新服务仍可正常查询。正式安装包的更新地址由发布脚本写入副本；开发时可用 `RAPTOR_UPDATE_SERVER` 覆盖，必须 HTTPS。用户可设置 `RAPTOR_NO_UPDATE_CHECK=1` 关闭检查。

## 发布命令的副作用

只有维护者决定正式发版、确认目标和内容后才运行：

```bash
npm run publish -- "本次更新说明"
```

该命令会提升版本号、生成安装包并向 `UPDATE_SERVER_URL` 上传，需要 `UPDATE_ADMIN_TOKEN`。`minor` / `major` 档位见脚本说明。

另一个 `npm run release` 脚本会进行 Git 提交、打标签和推送。它与上传更新后台不是同一条发布链路，不能把创建 Git 标签当成安装包已经发布。日常代码提交和 README 更新也不会自动生成新的安装包版本。

用户更新流程为 `/update` → 下载与覆盖应用文件 → 安装依赖 → 重启。当前升级会保护本机整个 `data/`、凭证、会话和输出目录。CI 文件已提供，远程验证结果需实际运行后确认。
