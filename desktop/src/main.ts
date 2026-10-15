/**
 * CourseRaptor 桌面版主进程（Electron 薄壳）。
 *
 * 职责边界（见 docs/superpowers/plans/2026-10-15-desktop-version.md）：
 *   - 只当壳：单实例锁 / 窗口 / 托盘 / 原生通知 / 自动更新 / watchdog
 *   - 后端仍是现成的 Node host（子进程），窗口 loadURL 指向它
 *   - 数据目录重定向到用户目录，升级不丢数据
 * Electron 与渲染层隔离：contextIsolation 开、nodeIntegration 关、sandbox 开，
 * 页面只通过 preload 暴露的极小 API 与本进程通信。
 */

import path from "node:path";
import { BrowserWindow, Notification, app, dialog, ipcMain, shell, type Tray } from "electron";
import { type BackendHandle, startBackend } from "./backend";
import { createTray } from "./tray";

const isDev = !app.isPackaged;
/** 数据落到用户目录：升级（替换安装目录）不丢数据（方案 §3.2） */
const dataDir = path.join(app.getPath("userData"), "data");
process.env.RAPTOR_DATA_DIR = dataDir;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let backend: BackendHandle | null = null;
let quitting = false;
let restarts = 0;

const MAX_RESTARTS = 5;

function appPath(): string {
  return isDev ? path.resolve(__dirname, "..", "..") : path.join(process.resourcesPath, "app");
}

function nodeBin(): string {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  // dev 用系统 node（依赖 PATH，仓库里有 tsx）；prod 用打包内置的 Node 24
  return isDev ? exe : path.join(process.resourcesPath, "runtime", exe);
}

function iconPath(): string {
  // prod 从 extraResources 注入的 icon.png 读；dev 直接指向仓库里的项目 logo
  return isDev
    ? path.resolve(__dirname, "..", "..", "docs", "courseraptor-logo.png")
    : path.join(process.resourcesPath, "icon.png");
}

// ── 单实例：第二个实例把已有窗口唤到前台，不再开新进程 ──
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(onReady);
}

function onReady(): void {
  createWindow();
  startOnce();
  tray = createTray(iconPath(), {
    onShow: showWindow,
    onOpenDataDir: () => void shell.openPath(dataDir),
    onCheckUpdate: () => void checkForUpdates(),
    onQuit: quitApp,
  });
  setupAutoUpdate();

  ipcMain.handle("raptor:open-data-dir", () => shell.openPath(dataDir));
  ipcMain.handle("raptor:app-version", () => app.getVersion());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "CourseRaptor",
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 先等首帧就绪再显示，避免白屏闪烁
  win.once("ready-to-show", () => win?.show());
  // 关闭窗口＝隐藏到托盘（后端继续跑；退出走托盘菜单 / 关机）
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  // 页面里的外链一律交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
}

function startOnce(): void {
  backend = startBackend({
    appPath: appPath(),
    nodeBin: nodeBin(),
    env: { ...process.env, RAPTOR_DATA_DIR: dataDir },
    onMessage: (m) => {
      if (m.type === "ready") {
        restarts = 0; // 握手成功即清零，避免长期运行累计触发上限
        win?.loadURL(m.url);
      } else if (m.type === "notify") {
        new Notification({ title: m.title, body: m.body, icon: iconPath() }).show();
      } else if (m.type === "log") {
        const level = m.level ?? "info";
        const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        sink(`[backend] ${m.text}`);
      }
    },
    onExit: ({ expected }) => {
      if (expected || quitting) return;
      restarts += 1;
      if (restarts > MAX_RESTARTS) {
        dialog.showErrorBox(
          "CourseRaptor 后端反复退出",
          "后端进程连续多次异常退出，已停止自动重启。\n请从托盘菜单「退出」后重新打开，或查看数据目录下的日志排查。",
        );
        return;
      }
      // 指数退避：1s → 2s → 4s → … 上限 30s
      const delay = Math.min(30_000, 1000 * 2 ** restarts);
      setTimeout(() => {
        if (!quitting) startOnce();
      }, delay);
    },
  });
}

function showWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp(): void {
  quitting = true;
  backend?.stop();
  app.quit();
}

app.on("before-quit", () => {
  quitting = true;
  backend?.stop();
});

app.on("window-all-closed", () => {
  // 关窗＝隐藏到托盘，不退出；真正退出走 quitApp / 系统关机
});

// ── 自动更新（electron-updater + GitHub Release；见方案 §3.4）──

interface AutoUpdaterLike {
  autoDownload: boolean;
  on(event: string, cb: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  checkForUpdatesAndNotify(): Promise<unknown>;
  quitAndInstall(): void;
}

function loadAutoUpdater(): AutoUpdaterLike | null {
  if (isDev) return null; // dev 无打包产物，跳过
  try {
    // 运行期解析：生产依赖里带 electron-updater，dev 未装时静默跳过
    // biome-ignore lint/style/noCommonJs: 条件加载可选依赖
    const mod = require("electron-updater") as { autoUpdater: AutoUpdaterLike };
    return mod.autoUpdater;
  } catch {
    return null;
  }
}

function setupAutoUpdate(): void {
  const autoUpdater = loadAutoUpdater();
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on("error", () => {
    /* 更新失败静默：不该打扰主流程 */
  });
  autoUpdater.on("update-downloaded", () => {
    const choice = messageBox({
      type: "info",
      buttons: ["立即重启更新", "稍后"],
      defaultId: 0,
      cancelId: 1,
      message: "新版本已下载",
      detail: "重启后应用将更新到最新版本。",
    });
    if (choice === 0) {
      quitting = true;
      backend?.stop();
      autoUpdater.quitAndInstall();
    }
  });
  void autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

async function checkForUpdates(): Promise<void> {
  const autoUpdater = loadAutoUpdater();
  if (!autoUpdater) {
    messageBox({
      type: "info",
      message: "开发模式",
      detail: "开发模式下不检查更新。",
    });
    return;
  }
  try {
    const r = (await autoUpdater.checkForUpdates()) as { updateInfo?: { version?: string } } | null;
    const version = r?.updateInfo?.version;
    if (version && version !== app.getVersion()) {
      messageBox({
        type: "info",
        message: "发现新版本",
        detail: `正在后台下载 v${version}，完成后会提示重启。`,
      });
    } else {
      messageBox({
        type: "info",
        message: "已是最新版本",
        detail: `当前版本 v${app.getVersion()}。`,
      });
    }
  } catch (e) {
    dialog.showErrorBox("检查更新失败", e instanceof Error ? e.message : String(e));
  }
}

/** showMessageBoxSync 的重载不接受 undefined 窗口：有窗口时挂窗口，否则独立弹 */
function messageBox(options: Electron.MessageBoxSyncOptions): number {
  return win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
}
