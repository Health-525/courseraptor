/**
 * 行内终端渲染器 —— 替代 @ai-sdk/tui 的全屏重绘 UI
 *
 * 为什么不用 @ai-sdk/tui（实测 1.0.78 ~ 1.0.84 均如此）：
 * 1. 滚动只能 Up/Down 逐行 + PageUp/PageDown，不支持鼠标滚轮——它把输出
 *    挡在自绘视口里，终端原生的滚动条、滚轮、选中复制全都失效；
 * 2. 工具卡要等整轮结束才出现，长工具（登录重试 + 查询动辄 5-20 秒）期间
 *    只有一个转圈，用户看不到"模型正在干什么"。
 *
 * 行内渲染反过来：所有输出直接写进终端原生缓冲区，滚动交给 Windows
 * Terminal / iTerm 自己（滚轮、PageUp、搜索、复制全都能用）；工具在
 * 发起瞬间打一行 ⟳、结束时打一行 ✓ 摘要 + 耗时，过程全程可见。
 *
 * 与全屏卡片 UI 可运行时互切：/card 请求切回卡片模式（index.ts 外层循环
 * 消费返回值），全屏卡片模式下输入 /inline 切回本渲染器。
 */

import readline from "node:readline";

// ── 流事件（对 ai 包 fullStream 的宽松视图，字段按需取用）────────

/**
 * fullStream 的真实事件类型是庞大的泛型联合，行内渲染只关心其中 7 种。
 * 这里用「全部可选字段」的宽接口在边界收窄一次——不用联合类型是因为
 * catch-all 成员会吃掉按 type 的收窄，字段访问会全部报错。
 */
interface StreamEvent {
  type: string;
  /** 文本/推理增量（ai 7.x 的 fullStream 用 text 字段，兼容 delta） */
  text?: string;
  delta?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  totalUsage?: { inputTokens?: number; outputTokens?: number };
}

export interface TUIStreamableAgent {
  stream(options: {
    prompt: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<{ fullStream: AsyncIterable<unknown> }>;
}

/** 进程级 SIGINT 监听（流式中断用）。运行时切换 UI 会多次进入本模块， */
/** 用模块级引用去重，避免监听器累积 */
let sigintHandler: (() => void) | null = null;

// ── ANSI 辅助 ─────────────────────────────────────────────────

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const write = (s: string): void => {
  process.stdout.write(s);
};

// ── 摘要工具 ──────────────────────────────────────────────────

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 工具入参的一行摘要（发起瞬间展示，让用户立刻知道模型在查什么） */
function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return oneLine(input, 80);
  if (typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>).filter(
      ([, v]) => v !== undefined && v !== "" && v !== null
    );
    // 无参工具（get_schedule 等）不显示 "{}"，只留工具名
    if (!entries.length) return "";
    return entries
      .slice(0, 2)
      .map(([k, v]) => `${k}=${oneLine(String(v), 40)}`)
      .join(" ");
  }
  return oneLine(JSON.stringify(input), 80);
}

/**
 * 工具结果的一行摘要。工具层返回的字段名是给模型消费的，
 * 这里挑人能读懂的几个透出：summary/term/gpa/total/各列表长度。
 */
function summarizeResult(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return oneLine(output, 100);
  if (Array.isArray(output)) return `${output.length} 项`;
  if (typeof output !== "object") return oneLine(String(output), 60);

  const o = output as Record<string, unknown>;
  if (typeof o.error === "string") return `${RED}错误：${oneLine(o.error, 80)}${RESET}`;

  // 先数列表：total 与某个列表长度一致时不再重复显示
  const counts: string[] = [];
  const listLengths: number[] = [];
  for (const [k, label] of [
    ["courses", "门课"],
    ["exams", "场考试"],
    ["items", "条"],
  ] as const) {
    if (Array.isArray(o[k])) {
      counts.push(`${o[k].length} ${label}`);
      listLengths.push(o[k].length);
    }
  }

  const bits: string[] = [];
  for (const k of ["summary", "term", "gpa", "isXkOpenLabel", "title"]) {
    if (o[k] !== undefined && o[k] !== null) bits.push(oneLine(String(o[k]), 48));
  }
  if (
    o.total !== undefined &&
    o.total !== null &&
    !listLengths.includes(Number(o.total))
  ) {
    bits.push(String(o.total));
  }
  bits.push(...counts);
  return bits.join(" · ") || `${oneLine(JSON.stringify(o), 40)}…`;
}

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number | undefined): string {
  if (n == null) return "?";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ── 主循环 ────────────────────────────────────────────────────

export type InlineTUIResult = "exit" | "switch-card";

/**
 * 行内渲染器会话循环。返回值供 index.ts 的 UI 切换外层循环消费：
 * - "exit"：用户退出（exit/quit/退出/Ctrl+D/Ctrl+C）
 * - "switch-card"：用户输入 /card，请求切回全屏卡片 UI
 */
export async function runInlineTUI(options: {
  title: string;
  agent: TUIStreamableAgent;
}): Promise<InlineTUIResult> {
  const { agent } = options;

  write(
    `${CYAN}${options.title}${RESET}\n` +
      `${DIM}  Enter 发送 · 滚轮/PageUp 翻历史（终端原生） · /card 切回全屏卡片 · Ctrl+C 退出${RESET}\n\n`
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${CYAN}›${RESET} `,
    historySize: 50,
  });

  /** 非空的一轮流式处理期间置为非 null，Ctrl+C 走中断而非退出 */
  let activeAbort: AbortController | null = null;

  const exit = (): void => {
    rl.close();
  };

  // 提示符空闲时的 Ctrl+C：readline 拦截为事件（raw mode 下 ^C 不产生信号）
  rl.on("SIGINT", () => {
    if (!activeAbort) exit();
  });
  // 流式期间 stdin 已 pause 且关闭 raw mode，^C 走进程信号 -> 中断本轮。
  // 运行时可在两种 UI 间来回切换，本函数会被多次调用——先摘掉上一次的
  // 监听再挂新的，避免监听器累积和重复处理
  if (sigintHandler) process.removeListener("SIGINT", sigintHandler);
  const onSigint = (): void => {
    if (activeAbort) {
      activeAbort.abort();
      write(`${DIM}\n  （已中断本轮）${RESET}\n`);
    } else {
      exit();
    }
  };
  process.on("SIGINT", onSigint);
  sigintHandler = onSigint;

  const ask = (): Promise<string | null> =>
    new Promise((resolve) => {
      rl.once("line", (line) => resolve(line));
      rl.once("close", () => resolve(null));
      rl.prompt();
    });

  /** 增量字段优先取 text（ai 7.x 实测），兼容 delta */
  const deltaOf = (p: StreamEvent): string => p.text ?? p.delta ?? "";

  /** 处理一轮：流式渲染工具状态与文本 */
  const runOnce = async (prompt: string): Promise<void> => {
    const abort = new AbortController();
    activeAbort = abort;

    const toolStart = new Map<string, number>();
    const startedAt = Date.now();
    let wroteText = false;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    let failure: string | null = null;

    rl.pause();
    try {
      // 行内渲染只需要 fullStream 的这些事件；ai 包的完整类型比这宽得多，
      // 在边界上收窄一次，循环内部按上面的 StreamEvent 处理
      const stream = await agent.stream({ prompt, abortSignal: abort.signal });
      const events = stream.fullStream as AsyncIterable<StreamEvent>;

      for await (const p of events) {
        switch (p.type) {
          case "tool-call": {
            const name = p.toolName ?? "tool";
            if (p.toolCallId) toolStart.set(p.toolCallId, Date.now());
            const input = summarizeInput(p.input);
            write(
              `  ${DIM}⟳ ${name}${input ? ` ${input}` : ""}…${RESET}\n`
            );
            break;
          }
          case "tool-result": {
            const name = p.toolName ?? "tool";
            const t0 = p.toolCallId ? toolStart.get(p.toolCallId) : undefined;
            const dur = t0 ? fmtDuration(Date.now() - t0) : "";
            const brief = summarizeResult(p.output);
            write(
              `  ${GREEN}✓${RESET} ${name}${dur ? ` ${DIM}· ${dur}${RESET}` : ""}` +
                `${brief ? ` ${DIM}· ${brief}${RESET}` : ""}\n`
            );
            break;
          }
          case "tool-error": {
            const name = p.toolName ?? "tool";
            const msg = p.error instanceof Error ? p.error.message : String(p.error ?? "");
            write(`  ${RED}✗ ${name} · ${oneLine(msg, 120)}${RESET}\n`);
            break;
          }
          case "text-delta": {
            const t = deltaOf(p);
            if (t) {
              write(t);
              wroteText = true;
            }
            break;
          }
          case "reasoning-delta": {
            // 默认不展示推理过程，与原 TUI 的 reasoning:"hidden" 一致
            if (process.env.RAPTOR_TUI_REASONING === "1") {
              const t = deltaOf(p);
              if (t) write(`${DIM}${t}${RESET}`);
            }
            break;
          }
          case "error": {
            const msg = p.error instanceof Error ? p.error.message : String(p.error ?? "");
            failure = oneLine(msg, 200);
            break;
          }
          case "finish": {
            if (p.totalUsage) usage = p.totalUsage;
            break;
          }
          default:
            break;
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        failure = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (wroteText) write("\n");
      if (failure) {
        write(`  ${RED}✗ ${failure}${RESET}\n`);
      }
      const total = fmtDuration(Date.now() - startedAt);
      const tokens =
        usage &&
        `↑${fmtTokens(usage.inputTokens)} ↓${fmtTokens(usage.outputTokens)} tokens`;
      write(`  ${DIM}── ${abort.signal.aborted ? "已中断" : "完成"} · ${total}` +
        `${tokens ? ` · ${tokens}` : ""}${RESET}\n\n`);
      activeAbort = null;
      rl.resume();
    }
  };

  // ── 会话循环 ────────────────────────────────────────────────
  let result: InlineTUIResult = "exit";
  while (true) {
    const line = await ask();
    if (line === null) break; // Ctrl+D / close
    const prompt = line.trim();
    if (!prompt) continue;
    if (prompt === "/card") {
      result = "switch-card";
      break;
    }
    if (prompt.startsWith("/key")) {
      const { setDeepSeekApiKey } = await import("../onboarding");
      const res = setDeepSeekApiKey(prompt.slice(4).trim());
      write(`  ${res.ok ? "" : ""}${res.message}${RESET}\n\n`);
      continue;
    }
    if (["exit", "quit", "/exit", "退出"].includes(prompt.toLowerCase())) break;
    await runOnce(prompt);
  }

  if (sigintHandler === onSigint) {
    process.removeListener("SIGINT", onSigint);
    sigintHandler = null;
  }
  rl.close();
  return result;
}
