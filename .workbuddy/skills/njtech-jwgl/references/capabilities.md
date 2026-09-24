# NJTech 教务能力清单（CourseRaptor · 南京工业大学）

本文件列出 CourseRaptor 中**南京工业大学教务相关**的工具与底层实现，供本技能（njtech-jwgl）
的调用方（agent 或同学）查阅。非教务类工具（日历/文档/文件/知识库/记忆/番茄钟/待办/设置/
时间/天气等共 12 个）不在此列。

> 总计 31 个 agent 工具，其中以下 **19 个**为 NJTech 教务专用。

## 一、课表与校历

| 工具 | 语义 | 底层（src/jwgl） | 脚本命令 |
|------|------|------------------|----------|
| `get_schedule` | 课表查询，自动探测最新有课表的学期；返回按周预分组的 `byWeek` 索引，并叠加放假/调休 | `academics.fetchScheduleSmart` | `schedule` |
| `set_holidays` | 把教务处放假/调休安排落盘到本地，后续 `get_schedule` 自动叠加 | `term-holidays.recordSpecialDays` | —（需交互确认来源） |

## 二、成绩与考试

| 工具 | 语义 | 底层 | 脚本命令 |
|------|------|------|----------|
| `get_grades` | 全部学期成绩 + GPA + 已获必修课学分 + 通识分类概览（重修取最高分；通过型不计 GPA） | `grades.fetchAllGrades` | `grades` |
| `get_exams` | 考试安排（科目/日期/时间/考场/座位） | `academics.fetchExamsSmart` | `exams` |
| `get_lab_grades` | 实验课程成绩（按学期） | `portal.fetchLabGradesSmart` | `lab-grades` |

## 三、通知情报

| 工具 | 语义 | 底层 | 脚本命令 |
|------|------|------|----------|
| `get_news` | 教务处官网三板块通知，按年级/是否需本人行动标相关性（high/medium/low） | `news.fetchJwcNews` + `tools/news.relevanceOf` | `news` |
| `read_notice` | 读取官网文章正文全文 + 附件链接（webplus CMS 解析） | `news.fetchJwcArticle` | — |
| `fetch_attachment` | 下载并解析通知附件（xlsx/csv 表格概览、docx/pdf/txt 分页/关键词定位） | `attachments.fetchAttachment` | — |

## 四、学籍与课程信息

| 工具 | 语义 | 底层 | 脚本命令 |
|------|------|------|----------|
| `get_student_info` | 学籍个人信息（敏感字段打码） | `portal.fetchProfile` | `student-info` |
| `get_enrolled_courses` | 本学期已选教学班（含时间/地点/学分/性质） | `portal.fetchEnrolledClasses` | `enrolled-courses` |
| `get_retake_courses` | 可重修课程（可关键词过滤） | `portal.fetchRetakeCourses` | `retake-courses` |

## 五、选课与抢课（含真实写操作）

| 工具 | 语义 | 底层 | 脚本命令 |
|------|------|------|----------|
| `check_selection_status` | 选课模块是否开放、xkkzId、各轮次状态、课程查询是否被「加密串」拦截 | `xk.inspectXk` | `selection-status` |
| `search_courses` | 搜可选课程及余量 | `xk.searchCourses` | `search-courses` |
| `search_classes` | 某门课下所有教学班明细（余量对比） | `xk.searchCourses` + `xk.fetchJxbList` | `search-classes` |
| `watch_courses` | 限时监控余量变化（**只观察不提交**） | `xk.searchCourses` 轮询 | `watch`（脚本版只监控） |
| `grab_course` | **真实提交选课**（抢课） | `xk.submitCourse` | 不提供（需 agent + 用户确认） |
| `grab_plan` | **分类抢课计划**（每类一门即停） | `xk.submitCourse` | 不提供 |
| `list_choosed_courses` | 本轮已选课程（选课维度） | `xk.fetchChoosedList` | — |
| `drop_course` | **真实提交退课**（绝不批量） | `xk.quitCourse` | 不提供 |

## 调用约定（agent 视角）

- **确定性单点查询**（课表/成绩/考试/通知/学籍/搜课）优先走技能脚本 `query.ts`，更快且不烧 LLM token。
- **多轮推理 / 附件解析 / 放假落盘 / 真实选退课** 走交互式 `raptor` agent 的对应工具。
- 所有「登录类」查询经 `jwgl/session.getCookie` 复用 25 分钟会话缓存，失效自动重登（带 5 次指数退避）。
- 「拿不到」与「确认为空」严格区分：传输失败一律报错上报，不允许降级成空列表。
