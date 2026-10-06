/**
 * CourseRaptor agent 定义：模型 + 系统提示词 + 工具装配
 *
 * 两层记忆：
 * - 短期：模型中间件捕获会话逐轮落盘，下次启动注入上次会话转写
 * - 长期：memory.json 事实条目（save_memory 工具维护），启动时全量注入
 */

import { type LanguageModelMiddleware, ToolLoopAgent, wrapLanguageModel } from "ai";

import { config } from "./config";
import { buildLanguageModel } from "./llm";
import { formatMemoryForPrompt } from "./memory/longterm";
import { captureSessionPrompt, loadLastSessionTranscript } from "./memory/shortterm";
import { basePrompt, QQ_CHANNEL_PROMPT } from "./prompt";
import { school } from "./school";
import { recordTokenUsage } from "./token-usage";
import { coreTools } from "./tools";

/** 模型用量键：providerId/modelId 组合（不同厂商可能有同名型号） */
function usageModelKey(): string {
  return `${config.providerId}/${config.model}`;
}

/**
 * AI SDK usage 的宽松读取（provider spec v4：inputTokens/outputTokens 是
 * {total, ...} 对象；个别厂商缺字段或旧 spec 数字形态都按 0 处理）。
 */
function usageTokens(usage: unknown): { inputTokens: number; outputTokens: number } {
  const raw = (usage ?? {}) as {
    inputTokens?: { total?: unknown } | number;
    outputTokens?: { total?: unknown } | number;
  };
  const read = (value: { total?: unknown } | number | undefined): number => {
    if (typeof value === "number") return Math.max(0, Math.trunc(value) || 0);
    return Math.max(0, Math.trunc(Number(value?.total) || 0));
  };
  return { inputTokens: read(raw.inputTokens), outputTokens: read(raw.outputTokens) };
}

/**
 * 包装模型：每次调用捕获完整对话（短期记忆的数据源），并把该次调用的
 * token 用量交给 token-usage 记账（功能大厅「用量统计」面板的数据源；
 * 托管版同时上报网关，供管理台全站聚合）。流式路径经 TransformStream
 * 旁听 finish 事件的 usage，不改写流的任何内容与时序。
 * 每次组装 agent 时重新构建模型（当前供应商 + 型号）——设置弹窗换供应商或
 * 型号后重建的 agent 才会用新模型；Key 不需要这里处理（DeepSeek 官方包每
 * 请求实时读 DEEPSEEK_API_KEY，其余供应商经 llm.ts 的 fetch 读
 * RAPTOR_PROVIDER_KEY，保存 Key 即热生效）。
 */
function buildWrappedModel() {
  return wrapLanguageModel({ model: buildLanguageModel(), middleware: raptorModelMiddleware() });
}

/**
 * 模型中间件（导出供测试全链路钉住 usage 字段解析）：短期记忆捕获 +
 * token 用量记账。字段形状必须跟随 AI SDK provider spec（v4 起 finish
 * part 的 usage 里 inputTokens/outputTokens 是 {total,...} 对象）——
 * 这层是「用量统计」的唯一数据源，spec 漂移要靠 agent-middleware 测试红出来。
 */
export function raptorModelMiddleware(): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      captureSessionPrompt(params.prompt);
      const result = await doGenerate();
      recordTokenUsage({ model: usageModelKey(), ...usageTokens(result.usage) });
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      captureSessionPrompt(params.prompt);
      const result = await doStream();
      const model = usageModelKey();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (part && (part as { type?: string }).type === "finish") {
                recordTokenUsage({ model, ...usageTokens((part as { usage?: unknown }).usage) });
              }
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}
/** 组装 agent：注入长期记忆与上次会话记录；channel 指定输出渠道风格 */
export async function createRaptorAgent(channel?: "qq") {
  const [memorySection, lastSession] = await Promise.all([
    formatMemoryForPrompt(),
    loadLastSessionTranscript(),
  ]);
  const instructions = [
    basePrompt(),
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
