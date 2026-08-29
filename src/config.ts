/**
 * 配置加载：.env 读取 + 教务凭证解析（.env > 加密凭证文件 > 首次引导）
 * Node 24 原生 process.loadEnvFile()，无 dotenv 依赖
 */

import path from "node:path";
import { loadCredentialsStore } from "./credentials";

// 项目根目录解析独立成 paths.ts，避免与 credentials.ts 循环依赖
import { PROJECT_ROOT as ROOT } from "./paths";
export const PROJECT_ROOT = ROOT;

export interface RaptorConfig {
  deepseekApiKey: string;
  deepseekBaseUrl?: string;
  model: string;
  jwglUsername: string;
  jwglPassword: string;
  /** 教务凭证来源（诊断用） */
  credentialsSource: "env" | "encrypted" | "unset";
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
const ENV_FILE = path.join(ROOT, ".env");

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

function loadConfig(): RaptorConfig {
  const config: RaptorConfig = {
    deepseekApiKey: env("DEEPSEEK_API_KEY") ?? "",
    deepseekBaseUrl: env("DEEPSEEK_BASE_URL"),
    model: env("RAPTOR_MODEL") ?? "deepseek-v4-flash",
    jwglUsername: env("JWGL_USERNAME") ?? "",
    jwglPassword: env("JWGL_PASSWORD") ?? "",
    credentialsSource: "env",
    firecrawlApiKey: env("FIRECRAWL_API_KEY"),
    qqBotAppId: env("QQBOT_APP_ID"),
    qqBotAppSecret: env("QQBOT_APP_SECRET"),
    qqBotPasscode: env("QQBOT_PASSCODE"),
    enableGrab: env("RAPTOR_ENABLE_GRAB") === "1",
  };

  // DEEPSEEK_API_KEY 允许缺失：/key 斜杠命令运行时配置（热生效）

  // 凭证解析：.env 优先；否则解密本地加密存储（都没有则由入口引导）
  if (!config.jwglUsername || !config.jwglPassword || !config.deepseekApiKey) {
    const stored = loadCredentialsStore();
    if (stored) {
      if ((!config.jwglUsername || !config.jwglPassword) && stored.username && stored.password) {
        config.jwglUsername = stored.username;
        config.jwglPassword = stored.password;
        config.credentialsSource = "encrypted";
      } else if (!config.jwglUsername || !config.jwglPassword) {
        config.credentialsSource = "unset";
      }
      if (!config.deepseekApiKey && stored.deepseekApiKey) {
        // provider 每次请求实时读该环境变量 -> 重启后同样生效
        config.deepseekApiKey = stored.deepseekApiKey;
        process.env.DEEPSEEK_API_KEY = stored.deepseekApiKey;
      }
    } else if (!config.jwglUsername || !config.jwglPassword) {
      config.credentialsSource = "unset";
    }
  }

  return config;
}

/** 惰性单例：入口调用一次，工具层直接 import 使用 */
export const config = loadConfig();
