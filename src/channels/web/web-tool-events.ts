/** SSE 工具事件的加工件：fullStream 的宽松事件视图、文本/摘要/预览提纯，
 *  以及工具结果里的下载文件、番茄钟、open_panel 与 NEED_SETUP 面板信号提取。 */

import { config } from "../../core/config";
import type { PomodoroView } from "../../core/pomodoro";
import { school } from "../../core/school";
import { PANEL_IDS } from "../../core/tools/panel";
import { insideGenerated } from "./web-files";

// ── fullStream 事件（同 inline.ts 的宽松视图，字段按需取用）──────

export interface StreamEvent {
  type: string;
  text?: string;
  delta?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

export const deltaOf = (p: StreamEvent): string => p.text ?? p.delta ?? "";

export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 工具结果的一行摘要（同 inline.ts summarizeResult 的简化版） */
export function summarizeResult(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return oneLine(output, 100);
  if (Array.isArray(output)) return `${output.length} 项`;
  if (typeof output !== "object") return oneLine(String(output), 60);
  const o = output as Record<string, unknown>;
  if (typeof o.error === "string") return `错误：${oneLine(o.error, 80)}`;
  const bits: string[] = [];
  for (const k of ["summary", "term", "gpa", "total"]) {
    if (o[k] !== undefined && o[k] !== null) bits.push(oneLine(String(o[k]), 48));
  }
  return bits.join(" · ");
}

/** 工具参数/结果的展开态预览：给独立工具卡片的 <pre> 用，封顶防刷屏 */
export function previewJson(v: unknown, max = 1200): string {
  if (v == null) return "";
  let s: string;
  try {
    s = typeof v === "string" ? v : (JSON.stringify(v, null, 1) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}\n…（已截断）` : s;
}

/**
 * 从工具结果里提取可下载的成品（网页端下载按钮的数据源）。
 * 兼容两种返回形状：文档工具的顶层 {filename, path} 与
 * export_calendar 的 {file: {filename, filePath, bytes}}；
 * 路径不在 generated 目录内的一律不透出。
 */
/** 工具因凭证未配置而失败的口径：命中时 SSE 事件带 panel=settings，网页端自动推出设置面板 */
export const NEED_SETUP_RE = /尚未配置|请先配置/;

/** open_panel 参数里的面板 id：白名单内才透传（schema 已拦异常值，这里再滤一次，
 *  防止畸形输入直达前端 hash/抽屉）；带上后网页端自动推出对应面板 */
export function openPanelIdOf(name: string | undefined, input: unknown): string | undefined {
  if (name !== "open_panel") return undefined;
  const id = (input as { panel?: unknown } | null | undefined)?.panel;
  if (typeof id !== "string" || !(PANEL_IDS as readonly string[]).includes(id)) return undefined;
  /* 教务通知门禁：与设置页 newsReady 同口径——本校没接入（custom）或
   * 教务账号未保存时，对话里点名要看通知也不推面板（宫格本就没有这张卡） */
  if (id === "news" && !school().notices) return undefined;
  if (id === "news" && !(config.jwglUsername && config.jwglPassword)) return undefined;
  return id;
}

export function filesOfToolOutput(output: unknown): Array<{ name: string; size: number }> {
  if (typeof output !== "object" || output == null || Array.isArray(output)) return [];
  const o = output as Record<string, unknown>;
  const out: Array<{ name: string; size: number }> = [];
  const push = (name: unknown, p: unknown, size: unknown) => {
    if (typeof name !== "string" || !name) return;
    if (typeof p !== "string" || !insideGenerated(p)) return;
    out.push({ name, size: typeof size === "number" ? size : 0 });
  };
  push(o.filename, o.path, o.bytes);
  if (typeof o.file === "object" && o.file != null) {
    const f = o.file as Record<string, unknown>;
    push(f.filename, f.filePath, f.bytes);
  }
  return out;
}

/**
 * 从工具结果里提取新建的番茄钟（前端渲染实时倒计时卡片的数据源）。
 * 只有 start 带 fresh 标记的才透出——status/cancel 的同名 payload
 * 只给模型组话用，不画卡，避免查一次时间就多一张卡。
 */
export function pomodoroOfToolOutput(output: unknown): PomodoroView | null {
  if (typeof output !== "object" || output == null || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  if (o.fresh !== true) return null;
  const p = o.pomodoro;
  if (typeof p !== "object" || p == null || Array.isArray(p)) return null;
  const v = p as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.endsAt !== "number" || typeof v.totalSec !== "number") {
    return null;
  }
  return v as unknown as PomodoroView;
}
