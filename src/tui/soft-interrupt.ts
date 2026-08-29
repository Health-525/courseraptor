/**
 * 软打断：ESC 只中止当前回复、回到输入框，会话继续。
 *
 * 为什么需要：@ai-sdk/tui 默认渲染器的键位词表里没有「打断但继续」——流式
 * 期间 ESC 和 Ctrl+C 都会置 _interrupted 并终结整个会话（1.0.84 实测）。这个
 * 语义无法在按键层修正，只能在 agent 包装层实现：键位代理（keys.ts）拦截
 * ESC 发出信号，本模块中止本轮底层生成流。库发现流提前结束会自动补 finish、
 * 关闭未闭合的文本片段（textStreamToUIMessageStream 的收尾逻辑），按「正常
 * 完成」处理，回到输入框。
 *
 * Ctrl+C 不经过这里：原样透传给库，任何状态下都走 runAgentTUI 正常 resolve
 * 的优雅退出路径。
 */

type SoftInterruptHandler = () => void;

const handlers = new Set<SoftInterruptHandler>();

/** 注册软打断监听，返回注销函数 */
export function onSoftInterrupt(handler: SoftInterruptHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitSoftInterrupt(): void {
  for (const handler of handlers) handler();
}

/** 库调用 agent.stream 的运行时入参（库不导出精确类型，按用到的字段收窄） */
interface TUIStreamArgs {
  prompt: string;
  abortSignal?: AbortSignal;
}

/**
 * 包装 agent：软打断信号 → 中止本轮生成，其余行为（tools 等）原样透传。
 * 软打断用独立的 AbortController 实现，和库传入的 abortSignal 合并——
 * 工具执行拿到的是合并后的信号，长工具（盯课/抢课）也能被 ESC 停下来。
 */
export function withSoftInterrupt<
  A extends {
    tools?: unknown;
    stream(args: TUIStreamArgs): PromiseLike<{ fullStream: AsyncIterable<unknown> }>;
  },
>(agent: A): A {
  const wrappedStream = async (args: TUIStreamArgs) => {
    const soft = new AbortController();
    const off = onSoftInterrupt(() => soft.abort());
    // 库侧中止（Ctrl+C 退出路径）时对齐，避免两边信号不一致
    args.abortSignal?.addEventListener("abort", () => soft.abort(), { once: true });

    const result = await agent.stream({ ...args, abortSignal: soft.signal });
    const inner = result.fullStream;
    return {
      ...result,
      fullStream: (async function* () {
        try {
          for await (const part of inner) {
            // abort 事件是软打断自己的痕迹，滤掉避免库往界面上渲染错误卡片
            if (soft.signal.aborted && (part as { type?: string })?.type === "abort") {
              continue;
            }
            yield part;
          }
        } catch (error) {
          // 软打断引发的底层流错误吞掉，让库按「正常结束」收尾
          if (!soft.signal.aborted) throw error;
        } finally {
          off();
        }
      })(),
    };
  };

  // 只代理库实际访问的两个成员（stream/tools），不 spread——tools 可能是
  // 原型上的 getter，展开会丢
  return {
    get tools() {
      return agent.tools;
    },
    stream: wrappedStream,
  } as unknown as A;
}
