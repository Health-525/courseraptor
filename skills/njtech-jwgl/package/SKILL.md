---
name: njtech-jwgl
description: >-
  南京工业大学（NJTech）正方教务系统适配器。当同学要查课表、成绩、GPA、考试、
  教务处通知，或查选课状态/搜课时使用。
  它封装了 CourseRaptor 项目里的 src/adapters/njtech 教务协议层，提供可无头调用的命令行入口，
  也可驱动交互式 raptor agent。仅适用于 njtech.edu.cn 域名。
license: ISC
agent_created: true
---

# NJTech 教务适配器（南京工业大学）

把 **CourseRaptor 项目里的南京工业大学教务部分**（`src/adapters/njtech` 正方教务协议层 + 工具封装）
打包成一个可被同学直接调用的技能。覆盖课表 / 成绩 / 考试 / 通知 / 选课 等
南京工业大学在校生的日常教务查询。

> 本项目与南京工业大学官方无关，也未获其授权或认可。使用者需自行承担全部风险，
> 请遵守学校相关规定与教务系统使用条款，避免大规模或高频请求。

## 何时使用

- 用户是南京工业大学在校生，想用对话/命令行查教务数据。
- 触发词示例：「查一下我这周课表」「我 GPA 多少」「这学期什么时候考试」
  「教务处最近有什么通知」「××课还有名额吗」「选课开了没」。
- 域名限定：`jwgl.njtech.edu.cn`（登录/课表/成绩）、`jwc.njtech.edu.cn`（通知，无需登录）、
  其它 `*.njtech.edu.cn` 子域。

## 前置条件

1. **Node.js ≥ 24**（项目内置说明；运行脚本用 `npx tsx`，无需全局安装）。
2. **教务凭证**：`JWGL_USERNAME`（学号）与 `JWGL_PASSWORD`（密码）需已配置——二选一：
   - 项目根 `.env` 里写 `JWGL_USERNAME` / `JWGL_PASSWORD`；或
   - 已通过 `raptor` 首次引导录入并 AES-256-GCM 加密保存在 `credentials.enc`。
   - 未配置时脚本/工具会明确报错「尚未配置教务账号」，不要拿空值去撞登录接口。
3. **DeepSeek Key**：仅驱动**交互式 LLM agent**（`raptor`）时需要；本技能的无头查询脚本
   不依赖它。

## 怎么调用（两条路径）

### 路径 A：无头命令行（推荐给同学直接使用，最快）

脚本：`scripts/query.ts`，直接复用 `src/adapters/njtech` 的已验证函数，输出 Markdown。

```bash
# 在 courseraptor 项目根目录执行
npx tsx skills/njtech-jwgl/scripts/query.ts <命令> [参数]

# 命令一览
schedule [学期]          # 课表；不填自动探测最新有课表的学期，如 schedule 2026-2027-1
grades                  # 全部学期成绩 + GPA + 已获必修课学分
exams [学期]            # 考试安排
news [板块] [条数]       # 教务处通知；板块=公告通知|教学动态|考试排课，默认全部
selection-status       # 选课模块是否开放、xkkzId、各轮次状态
search-courses <关键词> # 搜可选课程及余量
search-classes <课程名> # 某门课下所有教学班明细（含各班余量）
```

示例：

```bash
npx tsx skills/njtech-jwgl/scripts/query.ts schedule
npx tsx skills/njtech-jwgl/scripts/query.ts grades
npx tsx skills/njtech-jwgl/scripts/query.ts news 公告通知 5
npx tsx skills/njtech-jwgl/scripts/query.ts search-courses 高等数学
```

### 路径 B：交互式 agent（适合自然语言多轮对话）

```bash
npm run dev            # 或全局命令 raptor
```

agent 已内置 31 个工具，其中 NJTech 教务相关工具的名称与语义见 `references/capabilities.md`。
本技能加载后，你（agent）应优先用**路径 A 的脚本**完成确定性的单点查询（更快、可脚本化、不烧 token）；
需要多轮推理、附件解析、放假/调休落盘、或课表图与日历导出时，再走路径 B 或对应工具。

## 能力与对应实现（速查）

| 能力 | 脚本命令 | 底层函数（src/adapters/njtech） |
|------|----------|----------------------|
| 课表 | `schedule` | `academics.fetchScheduleSmart` |
| 成绩/GPA | `grades` | `grades.fetchAllGrades` |
| 考试 | `exams` | `academics.fetchExamsSmart` |
| 通知 | `news` | `news.fetchJwcNews` / `news.fetchJwcArticle` |
| 选课状态 | `selection-status` | `xk.inspectXk` |
| 搜课/余量 | `search-courses` | `xk.searchCourses` |
| 教学班明细 | `search-classes` | `xk.searchCourses` + `xk.fetchJxbList` |

协议细节、限流、模块覆盖与域名清单见 `references/protocol.md`；完整工具/能力清单见
`references/capabilities.md`。

## 安全与合规红线（务必遵守）

- **限流**：传输层有全局令牌桶（默认 3 RPS / 突发 8）。`RAPTOR_MAX_RPS` 只允许下调，
  严禁调高。不要并发或高频刷教务系统。
- **纯只读查询**：本脚本与交互式 agent 均不提供任何提交类操作（选课/退课等一律去教务系统官网操作）。
- **隐私**：不要向用户回显证件号等完整明文；本地 `credentials.enc` / `session.json` / `memory.json` 等切勿分享。
- **「拿不到」≠「没有」**：网络错误/会话失效必须如实上报，绝不能当作「课表为空 / 无成绩」。
  脚本已按此语义实现（传输失败直接以非零退出码报错）。
- **不绕过验证码**：附件若受图形验证码保护，本项目不做识别，直接失败并提示用户在浏览器里手动下载。

## 维护提示

- 本技能是 `src/adapters/njtech` 的**只读封装**：不要在本技能里复制教务协议逻辑，改了要同步回 `src/adapters/njtech`。
- 新增查询能力时，优先在 `src/adapters/njtech` 暴露纯函数，再在 `scripts/query.ts` 加一个薄命令。
- 发布独立包：`npm run package:skill` → `dist/skill/njtech-jwgl/`（整目录拷进 `~/.workbuddy/skills/` 即用）+ `dist/njtech-jwgl-skill-v*.zip`。独立包的 SKILL.md / README / .env.example 在 `package/` 下维护，随打包复制；`tests/skill-package.test.ts` 钉住自包含与无泄漏契约。
