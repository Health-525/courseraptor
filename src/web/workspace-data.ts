/**
 * 网页侧本地工作区数据：上传文件与截止日期待办。
 *
 * 这两类数据都只服务当前电脑，统一放在 RAPTOR_DATA_DIR 下。所有写入使用
 * 原子替换，上传文件名只保留安全扩展名，删除操作只允许落在自己的目录内。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../atomic-write";
import { PROJECT_ROOT } from "../config";

function dataDir(): string {
  return process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data");
}

function statePath(): string {
  return path.join(dataDir(), "web-workspace.json");
}

function uploadsDir(): string {
  return path.join(dataDir(), "web-uploads");
}

export interface WebUpload {
  id: string;
  name: string;
  type: string;
  size: number;
  storedPath: string;
  createdAt: number;
}

export interface Reminder {
  id: string;
  title: string;
  dueAt: string;
  source?: string;
  sourceUrl?: string;
  notes?: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

interface WorkspaceState {
  uploads: WebUpload[];
  reminders: Reminder[];
}

const emptyState = (): WorkspaceState => ({ uploads: [], reminders: [] });

function readState(): WorkspaceState {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Partial<WorkspaceState>;
    return {
      uploads: Array.isArray(value.uploads) ? value.uploads : [],
      reminders: Array.isArray(value.reminders) ? value.reminders : [],
    };
  } catch {
    return emptyState();
  }
}

function writeState(state: WorkspaceState): void {
  writeFileAtomicSync(statePath(), JSON.stringify(state, null, 2));
}

const ALLOWED_EXT = new Set([".pdf", ".docx", ".xlsx", ".xls", ".csv", ".txt", ".md", ".pptx"]);
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function saveUpload(name: string, type: string, buf: Buffer): WebUpload {
  const safeName = path
    .basename(name)
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 120);
  const ext = path.extname(safeName).toLowerCase();
  if (!safeName || !ALLOWED_EXT.has(ext)) {
    throw new Error("仅支持 PDF、Word、Excel、PPT、CSV、TXT 和 Markdown 文件");
  }
  if (!buf.length) throw new Error("文件为空");
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error("单个文件不能超过 25 MB");
  fs.mkdirSync(uploadsDir(), { recursive: true });
  const id = crypto.randomBytes(9).toString("hex");
  const storedPath = path.join(uploadsDir(), `${id}${ext}`);
  fs.writeFileSync(storedPath, buf);
  const upload: WebUpload = {
    id,
    name: safeName,
    type: type.slice(0, 100),
    size: buf.length,
    storedPath,
    createdAt: Date.now(),
  };
  const state = readState();
  state.uploads.unshift(upload);
  state.uploads = state.uploads.slice(0, 100);
  writeState(state);
  return upload;
}

export function getUploads(ids: string[]): WebUpload[] {
  const wanted = new Set(ids.filter((id) => /^[a-f0-9]{18}$/.test(id)));
  return readState().uploads.filter((u) => wanted.has(u.id) && fs.existsSync(u.storedPath));
}

export function listUploads(): WebUpload[] {
  return readState().uploads.filter((u) => fs.existsSync(u.storedPath));
}

function safeUnlink(target: string): boolean {
  const root = path.resolve(uploadsDir());
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;
  try {
    fs.rmSync(resolved, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function deleteUpload(id: string): boolean {
  const state = readState();
  const found = state.uploads.find((u) => u.id === id);
  if (!found) return false;
  safeUnlink(found.storedPath);
  state.uploads = state.uploads.filter((u) => u.id !== id);
  writeState(state);
  return true;
}

export function clearUploads(): number {
  const state = readState();
  let removed = 0;
  for (const upload of state.uploads) if (safeUnlink(upload.storedPath)) removed++;
  state.uploads = [];
  writeState(state);
  return removed;
}

export function listReminders(): Reminder[] {
  return readState().reminders.sort(
    (a, b) => Number(a.done) - Number(b.done) || a.dueAt.localeCompare(b.dueAt),
  );
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function addReminder(input: Record<string, unknown>): Reminder {
  const title = cleanText(input.title, 100);
  const dueAt = cleanText(input.dueAt, 40);
  if (!title) throw new Error("请填写待办内容");
  if (!dueAt || Number.isNaN(Date.parse(dueAt))) throw new Error("请选择有效的截止时间");
  const now = Date.now();
  const reminder: Reminder = {
    id: crypto.randomBytes(8).toString("hex"),
    title,
    dueAt: new Date(dueAt).toISOString(),
    source: cleanText(input.source, 160) || undefined,
    sourceUrl: cleanText(input.sourceUrl, 500) || undefined,
    notes: cleanText(input.notes, 500) || undefined,
    done: false,
    createdAt: now,
    updatedAt: now,
  };
  const state = readState();
  state.reminders.push(reminder);
  writeState(state);
  return reminder;
}

export function updateReminder(id: string, patch: Record<string, unknown>): Reminder | null {
  const state = readState();
  const reminder = state.reminders.find((r) => r.id === id);
  if (!reminder) return null;
  if (typeof patch.done === "boolean") reminder.done = patch.done;
  const title = cleanText(patch.title, 100);
  if (title) reminder.title = title;
  const dueAt = cleanText(patch.dueAt, 40);
  if (dueAt) {
    if (Number.isNaN(Date.parse(dueAt))) throw new Error("截止时间无效");
    reminder.dueAt = new Date(dueAt).toISOString();
  }
  reminder.updatedAt = Date.now();
  writeState(state);
  return reminder;
}

export function deleteReminder(id: string): boolean {
  const state = readState();
  const next = state.reminders.filter((r) => r.id !== id);
  if (next.length === state.reminders.length) return false;
  state.reminders = next;
  writeState(state);
  return true;
}

export function clearReminders(): number {
  const state = readState();
  const count = state.reminders.length;
  state.reminders = [];
  writeState(state);
  return count;
}

export function workspaceStats(): {
  uploads: { count: number; bytes: number };
  reminders: { total: number; open: number };
} {
  const state = readState();
  const uploads = state.uploads.filter((u) => fs.existsSync(u.storedPath));
  return {
    uploads: { count: uploads.length, bytes: uploads.reduce((n, u) => n + u.size, 0) },
    reminders: {
      total: state.reminders.length,
      open: state.reminders.filter((r) => !r.done).length,
    },
  };
}

export function reminderIcs(reminder: Reminder): string {
  const stamp = (value: string | number) =>
    new Date(value)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  const escapeIcs = (value: string) =>
    value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  const start = new Date(reminder.dueAt);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CourseRaptor//待办提醒//ZH-CN",
    "BEGIN:VEVENT",
    `UID:${reminder.id}@courseraptor.local`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(start.toISOString())}`,
    `DTEND:${stamp(end.toISOString())}`,
    `SUMMARY:${escapeIcs(reminder.title)}`,
    reminder.notes ? `DESCRIPTION:${escapeIcs(reminder.notes)}` : "",
    reminder.sourceUrl ? `URL:${reminder.sourceUrl}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ]
    .filter(Boolean)
    .join("\r\n");
}
