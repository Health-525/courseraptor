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
 *
 * 斜杠命令菜单：readline 不留插手渲染/按键的口子，所以 stdin 先过一层
 * 原始按键代理——提示符下输入 "/" 时在输入行下方自绘候选菜单：
 *   - ↑/↓ = 移动选中项（消费掉，不进 readline，否则变成历史翻阅）
 *   - Tab / 回车 = 补全选中命令再继续（回车补全后直接提交）
 *   - ESC = 收起菜单，且本行内不再自动弹出（删空或提交后解除）
 * 其余按键原样透传，菜单随行文本自动开关/过滤。
 * 菜单绘制全部用光标相对移动（下移不滚屏、\n 在屏底自然滚屏、画完按行数
 * 上移 + 绝对列归位），不查询光标绝对位置，readline 对这一切无感。
 * 菜单刷新挂在 keypress 事件上：事件触发时 readline 已处理完按键，
 * rl.line 是最新行文本。见 src/tui/slash-menu.ts（共用注册表与渲染）。
 */

import readline from "node:readline";
import { PassThrough } from "node:stream";
import {
  coalesceText,
  commandsForMode,
  displayWidth,
  filterSlashCommands,
  isLocalKeyCommandWithArgumentPrefix,
  isLocalOnlyKeyCommand,
  isPrintableKey,
  renderSlashMenu,
  type SlashCommand,
  splitKeys,
} from "./slash-menu";

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
      ([, v]) => v !== undefined && v !== "" && v !== null,
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
  if (o.total !== undefined && o.total !== null && !listLengths.includes(Number(o.total))) {
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

export type InlineTUIResult = "exit" | "switch-card" | "setup-key";

/**
 * 行内渲染器会话循环。返回值供 index.ts 的 UI 切换外层循环消费：
 * - "exit"：用户退出（exit/quit/退出/Ctrl+D/Ctrl+C）
 * - "switch-card"：用户输入 /card，请求切回全屏卡片 UI
 */
export async function runInlineTUI(options: {
  title: string;
  agent: TUIStreamableAgent;
  /**
   * 输出目标，默认 process.stdout。渲染器与 readline 的重绘全部走它——
   * 测试注入一个内存流就能捕获整帧 ANSI 做断言，不必劫持全局 stdout
   * （劫持会把 test runner 自己的报告一起吞掉）。
   */
  output?: NodeJS.WriteStream;
  /** 输入源，默认 process.stdin。同上，测试注入即可驱动按键 */
  input?: NodeJS.ReadStream;
}): Promise<InlineTUIResult> {
  const { agent } = options;
  const out = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const write = (s: string): void => {
    out.write(s);
  };

  write(
    `${CYAN}${options.title}${RESET}\n` +
      `${DIM}  Enter 发送 · 输入 / 唤出命令菜单（↑↓ 选择） · /card 切回全屏卡片 · Ctrl+C 退出${RESET}\n\n`,
  );

  // ── 输入代理：原始按键先过菜单拦截，再喂给 readline ─────────
  // readline 需要 isTTY 才进交互模式、会对 input 调 setRawMode，
  // 前者伪造为 true，后者转发给真实 stdin
  const proxy = new PassThrough();
  Object.defineProperty(proxy, "isTTY", { value: true });
  Object.defineProperty(proxy, "setRawMode", {
    value: (flag: boolean) => input.setRawMode?.(flag),
  });

  const rl = readline.createInterface({
    input: proxy,
    output: out,
    prompt: `${CYAN}›${RESET} `,
    historySize: 50,
  });

  /** 非空的一轮流式处理期间置为非 null，Ctrl+C 走中断而非退出 */
  let activeAbort: AbortController | null = null;

  // ── 斜杠命令候选菜单 ─────────────────────────────────────────
  const menuPool = commandsForMode("inline");
  let menuItems: SlashCommand[] = [];
  let menuIndex = 0;
  /** 当前画在屏上的菜单行数（0 = 收起）。擦除靠它做相对下移 */
  let menuRows = 0;
  /** 上次生成菜单的查询串（= 输入行），变了才重画 */
  let menuQuery = "";
  /** 回车补全 → line 事件之间的过渡期：补全字符的 keypress 不再唤出菜单 */
  let suppressMenu = false;
  /** ESC 收起后本行内不再自动弹出（对齐主流 CLI）；行清空或提交后解除 */
  let menuDismissed = false;
  /** 原始输入镜像仅用于秘密边界；普通文本保持 readline 现有行为。 */
  let rawLine = "";
  /** 旧式 /key <secret> 从首个空白开始吞掉，防止进入 readline/history/屏幕。 */
  let blockingKeyArgument = false;

  const resetMenuState = (): void => {
    menuItems = [];
    menuIndex = 0;
    menuQuery = "";
    menuDismissed = false;
  };

  /** 提示符可见宽度："› " 两列（光标列 = 提示符 + 光标前文本显示宽度） */
  const PROMPT_COLS = 2;
  const cursorCol = (): number => {
    const line = rl.line ?? "";
    const idx = Math.min(rl.cursor ?? line.length, line.length);
    return PROMPT_COLS + displayWidth(line.slice(0, idx));
  };

  /** 擦除菜单：从光标行向下逐行清除再上移回光标行。\x1b[B 在屏底只会
   * 钳住不滚屏，而菜单恰好画满到屏底，全程相对移动、永不产生滚动 */
  const eraseMenu = (): void => {
    if (!menuRows) return;
    for (let i = 0; i < menuRows; i++) write("\x1b[B\x1b[2K");
    write(`\x1b[${menuRows}A`);
    menuRows = 0;
  };

  /** 画菜单：光标行下方。行首 \n 在屏底让终端自然滚屏（屏上内容整体
   * 上移、光标留在原行），画完按菜单行数上移 + 绝对列归位——无论滚了
   * 几行，落点都是光标原位置，readline 对这次「出走再回来」无感 */
  const drawMenu = (): void => {
    const lines = renderSlashMenu(menuItems, menuIndex);
    if (!lines.length) {
      eraseMenu();
      return;
    }
    eraseMenu();
    write(`\r\n${lines.map((l) => `\x1b[2K${l}`).join("\r\n")}`);
    menuRows = lines.length;
    write(`\x1b[${menuRows}A\r\x1b[${cursorCol() + 1}G`);
  };

  const refreshSlashMenu = (): void => {
    if (suppressMenu || activeAbort) return;
    const line = rl.line ?? "";
    // 删空 = 新的一行，解除 ESC 的菜单抑制（下一行是新的意图）
    if (!line) menuDismissed = false;
    if (menuDismissed) return;
    const query = line.startsWith("/") ? line : "";
    if (query === menuQuery) return;
    menuQuery = query;
    menuItems = query ? filterSlashCommands(query, menuPool) : [];
    menuIndex = 0;
    drawMenu();
  };

  const writeBackspace = (): void => {
    // stdin 经 PassThrough 代理后，readline 不再把 DEL 解析成编辑键；直接复用
    // 它自己的删除实现，保留 Unicode 光标与终端重绘逻辑。
    (rl as typeof rl & { _deleteLeft(): void })._deleteLeft();
    refreshSlashMenu();
  };

  /** Tab/回车补全：把选中命令的剩余字符写进 readline（走与打字相同的
   * 按键路径，readline 自己刷新输入行）。带参数命令额外补一个空格并等待输入。
   * @returns 是否已进入等待参数状态；此时回车不应提交整行。 */
  const completeInline = (): boolean => {
    const sel = menuItems[Math.min(menuIndex, menuItems.length - 1)];
    const line = rl.line ?? "";
    if (!sel?.name.startsWith(line)) return false;
    const suffix = sel.name.slice(line.length);
    const awaitingArgument = Boolean(sel.requiresArgument && !line.includes(" "));
    if (suffix || awaitingArgument) proxy.write(`${suffix}${awaitingArgument ? " " : ""}`);
    return awaitingArgument;
  };

  const handleRawKey = (text: string): void => {
    // 防御：吞掉终端的光标位置报告（实现不依赖 CPR，混进输入行会成乱码）
    if (/^\x1b\[\d+;\d+R$/.test(text)) return;
    if (text === "\x7f" || text === "\b") {
      writeBackspace();
      return;
    }
    if (suppressMenu) {
      proxy.write(text);
      return;
    }
    if (menuRows > 0) {
      if (text === "\x1b[A" || text === "\x1b[B") {
        const n = menuItems.length;
        if (n) {
          menuIndex = text === "\x1b[A" ? (menuIndex - 1 + n) % n : (menuIndex + 1) % n;
          drawMenu();
        }
        return;
      }
      if (text === "\t") {
        if (completeInline()) {
          eraseMenu();
          resetMenuState();
        }
        return;
      }
      if (text === "\r" || text === "\n") {
        // 先擦菜单再补全。/key 这类带参命令仅补全并留在输入框，等待用户继续输入。
        eraseMenu();
        suppressMenu = true;
        const awaitingArgument = completeInline();
        resetMenuState();
        if (awaitingArgument) {
          suppressMenu = false;
          return;
        }
        proxy.write(text);
        return;
      }
      if (text === "\x1b") {
        // ESC 只收起菜单、不进输入行，且本行内不再自动弹出
        eraseMenu();
        resetMenuState();
        menuDismissed = true;
        return;
      }
      if (text === "\x03" || text === "\x04") {
        eraseMenu(); // Ctrl+C / Ctrl+D：菜单区先擦掉再走 readline 的退出路径
        resetMenuState();
      }
    }
    proxy.write(text);
  };

  const rejectVisibleKeyArgument = (): void => {
    eraseMenu();
    resetMenuState();
    for (let i = 0; i < (rl.line ?? "").length; i++) writeBackspace();
    rawLine = "";
    blockingKeyArgument = true;
  };

  /** 在 readline 前处理秘密命令参数，保证它们不会被回显或写入 history。 */
  const handleProtectedRawKey = (text: string): void => {
    if (blockingKeyArgument) {
      if (text === "\r" || text === "\n") {
        blockingKeyArgument = false;
        rawLine = "";
        write(`\r\n  ${YELLOW}请直接输入无参数 /key，再按提示安全设置 API Key。${RESET}\n`);
        rl.prompt();
      } else if (text === "\x1b") {
        blockingKeyArgument = false;
        rawLine = "";
        rl.prompt();
      }
      return;
    }

    if (isPrintableKey(text)) {
      const candidate =
        rawLine === "" ? text : rawLine === "\u0000" ? rawLine : `${rawLine}${text}`;
      if (isLocalKeyCommandWithArgumentPrefix(candidate)) {
        rejectVisibleKeyArgument();
        return;
      }
      rawLine = candidate.startsWith("/") ? candidate : "\u0000";
    } else if (text === "\x7f" || text === "\b") {
      rawLine = rawLine === "\u0000" ? rawLine : rawLine.slice(0, -1);
    } else if (text === "\r" || text === "\n") {
      rawLine = "";
    }
    handleRawKey(text);
  };

  const onRawData = (chunk: Buffer): void => {
    // 流式期间 readline 已 pause，不做菜单交互，按键原样进代理缓冲
    //（恢复后回放，与 pause 前的输入行为一致）
    if (activeAbort) {
      proxy.write(chunk);
      return;
    }
    // 一次 data 事件可能含多个按键（连按退格 / 粘贴 / 输入法整段上屏），
    // 必须切成单个按键序列再逐个处理——否则菜单打开时连按 ↑↓ 会整块漏给
    // readline，被当成历史翻阅把上一轮内容翻进输入行。
    // 切完再把连续文本合并回一块（见 coalesceText），避免逐字符喂 readline
    const keys = coalesceText(splitKeys(chunk.toString("utf8")));
    for (const key of keys) handleProtectedRawKey(key);
  };

  // readline 处理完按键（行文本已更新、光标已归位）后刷新菜单过滤。
  // keypress 发在输入流（= 下面的 proxy）上而不是接口对象上
  // （emitKeypressEvents(input, this)），接口自身的 onkeypress 先挂先跑，
  // 这里后挂、拿到的是已处理完的行文本。
  proxy.on("keypress", refreshSlashMenu);

  /** 非空的一轮流式处理期间置为非 null，Ctrl+C 走中断而非退出 */

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
      rl.once("line", (line) => {
        suppressMenu = false;
        // 粘贴等绕过菜单回车拦截的路径可能残留菜单：光标此时落在菜单
        // 第一行，\r\x1b[J 恰好把它整块擦掉
        if (menuRows) {
          write("\r\x1b[J");
          menuRows = 0;
          resetMenuState();
        }
        resolve(line);
      });
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
            write(`  ${DIM}⟳ ${name}${input ? ` ${input}` : ""}…${RESET}\n`);
            break;
          }
          case "tool-result": {
            const name = p.toolName ?? "tool";
            const t0 = p.toolCallId ? toolStart.get(p.toolCallId) : undefined;
            const dur = t0 ? fmtDuration(Date.now() - t0) : "";
            const brief = summarizeResult(p.output);
            write(
              `  ${GREEN}✓${RESET} ${name}${dur ? ` ${DIM}· ${dur}${RESET}` : ""}` +
                `${brief ? ` ${DIM}· ${brief}${RESET}` : ""}\n`,
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
        usage && `↑${fmtTokens(usage.inputTokens)} ↓${fmtTokens(usage.outputTokens)} tokens`;
      write(
        `  ${DIM}── ${abort.signal.aborted ? "已中断" : "完成"} · ${total}` +
          `${tokens ? ` · ${tokens}` : ""}${RESET}\n\n`,
      );
      activeAbort = null;
      rl.resume();
    }
  };

  // ── 会话循环 ────────────────────────────────────────────────
  input.resume();
  input.on("data", onRawData);

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
    if (isLocalOnlyKeyCommand(prompt)) {
      if (prompt.toLowerCase() === "/key") {
        result = "setup-key";
        break;
      }
      // 原始按键层已阻断参数；此处作为粘贴/非 TTY 路径的最后一道边界。
      write(`  ${YELLOW}请直接输入无参数 /key，再按提示安全设置 API Key。${RESET}\n\n`);
      continue;
    }
    if (prompt === "/update") {
      const { applyUpdate } = await import("../updater");
      try {
        const res = await applyUpdate((m) => write(`  ${m}\n`));
        write(`  ${res}\n\n`);
      } catch (e) {
        write(`  ${RED}❌ 更新失败：${e instanceof Error ? e.message : String(e)}${RESET}\n\n`);
      }
      continue;
    }
    if (["exit", "quit", "/exit", "退出"].includes(prompt.toLowerCase())) break;
    await runOnce(prompt);
  }

  input.removeListener("data", onRawData);
  if (sigintHandler === onSigint) {
    process.removeListener("SIGINT", onSigint);
    sigintHandler = null;
  }
  input.pause();
  rl.close();
  return result;
}
