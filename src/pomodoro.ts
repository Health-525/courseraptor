/**
 * 番茄钟存储与计时逻辑
 *
 * 模型经 manage_pomodoro 工具在这里建计时：开始时间与结束时间都落盘
 * （data/pomodoro.json，原子写），网页对话凭 endsAt 在本地每秒渲染
 * 倒计时卡片——计时本身不依赖 SSE 长连接，关页面只是看不到卡片，
 * 记录还在，回来用 status/list 照样能查到。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "./atomic-write";
import { dataDir } from "./paths";

export type PomodoroStatus = "running" | "done" | "cancelled";

export interface Pomodoro {
  id: string;
  label: string;
  focusMinutes: number;
  totalSec: number;
  startsAt: number;
  endsAt: number;
  status: PomodoroStatus;
  createdAt: number;
  updatedAt: number;
}

/** 对外视图：工具结果与 SSE 事件都用它，前端只凭这几个字段画卡片 */
export interface PomodoroView {
  id: string;
  label: string;
  focusMinutes: number;
  totalSec: number;
  startsAt: number;
  endsAt: number;
  status: PomodoroStatus;
  remainingSec: number;
}

export const POMODORO_MIN_MINUTES = 1;
export const POMODORO_MAX_MINUTES = 180;
const HISTORY_LIMIT = 50;

function storePath(): string {
  return path.join(dataDir(), "pomodoro.json");
}

function readStore(): Pomodoro[] {
  try {
    const value = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (p): p is Pomodoro =>
        !!p &&
        typeof p === "object" &&
        typeof (p as Pomodoro).id === "string" &&
        typeof (p as Pomodoro).endsAt === "number",
    );
  } catch {
    return [];
  }
}

function writeStore(items: Pomodoro[]): void {
  writeFileAtomicSync(storePath(), JSON.stringify(items.slice(0, HISTORY_LIMIT), null, 2));
}

/** 到期的 running 顺手置 done：查询即结算，不靠后台轮询 */
function refresh(item: Pomodoro, now = Date.now()): Pomodoro {
  if (item.status === "running" && now >= item.endsAt) {
    item.status = "done";
    item.updatedAt = now;
  }
  return item;
}

function refreshAll(now = Date.now()): Pomodoro[] {
  const items = readStore();
  let changed = false;
  for (const item of items) {
    if (item.status === "running" && now >= item.endsAt) {
      refresh(item, now);
      changed = true;
    }
  }
  if (changed) writeStore(items);
  return items;
}

export function toView(item: Pomodoro, now = Date.now()): PomodoroView {
  const live =
    item.status === "running" && now >= item.endsAt ? { ...item, status: "done" as const } : item;
  return {
    id: live.id,
    label: live.label,
    focusMinutes: live.focusMinutes,
    totalSec: live.totalSec,
    startsAt: live.startsAt,
    endsAt: live.endsAt,
    status: live.status,
    remainingSec:
      live.status === "running" ? Math.max(0, Math.ceil((live.endsAt - now) / 1000)) : 0,
  };
}

function cleanLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 60) : "";
}

export function startPomodoro(minutes: number, label?: unknown): Pomodoro {
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes)) {
    throw new Error("时长必须是整数分钟（如 25）");
  }
  if (minutes < POMODORO_MIN_MINUTES || minutes > POMODORO_MAX_MINUTES) {
    throw new Error(`时长须在 ${POMODORO_MIN_MINUTES}-${POMODORO_MAX_MINUTES} 分钟之间`);
  }
  const now = Date.now();
  const items = refreshAll(now);
  const item: Pomodoro = {
    id: crypto.randomBytes(8).toString("hex"),
    label: cleanLabel(label) || "专注",
    focusMinutes: minutes,
    totalSec: minutes * 60,
    startsAt: now,
    endsAt: now + minutes * 60_000,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  items.unshift(item);
  writeStore(items);
  return item;
}

export function getPomodoro(id: string): Pomodoro | null {
  const items = refreshAll();
  return items.find((p) => p.id === id) ?? null;
}

/** 最近一个还在走的计时（没有则为 null，顺带把到期的结算掉） */
export function activePomodoro(): Pomodoro | null {
  const items = refreshAll();
  return items.find((p) => p.status === "running") ?? null;
}

export function listPomodoros(limit = 10): Pomodoro[] {
  return refreshAll().slice(0, Math.max(1, Math.min(limit, HISTORY_LIMIT)));
}

export function cancelPomodoro(id?: string): Pomodoro | null {
  const items = refreshAll();
  const target = id ? items.find((p) => p.id === id) : items.find((p) => p.status === "running");
  if (!target) return null;
  if (target.status !== "running") return target;
  target.status = "cancelled";
  target.updatedAt = Date.now();
  writeStore(items);
  return target;
}
