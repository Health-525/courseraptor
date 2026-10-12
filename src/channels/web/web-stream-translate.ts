/**
 * agent fullStream → SSE 事件的翻译骨架。正式对话与演示 live 共用同一段
 * 事件建模（此前两份逐字抄写，30 行起步的克隆），各自差异用钩子注入：
 *
 *   - toolResult：正式版要透出成品文件/番茄钟/ppt 预览/面板联动，
 *     演示版透出结构化结果卡
 *   - toolError：正式版据报错文案自动推出设置面板
 *
 * 骨架只负责「事件类型 → SSE 载荷」的公共部分与工具耗时配对，不碰
 * 会话落盘、附件预解析等各自的收尾逻辑。
 */
import {
  deltaOf,
  oneLine,
  previewJson,
  type StreamEvent,
  summarizeResult,
} from "./web-tool-events";

/** 能拿到 stream.fullStream 的最小形态（正式 agent 与 demo agent 都满足）。
 *  M 就是该 agent 的消息类型——翻译器只透传它、不解读，故用泛型挂住而不约束。 */
export interface StreamableLike<M> {
  stream(options: { messages: M[]; abortSignal?: AbortSignal }): PromiseLike<{
    fullStream: unknown;
  }>;
}

export interface StreamTranslation {
  /** 累积的正文（已 trim 前的原始拼接） */
  text: string;
  /** 累积的思考过程 */
  think: string;
  /** 失败信息（流内 error 事件与agent 抛错都归入这里）；null 表示成功跑完 */
  failure: string | null;
}

export interface ToolClock {
  /** tool-call 记起点 */
  start: (id: string | undefined, name: string | undefined, input: unknown) => void;
  /** tool-result 取耗时（毫秒）；无配对返回 undefined */
  elapsed: (id: string | undefined) => number | undefined;
  /** 钩子需要 tool-call 时的入参（如 open_panel 的面板 id） */
  inputOf: (id: string | undefined) => unknown;
}

export interface TranslateOptions<M> {
  messages: M[];
  signal: AbortSignal;
  send: (obj: Record<string, unknown>) => void;
  /** tool-result 时追加的额外字段（成品文件 / 番茄钟 / ppt 预览 / 结果卡等）。
   *  clock 供钩子查回本次 tool-call 的入参与耗时，钩子内必须同步使用。 */
  extraForToolResult?: (
    output: unknown,
    toolName: string | undefined,
    toolCallId: string | undefined,
    clock: ToolClock,
  ) => Record<string, unknown>;
  /** tool-error 时追加的额外字段（如自动推出设置面板的 panel） */
  extraForToolError?: (message: string) => Record<string, unknown>;
  /** tool-result 事件发出之后调用（如演示版补发结构化结果卡）。
   *  排在 tool 事件之后，保证「工具卡 → 结果卡」的既有事件顺序不变。 */
  afterToolResult?: (output: unknown, toolName: string | undefined) => void;
}

/** 工具耗时配对：tool-call 记起点，tool-result 算耗时 */
export function createToolClock(): ToolClock {
  const marks = new Map<string, { name: string; at: number; input?: unknown }>();
  return {
    start: (id, name, input) => {
      if (!id) return;
      marks.set(id, { name: name ?? "tool", at: Date.now(), input });
    },
    elapsed: (id) => {
      if (!id) return undefined;
      const m = marks.get(id);
      return m ? Date.now() - m.at : undefined;
    },
    inputOf: (id) => (id ? marks.get(id)?.input : undefined),
  };
}

export async function translateStream<M>(
  agent: StreamableLike<M>,
  opts: TranslateOptions<M>,
): Promise<StreamTranslation> {
  const { send, signal } = opts;
  const toolStart = createToolClock();
  let text = "";
  let think = "";
  let failure: string | null = null;

  try {
    const stream = await agent.stream({ messages: opts.messages, abortSignal: signal });
    for await (const p of stream.fullStream as AsyncIterable<StreamEvent>) {
      switch (p.type) {
        case "text-delta": {
          const t = deltaOf(p);
          if (t) {
            text += t;
            send({ t: "text", v: t });
          }
          break;
        }
        // 思考过程走独立 think 通道（前端渲染成草稿卡）：和正文分开累积，
        // 绝不混进 text（混进去会既当正文渲染、又被当成回答写回下一轮上下文）
        case "reasoning-delta": {
          const t = deltaOf(p);
          if (t) {
            think += t;
            send({ t: "think", v: t });
          }
          break;
        }
        case "reasoning-end": {
          // 只发段末标记（全文已逐字发过）：前端据此把这一段定格折叠
          send({ t: "think", phase: "end" });
          break;
        }
        case "tool-call": {
          toolStart.start(p.toolCallId, p.toolName, p.input);
          send({
            t: "tool",
            phase: "start",
            id: p.toolCallId ?? "",
            name: p.toolName ?? "tool",
            args: previewJson(p.input),
          });
          break;
        }
        case "tool-result": {
          const extra =
            opts.extraForToolResult?.(p.output, p.toolName, p.toolCallId, toolStart) ?? {};
          send({
            t: "tool",
            phase: "end",
            id: p.toolCallId ?? "",
            name: p.toolName ?? "tool",
            dur: toolStart.elapsed(p.toolCallId),
            brief: summarizeResult(p.output),
            out: previewJson(p.output),
            ...extra,
          });
          opts.afterToolResult?.(p.output, p.toolName);
          break;
        }
        case "tool-error": {
          const msg = p.error instanceof Error ? p.error.message : String(p.error ?? "");
          send({
            t: "tool",
            phase: "error",
            id: p.toolCallId ?? "",
            name: p.toolName ?? "tool",
            brief: oneLine(msg, 200),
            ...(opts.extraForToolError?.(msg) ?? {}),
          });
          break;
        }
        case "error": {
          failure = p.error instanceof Error ? p.error.message : String(p.error ?? "");
          break;
        }
        default:
          break;
      }
    }
  } catch (e) {
    if (!signal.aborted) failure = e instanceof Error ? e.message : String(e);
  }

  return { text, think, failure };
}
