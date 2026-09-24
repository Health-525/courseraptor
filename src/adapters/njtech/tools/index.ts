/**
 * NJTECH 贡献的教务工具集
 *
 * 7 个模块（17 个工具），全部依赖本适配器的抓取实现：
 * - course-selection.ts 选课查询 / 盯课 / 抢课 / 退课（8，含抢课循环）
 * - course-compare.ts   选课冲突对比（1，只读分析）
 * - schedule.ts         课表 / 校历（2）
 * - grades.ts           成绩 / 考试 / 实验成绩（3）
 * - student.ts          学籍 / 已选 / 重修（3）
 * - news.ts             通知列表 / 正文 / 附件（3）
 * - calendar.ts         日历导出与发布（2）
 *
 * 抢课相关工具按 config.enableGrab 条件构建，而不是全建好再 delete——
 * 类型内容和运行时内容保持一致，TS 才帮得上忙。
 */

import { config } from "../../../core/config";
import { calendarTools } from "./calendar";
import { courseCompareTools } from "./course-compare";
import { courseSelectionTools } from "./course-selection";
import { gradesTools } from "./grades";
import { newsTools } from "./news";
import { scheduleTools } from "./schedule";
import { studentTools } from "./student";

const njtechToolsAll = {
  ...courseSelectionTools,
  ...courseCompareTools,
  ...scheduleTools,
  ...gradesTools,
  ...studentTools,
  ...newsTools,
  ...calendarTools,
};

const GRAB_TOOLS = ["watch_courses", "grab_course", "grab_plan", "drop_course"] as const;

export const njtechTools: typeof njtechToolsAll = config.enableGrab
  ? njtechToolsAll
  : (Object.fromEntries(
      Object.entries(njtechToolsAll).filter(
        ([name]) => !(GRAB_TOOLS as readonly string[]).includes(name),
      ),
    ) as typeof njtechToolsAll);
