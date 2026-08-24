/**
 * 配置加载：从 .env 读取凭证与模型设置
 * Node 24 原生 process.loadEnvFile()，无 dotenv 依赖
 */

export interface RaptorConfig {
  deepseekApiKey: string;
  deepseekBaseUrl?: string;
  model: string;
  jwglUsername: string;
  jwglPassword: string;
}

// 加载项目根目录 .env（不存在时静默跳过）
try {
  process.loadEnvFile();
} catch {
  /* .env 不存在，依赖真实环境变量 */
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
  };

  const missing: string[] = [];
  if (!config.deepseekApiKey) missing.push("DEEPSEEK_API_KEY");
  if (!config.jwglUsername) missing.push("JWGL_USERNAME");
  if (!config.jwglPassword) missing.push("JWGL_PASSWORD");

  if (missing.length > 0) {
    throw new Error(
      `缺少必要配置：${missing.join("、")}。请在项目根目录 .env 中填写（参考 .env.example）`
    );
  }

  return config;
}

/** 惰性单例：入口调用一次，工具层直接 import 使用 */
export const config = loadConfig();
