/**
 * 键位代理：在真实 stdin 和 @ai-sdk/tui 之间插一层，补齐库缺失的交互。
 *
 * 键位语义（1.0.84 实测）：流式期间 ESC 和 Ctrl+C 都会打断当前回复并终结
 * 整个会话，它的词表里没有「打断但继续」。期望的约定（Claude Code 等主流 CLI）：
 *   - ESC    = 打断当前回复，回到输入框（本代理拦下单字节 ESC，转成软打断
 *              信号，由 agent 包装层消费：src/tui/soft-interrupt.ts）
 *   - Ctrl+C = 退出程序（原样透传。库任何状态下按 Ctrl+C 都会打断在途
 *              回复并走 runAgentTUI 正常 resolve 的优雅退出路径）
 *
 * 滚轮支持：库完全不解析鼠标事件，又挡在备用屏幕里，终端原生滚动全失效，
 * 用户只能按住 ↑/↓ 逐行挪。这里自己启用 SGR 鼠标上报（1000/1006），把滚轮
 * 事件翻译成合成方向键（一格 3 行），其余鼠标事件（按下/释放/移动）吞掉。
 * ↑/↓ 本身也放大成 3 行——库固定每次 1 行，逐行挪太慢；库的 ↑/↓ 只用于
 * 滚动（输入框不支持历史翻阅），放大无副作用。菜单打开时例外（见下）。
 *
 * 斜杠命令切换 UI：提示符下输入 /inline 回车 → 不把命令提交给 TUI，而是
 * 注入 Ctrl+C 让 runAgentTUI 优雅返回，index.ts 据此切到行内渲染器。库不
 * 支持提交前拦截，只能在代理里镜像输入框文本（退格同步回退）来识别。
 * 注入按 300ms 重试到生效为止：若命令是流式期间敲的（库忽略字符但代理
 * 镜像仍在累积），第一次 Ctrl+C 只会打断在途回复，重试确保回到输入框后
 * 必然触发退出。
 *
 * 斜杠命令菜单：镜像文本以 / 开头时按前缀过滤候选命令，渲染成菜单行写入
 * globalThis.__raptorSlashMenu（scripts/patch-tui.mjs 的补丁把它插进帧）。
 * 打字/删字本身会让库重绘、菜单随之刷新；↑/↓ 换选中项不走库的按键管线，
 * 要 emit stdout 的 resize 强制全帧重画。菜单打开时按键语义接管：
 *   - ↑/↓ 或滚轮 = 移动选中项（不透传，否则变成正文滚动）
 *   - Tab = 把选中命令的剩余字符补进输入行（逐条 write，parseKey 逐条匹配）
 *   - 回车 = 先补全再走斜杠命令分发；普通文本不受影响
 *   - ESC = 只收起菜单（不发软打断），且本行内不再自动弹出；换行自动解除
 * 菜单未打开时 ESC 才是打断当前回复。
 *
 * 一个 data 事件可能含多个按键（连按退格、粘贴、输入法整段上屏），必须先
 * splitKeys 切成单个按键序列再逐个处理——连按三次退格拿到 "\x7f\x7f\x7f"，
 * 既不等于 "\x7f" 又满足 `text >= " "`，整块判断会被当成普通字符拼进命令
 * 镜像，镜像一脏前缀过滤就永远匹配不上，菜单从此假死。
 *
 * 为什么合成事件必须逐条 write：库的 parseKey 对整个 chunk 做**精确**匹配
 * （一次只认一个按键序列），多条拼在一个 chunk 里会被丢弃。
 *
 * raw mode 不在这里管：库会检查 input.isTTY 并调 input.setRawMode，前者
 * 伪造为 true，后者转发给真实 stdin，开关随库的生命周期走。鼠标上报是库
 * 不感知的模式，由本模块启用、restore() 时关闭。
 */

import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { emitSoftInterrupt } from "./soft-interrupt";
import {
  filterSlashCommands,
  renderSlashMenu,
  setCardSlashMenu,
  repaintCardFrame,
  coalesceText,
  isPrintableKey,
  isLocalKeyCommandWithArgumentPrefix,
  splitKeys,
  type SlashCommand,
} from "./slash-menu";

/** 一次滚轮滚格 / 一次 ↑/↓ 对应的滚动行数（库原生是 1，太慢） */
const SCROLL_LINES = 3;

export interface SlashCommandSpec {
  desc: string;
  /** 从候选菜单确认后先等待参数，而不是以空参数立即执行。 */
  requiresArgument?: boolean;
  /** 带参数命令（如旧式 /key sk-xxx）是否只允许无参调用。 */
  rejectsArgument?: boolean;
  /** 参数被拒绝时的本地提示；绝不能把命令继续交给 Agent。 */
  onArgumentRejected?: () => void;
  /** 提示符下回车 → 请求切换的 UI 模式（index.ts 消费 switchRequest） */
  switchTo?: string;
  /** 带参命令（如 /key sk-xxx）：注入退格清行后调用 */
  handler?: (arg: string) => void;
}

export interface KeyProxy {
  /** 传给 runAgentTUI 的 userInput */
  stream: Readable;
  /** TUI 退出后调用：解除转发、关鼠标上报。嵌入模式下 QQ 桥会让进程继续存活， */
  /** 不还原的话按键会继续流向已退出的 UI */
  restore(): void;
  /** 斜杠命令已请求切换到的目标模式；未触发为 null */
  readonly switchRequest: string | null;
}

export interface KeyProxyOptions {
  /** 斜杠命令表：菜单候选来自这里，desc 同时是菜单里的说明文案 */
  commands?: Record<string, SlashCommandSpec>;
}

export function createKeyProxy(
  stdin: Readable,
  options: KeyProxyOptions = {},
): KeyProxy {
  const commands = options.commands ?? {};
  const proxy = new PassThrough();
  // 库检查 input.isTTY 才启用交互模式，并对 input 调 setRawMode——
  // 前者伪造为 true，后者转发给真实 stdin
  Object.defineProperty(proxy, "isTTY", { value: true });
  Object.defineProperty(proxy, "setRawMode", {
    value: (flag: boolean) => (stdin as NodeJS.ReadStream).setRawMode?.(flag),
  });

  let restored = false;
  let switchTarget: string | null = null;
  /** 镜像输入框文本，识别斜杠命令；\u0000 标记本行已不是命令 */
  let cmdBuffer = "";
  let retryTimer: NodeJS.Timeout | undefined;
  /** 旧式 /key <secret> 的参数段：从首个空白开始吞掉，绝不写入 TUI。 */
  let blockingKeyArgument = false;

  // ── 斜杠菜单状态。候选池直接来自 commands 表——菜单展示 ⇔ 回车分发
  // 永远一致，不会出现菜单里有、分发却不认识的命令 ──
  const menuPool: SlashCommand[] = Object.entries(commands).map(([name, spec]) => ({
    name,
    desc: spec.desc,
    requiresArgument: spec.requiresArgument,
  }));
  let menuItems: SlashCommand[] = [];
  let menuIndex = 0;
  /** 上次生成菜单的查询串；变了才重建菜单（打字伴随库重绘，无需手动） */
  let menuQuery = "";
  /** ESC 收起菜单后，本行内不再自动弹出。对齐主流 CLI：ESC 关的是「这次提
   *  示」而不是「这个字符」，否则收起后每敲一个键菜单又糊上来，等于关不掉。
   *  行被提交或删空后重置——新的一行是新的意图 */
  let menuDismissed = false;

  const refreshMenu = (): void => {
    if (menuDismissed) return;
    const query = cmdBuffer.startsWith("/") ? cmdBuffer : "";
    if (query === menuQuery) return;
    menuQuery = query;
    menuItems = query ? filterSlashCommands(query, menuPool) : [];
    menuIndex = 0;
    setCardSlashMenu(renderSlashMenu(menuItems, menuIndex));
  };

  /** 一行结束（提交或删空）：镜像与菜单抑制状态一起归零 */
  const resetLine = (): void => {
    cmdBuffer = "";
    menuDismissed = false;
  };

  /** 收起菜单。命令分发/ESC 路径没有字符透传、库不会自发重绘，需手动触发 */
  const hideMenu = (repaint = true): void => {
    menuItems = [];
    menuQuery = "";
    setCardSlashMenu([]);
    if (repaint) repaintCardFrame();
  };

  /** Tab/回车的补全：把选中命令的剩余字符逐条写入库的输入行（parseKey
   * 对 chunk 精确匹配，必须逐条），镜像同步成完整命令。
   * @returns 是否已补全为等待参数的命令；此时回车不能继续分发。 */
  const completeSelection = (): boolean => {
    const sel = menuItems[menuIndex] ?? menuItems[0];
    if (!sel) return false;
    const suffix = sel.name.slice(cmdBuffer.length);
    for (const ch of suffix) proxy.write(ch);
    const awaitingArgument = Boolean(sel.requiresArgument && !cmdBuffer.includes(" "));
    if (awaitingArgument) proxy.write(" ");
    cmdBuffer = `${sel.name}${awaitingArgument ? " " : ""}`;
    return awaitingArgument;
  };

  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (retryTimer) clearInterval(retryTimer);
    hideMenu(false);
    try {
      stdin.removeListener("data", onData);
      stdin.pause();
      // 关鼠标上报（与启用顺序相反）
      process.stdout.write("\x1b[?1006l\x1b[?1000l");
    } catch {
      /* 恢复失败也不阻塞后续流程 */
    }
  };

  /** 触发切换：注入 Ctrl+C 走库的优雅退出路径。立即注入一次，再按 300ms
   * 重试——若库正在流式中（命令是流式期间敲的），第一次只会打断在途回复，
   * 重试保证回到输入框后必然退出。restore() 时清掉定时器。 */
  const triggerSwitch = (target: string): void => {
    switchTarget = target;
    proxy.write("\x03");
    retryTimer = setInterval(() => {
      if (!restored) proxy.write("\x03");
    }, 300);
    retryTimer.unref?.();
  };

  /** 可打印字符（含中文）。DEL(0x7f) 必须排除：它满足 `>= " "` 却其实是退格，
   *  早先正是靠这条混进命令镜像、把镜像带歪到菜单永久匹配不上 */
  const isPrintable = isPrintableKey;

  /**
   * 处理**一个**按键序列。调用方负责把 chunk 先切成按键再逐个送进来——终端
   * 不保证一次 data 事件只给一个按键，整块喂给按单按键写的判断必然误判。
   */
  const handleKey = (text: string): void => {
    // 旧式 /key <secret>：从第一个空白开始就不让后续字符进入 TUI 输入框。
    if (blockingKeyArgument) {
      if (text === "\r" || text === "\n") {
        blockingKeyArgument = false;
        resetLine();
        commands["/key"]?.onArgumentRejected?.();
        hideMenu();
      } else if (text === "\x1b") {
        blockingKeyArgument = false;
        resetLine();
        hideMenu();
      }
      return;
    }

    // ── 菜单打开时，按键语义被选择逻辑接管 ──
    if (menuItems.length) {
      if (text === "\x1b[A" || text === "\x1b[B") {
        const n = menuItems.length;
        menuIndex =
          text === "\x1b[A" ? (menuIndex - 1 + n) % n : (menuIndex + 1) % n;
        setCardSlashMenu(renderSlashMenu(menuItems, menuIndex));
        repaintCardFrame();
        return;
      }
      if (text === "\t") {
        if (completeSelection()) hideMenu();
        return;
      }
      if (text === "\x1b") {
        // 只收菜单、不发软打断：用户此刻想关的是菜单，不是中止回复
        hideMenu();
        menuDismissed = true;
        return;
      }
      // 回车不在这里截断：要先补全再走下面的分发路径
    }

    // 孤立 ESC（菜单已关）：打断当前回复、回到输入框（库没有这个语义）
    if (text === "\x1b") {
      emitSoftInterrupt();
      return;
    }

    // ↑/↓ 放大步长（parseKey 要求整块恰好是一个序列，所以必须拆条写）。
    // 菜单打开时 ↑/↓ 已被上面的选择语义截走，到不了这里
    if (text === "\x1b[A" || text === "\x1b[B") {
      for (let i = 0; i < SCROLL_LINES; i++) proxy.write(text);
      return;
    }

    // 斜杠命令镜像：整行以 / 开头才跟踪，回车命中则处理、不提交命令
    if (Object.keys(commands).length) {
      if (text === "\r" || text === "\n") {
        // 菜单打开时回车 = 补全后分发；需要参数的命令只补全并留在输入框。
        if (menuItems.length && completeSelection()) {
          hideMenu();
          return;
        }
        const cmd = cmdBuffer.trim();
        resetLine();
        const spaceIdx = cmd.indexOf(" ");
        const cmdName = spaceIdx > 0 ? cmd.slice(0, spaceIdx) : cmd;
        // 菜单补全仍保持大小写敏感；但 /key 是秘密边界，任何大小写变体都必须本地处理。
        const commandName = cmdName.toLowerCase() === "/key" ? "/key" : cmdName;
        if (commandName in commands) {
          const entry = commands[commandName];
          if (entry.rejectsArgument && spaceIdx > 0) {
            // 旧式 /key sk-xxx 已在输入框可见；立刻擦除并只显示无秘密的本地提示。
            for (let i = 0; i < cmd.length; i++) proxy.write("\x7f");
            entry.onArgumentRejected?.();
            hideMenu();
            return;
          }
          if (entry.switchTo !== undefined) {
            triggerSwitch(entry.switchTo);
          } else {
            // 带参命令（如 /key sk-xxx）：注入退格清空输入行（逐条 write，
            // 库的 parseKey 对 chunk 精确匹配），参数交给 handler，不提交
            for (let i = 0; i < cmd.length; i++) proxy.write("\x7f");
            entry.handler?.(spaceIdx > 0 ? cmd.slice(spaceIdx + 1).trim() : "");
          }
          hideMenu(); // 分发路径没有字符透传，库不会自发重绘
          return;
        }
        hideMenu(false); // 非命令提交：菜单本应已关，兜底清全局即可
      } else if (text === "\x7f" || text === "\b") {
        cmdBuffer = cmdBuffer.slice(0, -1);
        if (!cmdBuffer) resetLine(); // 删空 = 本行结束，解除菜单抑制
        refreshMenu();
      } else if (isPrintable(text)) {
        const candidate = cmdBuffer === ""
          ? (text.startsWith("/") ? text : "\u0000")
          : cmdBuffer.startsWith("/")
            ? `${cmdBuffer}${text}`
            : cmdBuffer;
        if (isLocalKeyCommandWithArgumentPrefix(candidate)) {
          // 已显示的命令名前缀也立即擦掉；参数段从未写入 TUI。
          for (let i = 0; i < cmdBuffer.length; i++) proxy.write("\x7f");
          resetLine();
          hideMenu();
          blockingKeyArgument = true;
          return;
        }
        cmdBuffer = candidate;
        refreshMenu();
      }
    }

    proxy.write(text);
  };

  const onData = (chunk: Buffer): void => {
    if (restored || switchTarget !== null) return;

    // SGR 鼠标事件：滚轮(编码 64/65)翻译成合成方向键，其余（按下/释放/移动）吞掉
    let wheelUp = 0;
    let wheelDown = 0;
    const text = chunk.toString("utf8").replace(
      /\x1b\[<(\d+);\d+;\d+[Mm]/g,
      (_m, code: string) => {
        if (code === "64") wheelUp++;
        else if (code === "65") wheelDown++;
        return "";
      },
    );

    // 菜单打开时滚轮 = 移动选中项（一格一项，放大就跳过头了）；
    // 否则 = 滚正文（一格 3 行）
    const step = menuItems.length ? 1 : SCROLL_LINES;
    const synth: string[] = [];
    for (let i = 0; i < wheelUp * step; i++) synth.push("\x1b[A");
    for (let i = 0; i < wheelDown * step; i++) synth.push("\x1b[B");
    for (const key of synth) {
      // 菜单内必须走 handleKey 才能命中选择分支；菜单外已经放大成 3 行，
      // 再进 handleKey 会被二次放大成 9 行，只能直接写
      if (menuItems.length) handleKey(key);
      else proxy.write(key);
    }

    // 原始按键：先切成单个按键序列再逐个处理（连按退格 / 粘贴 / 输入法整段
    // 上屏都会挤在一个 chunk），随后把连续文本合并回一块再送给库——逐字符写
    // 会让库每个字符重绘一次，粘贴长文本时卡得明显
    for (const key of coalesceText(splitKeys(text))) handleKey(key);
  };

  stdin.resume();
  stdin.on("data", onData);

  // 启用 SGR 鼠标上报（滚轮）；restore() 时按相反顺序关闭。
  // 只在代理存活期（全屏卡片 UI 期间）启用，行内模式依赖终端原生滚动
  process.stdout.write("\x1b[?1000h\x1b[?1006h");

  return {
    stream: proxy,
    restore,
    get switchRequest() {
      return switchTarget;
    },
  };
}
