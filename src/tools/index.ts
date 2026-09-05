/**
 * CourseRaptor agent 工具集（聚合层）
 * 28 个工具按领域拆分到独立模块，本文件只负责合并与抢课开关过滤。
 *
 * 模块划分：
 * - schedule.ts        课表 / 校历（2）
 * - grades.ts          成绩 / 考试 / 实验成绩（3）
 * - student.ts         学籍 / 已选 / 重修（3）
 * - course-selection.ts 选课查询 / 盯课 / 抢课（6，含抢课循环）
 * - news.ts            通知列表 / 正文 / 附件（3，含相关性评分）
 * - files.ts           本地文件 / 表格查询 / 沙箱 JS / 附件管理（4）
 * - document.ts        文档生成 / 格式转换（2）
 * - memory.ts          长期记忆（1）
 * - weather.ts         天气（1）
 * - time.ts            时间（1，模型的唯一时钟）
 * - calendar.ts        日历导出与发布（2，本机 .ics + GitHub 订阅源）
 */

import { config } from "../config";
import { calendarTools } from "./calendar";
import { courseSelectionTools } from "./course-selection";
import { documentTools } from "./document";
import { filesTools } from "./files";
import { gradesTools } from "./grades";
import { memoryTools } from "./memory";
import { newsTools } from "./news";
import { scheduleTools } from "./schedule";
import { studentTools } from "./student";
import { timeTools } from "./time";
import { weatherTools } from "./weather";

const raptorToolsAll = {
  ...courseSelectionTools,
  ...scheduleTools,
  ...gradesTools,
  ...studentTools,
  ...newsTools,
  ...filesTools,
  ...documentTools,
  ...memoryTools,
  ...weatherTools,
  ...timeTools,
  ...calendarTools,
};

// 抢课相关工具按开关条件构建，而不是全建好再 delete——
// 之前 raptorTools 的类型内容和运行时内容不一致，TS 完全帮不上忙。
const GRAB_TOOLS = ["watch_courses", "grab_course", "grab_plan"] as const;

export const raptorTools: typeof raptorToolsAll = config.enableGrab
  ? raptorToolsAll
  : (Object.fromEntries(
      Object.entries(raptorToolsAll).filter(
        ([name]) => !(GRAB_TOOLS as readonly string[]).includes(name),
      ),
    ) as typeof raptorToolsAll);
