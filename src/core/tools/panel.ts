/**
 * 功能大厅联动工具：open_panel
 *
 * 用户在对话里说「打开课表」「看看考试」「展开待办」这类明确要看某个
 * 面板的话时调用。工具本身不取数——面板数据由前端各自拉取；这里只是
 * 一个信号：chat-web 把参数里的面板 id 附到 SSE tool 事件上，网页端
 * 收到后自动从右侧推出对应面板（chat-app.js 的 ev.panel 推出路径）。
 * open_settings 仍专职「配置凭证」语义，两者并行不冲突。
 *
 * 面板白名单与网页端 HALL_CARDS 一一对应；隐藏卡 import / account 有
 * 专属入口语境（手动课表模式 / 托管版），不开放对话直达。pomodoro 虽
 * 已下架宫格，面板本身仍可用，照常放行。
 */

import { tool } from "ai";
import { z } from "zod";

/** 可通过对话打开的面板 id（网页端 HALL_CARDS 的子集） */
export const PANEL_IDS = [
  "today",
  "schedule",
  "exams",
  "grades",
  "news",
  "todos",
  "knowledge",
  "pomodoro",
  "prompts",
  "usage",
  "settings",
] as const;

const PANEL_TITLES: Record<(typeof PANEL_IDS)[number], string> = {
  today: "今日日程",
  schedule: "课表",
  exams: "考试",
  grades: "成绩",
  news: "教务通知",
  todos: "待办",
  knowledge: "知识库",
  pomodoro: "番茄钟",
  prompts: "提示词模板",
  usage: "用量统计",
  settings: "设置",
};

export const panelTools = {
  /** 打开网页端功能大厅的指定面板 */
  open_panel: tool({
    description:
      "用户明确想打开某个功能面板时调用，说法不限——「打开课表」「看看考试」「展开待办」" +
      "「我要看成绩」「切到知识库」「看下今天安排」「看看用量」都算。panel 取值：today 今日日程 / " +
      "schedule 课表 / exams 考试 / grades 成绩 / news 教务通知 / todos 待办 / knowledge 知识库 / " +
      "pomodoro 番茄钟 / prompts 提示词模板 / usage 用量统计（每日 token 热力图）/ settings 设置。" +
      "网页端会自动从右侧推出对应面板，" +
      "调完一句确认即可，不复述面板内容。注意：用户只是问数据（「这周有什么课」）时不要调本工具，" +
      "直接用查询工具在对话里回答；终端（TUI）/QQ 等没有网页面板的环境同样别调，直接给内容。",
    inputSchema: z.object({ panel: z.enum(PANEL_IDS).describe("要打开的面板 id") }),
    execute: async ({ panel }) =>
      `已请网页端推出「${PANEL_TITLES[panel]}」面板，简单确认一句即可，不必复述面板内容。` +
      "若当前是终端或 QQ 等没有网页面板的环境，请改用对应查询工具直接在对话里给出内容，" +
      "并提示可在浏览器打开网页版（npm start）查看面板。",
  }),
};
