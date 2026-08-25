/**
 * CourseRaptor 入口：终端对话 UI
 * 配置了 QQ 机器人（QQBOT_APP_ID/SECRET）时，QQ 渠道随本入口一并启动
 * 运行: raptor / npm run dev
 */

import { runAgentTUI } from "@ai-sdk/tui";

import { config } from "./config";
import { createRaptorAgent } from "./agent";
import { flushCapturedSession } from "./memory/shortterm";

// QQ 渠道：日志写 qq-bridge.log，不干扰 TUI 渲染
if (config.qqBotAppId && config.qqBotAppSecret) {
  const { startQQBridge } = await import("./qq/bridge");
  const { createQQFileLogger } = await import("./qq/logger");
  startQQBridge({ logger: createQQFileLogger() }).catch((e) => {
    console.error(`[qq] 桥启动失败（终端对话不受影响）：${(e as Error).message.slice(0, 120)}`);
  });
}

const agent = await createRaptorAgent();

await runAgentTUI({
  title: "🦖 CourseRaptor · NJTECH 教务 Agent",
  agent,
});

// 会话历史在每轮已逐轮落盘，这里兜底刷写
await flushCapturedSession();
