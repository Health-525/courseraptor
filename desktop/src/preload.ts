/**
 * 预加载脚本：在隔离的渲染世界里暴露极小的桥接 API。
 * contextIsolation + sandbox 下页面拿不到 Node，只有这里显式暴露的方法。
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("raptor", {
  /** 打开数据目录（系统文件管理器） */
  openDataDir: (): Promise<string> => ipcRenderer.invoke("raptor:open-data-dir"),
  /** 应用版本号 */
  appVersion: (): Promise<string> => ipcRenderer.invoke("raptor:app-version"),
  /** 桌面宠物设置；设置弹窗「桌面」栏目用 */
  petState: (): Promise<{ enabled: boolean; size: number; autoWalk: boolean; topmost: boolean }> =>
    ipcRenderer.invoke("raptor:pet-state"),
  /** 开关桌面宠物，返回开关后的最新设置 */
  setPetEnabled: (
    enabled: boolean,
  ): Promise<{ enabled: boolean; size: number; autoWalk: boolean; topmost: boolean }> =>
    ipcRenderer.invoke("raptor:pet-set-enabled", enabled),
});
