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
});
