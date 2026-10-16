/**
 * 渠道推送端口：core 只面向抽象能力（往 QQ 发一条主动消息 / 弹一条桌面通知），
 * 具体通道由宿主启动后注册——core 不 import local/（分层红线，verify-imports
 * 门禁盯守）。
 *   - QQ 推送：QQ 桥启动后注册 registerQQPushSender
 *   - 桌面通知：桌面后端（local/host/headless.ts）启动后注册 registerDesktopNotifier
 *
 * 未注册（桥/桌面未启动、演示模式）时如实返回 false，调用方自行降级；
 * 发送失败由注册方内部兜底记录，这里不重试。
 */

export type QQPushSender = (text: string) => Promise<void>;

let sender: QQPushSender | null = null;

/** 宿主（QQ 桥）启动完成后调用：注册真正的发送实现；传 null 注销 */
export function registerQQPushSender(fn: QQPushSender | null): void {
  sender = fn;
}

/** 发一条主动消息；桥未启动返回 false */
export async function sendQQPush(text: string): Promise<boolean> {
  if (!sender) return false;
  await sender(text);
  return true;
}

/**
 * 桌面通知端口：桌面宿主（Electron 后端）注册后接管本机通知（转原生 toast）。
 * 与 QQ 推送端口同款模式——core 只认抽象，具体通道由宿主注入；未注册时
 * sendDesktopNotification 如实返回 false，调用方回退本机实现（windowsToast）。
 */
export type DesktopNotifier = (title: string, body: string) => void;

let desktopNotifier: DesktopNotifier | null = null;

/** 宿主（桌面后端）启动后调用：注册桌面通知实现；传 null 注销 */
export function registerDesktopNotifier(fn: DesktopNotifier | null): void {
  desktopNotifier = fn;
}

/** 发一条桌面通知；宿主未注册返回 false，调用方自行回退 */
export function sendDesktopNotification(title: string, body: string): boolean {
  if (!desktopNotifier) return false;
  desktopNotifier(title, body);
  return true;
}
