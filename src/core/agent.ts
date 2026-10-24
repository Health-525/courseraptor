/**
 * CourseRaptor agent 定义：模型 + 系统提示词 + 工具装配
 *
 * 两层记忆：
 * - 短期：模型中间件捕获会话逐轮落盘，下次启动注入上次会话转写
 * - 长期：memory.json 事实条目（save_memory 工具维护），启动时全量注入
 */

import { type LanguageModelMiddleware, ToolLoopAgent, wrapLanguageModel } from "ai";
import { newsWorkflowStop } from "./ai-news";
import { config } from "./config";
import { buildLanguageModel } from "./llm";
import { toolTimeoutConfig } from "./loop-timeout";
import { formatMemoryForPrompt } from "./memory/longterm";
import { captureSessionPrompt, loadLastSessionTranscript } from "./memory/shortterm";
import { basePrompt, QQ_CHANNEL_PROMPT, WEB_CHANNEL_PROMPT } from "./prompt";
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
/**
 * 组装 agent：注入长期记忆与上次会话记录；channel 指定输出渠道风格
 *
 * `carryOver` 管的是**短期记忆的跨会话延续**（data/session.json 的尾部
 * 转写）。默认 true，因为 TUI 与 QQ 都是单线对话：TUI 重启后靠它接上，
 * QQ 每条消息新建 agent、靠它保持上下文连续。
 *
 * 网页端必须传 false：它每轮都带该会话自己的完整历史
 * （chat-stream 用 contextMessages(sessionId)），连续性已经够了；而
 * session.json 是**全局单文件**（模型中间件每轮覆写），把它注入网页
 * 提示词等于让 A 会话的尾巴出现在 B 会话里——多会话/多标签下还会互相
 * 覆盖。新会话要延续上文，切回历史会话即可，不必靠提示词注入。
 */
export async function createRaptorAgent(channel?: "qq" | "web", options?: { carryOver?: boolean }) {
  const carryOver = options?.carryOver ?? true;
  const [memorySection, lastSession] = await Promise.all([
    formatMemoryForPrompt(),
    carryOver ? loadLastSessionTranscript() : Promise.resolve(""),
  ]);
  // TUI（channel 留空）是纯文本终端，没有 Markdown 渲染：既不适用 QQ 的固定模板
  // （那是为手机窄屏设计的），也不能套网页的表格/产物收尾规则（会打印出原始
  // `| 列 | 列 |` 语法）——只给它 basePrompt 的朴素指引，跟过去行为一致。
  const channelPrompt =
    channel === "qq" ? QQ_CHANNEL_PROMPT : channel === "web" ? WEB_CHANNEL_PROMPT : undefined;
  const instructions = [basePrompt(), memorySection, lastSession, channelPrompt]
    .filter(Boolean)
    .join("\n\n");

  return new ToolLoopAgent({
    model: buildWrappedModel(),
    stopWhen: newsWorkflowStop,
    instructions,
    // 循环看门狗：单次工具执行硬预算（含文档三件套的更长覆盖）。
    // 经 AbortSignal 下发——信号感知的工具超时抛错，SDK 转成错误
    // tool-result 喂回模型，轮次不死；详见 loop-timeout.ts 的背景注释。
    // 流式看门狗（首 chunk / chunk 间隔）在 stream 调用点另配，
    // 因为 generateText 不支持那两个字段。
    timeout: toolTimeoutConfig(),
    // 通用工具（core/tools）+ 当前学校适配器贡献的教务工具（含能力门禁：
    // 学校没实现的模块，对应工具根本不会出现）
    tools: { ...coreTools, ...school().tools },
  });
}
