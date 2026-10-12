/**
 * 渠道推送端口：core 只面向「往 QQ 发一条主动消息」这个抽象能力，
 * 具体通道（QQ 桥的发送实现）由宿主在桥启动后注册——core 不 import
 * local/（分层红线，verify-imports 门禁盯守）。
 *
 * 未注册（桥未启动 / 演示模式）时发送如实返回 false，调用方自行降级；
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
