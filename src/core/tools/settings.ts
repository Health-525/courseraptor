/**
 * 设置联动工具：open_settings
 *
 * 用户想配置教务账号 / API Key / QQ 机器人，或说「打开设置」时调用。
 * 工具本身不做任何配置——凭证只允许用户在网页设置面板里填写（不经过模型）；
 * 这里只是一个信号：网页端收到 tool 事件后自动从右侧推出设置面板
 * （见 chat-page 的 TOOL_PANEL 映射）。终端里没有面板，返回文案里
 * 已提示引导用户走网页版。
 */

import { tool } from "ai";
import { z } from "zod";

export const settingsTools = {
  /** 打开网页端设置面板 */
  open_settings: tool({
    description:
      "用户想配置或修改设置（教务账号学号密码、DeepSeek API Key、QQ 机器人凭证、本地数据管理），" +
      "或说「打开设置」「我要配置账号」时调用。网页端会自动把设置面板从右侧推出来，" +
      "用户在面板里填写保存即可，凭证不经过对话。终端（TUI）环境没有面板，" +
      "此时按返回文案提示用户改用网页版（npm start）操作。",
    inputSchema: z.object({}),
    execute: async () =>
      "已请网页端弹出设置面板，请用户在面板内填写并保存；凭证不会进入对话内容。" +
      "若当前是终端环境（没有网页面板弹出），请提示：运行 npm start 后在浏览器打开的页面里，" +
      "点侧栏「功能大厅 → 设置」操作。",
  }),
};
