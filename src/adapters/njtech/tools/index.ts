/**
 * NJTECH 贡献的教务工具集
 *
 * 6 个模块（14 个工具），全部依赖本适配器的抓取实现：
 * - course-selection.ts 选课查询（4）
 * - course-compare.ts   选课冲突对比（1，只读分析）
 * - schedule.ts         课表 / 校历（2）
 * - grades.ts           成绩 / 考试（2）
 * - news.ts             通知列表 / 正文 / 附件（3）
 * - calendar.ts         日历导出、课表图片（2）
 */

import { calendarTools } from "./calendar";
import { courseCompareTools } from "./course-compare";
import { courseSelectionTools } from "./course-selection";
import { gradesTools } from "./grades";
import { newsTools } from "./news";
import { scheduleTools } from "./schedule";

export const njtechTools = {
  ...courseSelectionTools,
  ...courseCompareTools,
  ...scheduleTools,
  ...gradesTools,
  ...newsTools,
  ...calendarTools,
};
