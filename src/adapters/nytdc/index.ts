/**
 * NYTDC（南京邮电大学通达学院）学校适配器
 *
 * 把正方新版教务系统（jwxt.nytdc.edu.cn/jwglxt）的登录与查询组装成
 * core/school.ts 定义的 SchoolAdapter：
 * - 与 NJTECH 同源（正方 jwglxt），差异见 academics.ts / grades.ts 头注释：
 *   部署路径 /jwglxt、只有 HTTP、12 节作息、平均学分绩点为 5 分制且任选课不计、
 *   学号前 2 位是入学年、周次以位掩码为准
 * - 能力面：课表 / 成绩 / 考试 / 日历导出。选课与通知未接入（不声明 capability）
 * - 能力面：课表 / 成绩 / 考试 / 教务处通知 / 日历导出。选课查询未接入（不声明 capability）
 * - 通知走教务处官网（jwc.nytdc.edu.cn，公开可访问，不需要登录），见 news.ts
 *
 * 维护者：社区适配（实机验证：登录 / 课表 / 成绩 / 考试四个接口，
 * 学生本人账号、2025-2026-2 与 2026-2027-1 两个学期）
 */

import type { SchoolAdapter } from "../../core/school";
import * as academics from "./academics";
import { loginJwgl } from "./auth";
import * as news from "./news";
import { nytdcPromptSections } from "./prompt";
import * as session from "./session";
import * as termDates from "./term-dates";
import { nytdcTools } from "./tools";

export const nytdcSchool: SchoolAdapter = {
  info: {
    id: "nytdc",
    name: "南京邮电大学通达学院",
    shortName: "NYTDC",
    city: "扬州",
    timezone: "Asia/Shanghai",
  },
  capabilities: ["schedule", "exams", "grades", "notices", "calendarExport"],
  terms: {
    label: academics.termLabel,
    candidates: (now?: Date) => academics.candidateXnxqList(now),
    parseSemesterString: academics.parseSemesterString,
    weekOf: termDates.currentWeekOf,
    week1MondayOf: termDates.resolveWeek1Monday,
    recordedTerms: termDates.loadStore,
    expandWeeks: academics.expandWeeks,
    periodTimeRange: academics.periodTimeRange,
    periodTime: (period: number) => academics.NYTDC_PERIOD_TIMES[String(period)],
    periodTimes: () => academics.NYTDC_PERIOD_TIMES,
    weekdayName: (weekday: number) => academics.WEEKDAY_NAMES[weekday] ?? `周${weekday}`,
  },
  auth: {
    login: async (username, password) => {
      await loginJwgl(username, password);
    },
    getCookie: (force?: boolean) => session.getCookie(force),
  },
  schedule: {
    fetchSmart: academics.fetchScheduleSmart,
    fetchExamsSmart: academics.fetchExamsSmart,
  },
  notices: {
    fetchNews: (existing, maxItems) => news.fetchJwcNews(existing, maxItems),
    fetchArticle: (url) => news.fetchJwcArticle(url),
    // 面板与 get_news 共用的 5 分钟进程内快照（见 news.ts 的 fetchJwcNewsMemo）
    fetchNewsMemo: (maxItems) => news.fetchJwcNewsMemo(maxItems),
  },
  tools: nytdcTools,
  promptSections: nytdcPromptSections,
};
