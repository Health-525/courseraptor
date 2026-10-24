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

import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, Notification, app, dialog, ipcMain, shell, type Tray } from "electron";
import { type BackendHandle, startBackend } from "./backend";
import { ensureBackendExtracted, rescueLegacyCredentials } from "./payload";
import { createTray } from "./tray";

const isDev = !app.isPackaged;
/**
 * 数据目录解析，优先级：
 *   1) 环境变量 RAPTOR_DATA_DIR（显式指定）
 *   2) userData/data-dir.txt 第一行（绝对路径）——让桌面端与命令行共用同一个 data/
 *      （命令行默认就是仓库根的 data/，写入该路径即三端数据统一）
 *   3) userData/data（默认）：升级（替换安装目录）不丢数据（方案 §3.2）
 * 凭证 credentials.enc 跟着 dataDir 走，同样共用。
 */
function resolveDataDir(): string {
  const fromEnv = process.env.RAPTOR_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  try {
    const text = fs.readFileSync(path.join(app.getPath("userData"), "data-dir.txt"), "utf8");
    const line = (text.split(/\r?\n/)[0] ?? "").trim();
    if (line && path.isAbsolute(line)) return path.resolve(line);
  } catch {
    /* 没配置：走默认 */
  }
  return path.join(app.getPath("userData"), "data");
}
const dataDir = resolveDataDir();
process.env.RAPTOR_DATA_DIR = dataDir;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let backend: BackendHandle | null = null;
// 后端就绪后再给用户看窗口：首启要解压百兆 payload，先给个加载态窗口顶着
let backendStarting = false;
let quitting = false;
let restarts = 0;

const MAX_RESTARTS = 5;

/**
 * 首启加载态：安装后首次启动要解压百兆 payload（一两分钟），窗口在后端 ready
 * 前先顶着这个纯 CSS 本地页，避免用户对着空白窗口干等。ready 后 loadURL 替换。
 */
const LOADING_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>CourseRaptor</title>` +
      `<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;font-family:system-ui,"Microsoft YaHei",sans-serif}` +
      `.wrap{text-align:center}.spin{width:44px;height:44px;margin:0 auto 20px;border:4px solid #334155;border-top-color:#38bdf8;border-radius:50%;animation:rot 0.9s linear infinite}` +
      `@keyframes rot{to{transform:rotate(360deg)}}h1{font-size:20px;margin:0 0 8px}p{font-size:13px;color:#94a3b8;margin:0}</style></head>` +
      `<body><div class="wrap"><div class="spin"></div><h1>CourseRaptor 启动中…</h1><p>首次启动需解压内置运行环境，请稍候一两分钟</p></div></body></html>`,
  );

function iconPath(): string {
  // prod 从 extraResources 注入的 icon.png（README logo）读；dev 直接指向仓库里同一张
  return isDev
    ? path.resolve(__dirname, "..", "..", "docs", "courseraptor-logo.png")
    : path.join(process.resourcesPath, "icon.png");
}

/** dev = 仓库根 + 系统 node；prod = 解压到用户目录的 payload + 内置 Node 24 */
async function resolveBackend(): Promise<{ appPath: string; nodeBin: string }> {
  if (isDev) {
    return {
      appPath: path.resolve(__dirname, "..", ".."),
      nodeBin: process.platform === "win32" ? "node.exe" : "node",
    };
  }
  // 清理旧版本后端目录之前，先把旧版留在其中的 credentials.enc 抢救进数据目录
  rescueLegacyCredentials(dataDir);
  return ensureBackendExtracted(path.join(process.resourcesPath, "payload.zip"));
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
  void startBackendAsync();
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
  // 先顶加载态（首启解压慢）；后端 ready 后 loadURL 换成真实页面
  void win.loadURL(LOADING_PAGE);
}

function startBackendAsync(): void {
  // 同一时间只起一个后端：watchdog 重启和首启只会有一个在跑
  if (backendStarting) return;
  backendStarting = true;
  win?.webContents.executeJavaScript(
    `document.title="CourseRaptor（后端启动中…）"`,
  ).catch(() => {});
  resolveBackend()
    .then(({ appPath, nodeBin }) => startOnce(appPath, nodeBin))
    .catch((e: unknown) => {
      backendStarting = false;
      dialog.showErrorBox(
        "CourseRaptor 后端启动失败",
        e instanceof Error ? e.message : String(e),
      );
    });
}

function startOnce(appPath: string, nodeBin: string): void {
  backendStarting = false;
  backend = startBackend({
    appPath,
    nodeBin,
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
      // 指数退避：1s → 2s → 4s → … 上限 30s（寻址已解析，直接传回 startOnce）
      const delay = Math.min(30_000, 1000 * 2 ** restarts);
      setTimeout(() => {
        if (!quitting) startBackendAsync();
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
    // 运行期解析：electron-updater 是 external，electron-builder 按生产依赖
    // 自动拷进 resources/app/node_modules，安装版 require 直接命中
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
