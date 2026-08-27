/**
 * 配置加载：从 .env 读取凭证与模型设置
 * Node 24 原生 process.loadEnvFile()，无 dotenv 依赖
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RaptorConfig {
  deepseekApiKey: string;
  deepseekBaseUrl?: string;
  model: string;
  jwglUsername: string;
  jwglPassword: string;
  /** Firecrawl 云解析（通知附件转 markdown），可选 */
  firecrawlApiKey?: string;
  /** QQ 官方机器人（开放平台 q.qq.com，可选，npm run qq 启动桥接） */
  qqBotAppId?: string;
  qqBotAppSecret?: string;
  qqBotPasscode?: string;
  /** 抢课功能开关（选课季设为 1 才暴露抢课/盯课工具，平时关闭回到日常对话） */
  enableGrab: boolean;
}

// .env 跟随包位置解析：全局命令 raptor 可在任意目录启动
export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const ENV_FILE = path.join(PROJECT_ROOT, ".env");

// 不存在时静默跳过，依赖真实环境变量
try {
  process.loadEnvFile(ENV_FILE);
} catch {
  /* .env 不存在 */
}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

export function loadConfig(): RaptorConfig {
  const config: RaptorConfig = {
    deepseekApiKey: env("DEEPSEEK_API_KEY") ?? "",
    deepseekBaseUrl: env("DEEPSEEK_BASE_URL"),
    model: env("RAPTOR_MODEL") ?? "deepseek-v4-flash",
    jwglUsername: env("JWGL_USERNAME") ?? "",
    jwglPassword: env("JWGL_PASSWORD") ?? "",
    firecrawlApiKey: env("FIRECRAWL_API_KEY"),
    /** QQ 官方机器人（开放平台 q.qq.com，可选，npm run qq 启动桥接） */
    qqBotAppId: env("QQBOT_APP_ID"),
    qqBotAppSecret: env("QQBOT_APP_SECRET"),
    qqBotPasscode: env("QQBOT_PASSCODE"),
    enableGrab: env("RAPTOR_ENABLE_GRAB") === "1",
  };

  const missing: string[] = [];
  if (!config.deepseekApiKey) missing.push("DEEPSEEK_API_KEY");
  if (!config.jwglUsername) missing.push("JWGL_USERNAME");
  if (!config.jwglPassword) missing.push("JWGL_PASSWORD");

  if (missing.length > 0) {
    throw new Error(
      `缺少必要配置：${missing.join("、")}。请在 ${ENV_FILE} 中填写（参考 .env.example）`
    );
  }

  return config;
}

/** 惰性单例：入口调用一次，工具层直接 import 使用 */
export const config = loadConfig();
