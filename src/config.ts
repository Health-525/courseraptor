/**
 * 配置加载：.env 读取 + 教务凭证解析（.env > 加密凭证文件 > 首次引导）
 * Node 24 原生 process.loadEnvFile()，无 dotenv 依赖
 */

import path from "node:path";
import { loadCredentialsStore } from "./credentials";

// 项目根目录解析独立成 paths.ts，避免与 credentials.ts 循环依赖
import { PROJECT_ROOT as ROOT } from "./paths";
export const PROJECT_ROOT = ROOT;

export type DeepSeekApiKeySource = "env" | "encrypted" | "unset";

export interface RaptorConfig {
  deepseekApiKey: string;
  /** 仅供状态展示，UI 不得读取 deepseekApiKey 明文。 */
  deepseekApiKeySource: DeepSeekApiKeySource;
  deepseekBaseUrl?: string;
  model: string;
  jwglUsername: string;
  jwglPassword: string;
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
  /** 抢课功能开关（选课季设为 1 才暴露抢课/盯课工具，平时关闭回到日常对话） */
  enableGrab: boolean;
}

export interface ResolvedDeepSeekApiKey {
  key: string;
  source: DeepSeekApiKeySource;
}

/**
 * 交互式 /key 明确确认的覆盖值优先于 .env：否则成功提示后重启又回到旧值，
 * 用户无法可靠地更换密钥。未标记覆盖的历史加密值仍保持 .env 优先。
 */
export function resolveDeepSeekApiKey(input: {
  environmentKey?: string;
  storedKey?: string;
  storedOverride?: boolean;
}): ResolvedDeepSeekApiKey {
  if (input.storedOverride && input.storedKey) {
    return { key: input.storedKey, source: "encrypted" };
  }
  if (input.environmentKey) return { key: input.environmentKey, source: "env" };
  if (input.storedKey) return { key: input.storedKey, source: "encrypted" };
  return { key: "", source: "unset" };
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

function loadConfig(): RaptorConfig {
  const stored = loadCredentialsStore();
  const resolvedKey = resolveDeepSeekApiKey({
    environmentKey: env("DEEPSEEK_API_KEY"),
    storedKey: stored?.deepseekApiKey,
    storedOverride: stored?.deepseekApiKeyOverride,
  });
  if (resolvedKey.key) process.env.DEEPSEEK_API_KEY = resolvedKey.key;

  const config: RaptorConfig = {
    deepseekApiKey: resolvedKey.key,
    deepseekApiKeySource: resolvedKey.source,
    deepseekBaseUrl: env("DEEPSEEK_BASE_URL"),
    model: env("RAPTOR_MODEL") ?? "deepseek-v4-flash",
    jwglUsername: env("JWGL_USERNAME") ?? "",
    jwglPassword: env("JWGL_PASSWORD") ?? "",
    credentialsSource: "env",
    firecrawlApiKey: env("FIRECRAWL_API_KEY"),
    githubToken: env("GITHUB_TOKEN"),
    giteeToken: env("GITEE_TOKEN"),
    qqBotAppId: env("QQBOT_APP_ID"),
    qqBotAppSecret: env("QQBOT_APP_SECRET"),
    qqBotPasscode: env("QQBOT_PASSCODE"),
    enableGrab: env("RAPTOR_ENABLE_GRAB") === "1",
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
