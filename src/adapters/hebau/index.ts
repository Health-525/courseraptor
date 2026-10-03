/**
 * 河北农业大学学校适配器
 *
 * 认证：CAS 统一认证（cas.hebau.edu.cn，密码 AES-CBC 前端加密，可能触发动态码二次认证）
 * 数据：正方 URP 学生端（urp.hebau.edu.cn:1009，XHR .do 接口，学期用 XNXQDM 字符串）
 * 能力：课表 / 成绩（5.0 满绩制）/ 考试 / 日历导出。选课、学籍、实验成绩、教务通知
 *      没有对应端点：不声明 capability、不提供工具，如实报「本校未接入」，
 *      不拿南工大的接口猜数据。
 *
 * 抓取与登录实现散在同级各模块（cas/urp/schedule/grades/exams…），学校规则
 * （节次作息、绩点算法、校历种子、学期编码）随模块走，工具集在 ./tools。
 */

import type { SchoolAdapter } from "../../core/school";
import * as academics from "./academics";
import { loginHebau } from "./cas";
import { hebauPromptSections } from "./prompt";
import * as session from "./session";
import * as termDates from "./term-dates";
import { hebauTools } from "./tools";

export const hebauSchool: SchoolAdapter = {
  info: {
    id: "hebau",
    name: "河北农业大学",
    shortName: "HEBAU",
    city: "保定",
    timezone: "Asia/Shanghai",
  },
  capabilities: ["schedule", "exams", "grades", "calendarExport"],
  terms: {
    label: academics.hebauTermLabel,
    candidates: (now?: Date) => academics.hebauCandidateTerms(now),
    parseSemesterString: academics.parseSemesterString,
    weekOf: academics.currentWeekOf,
    week1MondayOf: academics.resolveWeek1Monday,
    recordedTerms: () => termDates.loadStore(),
    expandWeeks: academics.expandWeeks,
    periodTimeRange: academics.periodTimeRange,
    periodTime: (period: number) => academics.HEBAU_PERIOD_TIMES[String(period)],
    periodTimes: () => academics.HEBAU_PERIOD_TIMES,
    weekdayName: (weekday: number) => academics.WEEKDAY_NAMES[weekday] ?? `周${weekday}`,
  },
  auth: {
    login: async (username, password) => {
      await loginHebau({ username, password });
    },
    getCookie: (force?: boolean) => session.getCookie(force),
    submitSecondFactor: (input) => session.submitSecondFactor(input),
  },
  schedule: {
    fetchSmart: academics.fetchScheduleSmart,
    fetchExamsSmart: academics.fetchExamsSmart,
  },
  tools: hebauTools,
  promptSections: hebauPromptSections,
};
