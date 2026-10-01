---
name: njtech-jwgl
description: >-
  南京工业大学（NJTech）正方教务系统查询技能（独立包，本地直连）。当同学要查课表、成绩、GPA、
  考试、实验成绩、学籍信息、已选/可重修课程、教务处通知，或查选课状态/搜课/盯课余量时使用。
  用同学自己的教务账号在本机运行，无需安装完整项目；仅适用于 njtech.edu.cn 域名。
license: ISC
agent_created: true
---

# NJTech 教务查询（南京工业大学 · 独立技能包）

覆盖南京工业大学在校生日常教务查询：课表 / 成绩 / GPA / 考试 / 实验成绩 / 学籍 / 通知 /
选课状态 / 搜课 / 盯课余量。单文件脚本本地直连教务系统，凭证只留在本机。

> 本技能与南京工业大学官方无关，也未获其授权或认可。使用者需自行承担全部风险，
> 请遵守学校相关规定与教务系统使用条款，避免大规模或高频请求。

## 何时使用

- 用户是南京工业大学在校生，想用对话/命令行查教务数据。
- 触发词示例：「查一下我这周课表」「我 GPA 多少」「这学期什么时候考试」
  「教务处最近有什么通知」「××课还有名额吗」「选课开了没」。
- 域名限定：`jwgl.njtech.edu.cn`（登录/课表/成绩）、`jwc.njtech.edu.cn`（通知，无需登录）、
  其它 `*.njtech.edu.cn` 子域。

## 前置条件（首次配置，一次性）

1. **Node.js ≥ 18**（推荐 20+）。`node --version` 能正常输出即可。
2. **教务凭证（同学自己的）**，二选一：
   - 在本技能根目录把 `.env.example` 复制为 `.env`，填入：
     ```
     JWGL_USERNAME=学号
     JWGL_PASSWORD=教务密码
     ```
   - 或设置同名环境变量。
3. 未配置时脚本会明确报错「尚未配置教务账号」，不要拿空值去撞登录接口。

## 怎么调用

在本技能目录（SKILL.md 所在目录）执行：

```bash
node scripts/query.mjs <命令> [参数]

# 命令一览
schedule [学期]          # 课表；不填自动探测最新有课表的学期，如 schedule 2026-2027-1
grades                  # 全部学期成绩 + GPA + 已获必修课学分
exams [学期]            # 考试安排
lab-grades [学期]       # 实验成绩
news [板块] [条数]       # 教务处通知；板块=公告通知|教学动态|考试排课，默认全部
student-info           # 学籍个人信息（敏感字段自动打码）
enrolled-courses       # 本学期已选教学班
retake-courses [关键词] # 可重修课程（可关键词过滤）
selection-status       # 选课模块是否开放、xkkzId、各轮次状态
search-courses <关键词> # 搜可选课程及余量
search-classes <课程名> # 某门课下所有教学班明细（含各班余量）
watch <课程名> [秒]     # 限时监控余量变化（只观察不提交！）
```

示例：

```bash
node scripts/query.mjs schedule
node scripts/query.mjs grades
node scripts/query.mjs news 公告通知 5
node scripts/query.mjs search-courses 高等数学
```

输出为 Markdown，可直接转述给用户；命令出错时以非零退出码报错，
**「拿不到」≠「没有」**——网络错误/会话失效必须如实上报，绝不能当作「课表为空 / 无成绩」。

## 数据与隐私

- 会话、缓存等全部落在本技能目录的 `data/` 下，不写其它位置。
- 凭证（`.env`、`data/credentials.enc`）只在本机，任何情况下都不要把它们复述、
  截图或发送给他人；也不要把 `.env` 提交到任何仓库。
- 学籍敏感字段（证件号/银行卡/考生号）返回时自动打码，不要向用户回显完整明文。

## 安全红线（务必遵守）

- **限流**：内置全局限速（默认 3 请求/秒），`RAPTOR_MAX_RPS` 只允许 1-3，
  严禁调高。不要并发或高频刷教务系统。
- **只读**：本技能只做查询。**不提供也不应尝试**抢课/退课等真实写操作——
  那需要完整 CourseRaptor 项目的交互式 agent 且必须用户二次确认。
- **盯课 ≠ 抢课**：`watch` 命令只监控余量、不提交任何选课请求。
- 传输失败直接以非零退出码报错（脚本已按此语义实现）。

## 与完整项目的关系

本包是开源项目 [CourseRaptor](https://github.com/Health-525/courseraptor) 中
NJTech 教务适配层的只读打包。抢课/退课、附件深度解析（PDF 通知正文、验证码 OCR）、
对话式 agent 等能力需要完整项目，不在本包内。

协议细节与模块覆盖说明见 `references/protocol.md`；能力清单见 `references/capabilities.md`。
