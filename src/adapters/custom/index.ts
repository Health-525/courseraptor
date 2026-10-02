/**
 * 自定义学校（其他学校）适配器 — 手动课表模式
 *
 * 没有真实教务系统可接：课表来自用户在设置页导入的本地缓存，
 * 成绩/考试/通知/选课等在线能力一概不声明（agent 相应少一组工具）。
 * 学期规则与开学日期见 ./academics，工具见 ./tools，提示词见 ./prompt。
 */

import type { FetchResult } from "../../core/fetch-result";
import type { ExamResult, ScheduleResult } from "../../core/model";
import { loadScheduleCache } from "../../core/schedule-cache";
import type { SchoolAdapter } from "../../core/school";
import * as academics from "./academics";
import { customPromptSections } from "./prompt";
import { customScheduleTools } from "./tools/schedule";

/** 自定义学校没有教务登录：任何登录调用都指回设置页 */
const noJwgl = async () => {
  throw new Error(
    "自定义学校模式没有接入教务系统：课表用 设置 → 学校 → 导入课表；需要教务在线功能请换回已适配学校",
  );
};

export const customSchool: SchoolAdapter = {
  info: {
    id: "custom",
    name: "其他学校（手动课表）",
    shortName: "自定义",
    city: "",
    timezone: "Asia/Shanghai",
    manual: true,
  },
  capabilities: ["schedule", "calendarExport"],
  terms: {
    label: academics.termLabel,
    candidates: (now?: Date) => academics.candidateTerms(now),
    parseSemesterString: academics.parseSemesterString,
    weekOf: academics.currentWeekOf,
    week1MondayOf: academics.resolveWeek1Monday,
    recordedTerms: () =>
      Object.fromEntries(
        Object.entries(academics.customTermStarts()).map(([term, week1Monday]) => [
          term,
          { week1Monday, source: "recorded", evidence: "导入课表时记录的开学日期" },
        ]),
      ),
    expandWeeks: academics.expandWeeks,
    periodTimeRange: academics.periodTimeRange,
    periodTime: academics.periodTime,
    periodTimes: () => academics.DEFAULT_PERIOD_TIMES,
    weekdayName: academics.weekdayName,
  },
  auth: {
    login: noJwgl,
    getCookie: noJwgl,
  },
  schedule: {
    // 手动课表的「抓取」就是读缓存：欢迎面板与今日页与 njtech 同一条路
    fetchSmart: async (): Promise<FetchResult<ScheduleResult>> => {
      const cached = loadScheduleCache();
      return cached
        ? { ok: true, data: cached.schedule }
        : { ok: false, error: "尚未导入课表（设置 → 学校 → 导入课表）" };
    },
    fetchExamsSmart: async (): Promise<FetchResult<ExamResult>> => ({
      ok: false,
      error: "自定义学校暂不支持考试安排查询",
    }),
  },
  tools: customScheduleTools,
  promptSections: customPromptSections,
};
