# 配置参考

[返回首页](../README.md) · [同学使用指南](student-guide.md)

首次使用建议直接运行 `npm start`，按引导加密保存凭证。需要手动配置时，复制 `.env.example` 为 `.env`；不要覆盖已有文件，也不要把真实 Key 或密码写进聊天。

| 配置项 | 默认 / 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 正式对话需要；可通过首次引导或无参数 `/key` 配置 |
| `JWGL_USERNAME` / `JWGL_PASSWORD` | 本人的教务凭证；留空时按启动引导配置 |
| `RAPTOR_MODEL` | 源码默认 `deepseek-v4-flash`；须确认自己的服务账户支持所选模型 |
| `DEEPSEEK_BASE_URL` | 可选，自定义模型服务地址；对话内容会发往这个服务 |
| `RAPTOR_WEB_PORT` | 正式网页首选端口，默认 3210，占用后自动选择空闲端口 |
| `RAPTOR_TUI_INLINE` | `1` 使用终端行内模式；默认全屏卡片模式 |
| `RAPTOR_ENABLE_GRAB` | 默认关闭；`1` 启用盯课和真实选课提交工具 |
| `RAPTOR_DISABLE_CAPTCHA_OCR` | `1` 停用通知附件下载时的本地验证码识别 |
| `RAPTOR_MAX_RPS` | 请求频率上限只允许下调；尊重学校服务容量 |
| `FIRECRAWL_API_KEY` | 可选，公开通知附件的云解析兜底；本地解析无需此项 |
| `RAPTOR_CJK_FONT` | 可选，中文 PDF 使用的本机字体绝对路径 |
| `QQBOT_APP_ID` / `QQBOT_APP_SECRET` / `QQBOT_PASSCODE` | 可选，QQ 官方机器人凭证与准入暗号；仍共用本机教务身份 |
| `GITHUB_TOKEN` / `GITEE_TOKEN` | 可选，将课表日历发布到公开仓库；分享范围需本人确认 |
| `RAPTOR_NO_UPDATE_CHECK` | `1` 关闭启动时版本检查 |
| `RAPTOR_UPDATE_SERVER` | 维护者本地覆盖 HTTPS 更新服务地址；分发包可内置地址 |
| `UPDATE_SERVER_URL` / `UPDATE_ADMIN_TOKEN` | 仅维护者发版需要，见[维护指南](maintainers.md) |

`RAPTOR_DEMO_PORT` 默认 3211。演示入口不加载 `.env`，需在终端环境变量中指定，例如 Windows PowerShell：

```powershell
$env:RAPTOR_DEMO_PORT = "3212"
npm run demo
```

## 凭证优先级

- 教务账号：`.env` / 进程环境里的 `JWGL_*` 优先，其次本机 `credentials.enc`，最后首次引导。
- API Key：通过 `/key` 明确设置的加密覆盖值优先，其次环境变量，再其次加密存储中的旧值。
- 加密存储依赖当前机器和系统用户信息，不是系统密码保险库；不能防御同机同用户运行的恶意程序。

完整 Key 不应出现在命令参数中。正确方式是输入 `/key`，再按隐藏输入提示录入。
