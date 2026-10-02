/**
 * 配置加载：.env 读取 + 教务凭证解析（.env > 加密凭证文件 > 首次引导）
 * Node 24 原生 process.loadEnvFile()，无 dotenv 依赖
 */

import path from "node:path";
import { z } from "zod";
import { type CredentialsStore, loadCredentialsStore } from "./credentials";
import { resolveStoredModel } from "./models";
// 项目根目录解析独立成 paths.ts，避免与 credentials.ts 循环依赖
import { PROJECT_ROOT as ROOT } from "./paths";
import {
  getProviderDef,
  normalizeCustomBaseUrl,
  providerBaseUrl,
  resolveProviderId,
} from "./providers";
export const PROJECT_ROOT = ROOT;

export type DeepSeekApiKeySource = "env" | "encrypted" | "unset";

export interface RaptorConfig {
  /** 当前模型供应商 id（内置厂商之一；缺省 deepseek，历史行为零改动） */
  providerId: string;
  /** 当前供应商显示名（给 UI 的摘要） */
  providerLabel: string;
  /** 当前供应商的 OpenAI 兼容端点（custom = 解析后的自填地址） */
  providerBaseUrl: string;
  /** custom 供应商的自填端点（其余供应商为空串） */
  customBaseUrl: string;
  /** 多用户网关注入 RAPTOR_HOSTED=1；本地版恒 false（探测显隐红线） */
  hosted: boolean;
  deepseekApiKey: string;
  /** 仅供状态展示，UI 不得读取 deepseekApiKey 明文。 */
  deepseekApiKeySource: DeepSeekApiKeySource;
  deepseekBaseUrl?: string;
  model: string;
  jwglUsername: string;
  jwglPassword: string;
  /**
   * 统一身份认证（信息门户/WebVPN）密码，可选：与教务系统密码不同时
   * 在 .env 配置 CAS_PASSWORD；缺省回退 jwglPassword
   */
  casPassword?: string;
  /** 教务凭证来源（诊断用） */
  credentialsSource: "env" | "encrypted" | "unset";
  /** Firecrawl 云解析（通知附件转 markdown），可选 */
  firecrawlApiKey?: string;
  /** GitHub 个人访问令牌（可选）：publish_calendar 把课表日历发布成手机可订阅的公开仓库 */
  githubToken?: string;
  /** Gitee 私人令牌（可选）：国内直连的日历订阅源（github.io/raw 国内常不可达） */
  giteeToken?: string;
  /** QQ 官方机器人（开放平台 q.qq.com，可选，npm run qq 启动桥接） */
  qqBotAppId?: string;
  qqBotAppSecret?: string;
  qqBotPasscode?: string;
  /**
   * QQ 主动推送目标（openid 列表）：待办到期等提醒只发给显式列在这里的
   * openid（宿主本人）。白名单是对话授权名单，不是推送名单——为空时
   * 桥关闭主动推送，绝不把本机单用户数据广播给全部授权用户。
   */
  qqPushOpenids: string[];
  /** QQ 凭证来源（诊断用）；「完整可用」指 AppID 与 AppSecret 都在 */
  qqBotSource: QQBotSource;
  /** 抢课功能开关（选课季设为 1 才暴露抢课/盯课工具，平时关闭回到日常对话） */
  enableGrab: boolean;
  /** 教务请求全局限速（zod 校验后的 RAPTOR_MAX_RPS / RAPTOR_BURST） */
  rateLimit: { rps: number; burst: number };
}

export type QQBotSource = "env" | "encrypted" | "unset";

export interface ResolvedQQBotCredentials {
  appId?: string;
  appSecret?: string;
  passcode?: string;
  source: QQBotSource;
}

/** QQ 凭证解析：.env 优先（与教务账号同规则），缺失时回退加密存储 */
export function resolveQQBotCredentials(input: {
  environmentAppId?: string;
  environmentAppSecret?: string;
  environmentPasscode?: string;
  storedAppId?: string;
  storedAppSecret?: string;
  storedPasscode?: string;
}): ResolvedQQBotCredentials {
  const passcode = input.environmentPasscode || input.storedPasscode;
  if (input.environmentAppId && input.environmentAppSecret) {
    return {
      appId: input.environmentAppId,
      appSecret: input.environmentAppSecret,
      passcode,
      source: "env",
    };
  }
  if (input.storedAppId && input.storedAppSecret) {
    return {
      appId: input.storedAppId,
      appSecret: input.storedAppSecret,
      passcode,
      source: "encrypted",
    };
  }
  return { passcode, source: "unset" };
}

/** QQ 主动推送目标解析：QQBOT_PUSH_OPENIDS 以逗号/分号/空白分隔多个 openid，
 *  去空去重；未配置返回空数组（桥据此关闭主动推送） */
export function parseQQPushOpenids(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

export interface ResolvedDeepSeekApiKey {
  key: string;
  source: DeepSeekApiKeySource;
}

/**
 * 交互式保存（/key、设置弹窗）明确确认的覆盖值优先于 .env：否则成功提示后
 * 重启又回到旧值，用户无法可靠地更换密钥。未标记覆盖的历史加密值仍保持
 * .env 优先。适用于任意供应商（历史名保留，语义未变）。
 *
 * 多用户网关部署时注入 RAPTOR_DISABLE_DS_OVERRIDE=1：该同学选了「站点
 * 免费额度」模式——加密保存的自己 Key 保留不删，但本轮会话改用站点 Key
 * （.env 层）。本地版从不设置此变量，行为不变。
 */
export function resolveProviderApiKey(input: {
  environmentKey?: string;
  storedKey?: string;
  storedOverride?: boolean;
  disableOverride?: boolean;
}): ResolvedDeepSeekApiKey {
  if (input.storedOverride && input.storedKey && !input.disableOverride) {
    return { key: input.storedKey, source: "encrypted" };
  }
  if (input.environmentKey) return { key: input.environmentKey, source: "env" };
  if (input.storedKey) return { key: input.storedKey, source: "encrypted" };
  return { key: "", source: "unset" };
}

/** @deprecated 历史名：逻辑已泛化到全部供应商，新代码用 resolveProviderApiKey */
export const resolveDeepSeekApiKey = resolveProviderApiKey;

/**
 * 各供应商 Key 的有效视图：新格式 providerKeys（存在即明确保存过）合并
 * 旧格式 deepseekApiKey(+Override) 的迁移映射——存量凭证不用重存就生效。
 */
export function effectiveProviderKeys(stored: CredentialsStore | null): {
  keys: Record<string, string>;
  overrides: Record<string, boolean>;
} {
  const keys: Record<string, string> = { ...(stored?.providerKeys ?? {}) };
  const overrides: Record<string, boolean> = { ...(stored?.providerKeyOverrides ?? {}) };
  if (stored?.deepseekApiKey && keys.deepseek === undefined) {
    keys.deepseek = stored.deepseekApiKey;
    overrides.deepseek = stored.deepseekApiKeyOverride === true;
  }
  return { keys, overrides };
}

/** 脱敏展示：永远不完整回显；过短或不规范值只表明已配置。 */
export function maskDeepSeekApiKey(key: string): string {
  const trimmed = key.trim();
  if (!/^sk-[A-Za-z0-9]{8,}$/.test(trimmed)) return "已配置";
  return `${trimmed.slice(0, 3)}••••••••••••${trimmed.slice(-4)}`;
}

// .env 跟随包位置解析：全局命令 raptor 可在任意目录启动
const ENV_FILE = path.join(ROOT, ".env");

// 不存在时静默跳过，依赖真实环境变量
try {
  process.loadEnvFile(ENV_FILE);
} catch {
  /* .env 不存在 */
}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v?.trim() ? v.trim() : undefined;
}

// ── 数值型环境变量：zod 校验，坏值启动即报错（不再是 NaN 悄悄进限速桶）────

/** @internal 导出仅供测试钉住校验规则 */
export const rateLimitSchema = z.object({
  // 只允许下调：默认 3 rps 是对学校系统的礼貌边界，想调高请改代码并想清楚
  rps: z.coerce.number().int().min(1).max(3).default(3),
  burst: z.coerce.number().int().min(1).max(64).default(8),
});

function parseRateLimit(): { rps: number; burst: number } {
  const parsed = rateLimitSchema.safeParse({
    rps: env("RAPTOR_MAX_RPS") ?? 3,
    burst: env("RAPTOR_BURST") ?? 8,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue.path.join(".");
    throw new Error(
      `环境变量校验失败：${key === "rps" ? "RAPTOR_MAX_RPS" : "RAPTOR_BURST"} ` +
        `必须是 1-${key === "rps" ? "3" : "64"} 的整数（当前值：${
          key === "rps" ? env("RAPTOR_MAX_RPS") : env("RAPTOR_BURST")
        }），请修正 .env 后重启`,
    );
  }
  return parsed.data;
}

function loadConfig(): RaptorConfig {
  const stored = loadCredentialsStore();
  // 供应商解析：网关注入（RAPTOR_PROVIDER_ID）优先于本地保存的选择，
  // 都没有就是 deepseek——本地版什么都不配时历史行为零改动。
  const providerId = resolveProviderId(env("RAPTOR_PROVIDER_ID") ?? stored?.providerId);
  const def = getProviderDef(providerId);

  const { keys: providerKeys, overrides: providerOverrides } = effectiveProviderKeys(stored);
  const resolvedKey = resolveProviderApiKey({
    environmentKey:
      env("RAPTOR_PROVIDER_KEY") ??
      (providerId === "deepseek" ? env("DEEPSEEK_API_KEY") : undefined),
    storedKey: providerKeys[providerId],
    storedOverride: providerOverrides[providerId] === true,
    disableOverride: env("RAPTOR_DISABLE_DS_OVERRIDE") === "1",
  });
  // 回写进程环境：llm.ts 的 fetch 包装每请求读 RAPTOR_PROVIDER_KEY（热生效），
  // DeepSeek 官方包读 DEEPSEEK_API_KEY（历史路径）。
  if (resolvedKey.key) {
    process.env.RAPTOR_PROVIDER_KEY = resolvedKey.key;
    if (providerId === "deepseek") process.env.DEEPSEEK_API_KEY = resolvedKey.key;
  }

  const resolvedQQ = resolveQQBotCredentials({
    environmentAppId: env("QQBOT_APP_ID"),
    environmentAppSecret: env("QQBOT_APP_SECRET"),
    environmentPasscode: env("QQBOT_PASSCODE"),
    storedAppId: stored?.qqBotAppId,
    storedAppSecret: stored?.qqBotAppSecret,
    storedPasscode: stored?.qqBotPasscode,
  });

  // custom 端点是「custom 供应商的持久配置」：与当前选的供应商无关地保留
  // （切到别家再切回来地址还在）；.env 可选覆盖（RAPTOR_CUSTOM_BASE_URL），
  // 坏值按未配置处理，绝不让畸形 URL 进请求层。
  const customRaw = env("RAPTOR_CUSTOM_BASE_URL") ?? stored?.customBaseUrl;
  const customBaseUrl = normalizeCustomBaseUrl(customRaw).url;

  const config: RaptorConfig = {
    providerId,
    providerLabel: def.label,
    providerBaseUrl:
      providerId === "deepseek" && env("DEEPSEEK_BASE_URL")
        ? (env("DEEPSEEK_BASE_URL") as string)
        : providerBaseUrl(providerId, customBaseUrl),
    customBaseUrl,
    hosted: env("RAPTOR_HOSTED") === "1",
    deepseekApiKey: resolvedKey.key,
    deepseekApiKeySource: resolvedKey.source,
    deepseekBaseUrl: env("DEEPSEEK_BASE_URL"),
    model: resolveStoredModel({
      environmentModel: providerId === "deepseek" ? env("RAPTOR_MODEL") : undefined,
      // 每供应商的型号记忆优先；全局 model 字段是旧格式回退
      storedModel: stored?.providerModels?.[providerId] ?? stored?.model,
      storedOverride: stored?.providerModels?.[providerId]
        ? true
        : (stored?.modelOverride ?? false),
    }),
    jwglUsername: env("JWGL_USERNAME") ?? "",
    jwglPassword: env("JWGL_PASSWORD") ?? "",
    casPassword: env("CAS_PASSWORD"),
    credentialsSource: "env",
    firecrawlApiKey: env("FIRECRAWL_API_KEY"),
    githubToken: env("GITHUB_TOKEN"),
    giteeToken: env("GITEE_TOKEN"),
    qqBotAppId: resolvedQQ.appId,
    qqBotAppSecret: resolvedQQ.appSecret,
    qqBotPasscode: resolvedQQ.passcode,
    qqBotSource: resolvedQQ.source,
    qqPushOpenids: parseQQPushOpenids(env("QQBOT_PUSH_OPENIDS")),
    enableGrab: env("RAPTOR_ENABLE_GRAB") === "1",
    rateLimit: parseRateLimit(),
  };

  // 凭证解析：教务账号保持 .env 优先，缺失时再解密本地存储。
  if (!config.jwglUsername || !config.jwglPassword) {
    if (stored?.username && stored.password) {
      config.jwglUsername = stored.username;
      config.jwglPassword = stored.password;
      config.credentialsSource = "encrypted";
    } else {
      config.credentialsSource = "unset";
    }
  }

  return config;
}

/** 惰性单例：入口调用一次，工具层直接 import 使用 */
export const config = loadConfig();
