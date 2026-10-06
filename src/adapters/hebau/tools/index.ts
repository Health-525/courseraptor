/**
 * HEBAU 贡献的教务工具集
 *
 * 3 个模块（4 个工具），全部依赖本适配器的抓取实现：
 * - schedule.ts 课表 / 校历（get_schedule + 跨校通用的 set_holidays）
 * - grades.ts   成绩 / 考试（get_grades / get_exams）
 * - auth.ts     CAS 二次认证（submit_auth_code）
 *
 * 河北农大教务没有选课/学籍/通知接口，对应工具一律不提供——
 * capability 声明与工具集保持一致，缺哪项 agent 就少哪组工具。
 */

import { authTools } from "./auth";
import { gradesTools } from "./grades";
import { scheduleTools } from "./schedule";

const hebauToolsAll = {
  ...scheduleTools,
  ...gradesTools,
  ...authTools,
};

/** 河北农大没有真实写操作（无选课/退课），直接全量提供 */
export const hebauTools = hebauToolsAll;
