/**
 * HEBAU（河北农业大学）学校适配器
 *
 * 把 CAS 统一认证（cas.hebau.edu.cn）与正方 URP 学生端（urp.hebau.edu.cn:1009）
 * 的能力组装成 core/school.ts 定义的 SchoolAdapter：
 * - 认证：CAS 账密（AES-CBC 前端加密）+ 动态码二次认证（MFA 子系统自包含在本目录）
 * - 数据：URP XHR .do 接口，学期用 XNXQDM 字符串（换算关在 urp.ts）
 * - 能力：课表 / 成绩 / 考试。选课、学籍、实验成绩、教务通知没有对应端点，
 *   一律不声明 capability，如实走「暂不支持」，不借用其他学校的接口猜数据。
 *
 * 维护者：社区（原适配 jiangshu，新架构移植见 git log）
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
  capabilities: ["schedule", "exams", "grades"],
  terms: {
    label: academics.termLabel,
    candidates: (now?: Date) => academics.candidateXnxqList(now),
    parseSemesterString: academics.parseSemesterString,
    weekOf: termDates.currentWeekOf,
    week1MondayOf: termDates.resolveWeek1Monday,
    recordedTerms: termDates.loadStore,
    expandWeeks: academics.expandWeeks,
    periodTimeRange: academics.periodTimeRange,
    periodTime: (period: number) => academics.HEBAU_PERIOD_TIMES_TABLE[String(period)],
    periodTimes: () => academics.HEBAU_PERIOD_TIMES_TABLE,
    weekdayName: academics.weekdayName,
  },
  auth: {
    login: async (username, password) => {
      // 二次认证不走这里：auth.login 只验证凭证有效性，动态码续登由
      // submit_auth_code 工具直接调 completeSecondFactor（会话状态在工具层闭环）
      await loginHebau(username, password);
    },
    getCookie: (force?: boolean) => session.getCookie(force),
  },
  schedule: {
    fetchSmart: academics.fetchScheduleSmart,
    fetchExamsSmart: academics.fetchExamsSmart,
  },
  tools: hebauTools,
  promptSections: hebauPromptSections,
};
