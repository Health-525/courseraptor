/**
 * 待办到期提醒：定时扫描本地待办（web-workspace.json），进入「距到期 ≤ 7 天」
 * 窗口的未完成待办每天提醒一次——Windows 桌面通知 + QQ 主动推送（桥在线时）。
 *
 * 去重状态落在 data/todo-reminder-state.json（todoId -> 已提醒的本地日期），
 * 同一天只提醒一次；每天 8 点前不弹，避免半夜打扰。逾期未完成的不弹
 * （课表页 /today 已有红色 ⚠ 展示），窗口外、已完成的都不提醒。
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "./atomic-write";
import { PROJECT_ROOT } from "./config";
import { pushQQText } from "./qq/push";
import { listReminders, type Reminder } from "./workspace-data";

const DAY_MS = 86_400_000;
/** 提前提醒窗口：距到期 ≤ 7 天 */
const WINDOW_MS = 7 * DAY_MS;
/** 复查间隔：每小时一次（去重按天，多查不重弹） */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** 当天这个点之前不提醒（本地时区），避免半夜弹通知 */
const REMIND_AFTER_HOUR = 8;
/** 单轮最多提醒条数，防止一口气刷屏 */
const MAX_NOTIFY_PER_CHECK = 5;

function statePath(): string {
  return path.join(
    process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data"),
    "todo-reminder-state.json",
  );
}

/** todoId -> 已提醒过的本地日期（YYYY-MM-DD） */
interface ReminderState {
  reminded: Record<string, string>;
}

function readState(): ReminderState {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Partial<ReminderState>;
    return {
      reminded: value.reminded && typeof value.reminded === "object" ? value.reminded : {},
    };
  } catch {
    return { reminded: {} };
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 窗口内未完成待办（0 < 距到期 ≤ 7 天），按到期升序 */
export function dueWithinWindow(now: Date): Reminder[] {
  return listReminders()
    .filter((r) => {
      if (r.done) return false;
      const due = Date.parse(r.dueAt);
      return Number.isFinite(due) && due > now.getTime() && due - now.getTime() <= WINDOW_MS;
    })
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

/** 本地星期表（JS getDay 索引，周日=0），不引 jwgl 模块 */
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 提醒文案：今天到期给钟点，未来给日期+剩余天数 */
function dueText(r: Reminder, now: Date): string {
  const due = new Date(r.dueAt);
  const hm = `${pad(due.getHours())}:${pad(due.getMinutes())}`;
  const dayDiff = Math.round(
    (new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      DAY_MS,
  );
  if (dayDiff === 0) return `今天 ${hm} 到期`;
  return `${due.getMonth() + 1}月${due.getDate()}日 ${WEEKDAY_NAMES[due.getDay()]} ${hm} 到期（还有 ${dayDiff} 天）`;
}

// PowerShell 注册的 AppId：借 Windows PowerShell 的 AUMID 弹 toast
const TOAST_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0";

/**
 * Windows 桌面通知：PowerShell 调系统 toast（零依赖，沿用 updater 调系统命令的先例）。
 * 标题/正文走子进程环境变量、PowerShell 侧再做 XML 转义——待办文本是用户输入，
 * 绝不能拼进命令代码层。失败静默：通知丢了不该影响主流程。
 */
export function windowsToast(title: string, body: string): void {
  if (process.platform !== "win32") return;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null",
    "$x=New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$x.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>'+[System.Security.SecurityElement]::Escape($env:RAPTOR_TOAST_TITLE)+'</text><text>'+[System.Security.SecurityElement]::Escape($env:RAPTOR_TOAST_BODY)+'</text></binding></visual></toast>')",
    "$t=New-Object Windows.UI.Notifications.ToastNotification $x",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}').Show($t)`,
  ].join("; ");
  execFile(
    "powershell",
    ["-NoProfile", "-Command", script],
    { timeout: 8000, env: { ...process.env, RAPTOR_TOAST_TITLE: title, RAPTOR_TOAST_BODY: body } },
    () => {},
  );
}

/** 默认通知出口：每条一个桌面 toast，再往 QQ 推一条合并清单 */
async function defaultNotify(items: Reminder[], now: Date): Promise<void> {
  for (const r of items) {
    windowsToast("CourseRaptor 待办提醒", `「${r.title}」${dueText(r, now)}`);
  }
  const lines = items.map((r) => `• ${r.title} — ${dueText(r, now)}`).join("\n");
  await pushQQText(`⏰ 待办提醒（未来 7 天内到期）\n${lines}`).catch(() => {});
}

export interface ReminderCheckDeps {
  /** 测试注入时钟 */
  now?: Date;
  /** 测试注入通知出口；默认桌面通知 + QQ 推送 */
  notify?: (items: Reminder[], now: Date) => void | Promise<void>;
}

/**
 * 扫一轮：返回本轮真正提醒出去的待办。
 * 同步返回、通知异步发（fire-and-forget），提醒失败也先把去重标记落盘，
 * 避免下一轮对同一批待办反复重试轰炸。
 */
export function runReminderCheck(deps: ReminderCheckDeps = {}): Reminder[] {
  const now = deps.now ?? new Date();
  if (now.getHours() < REMIND_AFTER_HOUR) return [];

  const all = listReminders();
  const state = readState();
  let dirty = false;
  // 完成或删除的待办，去重记录一并清掉
  const alive = new Set(all.filter((r) => !r.done).map((r) => r.id));
  for (const id of Object.keys(state.reminded)) {
    if (!alive.has(id)) {
      delete state.reminded[id];
      dirty = true;
    }
  }

  const today = dayKey(now);
  const fresh = dueWithinWindow(now)
    .filter((r) => state.reminded[r.id] !== today)
    .slice(0, MAX_NOTIFY_PER_CHECK);
  if (fresh.length) {
    const notify = deps.notify ?? defaultNotify;
    Promise.resolve(notify(fresh, now)).catch(() => {});
    for (const r of fresh) {
      state.reminded[r.id] = today;
      dirty = true;
    }
  }

  if (dirty) {
    try {
      writeFileAtomicSync(statePath(), JSON.stringify(state, null, 2));
    } catch {
      // 状态写不进去只影响去重，下一轮会重试
    }
  }
  return fresh;
}

/**
 * 定时任务入口：启动即查 + 每小时复查。
 * RAPTOR_NO_TODO_REMINDERS=1 整体关闭；interval unref，不拖住进程退出。
 */
export function startTodoReminderScheduler(): void {
  if (process.env.RAPTOR_NO_TODO_REMINDERS === "1") return;
  const check = () => {
    try {
      runReminderCheck();
    } catch {
      // 提醒是附加能力，任何异常都不许影响主流程
    }
  };
  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref?.();
}
