/**
 * 桌面版后端 ↔ Electron 主进程的 stdout 行协议。
 *
 * 后端（local/host/headless.ts）把消息写成前缀 + 单行 JSON 到 stdout；
 * 主进程（desktop/）按前缀逐行解析。本模块是**纯数据约定**，不 import
 * electron，便于主仓测试直接复用。
 *
 * 协议详见 docs/superpowers/plans/2026-10-15-desktop-version.md §5。
 */

export type IpcMessage =
  | { type: "ready"; url: string }
  | { type: "notify"; title: string; body: string }
  | { type: "log"; level?: "info" | "warn" | "error"; text: string };

export const IPC_PREFIX = "@raptor-ipc ";

/** 解析一行 stdout：非本协议前缀或非法 JSON 返回 null（调用方按日志处理） */
export function parseIpcLine(line: string): IpcMessage | null {
  if (!line.startsWith(IPC_PREFIX)) return null;
  try {
    const obj = JSON.parse(line.slice(IPC_PREFIX.length)) as unknown;
    if (obj && typeof obj === "object" && typeof (obj as { type?: unknown }).type === "string") {
      return obj as IpcMessage;
    }
  } catch {
    /* 非法 JSON：按日志处理 */
  }
  return null;
}

/** 编码成一行（后端写入用；不含行尾换行） */
export function encodeIpc(msg: IpcMessage): string {
  return IPC_PREFIX + JSON.stringify(msg);
}
