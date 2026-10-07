/**
 * 手动课表模式 — 唯一内置学校形态
 *
 * 不接入任何学校教务系统：课表等数据全部来自用户自行导入的本地缓存
 * （设置页「导入课表」，可粘贴文本或上传文件由 AI 解析），
 * 成绩/考试/通知/选课等在线能力一概不声明（agent 相应少一组工具）。
 * 学期规则与开学日期见 ./academics，工具见 ./tools，提示词见 ./prompt。
 */

import type { FetchResult } from "../../core/fetch-result";
import type { ExamResult, ScheduleResult } from "../../core/model";
import { loadScheduleCache } from "../../core/schedule-cache";
import type { SchoolAdapter } from "../../core/school";
import * as academics from "./academics";
import { customPromptSections } from "./prompt";
import { calendarTools } from "./tools/calendar";
import { customScheduleTools } from "./tools/schedule";

export const customSchool: SchoolAdapter = {
  info: {
    id: "custom",
    name: "手动课表模式",
    shortName: "手动课表",
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
  schedule: {
    // 手动课表的「抓取」就是读缓存：欢迎面板与今日页与通用路径同一条路
    fetchSmart: async (): Promise<FetchResult<ScheduleResult>> => {
      const cached = loadScheduleCache();
      return cached
        ? { ok: true, data: cached.schedule }
        : { ok: false, error: "尚未导入课表（设置 → 导入课表）" };
    },
    fetchExamsSmart: async (): Promise<FetchResult<ExamResult>> => ({
      ok: false,
      error: "考试安排需要学校教务数据，手动课表模式暂不支持",
    }),
  },
  tools: { ...customScheduleTools, ...calendarTools },
  promptSections: customPromptSections,
};
