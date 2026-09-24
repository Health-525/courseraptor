/**
 * CourseRaptor agent 定义：模型 + 系统提示词 + 工具装配
 *
 * 两层记忆：
 * - 短期：模型中间件捕获会话逐轮落盘，下次启动注入上次会话转写
 * - 长期：memory.json 事实条目（save_memory 工具维护），启动时全量注入
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { ToolLoopAgent, wrapLanguageModel } from "ai";

import { config } from "./config";
import { formatMemoryForPrompt } from "./memory/longterm";
import { captureSessionPrompt, loadLastSessionTranscript } from "./memory/shortterm";
import { basePrompt, QQ_CHANNEL_PROMPT } from "./prompt";
import { school } from "./school";
import { coreTools } from "./tools";

const deepseek = createDeepSeek({
  // 不传 apiKey：AI SDK 会每次请求实时读 DEEPSEEK_API_KEY 环境变量，
  // /key 斜杠命令更新 env 即热生效，无需重建 provider

  ...(config.deepseekBaseUrl ? { baseURL: config.deepseekBaseUrl } : {}),
});

/**
 * 包装模型：每次调用捕获完整对话（短期记忆的数据源）。
 * 每次组装 agent 时重新取 config.model——设置弹窗换型号后重建的 agent 才会用新模型；
 * Key 不需要这里处理（AI SDK 每次请求实时读 DEEPSEEK_API_KEY）。
 */
function buildWrappedModel() {
  return wrapLanguageModel({
    model: deepseek(config.model),
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        captureSessionPrompt(params.prompt);
        return doGenerate();
      },
      wrapStream: async ({ doStream, params }) => {
        captureSessionPrompt(params.prompt);
        return doStream();
      },
    },
  });
}
/** 组装 agent：注入长期记忆与上次会话记录；channel 指定输出渠道风格 */
export async function createRaptorAgent(channel?: "qq") {
  const [memorySection, lastSession] = await Promise.all([
    formatMemoryForPrompt(),
    loadLastSessionTranscript(),
  ]);
  const instructions = [
    basePrompt(config.enableGrab),
    memorySection,
    lastSession,
    channel === "qq" ? QQ_CHANNEL_PROMPT : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");

  return new ToolLoopAgent({
    model: buildWrappedModel(),
    instructions,
    // 通用工具（core/tools）+ 当前学校适配器贡献的教务工具（含能力门禁：
    // 学校没实现的模块，对应工具根本不会出现）
    tools: { ...coreTools, ...school().tools },
  });
}
