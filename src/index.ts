/**
 * CourseRaptor 入口：终端对话 UI
 * 运行: raptor / npm run dev
 */

import { runAgentTUI } from "@ai-sdk/tui";

import { createRaptorAgent } from "./agent";
import { flushCapturedSession } from "./memory/shortterm";

const agent = await createRaptorAgent();

await runAgentTUI({
  title: "🦖 CourseRaptor · NJTECH 教务 Agent",
  agent,
});

// 会话历史在每轮已逐轮落盘，这里兜底刷写
await flushCapturedSession();
