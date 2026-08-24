/**
 * CourseRaptor 入口：终端对话 UI
 * 运行: npm run dev
 */

import { runAgentTUI } from "@ai-sdk/tui";

import { raptorAgent } from "./agent";

await runAgentTUI({
  title: "🦖 CourseRaptor · NJTECH 教务 Agent",
  agent: raptorAgent,
});
