/**
 * core 工具集（学校无关部分）
 *
 * 与教务相关的工具（课表/成绩/学籍/选课/通知/日历）由学校适配器贡献
 * （src/adapters/njtech/tools），agent.ts 在装配时把两边合并。
 * 这里只聚合 9 个通用模块：
 * - files.ts      本地文件 / 表格查询 / 沙箱 JS / 附件管理（4）
 * - document.ts   文档生成 / 格式转换（2）
 * - memory.ts     长期记忆（1）
 * - reminders.ts  待办（1）
 * - knowledge.ts  知识库（1）
 * - pomodoro.ts   番茄钟（1）
 * - settings.ts   设置（1）
 * - weather.ts    天气（1，默认城市来自学校适配器）
 * - time.ts       时间（1，模型的唯一时钟，学期规则来自学校适配器）
 */

import { documentTools } from "./document";
import { filesTools } from "./files";
import { knowledgeTools } from "./knowledge";
import { memoryTools } from "./memory";
import { pomodoroTools } from "./pomodoro";
import { reminderTools } from "./reminders";
import { settingsTools } from "./settings";
import { timeTools } from "./time";
import { weatherTools } from "./weather";

export const coreTools = {
  ...filesTools,
  ...documentTools,
  ...memoryTools,
  ...reminderTools,
  ...knowledgeTools,
  ...pomodoroTools,
  ...settingsTools,
  ...weatherTools,
  ...timeTools,
};
