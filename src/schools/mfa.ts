/**
 * 二次认证（动态码）待验证会话存储
 *
 * 场景：河北农大走 CAS 统一认证，账密通过后常被要求再填一个手机/邮箱验证码。
 * 对话式 agent 拿不到用户手机，只能：
 *   第 1 轮 登录 -> 抛「需要验证码，已发往 138****1234」 -> 存下待验证会话
 *   第 2 轮 用户把验证码发进对话 -> 模型调 submit_auth_code -> 用同一份 Cookie 续完登录
 *
 * 因此待验证状态必须跨请求活着，而且要落盘而不是只在内存里：
 * 网页/TUI 与 QQ 桥是两个进程，用户也很可能在上一个窗口问完、下一个窗口才回验证码。
 *
 * 三条护栏：
 * 1. 校验 challengeId 时必须同时匹配学校与学号，防止拿别人的 challenge 冒领会话。
 * 2. 10 分钟过期（CAS 侧验证码本身也短命），过期即销毁。
 * 3. 存储里是 Cookie（等同临时登录态），落在 data/ 下——data 整体不打包、不参与更新覆盖。
 */

import fs from "node:fs";
import path from "node:path";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "../atomic-write";
import { PROJECT_ROOT } from "../paths";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface PendingSecondFactor {
  challengeId: string;
  schoolId: string;
  username: string;
  /** CAS 侧这次要求哪种二次认证（3=短信 4=微信 5=企业微信 11=邮箱 12=钉钉 13=WeLink） */
  reAuthType: string;
  isMultifactor: string;
  /** 脱敏后的投递目标，如手机号/邮箱，只用于给用户说明验证码发去哪了 */
  maskedTarget: string;
  /** 已持有的认证 Cookie，提交验证码时要在同一份 Cookie 上继续 */
  cookies: [string, string][];
  serviceUrl: string;
  createdAt: number;
}

function storePath(): string {
  const dir = process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data");
  return path.join(dir, "school-mfa.json");
}

function readStore(): Record<string, PendingSecondFactor> {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, PendingSecondFactor>;
    }
    return {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // 文件在却解析不出来：留副本再当空的，别让半截 JSON 把待验证会话无声吞掉
      quarantineCorruptFileSync(storePath());
    }
    return {};
  }
}

function writeStore(store: Record<string, PendingSecondFactor>): void {
  try {
    writeFileAtomicSync(storePath(), JSON.stringify(store, null, 2));
  } catch {
    // 只读环境下退化为「验证码流程不可用」，不影响其他工具
  }
}

function isPending(value: unknown): value is PendingSecondFactor {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<PendingSecondFactor>;
  return (
    typeof p.challengeId === "string" &&
    typeof p.schoolId === "string" &&
    typeof p.username === "string" &&
    typeof p.createdAt === "number" &&
    Array.isArray(p.cookies)
  );
}

/** 丢掉过期/结构损坏的条目，返回清理后的存储（同时回写磁盘） */
function prune(now = Date.now()): Record<string, PendingSecondFactor> {
  const raw = readStore();
  const kept: Record<string, PendingSecondFactor> = {};
  let dirty = false;
  for (const [id, value] of Object.entries(raw)) {
    if (!isPending(value) || now - value.createdAt > CHALLENGE_TTL_MS) {
      dirty = true;
      continue;
    }
    kept[id] = value;
  }
  if (dirty) writeStore(kept);
  return kept;
}

/**
 * 登记一次待验证会话。同一账号只保留最新一条：
 * 用户重复问「今天课表」会反复触发登录，留着旧 challenge 只会让验证码对不上。
 */
export function beginSecondFactor(
  input: Omit<PendingSecondFactor, "challengeId" | "createdAt">,
): string {
  const challengeId = `${input.schoolId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const store = prune();
  for (const [id, pending] of Object.entries(store)) {
    if (pending.schoolId === input.schoolId && pending.username === input.username)
      delete store[id];
  }
  store[challengeId] = { ...input, challengeId, createdAt: Date.now() };
  writeStore(store);
  return challengeId;
}

/** 取出并校验归属（不删除：验证码可能一次填错，删除得由调用方显式做） */
export function readSecondFactor(
  challengeId: string,
  schoolId: string,
  username: string,
): PendingSecondFactor | string {
  const pending = prune()[challengeId];
  if (!pending) return "验证码会话不存在或已过期（超过 10 分钟），请重新查询触发新的验证码";
  if (pending.schoolId !== schoolId) return "验证码会话与当前配置的学校不匹配，请重新查询";
  if (pending.username !== username.trim()) return "验证码会话与当前学号不匹配，请重新查询";
  return pending;
}

export function clearSecondFactor(challengeId: string): void {
  const store = prune();
  if (!(challengeId in store)) return;
  delete store[challengeId];
  writeStore(store);
}

/** 测试与 /reset 用：清空全部待验证会话 */
export function clearAllSecondFactors(): void {
  try {
    fs.rmSync(storePath(), { force: true });
  } catch {
    /* 不存在就算了 */
  }
}

/**
 * 找当前账号唯一有效的待验证会话。
 * 用户通常只会把验证码原文发过来，不记得 challenge id —— 而 beginSecondFactor
 * 保证同一「学校+学号」只保留最新一条，所以这里可以安全地按账号定位。
 */
export function findSecondFactor(schoolId: string, username: string): PendingSecondFactor | null {
  const store = prune();
  const wanted = username.trim();
  for (const pending of Object.values(store)) {
    if (pending.schoolId === schoolId && pending.username === wanted) return pending;
  }
  return null;
}

/**
 * 需要验证码时抛出的信号错误。
 * message 是给模型看的：必须含「把验证码发给我」这个可执行动作，
 * 否则模型会把它当普通失败转述成「登录失败，请稍后再试」。
 */
export class SecondFactorRequiredError extends Error {
  readonly challengeId: string;
  readonly maskedTarget: string;

  constructor(challengeId: string, maskedTarget: string) {
    super(
      `需要二次认证：验证码已发送到${maskedTarget || "绑定的手机/邮箱"}，` +
        `10 分钟内有效。请向用户索要验证码原文，拿到后调用 submit_auth_code(code, challenge_id="${challengeId}") 完成登录，` +
        `然后重新执行刚才的查询。在用户提供验证码之前不要重复触发登录。`,
    );
    this.name = "SecondFactorRequiredError";
    this.challengeId = challengeId;
    this.maskedTarget = maskedTarget;
  }
}
