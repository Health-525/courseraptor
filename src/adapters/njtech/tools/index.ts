/**
 * NJTECH 贡献的教务工具集
 *
 * 7 个模块（15 个工具），全部依赖本适配器的抓取实现：
 * - course-selection.ts 选课查询 / 退课（5）
 * - course-compare.ts   选课冲突对比（1，只读分析）
 * - schedule.ts         课表 / 校历（2）
 * - grades.ts           成绩 / 考试 / 实验成绩（3）
 * - student.ts          学籍 / 已选 / 重修（3）
 * - news.ts             通知列表 / 正文 / 附件（3）
 * - calendar.ts         日历导出与发布、课表图片（3）
 */

import { calendarTools } from "./calendar";
import { courseCompareTools } from "./course-compare";
import { courseSelectionTools } from "./course-selection";
import { gradesTools } from "./grades";
import { newsTools } from "./news";
import { scheduleTools } from "./schedule";
import { studentTools } from "./student";

export const njtechTools = {
  ...courseSelectionTools,
  ...courseCompareTools,
  ...scheduleTools,
  ...gradesTools,
  ...studentTools,
  ...newsTools,
  ...calendarTools,
};
