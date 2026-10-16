import { Menu, Tray, nativeImage } from "electron";

// 兜底图标：build/icon.png 缺失时用一张 1×1 透明 PNG，避免 Tray 因空图报错
const FALLBACK_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export interface TrayHandlers {
  onShow: () => void;
  onOpenDataDir: () => void;
  onCheckUpdate: () => void;
  onQuit: () => void;
}

export function createTray(iconPath: string, handlers: TrayHandlers): Tray {
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? nativeImage.createFromDataURL(FALLBACK_PNG) : image);
  tray.setToolTip("CourseRaptor");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主窗口", click: handlers.onShow },
      { label: "打开数据目录", click: handlers.onOpenDataDir },
      { label: "检查更新…", click: handlers.onCheckUpdate },
      { type: "separator" },
      { label: "退出 CourseRaptor", click: handlers.onQuit },
    ]),
  );
  // 左键单击托盘图标即显示主窗口（与关闭窗口＝隐藏到托盘配套）
  tray.on("click", handlers.onShow);
  return tray;
}
