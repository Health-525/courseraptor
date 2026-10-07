/**
 * 学校适配器端口（core 定义规范形状，适配器负责实现）
 *
 * 依赖方向约定（重构自 roadmap P3「多校适配」）：
 * - core 与 channels 只允许 import 本文件的类型与 school()/registerSchool()，
 *   绝不 import src/adapters 下的任何模块
 * - 适配器（adapters/*）可以 import core 的任何东西
 * - 装配点在 src/adapters/index.ts：入口文件顶部 `import "../adapters"`
 *   （或 ../../adapters）完成学校注册，之后 school() 全局可用
 *
 * 学校规则（节次作息表、校历种子、学期编码）一律通过本端口暴露，
 * core 不再持有任何具体学校的常量或域名。
 *
 * 2026-10 起仓库内置实现只剩手动课表模式（custom）：不保存教务密码、
 * 不代登录、不请求学校教务系统，课表等数据由用户自行导入。端口保持
 * 开放，未来若出现合规的官方数据源适配器，按本端口接入即可。
 */

import type { ToolSet } from "ai";
import type { FetchResult } from "./fetch-result";
import type {
  ExamResult,
  NewsItem,
  ScheduleResult,
  SchoolArticle,
  TermCandidate,
  TermDateSource,
  TermStartDate,
} from "./model";

/** 适配器可声明的能力面；缺哪项，agent 就少哪组工具 */
export type SchoolCapability =
  | "schedule" // 课表
  | "exams" // 考试安排
  | "grades" // 成绩 / GPA
  | "enrolledCourses" // 已选课程教学班
  | "courseSelection" // 选课查询
  | "notices" // 教务通知
  | "calendarExport"; // 日历导出

export interface SchoolInfo {
  /** 适配器标识 */
  id: string;
  /** 学校全名，用于系统提示词自我介绍 */
  name: string;
  /** 短名，用于标题栏等紧凑位置 */
  shortName: string;
  /** 学校所在城市：天气等工具的默认城市 */
  city: string;
  /** 学校所在时区（IANA 名）：教学周与「北京时间」口径 */
  timezone: string;
  /**
   * 手动课表模式：数据全部来自用户导入的本地缓存，没有教务在线能力
   * （成绩/考试/通知/选课）。设置页据此显示「导入课表」形态。
   */
  manual?: boolean;
}

/** 当前教学周快照；估算出来的必须带 source，调用方如实透传 */
export interface WeekSnapshot {
  week: number;
  week1Monday: string;
  source: TermDateSource;
  evidence?: string;
}

/**
 * 学期规则：编码、校历真值、周次展开与节次作息，全部由学校侧给出。
 */
export interface SchoolTerms {
  /** 学期展示名，如「2026-2027学年第一学期」 */
  label(year: number, semester: number): string;
  /** 候选学期列表（新到旧），用于「当前学期」探测 */
  candidates(now?: Date): TermCandidate[];
  /** 解析用户给的学期串，如「2026-2027-1」；不认识返回 null */
  parseSemesterString(text: string): TermCandidate | null;
  /** 某学期当前第几教学周；不在学期内返回 null */
  weekOf(year: number, semester: number, now?: Date): WeekSnapshot | null;
  /** 某学期第 1 周周一（含来源与证据；查不到给估算值） */
  week1MondayOf(year: number, semester: number): TermStartDate;
  /** 已落盘的学期开学日期（data/term-dates.json 真值快照） */
  recordedTerms(): Record<string, TermStartDate>;
  /** 周次表达式 → 周号数组，如「2-6,8-12(单)」 */
  expandWeeks(spec: string): number[];
  /** 节次号 → 上课时间段，如 [7,8] → "16:10-17:50"；缺节次表时 undefined */
  periodTimeRange(periods: number[]): string | undefined;
  /** 单个节次的时间段，如 5 → "14:00-14:45"；作息表里没有该节次时 undefined */
  periodTime(period: number): string | undefined;
  /** 完整作息表（节次号 → 时间段），供网页今日页渲染时间轴 */
  periodTimes(): Record<string, string>;
  /** 教学周星期名（1=周一 … 7=周日） */
  weekdayName(weekday: number): string;
}

/** 教务处通知 */
export interface SchoolNotices {
  fetchNews(existing?: NewsItem[], maxItems?: number): Promise<NewsItem[]>;
  fetchArticle(url: string): Promise<SchoolArticle>;
  /**
   * 带通道与降级信息、进程内短 TTL 快照的列表抓取：网页通知面板与
   * get_news 工具共用同一份快照，一轮里「面板看过 + 对话又问」不重复
   * 抓官网三页。可选端口：适配器不实现时调用方回退 fetchNews。
   */
  fetchNewsMemo?(maxItems?: number): Promise<SchoolNewsSnapshot>;
}

/** fetchNewsMemo 的返回形状：items 之外如实说明新鲜度 */
export interface SchoolNewsSnapshot {
  items: NewsItem[];
  /** 非空表示本次返回的是落盘缓存快照（直连失败时的兜底） */
  staleAt?: number;
}

/** 课表 / 考试抓取（欢迎面板与网页今日页共用） */
export interface SchoolSchedule {
  fetchSmart(cookie: string, xnm?: number, xqm?: number): Promise<FetchResult<ScheduleResult>>;
  fetchExamsSmart(cookie: string, xnm?: number, xqm?: number): Promise<FetchResult<ExamResult>>;
}

/** 学校贡献的系统提示词段：插在通用能力清单处与背景知识处 */
export interface SchoolPromptSections {
  /** 教务工具说明（选课 / 成绩 / 通知等能力段） */
  tools: string;
  /** 学校背景知识 + 学校特有的行为规则（如退课护栏） */
  background: string;
}

export interface SchoolAdapter {
  readonly info: SchoolInfo;
  readonly capabilities: readonly SchoolCapability[];
  readonly terms: SchoolTerms;
  readonly schedule?: SchoolSchedule;
  readonly notices?: SchoolNotices;
  /** 该校贡献给 agent 的工具（与 capabilities 对应；由 agent 与 core 工具合并） */
  readonly tools: ToolSet;
  promptSections(): SchoolPromptSections;
}

let registered: SchoolAdapter | null = null;

/** 注册学校适配器（幂等；装配点在 src/adapters/index.ts） */
export function registerSchool(adapter: SchoolAdapter): void {
  registered = adapter;
}

export function registeredSchool(): SchoolAdapter | null {
  return registered;
}

/** 取当前学校适配器；未装配时给出可操作的报错 */
export function school(): SchoolAdapter {
  if (!registered) {
    throw new Error('尚未装配学校适配器：入口文件应先 import "../adapters"');
  }
  return registered;
}
