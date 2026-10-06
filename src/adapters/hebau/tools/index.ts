/**
 * HEBAU 贡献的教务工具集
 *
 * 5 个模块（9 个工具），全部依赖本适配器的抓取实现：
 * - schedule.ts 课表 / 校历（get_schedule + 跨校通用的 set_holidays）
 * - grades.ts   成绩 / 考试（get_grades / get_exams）
 * - auth.ts     CAS 二次认证（submit_auth_code）
 * - calendar.ts 日历导出 / 课表图（export_calendar / export_schedule_image，
 *   跨校通用实现，只依赖端口与本校 Smart 抓取函数，与 njtech 同构）
 * - news.ts     通知情报（get_news / read_notice / fetch_attachment）
 *
 * 河北农大教务没有选课/学籍接口，对应工具一律不提供——
 * capability 声明与工具集保持一致，缺哪项 agent 就少哪组工具。
 */

import { authTools } from "./auth";
import { calendarTools } from "./calendar";
import { gradesTools } from "./grades";
import { newsTools } from "./news";
import { scheduleTools } from "./schedule";

/** 河北农大没有真实写操作，直接全量提供 */
export const hebauTools = {
  ...scheduleTools,
  ...gradesTools,
  ...authTools,
  ...calendarTools,
  ...newsTools,
};
