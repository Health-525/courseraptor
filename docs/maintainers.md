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
