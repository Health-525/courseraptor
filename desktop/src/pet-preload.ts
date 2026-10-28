/**
 * 桌宠窗口专用预加载：只给 pet.html 暴露窗口级操作（移动/菜单/持久化/退场）。
 * 与主窗口的 preload.ts 分开：主窗口页面拿不到这套接口，桌宠页面也拿不到
 * 主窗口的 openDataDir/appVersion。动画与状态机在页面自包含，不过这里。
 */

import { contextBridge, ipcRenderer } from "electron";
import type { PetMenuResult } from "./pet";

export interface PetBridge {
  /** 页面加载后取自动散步等初始状态 */
  initial(): Promise<{ autoWalk: boolean; size: number }>;
  /** 走一步（横移 dx，主进程钳制到工作区），返回钳制后的 x 与工作区左右界 */
  step(dx: number): Promise<{ x: number; left: number; right: number }>;
  /** 拖动位移（主进程钳制到工作区） */
  moveBy(dx: number, dy: number): Promise<void>;
  /** 弹原生右键菜单，回传所选动作与开关的新值（未选中返回空对象） */
  menu(cur: { autoWalk: boolean; size: number }): Promise<PetMenuResult>;
  /** 页面侧开关（自动散步）落盘 */
  persist(patch: { autoWalk?: boolean }): Promise<void>;
  /** 退场：销毁窗口并在设置里记为关闭 */
  close(): Promise<void>;
}

contextBridge.exposeInMainWorld("pet", {
  initial: (): Promise<{ autoWalk: boolean; size: number }> => ipcRenderer.invoke("pet:initial"),
  step: (dx: number): Promise<{ x: number; left: number; right: number }> =>
    ipcRenderer.invoke("pet:step", dx),
  moveBy: (dx: number, dy: number): Promise<void> => ipcRenderer.invoke("pet:move-by", dx, dy),
  menu: (cur: { autoWalk: boolean; size: number }): Promise<PetMenuResult> =>
    ipcRenderer.invoke("pet:menu", cur),
  persist: (patch: { autoWalk?: boolean }): Promise<void> => ipcRenderer.invoke("pet:persist", patch),
  close: (): Promise<void> => ipcRenderer.invoke("pet:close"),
} satisfies PetBridge);
