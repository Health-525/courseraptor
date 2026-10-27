/**
 * 定时提醒（定点闹钟）：到用户指定的时刻弹桌面通知 / 推送 QQ。
 *
 * 与待办到期提醒（todo-reminders，按「距截止 ≤ 7 天」每天扫一轮）互补：
 * 这里管明确到点的提醒——一次性（「明早 8 点叫我交材料」）、每天
 * （「22:30 提醒背单词」）、每周（「每周五 17:00 提醒还书」）。
 *
 * 触发依赖本进程存活：桌面版关闭窗口只是隐藏到托盘，仍会触发；彻底
 * 退出期间错过的不追发——超过补发窗口（15 分钟）的一次性提醒自动停用，
 * 周期提醒跳过错过的那一次等下个周期。去重靠 lastRunAt 记「上一次已
 * 触发的计划时刻」，状态落 data/alarms.json（原子写）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "./atomic-write";
import { sendDesktopNotification, sendQQPush } from "./notify";
import { dataDir } from "./paths";
import { windowsToast } from "./todo-reminders";

/** 核对间隔：30 秒，触发误差不超过半分钟 */
const TICK_MS = 30_000;
/** 补发窗口：计划时刻已过但不超过 15 分钟仍补发（睡眠唤醒 / 刚开程序） */
const CATCH_UP_MS = 15 * 60_000;
/** 启用中的提醒上限，防误建失控 */
const MAX_ACTIVE_ALARMS = 50;

export type AlarmTrigger =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekly"; weekday: number; time: string };

export interface Alarm {
  id: string;
  title: string;
  notes?: string;
  trigger: AlarmTrigger;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** 上一次已触发的计划时刻（ISO）；null=从未触发，周期提醒据此去重 */
  lastRunAt: string | null;
}

function storeFile(): string {
  return path.join(dataDir(), "alarms.json");
}

function loadAll(): Alarm[] {
  let text: string;
  try {
    text = fs.readFileSync(storeFile(), "utf8");
  } catch {
    return []; // 文件不存在：正常首启
  }
  try {
    const parsed = JSON.parse(text) as { alarms?: unknown };
    return Array.isArray(parsed.alarms) ? (parsed.alarms as Alarm[]) : [];
  } catch {
    // 损坏先留档再当空，避免下一次写入把真实提醒整个覆盖掉
    quarantineCorruptFileSync(storeFile());
    return [];
  }
}

function persistAll(alarms: Alarm[]): void {
  writeFileAtomicSync(storeFile(), JSON.stringify({ alarms }, null, 2));
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 「2026-10-28 08:00」也收（空格换 T），拿不到有效时刻返回 null */
function parseMoment(raw: string): Date | null {
  const candidate = new Date(raw.trim().replace(" ", "T"));
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

export function parseTrigger(raw: unknown): AlarmTrigger {
  if (!raw || typeof raw !== "object") throw new Error("缺少提醒时间配置");
  const input = raw as Record<string, unknown>;
  if (input.type === "once") {
    const at = parseMoment(String(input.at ?? ""));
    if (!at) throw new Error("一次性提醒需给完整时刻，如 2026-10-28T08:00:00");
    if (at.getTime() <= Date.now()) throw new Error("一次性提醒的时刻必须在未来");
    return { type: "once", at: at.toISOString() };
  }
  const time = String(input.time ?? "");
  if (!TIME_RE.test(time)) throw new Error(`时刻无效：${time}（需 HH:MM，24 小时制）`);
  if (input.type === "daily") return { type: "daily", time };
  if (input.type === "weekly") {
    const weekday = Number(input.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error("weekday 需为 0-6 的整数（0=周日，同 Date.getDay）");
    }
    return { type: "weekly", weekday, time };
  }
  throw new Error("提醒类型需为 once / daily / weekly");
}

export function listAlarms(includeDisabled = false): Alarm[] {
  const all = includeDisabled ? loadAll() : loadAll().filter((a) => a.enabled);
  const now = new Date();
  return all.sort(
    (a, b) =>
      (nextDueMoment(a.trigger, now)?.getTime() ?? Number.POSITIVE_INFINITY) -
      (nextDueMoment(b.trigger, now)?.getTime() ?? Number.POSITIVE_INFINITY),
  );
}

export function addAlarm(input: Record<string, unknown>): Alarm {
  const title = cleanText(input.title, 100);
  if (!title) throw new Error("请填写提醒内容");
  const trigger = parseTrigger(input.trigger);
  const notes = cleanText(input.notes, 500);
  const alarms = loadAll();
  if (alarms.filter((a) => a.enabled).length >= MAX_ACTIVE_ALARMS) {
    throw new Error(`启用中的提醒已达上限 ${MAX_ACTIVE_ALARMS} 条`);
  }
  const stamp = Date.now();
  const alarm: Alarm = {
    id: crypto.randomBytes(8).toString("hex"),
    title,
    notes: notes || undefined,
    trigger,
    enabled: true,
    createdAt: stamp,
    updatedAt: stamp,
    lastRunAt: null,
  };
  alarms.push(alarm);
  persistAll(alarms);
  return alarm;
}

export function updateAlarm(id: string, patch: Record<string, unknown>): Alarm | null {
  const alarms = loadAll();
  const alarm = alarms.find((a) => a.id === id);
  if (!alarm) return null;
  if (typeof patch.enabled === "boolean") alarm.enabled = patch.enabled;
  const title = cleanText(patch.title, 100);
  if (title) alarm.title = title;
  // 备注显式传入即可改（含清空）；不传不动
  if (typeof patch.notes === "string") alarm.notes = cleanText(patch.notes, 500) || undefined;
  // 改期不重置 lastRunAt：旧时刻已触发过的记录继续压住旧计划点，
  // 新时刻自然从下一个到达的计划点开始生效
  if (patch.trigger !== undefined) alarm.trigger = parseTrigger(patch.trigger);
  alarm.updatedAt = Date.now();
  persistAll(alarms);
  return alarm;
}

export function deleteAlarm(id: string): boolean {
  const alarms = loadAll();
  const next = alarms.filter((a) => a.id !== id);
  if (next.length === alarms.length) return false;
  persistAll(next);
  return true;
}

/** 本地日历语义取某天的 HH:MM（不做毫秒加减，DST 安全） */
function momentOn(day: Date, hh: number, mm: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0);
}

function timeParts(time: string): [number, number] {
  const [hh, mm] = time.split(":");
  return [Number(hh), Number(mm)];
}

/**
 * now 之前（含）最近一次计划时刻：判断「该不该已经响了」。
 * 一次性且尚未到点返回 null；周期类永远有值（可能是上周期的）。
 */
export function lastDueMoment(trigger: AlarmTrigger, now: Date): Date | null {
  if (trigger.type === "once") {
    const at = new Date(trigger.at);
    return at.getTime() <= now.getTime() ? at : null;
  }
  const [hh, mm] = timeParts(trigger.time);
  if (trigger.type === "daily") {
    const today = momentOn(now, hh, mm);
    if (today.getTime() <= now.getTime()) return today;
    return momentOn(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1), hh, mm);
  }
  // weekly：先落在本周期的目标星期，再保证不越过 now
  const base = momentOn(now, hh, mm);
  const back = (base.getDay() - trigger.weekday + 7) % 7;
  let due = momentOn(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back), hh, mm);
  if (due.getTime() > now.getTime()) {
    due = momentOn(new Date(due.getFullYear(), due.getMonth(), due.getDate() - 7), hh, mm);
  }
  return due;
}

/** 下一次将触发的计划时刻（list 展示用）；一次性已过期返回 null */
export function nextDueMoment(trigger: AlarmTrigger, now: Date): Date | null {
  if (trigger.type === "once") {
    const at = new Date(trigger.at);
    return at.getTime() > now.getTime() ? at : null;
  }
  const [hh, mm] = timeParts(trigger.time);
  if (trigger.type === "daily") {
    const today = momentOn(now, hh, mm);
    if (today.getTime() > now.getTime()) return today;
    return momentOn(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), hh, mm);
  }
  const ahead = (trigger.weekday - now.getDay() + 7) % 7;
  let due = momentOn(new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead), hh, mm);
  if (due.getTime() <= now.getTime()) {
    due = momentOn(new Date(due.getFullYear(), due.getMonth(), due.getDate() + 7), hh, mm);
  }
  return due;
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function describeTrigger(trigger: AlarmTrigger): string {
  if (trigger.type === "once") return "一次性";
  if (trigger.type === "daily") return `每天 ${trigger.time}`;
  return `每${WEEKDAY_LABELS[trigger.weekday]} ${trigger.time}`;
}

export interface FiredAlarm {
  alarm: Alarm;
  /** 本次对应的计划时刻（ISO），可能略早于 now（补发） */
  dueAt: string;
}

async function defaultNotify(fired: FiredAlarm[]): Promise<void> {
  for (const { alarm } of fired) {
    const title = "CourseRaptor 定时提醒";
    const body = alarm.notes ? `「${alarm.title}」— ${alarm.notes}` : `「${alarm.title}」`;
    // 桌面宿主注册了端口就走原生通知，否则回退 PowerShell toast
    if (!sendDesktopNotification(title, body)) windowsToast(title, body);
  }
  const lines = fired
    .map(({ alarm }) => `• ${alarm.title}（${describeTrigger(alarm.trigger)}）`)
    .join("\n");
  await sendQQPush(`⏰ 定时提醒\n${lines}`).catch(() => {});
}

export interface AlarmCheckDeps {
  /** 测试注入时钟 */
  now?: Date;
  /** 测试注入通知出口；默认桌面通知 + QQ 推送 */
  notify?: (fired: FiredAlarm[]) => void | Promise<void>;
}

/**
 * 核对一轮：返回本轮真正触发出去的提醒。
 * 同步返回、通知异步发（fire-and-forget），先落去重标记再发——发送失败
 * 也不下一轮重复轰炸。错过超过补发窗口的：一次性自动停用，周期跳过等下轮。
 */
export function runAlarmCheck(deps: AlarmCheckDeps = {}): FiredAlarm[] {
  const now = deps.now ?? new Date();
  const alarms = loadAll();
  const fired: FiredAlarm[] = [];
  let dirty = false;

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    const due = lastDueMoment(alarm.trigger, now);
    if (!due) continue; // 一次性未到点
    const lastRunMs = alarm.lastRunAt ? new Date(alarm.lastRunAt).getTime() : null;
    if (lastRunMs !== null && due.getTime() <= lastRunMs) continue; // 本计划点已触发
    if (now.getTime() - due.getTime() > CATCH_UP_MS) {
      // 错过太久，补发已无意义；一次性顺带停用，别在列表里装活
      if (alarm.trigger.type === "once") {
        alarm.enabled = false;
        alarm.updatedAt = Date.now();
        dirty = true;
      }
      continue;
    }
    fired.push({ alarm, dueAt: due.toISOString() });
    alarm.lastRunAt = due.toISOString();
    alarm.updatedAt = Date.now();
    if (alarm.trigger.type === "once") alarm.enabled = false; // 响过即完成
    dirty = true;
  }

  if (fired.length) {
    const notify = deps.notify ?? defaultNotify;
    Promise.resolve(notify(fired)).catch(() => {});
  }
  if (dirty) {
    try {
      persistAll(alarms);
    } catch {
      // 状态写不进去只影响去重，下一轮会重试
    }
  }
  return fired;
}

let schedulerStarted = false;

/**
 * 定时任务入口：启动即查 + 每 30 秒核对。
 * RAPTOR_NO_ALARMS=1 整体关闭；boot 与独立 QQ 桥都会调，重复调用只跑一份。
 */
export function startAlarmScheduler(): void {
  if (process.env.RAPTOR_NO_ALARMS === "1") return;
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = () => {
    try {
      runAlarmCheck();
    } catch {
      // 提醒是附加能力，任何异常都不许影响主流程
    }
  };
  tick();
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
}
