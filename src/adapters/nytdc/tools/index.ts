/**
 * NYTDC 贡献的教务工具集
 *
 * 5 个模块（13 个工具）：
 * - schedule.ts 课表 / 校历（get_schedule + 跨校通用的 set_holidays）
 * - grades.ts   成绩 / 考试（get_grades / get_exams）
 * - news.ts     教务处通知（get_news / read_notice / fetch_attachment）
 * - calendar.ts 日历导出 / 课表图片（手机使用的主路径）
 * - xgstu.ts    学工系统（奥蓝）信息汇总 / 资料下载（xgstu_messages / xgstu_files /
 *   xgstu_download / xgstu_login），需图片验证码登录，且一律只读
 *
 * 暂**没有**选课查询：正方选课接口（自主选课 zzxkyzb）尚未在通达实机验证。
 * capability 声明与工具集保持一致——没验证过的不提供，避免给出看似能用的坏数据。
 */

import { calendarTools } from "./calendar";
import { gradesTools } from "./grades";
import { newsTools } from "./news";
import { scheduleTools } from "./schedule";
import { xgstuTools } from "./xgstu";

export const nytdcTools = {
  ...scheduleTools,
  ...gradesTools,
  ...newsTools,
  ...calendarTools,
  ...xgstuTools,
};
