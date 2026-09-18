/**
 * 番茄钟工具：manage_pomodoro
 *
 * 用户在对话里说「开始 25 分钟番茄钟」「专注半小时」时调 start；
 * 计时落盘后网页对话会另外渲染实时倒计时卡片（见 chat-web 的
 * pomodoro 事件与 chat-page 的卡片），工具本身只返回计时记录。
 */

import { tool } from "ai";
import { z } from "zod";

import {
  activePomodoro,
  cancelPomodoro,
  getPomodoro,
  listPomodoros,
  POMODORO_MAX_MINUTES,
  POMODORO_MIN_MINUTES,
  startPomodoro,
  toView,
} from "../pomodoro";

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const pad = (x: number) => (x < 10 ? `0${x}` : `${x}`);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const pomodoroTools = {
  /** 番茄钟维护 */
  manage_pomodoro: tool({
    description:
      "番茄钟计时（本地持久，网页对话里会显示实时倒计时卡片）。用户说「开始/来一个/X分钟番茄钟」「专注X分钟/半小时」时调 start（minutes 取用户说的分钟数，没说默认 25；label 是专注内容，如「写论文」）；问「番茄钟还有多久」用 status（默认查最近一个在走的）；不想做了用 cancel；问历史用 list。开始后用一句话告诉用户已开始（几分钟、到几点结束），网页卡片会自动倒计时，无需复述技术细节。",
    inputSchema: z.object({
      action: z
        .enum(["start", "status", "cancel", "list"])
        .describe("start=开始计时，status=查剩余，cancel=取消，list=查最近记录"),
      minutes: z
        .number()
        .optional()
        .describe(
          `专注时长（整数分钟，${POMODORO_MIN_MINUTES}-${POMODORO_MAX_MINUTES}；不填默认 25）`,
        ),
      label: z.string().optional().describe("专注内容（如「写论文」「背单词」），不填为「专注」"),
      id: z.string().optional().describe("目标计时 id（status/cancel 不填默认指最近一个在走的）"),
      limit: z.number().optional().describe("list 条数（默认 10）"),
    }),
    execute: async ({ action, minutes, label, id, limit }) => {
      if (action === "start") {
        const value = minutes ?? 25;
        try {
          const item = startPomodoro(value, label);
          const view = toView(item);
          return {
            ok: true,
            summary: `🍅 番茄钟已开始：${item.focusMinutes} 分钟「${item.label}」（${fmtClock(item.startsAt)} → ${fmtClock(item.endsAt)} 结束）`,
            pomodoro: view,
            // fresh 只在新建时带：网页端凭它渲染实时倒计时卡片，
            // status/cancel 的同名 payload 只给模型组话，不画卡
            fresh: true,
          };
        } catch (e) {
          return { error: e instanceof Error ? e.message : "开始番茄钟失败" };
        }
      }
      if (action === "status") {
        const target = id ? getPomodoro(id) : activePomodoro();
        if (!target) return { summary: "当前没有在走的番茄钟", pomodoro: null };
        const view = toView(target);
        if (view.status !== "running") {
          return {
            summary: view.status === "done" ? "这个番茄钟已经结束了" : "这个番茄钟已取消",
            pomodoro: view,
          };
        }
        const mm = Math.floor(view.remainingSec / 60);
        const ss = String(view.remainingSec % 60).padStart(2, "0");
        return {
          summary: `🍅「${view.label}」还剩 ${mm}:${ss}（${fmtClock(view.endsAt)} 结束）`,
          pomodoro: view,
        };
      }
      if (action === "cancel") {
        const target = cancelPomodoro(id);
        if (!target) return { error: "当前没有在走的番茄钟" };
        return {
          ok: true,
          summary:
            target.status === "cancelled"
              ? `已取消「${target.label}」番茄钟`
              : `「${target.label}」已经结束，无需取消`,
          pomodoro: toView(target),
        };
      }
      const items = listPomodoros(limit ?? 10).map((p) => toView(p));
      return {
        summary: items.length ? `最近 ${items.length} 个番茄钟` : "还没有番茄钟记录",
        pomodoros: items,
      };
    },
  }),
};
