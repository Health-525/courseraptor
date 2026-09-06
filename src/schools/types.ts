/**
 * 学校适配器契约 —— agent 侧的「一校一适配」边界
 *
 * 为什么要有这一层：
 * 教务抓取原本直接写死 NJTECH（src/jwgl/auth.ts 导出一个 BASE 常量，被 5 个模块
 * import）。接第二所学校时，如果不设边界，最省事的做法是到处 `if (school === "hebau")`，
 * 结果是任何一所学校的接口改版都要改十几个文件，而且很容易出现「用河北农大的密码
 * 去请求南工大教务」这种凭证外泄事故。所以：
 *
 * - 一所学校 = 一个适配器。端点、登录方式、字段名、绩点口径都关在适配器里。
 * - 工具层只认 SchoolAdapter 接口 + capability 清单，不再认学校名。
 * - 学校没有对应端点的能力必须走 capability 门禁明确报「暂不支持」，
 *   绝不允许退回另一所学校的接口去猜——宁缺毋滥，错的数据比没有数据更坏。
 *
 * 术语沿用 jwgl/types.ts 的数据结构（CourseData/ExamData/GradeResult），
 * 这样课表分组、学业概览、日历导出这些下游纯计算逻辑可以零改动复用。
 */

import type { FetchResult } from "../jwgl/http";
import type { TermStartDate } from "../jwgl/term-dates";
import type { CourseData, ExamData, GradeResult } from "../jwgl/types";

/**
 * 能力键。粒度按「工具能不能干活」划分，不按学校划分——
 * 加学校时只需要填这张表，改工具时只需要问一句「这能力有没有」。
 */
export type SchoolCapability =
  /** get_schedule 课表查询 */
  | "schedule"
  /** get_grades 成绩与 GPA */
  | "grades"
  /** get_exams 考试安排 */
  | "exams"
  /** 通识选修六类分类统计（依赖成绩里的课程归属字段） */
  | "generalElectives"
  /** get_news 教务处通知列表 */
  | "news"
  /** read_notice / fetch_attachment 通知正文与附件 */
  | "notice"
  /** get_student_info 学籍信息 */
  | "student"
  /** get_enrolled_courses 已选课程教学班 */
  | "enrolledCourses"
  /** get_retake_courses 可重修课程 */
  | "retakeCourses"
  /** get_lab_grades 实验成绩 */
  | "labGrades"
  /** 选课/盯课/抢课一族 */
  | "courseSelection"
  /** export_calendar / publish_calendar（只要有课表和考试就能导） */
  | "calendar";

export interface SchoolSession {
  /** 后续抓取请求带的 Cookie 串 */
  cookie: string;
  username: string;
}

export interface SchoolLoginInput {
  username: string;
  password: string;
  /** 二次认证：上一轮拿到的 challengeId，与 dynamicCode 同时传表示提交验证码 */
  challengeId?: string;
  dynamicCode?: string;
}

export interface SchoolAdapter {
  /** 稳定标识，同时是 data 目录下按学校分文件的后缀 */
  id: string;
  /** 全称，用于文案与系统提示词 */
  name: string;
  /** 城市名（get_weather 默认城市）。写死在学校中，不要靠主机名猜 */
  city: string;
  /** 教务系统基础 URL（展示与诊断用；凭证只会发往这一处） */
  jwglBase: string;
  /** read_notice/fetch_attachment 允许直读的官网域名后缀 */
  newsDomains: string[];
  /** 节次号 -> 时间段，如 "1" -> "08:00-08:45" */
  periodTimes: Record<string, string>;
  /** 春夏学期覆盖的月份区间（含端点），学期归属推断用 */
  secondSemesterMonths: readonly [number, number];
  capabilities: readonly SchoolCapability[];
  /** 登录是否可能要求二次认证（触发对话内提交验证码流程） */
  supportsSecondFactor: boolean;
  /** 学校专属的提示词事实：教务形态、已知校历、学校侧停用模块 */
  promptFacts: string;
  /** 开学日期播种值（`${学年}-${1|2}` -> 真值），仅在 data 文件不存在时用一次 */
  termSeed: Record<string, TermStartDate>;
  /** GPA 口径一句话说明，供工具层如实转述 */
  gpaBasis: string;

  login(input: SchoolLoginInput): Promise<SchoolSession>;
  /** 抓单个学期课表。学期编码由适配器自己换算 */
  fetchScheduleFor(
    session: SchoolSession,
    year: number,
    semester: number,
  ): Promise<FetchResult<CourseData[]>>;
  /** 抓单个学期考试 */
  fetchExamsFor(
    session: SchoolSession,
    year: number,
    semester: number,
  ): Promise<FetchResult<ExamData[]>>;
  /** 抓全部学期成绩并算 GPA */
  fetchGrades(session: SchoolSession): Promise<GradeResult>;
}

export function supportsCapability(school: SchoolAdapter, cap: SchoolCapability): boolean {
  return school.capabilities.includes(cap);
}

/** 能力键的中文名。门禁话术与 get_school_status 清单共用一份，避免两处各写一遍 */
export const CAPABILITY_LABELS: Record<SchoolCapability, string> = {
  schedule: "课表查询",
  grades: "成绩查询",
  exams: "考试安排查询",
  generalElectives: "通识选修分类统计",
  news: "教务处通知列表",
  notice: "通知正文读取",
  student: "学籍个人信息",
  enrolledCourses: "已选课程查询",
  retakeCourses: "可重修课程查询",
  labGrades: "实验成绩",
  courseSelection: "选课/抢课",
  calendar: "日历导出",
};

/**
 * 门禁话术。返回给模型的文本要能直接转述给用户，所以：
 * 说清是「学校没开这个接口」而不是「你查错了」，并给出可行的下一步。
 */
export function unsupportedCapabilityMessage(school: SchoolAdapter, cap: SchoolCapability): string {
  return (
    `${CAPABILITY_LABELS[cap]}暂不支持：${school.name}的教务系统没有提供对应接口，` +
    `CourseRaptor 不会拿其他学校的接口猜数据。需要这项信息请到${school.name}教务系统官网查看。`
  );
}
