/**
 * NJTECH（南京工业大学）学校适配器
 *
 * 把正方教务系统（jwgl.njtech.edu.cn）与教务处官网（jwc.njtech.edu.cn）
 * 的全部能力组装成 core/school.ts 定义的 SchoolAdapter：
 * - 抓取与登录实现散在同级各模块（auth/academics/grades/portal/news/xk…）
 * - 学校规则（节次作息、绩点算法、校历种子、学期编码、通识六类）随模块走
 * - 工具集在 ./tools（抢课开关在装配时过滤）
 * - 系统提示词段在 ./prompt
 */

import type { SchoolAdapter } from "../../core/school";
import * as academics from "./academics";
import { loginJwgl } from "./auth";
import * as news from "./news";
import { njtechPromptSections } from "./prompt";
import * as session from "./session";
import * as termDates from "./term-dates";
import { njtechTools } from "./tools";

export const njtechSchool: SchoolAdapter = {
  info: {
    id: "njtech",
    name: "南京工业大学",
    shortName: "NJTECH",
    city: "南京",
    timezone: "Asia/Shanghai",
  },
  capabilities: [
    "schedule",
    "exams",
    "grades",
    "student",
    "enrolledCourses",
    "retakeCourses",
    "labGrades",
    "courseSelection",
    "notices",
    "calendarExport",
  ],
  terms: {
    label: academics.termLabel,
    candidates: (now?: Date) => academics.candidateXnxqList(now),
    parseSemesterString: academics.parseSemesterString,
    weekOf: termDates.currentWeekOf,
    week1MondayOf: termDates.resolveWeek1Monday,
    recordedTerms: termDates.loadStore,
    expandWeeks: academics.expandWeeks,
    periodTimeRange: academics.periodTimeRange,
    periodTime: (period: number) => academics.NJTECH_PERIOD_TIMES[String(period)],
    periodTimes: () => academics.NJTECH_PERIOD_TIMES,
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
  },
  tools: njtechTools,
  promptSections: njtechPromptSections,
};
