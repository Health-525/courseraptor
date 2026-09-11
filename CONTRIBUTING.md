# 参与 CourseRaptor

欢迎帮助完善面向南京工业大学学生的教务助手。可以从[反馈问题](https://github.com/Health-525/courseraptor/issues/new?template=bug_report.yml)、[提出学生场景](https://github.com/Health-525/courseraptor/issues/new?template=feature_request.yml)、改进文档或修复错误开始。

交流时请遵守[社区约定](CODE_OF_CONDUCT.md)；用法讨论可前往 [Discussions](https://github.com/Health-525/courseraptor/discussions)。

## 本地开发

需要 Node.js 24 或更高版本：

```bash
npm ci
npm run demo
```

演示不需要学号、密码或 API Key。正式教务测试使用自己的账号，避免高频请求；单元测试应使用虚构数据和模拟网络。

提交代码评审前运行：

```bash
npm run typecheck
npm run lint
npm test
```

## 代码约定

- 学校 HTTP 接口放在 `src/jwgl/`，数据计算优先写成可独立测试的纯函数，Agent 参数和返回说明放在 `src/tools/`。
- 新功能先描述学生场景，复用现有课表、日历、成绩和文件能力；避免仅为增加工具数量而拆新接口。
- 遵循现有中文注释和 Biome 格式。数据查询失败不能转换为“没有数据”，估算值必须标明来源。
- 修改学分、单双周、调休、文件路径、凭证和更新行为时增加有效边界测试。
- 不把凭证、真实成绩单、聊天记录、附件缓存或录屏中的个人资料提交到仓库。安全问题见 [SECURITY.md](SECURITY.md)。

## 评审说明

说明原问题、最终行为、验证方式和已知限制。网页变化附虚构数据截图；学校接口变化附脱敏后的最小样例。新能力同时更新[能力参考](docs/capabilities.md)和[路线图](docs/roadmap.md)，不要将规划标为已上线。

CI 配置位于 `.github/workflows/ci.yml`。远程检查是否通过，以实际 GitHub Actions 运行结果为准。

Issue 表单参考 [GitHub 官方文档](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)。
