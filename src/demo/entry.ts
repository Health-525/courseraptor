/**
 * 演示入口：只监听本机，不启用 QQ、自动更新或教务登录。
 *
 *   npm run demo        离线固定剧本——零配置，不调用 AI
 *   npm run demo:live   真实模型分析——回答由 AI 实时生成，工具数据仍为虚构示例
 *
 * Key 来源（--live 时）：先看 shell 环境的 DEEPSEEK_API_KEY，没有再从项目根
 * .env 里取同名键（仅取 AI 相关三键，见 readDemoEnvKeys）；不 import
 * core/config、不读 credentials.enc——演示永不触碰教务凭证。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDemoAgent, type DemoStreamAgent } from "./agent";
import { createDemoServer } from "./server";

/** 从 .env 文本里只挑出需要的键：解析失败或文件不存在都不影响演示启动 */
function readDemoEnvKeys(path: string, keys: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return found;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (!keys.includes(key)) continue;
    const value = raw.replace(/^(['"])(.*)\1$/, "$2").trim();
    if (value) found[key] = value;
  }
  return found;
}

const port = Number(process.env.RAPTOR_DEMO_PORT ?? 3211);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("RAPTOR_DEMO_PORT 应为 0–65535 之间的整数。");
  process.exitCode = 1;
} else {
  const live = process.argv.includes("--live");
  let liveAgent: DemoStreamAgent | null = null;
  let liveModel = "";
  if (live) {
    // shell 环境优先；缺的键再从项目根 .env 补（src/demo/ 上两级即项目根）
    const fromEnvFile = readDemoEnvKeys(fileURLToPath(new URL("../../.env", import.meta.url)), [
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_BASE_URL",
      "RAPTOR_MODEL",
    ]);
    const apiKey = process.env.DEEPSEEK_API_KEY || fromEnvFile.DEEPSEEK_API_KEY;
    if (apiKey) {
      if (fromEnvFile.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY)
        process.env.DEEPSEEK_API_KEY = fromEnvFile.DEEPSEEK_API_KEY;
      liveModel = process.env.RAPTOR_MODEL || fromEnvFile.RAPTOR_MODEL || "deepseek-flash";
      liveAgent = createDemoAgent({
        model: liveModel,
        ...(process.env.DEEPSEEK_BASE_URL || fromEnvFile.DEEPSEEK_BASE_URL
          ? {
              baseUrl: process.env.DEEPSEEK_BASE_URL || fromEnvFile.DEEPSEEK_BASE_URL,
            }
          : {}),
      });
    } else {
      console.error(
        "已请求 --live，但未找到 DEEPSEEK_API_KEY（shell 环境或项目根 .env）；本次回退为离线固定剧本。",
      );
    }
  }
  const server = createDemoServer({ liveAgent });
  server.once("error", (error) => {
    console.error(`演示启动失败：${error.message}。请关闭旧演示或设置 RAPTOR_DEMO_PORT。`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") {
      if (liveAgent) {
        console.log(`CourseRaptor 演示（真实模型）：http://127.0.0.1:${address.port}`);
        console.log(
          `模型 ${liveModel}：回答由 AI 实时生成（会产生 API 费用），课表/成绩等数据仍为虚构示例。Ctrl+C 退出。`,
        );
      } else {
        console.log(`CourseRaptor 离线演示：http://127.0.0.1:${address.port}`);
        console.log("全部为虚构数据，无需账号或 API Key，不调用 AI。Ctrl+C 退出。");
      }
    }
  });
}
