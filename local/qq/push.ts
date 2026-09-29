/**
 * QQ 主动推送通道：桥启动后注册发送函数，后台任务（待办到期提醒等）复用。
 * 桥不在时 pushQQText 返回 false，调用方自行降级；桥的注册实现负责
 * 按白名单逐个发送并兜底记录失败。
 */

type QQPushSender = (text: string) => Promise<void>;

let sender: QQPushSender | null = null;

/** 桥启动完成后调用：注册真正的发送实现 */
export function registerQQPush(fn: QQPushSender): void {
  sender = fn;
}

/** 发一条主动消息；桥未启动返回 false，发送失败由注册方内部兜底 */
export async function pushQQText(text: string): Promise<boolean> {
  if (!sender) return false;
  await sender(text);
  return true;
}
