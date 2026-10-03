/**
 * 河北农业大学贡献的教务工具集
 *
 * 4 个模块（9 个工具），全部依赖本适配器的抓取实现：
 * - schedule.ts   课表 / 校历（2，set_holidays 复用 core 通用实现）
 * - grades.ts     成绩 / 考试（2）
 * - calendar.ts   日历导出与发布、课表图片（3）
 * - auth-code.ts  统一认证动态验证码续登（1）
 *
 * 选课、学籍、实验成绩、教务通知没有对应端点：不提供工具就是最诚实的门禁，
 * 模型看不到这些工具名，自然不会拿别校口径猜数据。
 */

import { authCodeTools } from "./auth-code";
import { calendarTools } from "./calendar";
import { gradesTools } from "./grades";
import { scheduleTools } from "./schedule";

export const hebauTools = {
  ...scheduleTools,
  ...gradesTools,
  ...calendarTools,
  ...authCodeTools,
};
