/**
 * 桌面宠物（戴眼镜的小恐龙）：透明置顶小窗口 + 本地 pet.html 自绘动画。
 *
 * 边界（与桌面壳「只当壳」的分工一致）：
 *   - 动画、状态机、自动散步的决策都在 pet.html 页面里自包含；
 *   - 本模块只管窗口生命周期与窗口级操作：创建/销毁、走动与拖动的钳制、
 *     右键原生菜单（动作选择回传页面，置顶/大小/退出就地生效）、设置持久化；
 *   - 开关状态持久化在 userData/pet.json，启动时按需恢复；
 *   - 应用整体退出时不改设置：下次启动桌宠是否出现由最后一次开关决定。
 * 设置开关在 Web 设置弹窗的「桌面」栏目（仅桌面壳注入 window.raptor 桥时显示）。
 */

import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, Menu, app, ipcMain, screen } from "electron";

export interface PetSettings {
  enabled: boolean;
  /** 窗口宽度（高度 = 宽度 + 70 的状态区），迷你/小/中/大 = 140/170/210/260 */
  size: number;
  autoWalk: boolean;
  topmost: boolean;
}

/** pet:menu 的回传：action 给页面切状态，其余字段主进程已就地生效 */
export interface PetMenuResult {
  action?: "idle" | "walkLeft" | "walkRight" | "wave" | "glasses" | "happy" | "sleep";
  autoWalk?: boolean;
  topmost?: boolean;
  size?: number;
  quit?: boolean;
}

const SIZES = [
  { width: 140, label: "迷你" },
  { width: 170, label: "小" },
  { width: 210, label: "中" },
  { width: 260, label: "大" },
];
/** 状态胶囊与气泡的高度预算：窗口高 = 角色区 + 这 70px */
const HEIGHT_EXTRA = 70;
const DEFAULTS: PetSettings = { enabled: false, size: 170, autoWalk: true, topmost: true };

let settings: PetSettings = { ...DEFAULTS };
let win: BrowserWindow | null = null;

function settingsFile(): string {
  return path.join(app.getPath("userData"), "pet.json");
}

function loadSettings(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Partial<PetSettings>;
    settings = {
      enabled: raw.enabled === true,
      size: SIZES.some((s) => s.width === raw.size) ? (raw.size as number) : DEFAULTS.size,
      autoWalk: raw.autoWalk !== false,
      topmost: raw.topmost !== false,
    };
  } catch {
    settings = { ...DEFAULTS };
  }
}

function saveSettings(): void {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
  } catch {
    /* 存不进就下次走默认，不打扰主流程 */
  }
}

function applyTopmost(): void {
  // screen-saver 层级：压过普通置顶窗口，跟 WPF 原型的 Topmost 观感一致
  win?.setAlwaysOnTop(settings.topmost, "screen-saver");
}

function createPetWindow(): void {
  if (win) {
    win.show();
    return;
  }
  const height = settings.size + HEIGHT_EXTRA;
  const work = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: settings.size,
    height,
    // 首现位置：主屏工作区右下角，留 80/18 边距（与原型一致）
    x: work.x + work.width - settings.size - 80,
    y: work.y + work.height - height - 18,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: "CourseRaptor 桌面宠物",
    webPreferences: {
      preload: path.join(__dirname, "pet-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyTopmost();
  win.once("ready-to-show", () => win?.show());
  void win.loadFile(path.join(__dirname, "pet.html"));
  win.on("closed", () => {
    win = null;
  });
}

/** byUser=true（菜单退出/Esc/设置关开关）才落盘 enabled=false；应用整体退出不动设置 */
function closePetWindow(byUser: boolean): void {
  if (byUser) {
    settings.enabled = false;
    saveSettings();
  }
  const w = win;
  win = null;
  w?.destroy();
}

function resizePet(width: number): void {
  if (!win) return;
  const bounds = win.getBounds();
  const work = screen.getPrimaryDisplay().workArea;
  const height = width + HEIGHT_EXTRA;
  const x = Math.max(work.x, Math.min(work.x + work.width - width, bounds.x));
  win.setBounds({
    x,
    y: bounds.y + bounds.height - height,
    width,
    height,
  });
  settings.size = width;
  saveSettings();
}

type MenuItemConstructor = Electron.MenuItemConstructorOptions;

function popupPetMenu(cur: { autoWalk: boolean; topmost: boolean; size: number }): Promise<PetMenuResult> {
  return new Promise((resolve) => {
    if (!win) {
      resolve({});
      return;
    }
    // 菜单是事件回调，用一次性 settle 兜住：选中即回传，未选中（点击别处关闭）回空
    let settled = false;
    const done = (r: PetMenuResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const action = (label: string, id: NonNullable<PetMenuResult["action"]>): MenuItemConstructor => ({
      label,
      click: () => done({ action: id }),
    });
    const menu = Menu.buildFromTemplate([
      { label: "小恐龙 · CourseRaptor 桌宠", enabled: false },
      { type: "separator" },
      action("待机", "idle"),
      action("向左走", "walkLeft"),
      action("向右走", "walkRight"),
      action("打招呼", "wave"),
      action("推眼镜", "glasses"),
      action("开心蹦跳", "happy"),
      action("睡觉 / 唤醒", "sleep"),
      { type: "separator" },
      {
        label: "自动散步",
        type: "checkbox",
        checked: cur.autoWalk,
        click: (item) => {
          settings.autoWalk = item.checked;
          saveSettings();
          done({ autoWalk: item.checked });
        },
      },
      {
        label: "置顶显示",
        type: "checkbox",
        checked: cur.topmost,
        click: (item) => {
          settings.topmost = item.checked;
          saveSettings();
          applyTopmost();
          done({ topmost: item.checked });
        },
      },
      {
        label: "调整大小",
        submenu: SIZES.map((s) => ({
          label: s.label,
          click: () => {
            resizePet(s.width);
            done({ size: s.width });
          },
        })),
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          done({ quit: true });
          closePetWindow(true);
        },
      },
    ]);
    menu.popup({ window: win, callback: () => done({}) });
  });
}

function fromPetWindow(e: Electron.IpcMainInvokeEvent): boolean {
  return win != null && e.sender === win.webContents;
}

function clampX(x: number, width: number): number {
  const work = screen.getPrimaryDisplay().workArea;
  return Math.max(work.x, Math.min(work.x + work.width - width, x));
}

function clampY(y: number, height: number): number {
  const work = screen.getPrimaryDisplay().workArea;
  return Math.max(work.y, Math.min(work.y + work.height - height, y));
}

/**
 * 意图尺寸（settings.size + 状态区）。Windows 上透明无边框窗口的 getBounds
 * 含不可见边框（比设置值大），把返回值再传回 setBounds 会每移一次涨一圈，
 * 所以移动/钳制一律按意图尺寸来，不信 getBounds 的宽高。
 */
function petWindowSize(): { width: number; height: number } {
  return { width: settings.size, height: settings.size + HEIGHT_EXTRA };
}

export function setPetEnabled(enabled: boolean): PetSettings {
  settings.enabled = enabled;
  saveSettings();
  if (enabled) createPetWindow();
  else closePetWindow(false);
  return { ...settings };
}

export function petSettings(): PetSettings {
  return { ...settings };
}

/** 在 app ready 后调用：注册 IPC + 按持久化设置恢复桌宠 */
export function initPet(): void {
  loadSettings();

  // 主窗口（设置弹窗）用的两个开关接口
  ipcMain.handle("raptor:pet-state", () => petSettings());
  ipcMain.handle("raptor:pet-set-enabled", (_e, enabled: unknown) => setPetEnabled(enabled === true));

  // 桌宠窗口内部接口：只认桌宠窗口发来的调用
  ipcMain.handle("pet:initial", () => ({ autoWalk: settings.autoWalk, size: settings.size }));
  ipcMain.handle("pet:step", (e, dx: unknown) => {
    if (!fromPetWindow(e) || !win) return { x: 0, left: 0, right: 0 };
    const bounds = win.getBounds();
    const work = screen.getPrimaryDisplay().workArea;
    const size = petWindowSize();
    // 页面按 dt 算位移会带小数：窗口坐标必须取整，Electron 的 setPosition 拒收浮点
    const x = clampX(Math.round(bounds.x + (Number(dx) || 0)), size.width);
    if (x !== bounds.x) {
      win.setBounds({ x, y: bounds.y, width: size.width, height: size.height });
    }
    return { x, left: work.x, right: work.x + work.width };
  });
  ipcMain.handle("pet:move-by", (e, dx: unknown, dy: unknown) => {
    if (!fromPetWindow(e) || !win) return;
    const bounds = win.getBounds();
    const size = petWindowSize();
    const x = clampX(Math.round(bounds.x + (Number(dx) || 0)), size.width);
    const y = clampY(Math.round(bounds.y + (Number(dy) || 0)), size.height);
    if (x !== bounds.x || y !== bounds.y) {
      win.setBounds({ x, y, width: size.width, height: size.height });
    }
  });
  ipcMain.handle("pet:menu", (e, cur: unknown) => {
    if (!fromPetWindow(e)) return {} satisfies PetMenuResult;
    const state = (cur ?? {}) as { autoWalk?: unknown; topmost?: unknown; size?: unknown };
    return popupPetMenu({
      autoWalk: state.autoWalk !== false,
      topmost: state.topmost !== false,
      size: SIZES.some((s) => s.width === state.size) ? (state.size as number) : settings.size,
    });
  });
  ipcMain.handle("pet:persist", (e, patch: unknown) => {
    if (!fromPetWindow(e) || !patch || typeof patch !== "object") return;
    const p = patch as { autoWalk?: unknown };
    if (typeof p.autoWalk === "boolean") settings.autoWalk = p.autoWalk;
    saveSettings();
  });
  ipcMain.handle("pet:close", (e) => {
    if (fromPetWindow(e)) closePetWindow(true);
  });

  if (settings.enabled) createPetWindow();
}
