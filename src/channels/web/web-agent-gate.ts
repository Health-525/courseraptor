/** 对话引擎注入口：网页端与主程序之间的最小 agent 接口、注入/重建钩子，
 *  以及「重建串行链」（连续保存两次模型也不会并发建两个 agent）。 */

import type { ModelMessage } from "ai";

/** 与 agent.ts 的 ToolLoopAgent 对齐的最小接口：网页端每轮都带全量历史，
 * 所以只声明 messages 分支（ToolLoopAgent.stream 的 prompt/messages 是
 * 二选一的判别联合，两边都可选反而匹配不上） */
export interface ChatStreamableAgent {
  stream(options: {
    messages: ModelMessage[];
    abortSignal?: AbortSignal;
  }): PromiseLike<{ fullStream: AsyncIterable<unknown> }>;
}

export let agentProvider: (() => ChatStreamableAgent | null) | null = null;

/** 主程序在 agent 就绪后注入；网页先于 agent 可用也无妨，来消息时才取 */
export function setChatAgent(agent: ChatStreamableAgent | null): void {
  agentProvider = agent ? () => agent : null;
}

/** 换模型后重建 agent 的钩子（模型在组装时绑定，不重建就只能重启） */
let agentRefresher: (() => Promise<void>) | null = null;

export function setChatAgentRefresher(refresh: () => Promise<void>): void {
  agentRefresher = refresh;
}

/** 重建串行链：连续保存两次模型也不会并发建两个 agent */
let refreshChain: Promise<string> = Promise.resolve("");

/** 重建对话引擎，返回给用户看的生效说明 */
async function refreshChatAgent(): Promise<string> {
  if (!agentRefresher) return "；本次未能即时切换，重启后生效";
  try {
    await agentRefresher();
    return "；下一条消息起生效（终端界面重启后生效）";
  } catch {
    // 重建失败时旧 agent 仍在位，对话不会中断
    return "；即时切换失败，旧模型继续可用，重启后生效";
  }
}

/** 保存设置后的跨模块写入口：ES 模块的 let 绑定只能在本模块内赋值，
 * 这里替 handle() 完成「把一次重建追加进串行链」并返回本次的生效说明。 */
export function enqueueAgentRefresh(): Promise<string> {
  refreshChain = refreshChain
    .then(refreshChatAgent)
    .catch(() => "；即时切换失败，旧模型继续可用，重启后生效");
  return refreshChain;
}
