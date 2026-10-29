/**
 * core 工具集（学校无关部分）
 *
 * 与教务相关的工具（课表/成绩/学籍/选课/通知/日历）由学校适配器贡献
 * （src/adapters/.../tools），agent.ts 在装配时把两边合并。
 * 这里只聚合通用模块。PPT 工具（ppt.ts）保留源码但不注册——产品侧暂下线。
 */

import { aiNewsTools } from "./ai-news";
import { documentTools } from "./document";
import { examEditTools } from "./exams";
import { filesTools } from "./files";
import { gradeEditTools } from "./grades";
import { knowledgeTools } from "./knowledge";
import { memoryTools } from "./memory";
import { panelTools } from "./panel";
import { pomodoroTools } from "./pomodoro";
import { promptTools } from "./prompts";
import { reminderTools } from "./reminders";
import { scheduleEditTools } from "./schedule-edit";
import { scheduleImageTools } from "./schedule-image";
import { settingsTools } from "./settings";
import { skillTools } from "./skill-library";
import { timeTools } from "./time";
import { weatherTools } from "./weather";
import { webSearchTools } from "./web-search";

export const coreTools = {
  ...aiNewsTools,
  ...filesTools,
  ...documentTools,
  ...examEditTools,
  ...gradeEditTools,
  ...memoryTools,
  ...reminderTools,
  ...knowledgeTools,
  ...pomodoroTools,
  ...promptTools,
  ...skillTools,
  ...scheduleImageTools,
  ...scheduleEditTools,
  ...settingsTools,
  ...panelTools,
  ...weatherTools,
  ...webSearchTools,
  ...timeTools,
};
