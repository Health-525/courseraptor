# NJTech 教务查询技能（南京工业大学 · 独立包）

一个技能包：装进 WorkBuddy（或任何支持 Agent Skills 规范的工具，技能目录约定
`~/.workbuddy/skills/`），对话说「查课表」「我 GPA 多少」即可查询南京工业大学
正方教务系统的数据；也可以直接在终端当命令行用。

- 覆盖：课表 / 成绩 / GPA / 考试 / 实验成绩 / 学籍 / 教务处通知 / 选课状态 /
  搜课与余量 / 余量监控（只观察）
- **本地直连**：用你自己的学号 + 教务密码，在本机运行；凭证不经过任何第三方服务器
- 单文件脚本（`scripts/query.mjs`），无需 `npm install`
- ISC 开源协议

> 与南京工业大学官方无关，未获其授权或认可。使用需自行承担风险，请遵守学校
> 相关规定与教务系统使用条款，不要高频请求。内置 3 请求/秒限速，请保持默认。

## 快速开始

1. 安装 [Node.js](https://nodejs.org/) ≥ 18（推荐 20+）。
2. 下载本包并解压（WorkBuddy 用户：把 `njtech-jwgl` 整个文件夹放进
   `~/.workbuddy/skills/`，即与 `SKILL.md` 同级）。
3. 配置你自己的教务账号（二选一）：
   - 在 `njtech-jwgl/` 下把 `.env.example` 复制为 `.env`，填入
     `JWGL_USERNAME=学号`、`JWGL_PASSWORD=教务密码`；
   - 或设置同名环境变量。
4. 验证与使用：

```bash
node scripts/query.mjs schedule        # 本周课表（自动探测最新学期）
node scripts/query.mjs grades          # 成绩 + GPA
node scripts/query.mjs news 公告通知 5 # 教务处通知前 5 条
node scripts/query.mjs search-courses 高等数学   # 搜课与余量
node scripts/query.mjs                 # 查看全部命令
```

输出是 Markdown，直接可读，也方便贴给 AI 助手继续处理。

## 在 WorkBuddy 里怎么触发

技能装好后，对话里自然地说需求即可，例如「查一下我这周课表」「这学期什么时候考试」
「××课还有名额吗」。助手会自动调用本技能的脚本并转述结果。

## 隐私说明

- 凭证只存在你本机（`.env` 或 `data/credentials.enc`），查询直连学校教务系统
  （`jwgl.njtech.edu.cn` / `jwc.njtech.edu.cn`），没有中间服务器。
- 会话与缓存落在技能目录 `data/` 下，删除该目录即清空全部本地数据。
- 学籍信息中的证件号/银行卡/考生号等敏感字段自动打码。
- 请勿把 `.env` 或 `data/` 分享给任何人。

## 常见问题

- **提示「尚未配置教务账号」**：`.env` 没建好或路径不对——它必须和 `SKILL.md`
  在同一目录（不是 `scripts/` 里）。
- **「拿不到」≠「没有」**：网络错误/会话失效会以报错退出，这是设计行为，
  重试即可；不要把报错理解成「无课表/无成绩」。
- **需要真实写操作类功能**：本包刻意只做查询。写操作请使用完整项目
  [CourseRaptor](https://github.com/Health-525/courseraptor)（交互式 agent，
  需显式确认）。

## 来源与许可

打包自开源项目 [CourseRaptor](https://github.com/Health-525/courseraptor) 的
NJTech 教务适配层（ISC 协议）。技能本身与南京工业大学官方无关。
