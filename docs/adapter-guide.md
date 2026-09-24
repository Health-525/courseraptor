# 学校适配指南

[返回首页](../README.md) · [能力参考](capabilities.md) · [参与贡献](../CONTRIBUTING.md)

想把 CourseRaptor 带到你的学校？这篇指南把整个过程拆成可以独立完成的步骤。适配一所学校的本质是：**实现一个 `SchoolAdapter`，把你学校教务系统的登录与查询翻译成统一端口**。你不需要动内核（`src/core`）与界面（`src/channels`）的任何代码。

> 想要适配但不想写代码？直接提[「请求适配我的学校」](https://github.com/Health-525/courseraptor/issues/new?template=request-school.yml)，把学校信息留给社区。

## 0. 开始前先确认三件事

1. **你的教务系统是哪家**：登录页上通常有厂商署名（正方、强智、金智、超星等）。全国大量高校使用**正方新版（zfsoft）**——如果是，NJTECH 适配里的登录与大部分查询逻辑可以直接参考改造，工作量会小很多。
2. **入口形态**：是教务系统直连，还是先过统一身份认证（SSO）/ WebVPN？这类差异全部封装在你适配器的 auth/session 模块里，不影响端口形状。
3. **你有自己的账号**，且接受[使用红线](#7-红线与隐私)（只用本人账号、低频请求、不提交真实数据）。

侦察方法：浏览器打开教务系统 → F12 → Network 面板，手动走一遍「登录、查课表、查成绩」，记下每一步的 URL、请求体和返回结构。这就是你要在适配器里复现的东西。

## 1. 架构与依赖方向

```
src/
├── core/       # 学校无关内核：agent、记忆、文档、日历、通用工具
│   └── school.ts   # SchoolAdapter 端口定义（唯一的契约文件）
├── adapters/   # 学校适配层：每校一个自包含目录
│   ├── index.ts    # 装配点：注册表 + RAPTOR_SCHOOL 环境变量切换
│   └── njtech/     # 参考实现（南京工业大学，正方新版）
└── channels/   # 输出渠道：cli / web / qq
```

依赖方向是硬约束（`src/core/school.ts` 头部注释亦有说明）：

- 适配器**可以** import core 的任何东西；
- core 与 channels **绝不** import 任何 `src/adapters/<school>` 模块，它们只认 `school()` 返回的端口。

## 2. 一个适配器由什么组成

完整契约见 [`src/core/school.ts`](../src/core/school.ts)（以它为唯一事实来源，本节是概念导读）：

| 成员 | 必填 | 内容 |
|---|---|---|
| `info` | ✅ | 学校 id（`RAPTOR_SCHOOL` 取值）、全名、短名、城市、时区 |
| `capabilities` | ✅ | 能力面清单：声明了哪项，agent 才有哪组工具 |
| `terms` | ✅ | 学期规则：学期编码、校历真值与开学周推算、周次表达式展开（`2-6,8-12(单)`）、节次作息表 |
| `auth` | ✅ | `login(学号, 密码)` 与 `getCookie()`（会话管理，含自动重登） |
| `schedule` | ➖ | 课表 / 考试抓取 |
| `notices` | ➖ | 教务通知列表与正文 |
| `tools` | ✅ | 贡献给 agent 的工具集（与 capabilities 对应；先给空对象也合法） |
| `promptSections()` | ✅ | 学校侧系统提示词：工具说明段 + 背景知识段 |

`capabilities` 可选值：`schedule` `exams` `grades` `student` `enrolledCourses` `retakeCourses` `labGrades` `courseSelection` `notices` `calendarExport`——**缺哪项，agent 就少哪组工具**，所以可以渐进式交付：先跑通课表，再补成绩、考试、通知。

**最小可用适配** = `info` + `capabilities: ["schedule"]` + `terms` + `auth` + `schedule` + 空 `tools` + 极简 `promptSections`。做到这一步，「查课表」就已经能用了。

## 3. 开发流程（六步）

### 第一步：建目录

```
src/adapters/<你的学校id>/
├── index.ts        # 组装 SchoolAdapter 并导出
├── auth.ts         # 登录（参考 njtech/auth.ts：正方 RSA + CSRF）
├── session.ts      # 会话 Cookie 管理（参考 njtech/session.ts）
├── academics.ts    # 学期规则、节次作息、周次展开
├── grades.ts / news.ts / xk.ts ...   # 按能力面逐个补
├── tools/          # agent 工具定义
└── prompt.ts       # 提示词段
```

目录名用学校 id（小写拼音或缩写，如 `hebau`、`nju`），与 `info.id` 一致。文件头注释写上**维护者署名**（GitHub 用户名），这是适配的功劳簿。

### 第二步：实现 info 与 terms

`terms` 是最需要查资料的部分：开学日期从校历/教务处通知里找真值，查不到时按「9 月/3 月第一个周一」估算并**标注来源**（`TermDateSource`），core 会如实透传。节次作息表抄你们学校的时间安排（如第 1-2 节 = 08:00-09:40）。

### 第三步：实现 auth

用第一步侦察到的登录流程复现：密码加密方式（正方新版是 RSA）、CSRF token、验证码处理（如有）。`login` 成功的标准是后续查询接口能通；`getCookie` 负责会话过期后的静默重登。**内置重试与退避**，参考 `njtech/session.ts`。

### 第四步：实现查询能力

从 `schedule` 开始：把教务接口返回的课程列表翻译成 core 的 `ScheduleResult`（结构见 `src/core/model.ts`）。之后每加一个能力，就在 `capabilities` 里声明一项、补一个模块、（可选）挂一组工具。

### 第五步：注册

在 [`src/adapters/index.ts`](../src/adapters/index.ts) 的 `IMPLEMENTATIONS` 表里加一行，然后：

```bash
RAPTOR_SCHOOL=<你的学校id> npm run dev
```

如果 `RAPTOR_SCHOOL` 未设置时希望默认是你的学校，改 `installDefaultSchool()` 里的缺省值（仅 fork 自用时）。

### 第六步：自检与提交

```bash
npm run typecheck && npm run lint && npm test
```

测试用虚构数据和模拟网络（参考 `tests/` 现有做法），**不要**把真实成绩、学号、Cookie 写进任何文件。

## 4. 提 PR 清单

- [ ] `src/adapters/<school>/` 自包含，core 与 channels 零改动（动了就说明端口不够用，先来开 issue 讨论端口扩展）
- [ ] 已注册进 `IMPLEMENTATIONS`
- [ ] 文件头与 README「已适配学校」表（中英两份）登记了维护者署名
- [ ] [能力参考](capabilities.md)按新能力同步更新
- [ ] 单元测试覆盖学期推算与周次展开这类纯函数
- [ ] 提交前 `typecheck` / `lint` / `test` 全绿
- [ ] PR 描述说明：验证过的能力面、未覆盖项、已知限制

## 5. 红线与隐私

- 只用**本人账号**测试；不发高频请求，尊重教务系统承载能力（全局限速 `RAPTOR_MAX_RPS` 只允许下调）。
- 抢课 / 退课等真实写操作**必须**走交互式确认，不进无头脚本（与 NJTECH 现行做法一致）。
- 不提交真实成绩、学号、Cookie、密码、验证码样例；仓库里出现过的凭证一律视为已泄露，立即改密。
- 遵守学校规定与教务系统使用条款；本工具与任何学校官方无关（见 README 免责声明）。

## 6. 卡住了怎么办

- 先看 [NJTECH 参考实现](../src/adapters/njtech/index.ts)——正方系学校大概率能对号入座；
- 端口语义拿不准：开 issue 或 Discussion，标题带「适配咨询」；
- 教务接口逆向细节：F12 Network 面板是主要手段；学校侧改版导致失效时，适配维护者（文件头署名者）会收到 issue 提醒。
