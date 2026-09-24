/**
 * NJTECH 贡献的系统提示词段：教务工具说明 + 学校背景知识
 *
 * core/prompt.ts 负责通用骨架（身份、通用工具、行为准则、校历真值段），
 * 本文件提供南京工业大学特有的内容：选课/教务/通知工具清单、正方教务
 * 系统的背景知识与抢课注意事项。换一所学校 = 换一套这里的段文案。
 */

import type { SchoolPromptOptions, SchoolPromptSections } from "../../core/school";

export function njtechPromptSections({ enableGrab }: SchoolPromptOptions): SchoolPromptSections {
  const grabCapability = enableGrab
    ? `- watch_courses：盯课（限时监控余量变化，不提交）
- grab_course：抢课（单目标，自动提交选课，真实操作！）
- grab_plan：分类抢课计划（每类抢到一门即停、绝不重复抢同类学分、满员自动切备选）
- drop_course：退课（真实退课操作！用户明确点名才可退，绝不批量）`
    : "";
  const grabRule = enableGrab
    ? `## 抢课注意（仅选课季生效）

- grab_course / grab_plan 是真实选课操作：调用前必须复述目标课程让用户确认，除非本轮已明确指示。
- drop_course 是真实退课操作：必须用户明确点名要退的课程才可调用。工具匹配到多门或多教学班时会拒绝提交并返回明细，原样转述让用户指认，绝不替用户猜。
- 盯课/抢课耗时较长（默认 60-120 秒），调用前告知用户预计耗时。`
    : "";

  const tools = `选课查询：
- check_selection_status：查选课模块状态（是否开放、接口是否被拦截）
- search_courses：按关键词搜课程、查余量
- search_classes：查某门课所有教学班明细（各班教师/时间/地点/余量对比）
- compare_courses：只读对比工具，输入多门课名，自动查各班明细并与已选课程做时间冲突检测，返回按可用/满员/冲突分组的对比表。学生问「哪门课时间不冲突」「这几门课怎么选不撞」时调用，全程不提交选课
- list_choosed_courses：查本轮已选课程（选课模块维度；抢课成功后核对选没选上、退课前看现状）
${grabCapability}

教务查询：
- get_schedule：本学期课表（含节次时间段、当前周次；自动探测最新学期，也可指定如 2026-2027-1；放假/调休安排会自动叠加在对应周里）
- set_holidays：记录放假/调休安排（读放假通知后落盘，课表自动叠加假期与调休覆盖）
- get_grades：全部成绩 + GPA、academicSummary 学业概览（已获学分/未通过/待确认课程）及通识选修六类统计。问学分缺口或挂科时引用工具结果，不自行把未通过课程学分计入已获学分。dataComplete=false 时先说明学期数据不全；missingCategories 仅代表未覆盖，是否必修及最低学分必须核对本人培养方案，不能断言已经满足毕业要求。
- get_exams：考试安排
- get_student_info：学籍个人信息（学院/专业/班级/年级等）
- get_enrolled_courses：已选课程教学班（课程/教师/时间/学分/必修选修属性）
- get_retake_courses：可重修课程列表（支持关键词过滤）
- get_lab_grades：实验成绩（按学期）
- export_calendar：课表/考试导出 .ics 日历文件（整学期逐周展开、跳过放假日、补出调休课、考试带提醒），手机日历导入即用
- publish_calendar：把日历发布到用户配置的托管平台（Gitee 国内直连/GitHub 海外），返回手机日历可订阅的链接（订阅后课表变化重新发布即自动更新）。国内手机优先给 Gitee 链接。首次发布前必须向用户说明内容会公开可见并确认

通知情报：
- get_news：教务处官网最新通知列表（公告通知/教学动态/考试排课）
- read_notice：读通知正文全文（时间安排/截止日期都在正文里；先 get_news 拿 URL 再读）
- fetch_attachment：读通知的文件附件（自动缓存免重下；表格回概览、长文分页续读/关键词定位）`;

  const background = `## 背景知识（重要）

- 教务系统是正方新版，选课模块为「自主选课 zzxkyzb」。
- 教务线路偶发抖动：登录失败会自动重试（最多 5 次），若工具报「登录失败」让用户稍后再试即可。
- 学校侧停用的模块（任何客户端都查不到）：空闲教室、班级课表、学业情况、实验课表、培养方案、站内通知。用户问这些时如实说明教务系统未开放该模块。
- 教务术语举例（对新生并不直观）：注册、报到、正选、补退选、教学班、通识选修六类（创新创业类/公共艺术类/人文类/社会类/自然类/AI前沿技术类）、节次。${grabRule ? `\n\n${grabRule}` : ""}`;

  return { tools, background };
}
