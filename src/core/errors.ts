/**
 * 类型化错误体系
 *
 * 约定：code 是程序判断用的稳定契约（重试 / 重登 / 引导配置 / 换通道），
 * message 是给人看的中文文案——文案怎么改都不应影响逻辑。
 * 在此之前重试分类靠 message 子串匹配（如 includes("密码")）、会话失效
 * 靠 "SESSION_EXPIRED" 魔法字符串散落十多处，改一句文案就静默破坏行为。
 *
 * 适配器（src/adapters/*）对外抛错应优先使用 RaptorError；core 与 channels
 * 用 isRaptorError / 谓词函数分类处理，不要匹配 message 文本。
 */

export type RaptorErrorCode =
  | "AUTH_MISSING" // 未配置学号/密码 → 引导配置，不可重试
  | "AUTH_INVALID" // 学号或密码不正确 → 不可重试
  | "AUTH_LOCKED" // 账号被锁定 → 不可重试
  | "SESSION_EXPIRED" // 会话失效 → 重登可恢复
  | "NETWORK" // 网络/超时/线路抖动 → 可重试
  | "UPSTREAM" // 上游 5xx/异常响应 → 可重试
  | "PARSE" // 页面或数据结构变化 → 不可重试
  | "CAMPUS_ONLY" // 校外 IP 被拦 → 换通道（如 WebVPN）
  | "BUSINESS_REJECT" // 上游业务拒绝（课程满员等），非故障
  | "UNKNOWN";

/** 各错误码默认是否值得重试（瞬时故障） */
const RETRYABLE: ReadonlySet<RaptorErrorCode> = new Set(["SESSION_EXPIRED", "NETWORK", "UPSTREAM"]);

export interface RaptorErrorOptions {
  cause?: unknown;
  /** 覆盖该错误码的默认可重试性 */
  retryable?: boolean;
}

export class RaptorError extends Error {
  readonly code: RaptorErrorCode;
  readonly retryable: boolean;

  constructor(code: RaptorErrorCode, message: string, options: RaptorErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RaptorError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }
}

/** 是否 RaptorError；给 code 时进一步过滤 */
export function isRaptorError(e: unknown, ...codes: RaptorErrorCode[]): e is RaptorError {
  return e instanceof RaptorError && (codes.length === 0 || codes.includes(e.code));
}

/** 会话失效（可重登恢复） */
export function isSessionExpiredError(e: unknown): boolean {
  return isRaptorError(e, "SESSION_EXPIRED");
}

/** 凭证类错误（未配置/密码错/被锁）：重登也不会成功，不该重试 */
export function isCredentialError(e: unknown): boolean {
  return isRaptorError(e, "AUTH_MISSING", "AUTH_INVALID", "AUTH_LOCKED");
}

/**
 * 选课动作结果协议里的会话失效哨兵值。
 * submitCourse 一族返回 { ok, message } 形状（不抛异常），message 取本常量；
 * 与 code "SESSION_EXPIRED" 同名同值，两套协议一个语义。
 */
export const SESSION_EXPIRED_MESSAGE = "SESSION_EXPIRED";
