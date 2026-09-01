/**
 * 斜杠命令候选菜单 —— 输入 "/" 即弹出内置命令列表，↑/↓ 选择、Tab/Enter 补全。
 *
 * 两种 UI 共用命令注册表、前缀过滤和菜单框渲染，落地方式各自不同：
 * - 卡片模式（keys.ts 采集按键，scripts/patch-tui.mjs 补丁渲染）：菜单行写入
 *   globalThis.__raptorSlashMenu，库每帧重绘时插到正文框与输入框之间。↑/↓
 *   换选中项不走库的按键管线（不会触发它的重绘），复用库唯一监听的重绘入口
 *   ——stdout 的 resize 事件强制全帧重画。
 * - 行内模式（inline.ts）：readline 不留插手渲染的口子，在提示符下方自绘/
 *   自擦菜单。全部用光标相对移动（\x1b[B 下移不滚屏、\n 在屏底自然滚屏、
 *   画完按行数上移归位），不查询光标绝对位置，readline 对这一切无感。
 */

export interface SlashCommand {
  name: string;
  desc: string;
  /** 从菜单确认后先补全并等待用户输入参数，不能立刻以空参数执行。 */
  requiresArgument?: boolean;
}

export type SlashCommandDefinition = Omit<SlashCommand, "name">;

/**
 * 全部内置斜杠命令的交互定义 —— 全项目唯一数据源。
 *
 * 卡片模式的候选池来自它分发用的 commands 表（keys.ts），行内模式来自
 * commandsForMode()。两边都取同一份说明和参数行为，避免菜单里写的说明、
 * 补全规则和回车后的真实执行逻辑漂移。
 */
export const SLASH_COMMANDS: Readonly<Record<string, SlashCommandDefinition>> = {
  "/inline": { desc: "切换到行内模式（滚轮/复制可用）" },
  "/card": { desc: "切换到全屏卡片模式" },
  "/key": { desc: "管理 DeepSeek API Key（查看或覆盖）" },
  "/update": { desc: "检查并一键更新到最新版（更新后需重启）" },
  "/exit": { desc: "退出程序" },
};

export function commandsForMode(mode: "card" | "inline"): SlashCommand[] {
  const names =
    mode === "card"
      ? ["/inline", "/key", "/update", "/exit"]
      : ["/card", "/key", "/update", "/exit"];
  return names.map((name) => ({ name, ...SLASH_COMMANDS[name] }));
}

/**
 * 只能由运行程序的本机终端处理的命令。严格匹配命令边界，避免误伤 /keyfoo
 * 或普通对话文字；QQ 等远程渠道在写 history/调用 Agent 前据此拦截。
 */
/** 仅本机处理的 /key 命令；安全边界忽略大小写，菜单补全仍保持大小写敏感。 */
export function isLocalOnlyKeyCommand(input: string): boolean {
  return /^\/key(?:\s|$)/i.test(input.trim());
}

/** 原始按键层用：一出现空白即视为旧式带参数写法，后续字符不得进入输入组件。 */
export function isLocalKeyCommandWithArgumentPrefix(input: string): boolean {
  return /^\/key\s/i.test(input);
}

export function localOnlyCommandMessage(input: string): string | undefined {
  if (!isLocalOnlyKeyCommand(input)) return undefined;
  return "🔐 API Key 只能在运行 CourseRaptor 的本机终端设置：请输入无参数 /key。";
}

/**
 * 前缀过滤。区分大小写是刻意的：补全按「已输入长度」截取命令名剩余部分，
 * 忽略大小写会让 "/K" 补成 "/Key" 错位。
 */
export function filterSlashCommands(query: string, pool: SlashCommand[]): SlashCommand[] {
  if (!query.startsWith("/")) return [];
  return pool.filter((c) => c.name.startsWith(query));
}

// ── 按键切分（两种 UI 共用） ──────────────────────────────────

/**
 * 一个按键序列的开头：CSI（\x1b[A 方向键等）、OSC（\x1b]… 标题设置，以 BEL
 * 或 ST 收尾）、或 ESC 加一个字符（Alt 组合键）。孤立 ESC 由最后一项的可选
 * 分支匹配。用 ^ 锚定，调用方在子串上 exec，正则保持无状态。
 *
 * 最后一项刻意排除 `[` 和另一个 ESC：连按 ESC 或「ESC 紧跟方向键」会挤进
 * 同一个 chunk（"\x1b\x1b[A"），若让 `\x1b` 吃掉下一个字符，剩下的 "[A" 会
 * 被当成普通文本拼进输入行/命令镜像。排除后能正确切成 ESC + \x1b[A。
 */
const ESC_SEQ = /^(?:\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^\x1b[]?)/;

/**
 * 把一次 data 事件的 chunk 切成一个个按键序列。
 *
 * 终端不保证一次 data 事件只给一个按键：连按退格、粘贴、中文输入法整段上屏，
 * 都会把多个按键塞进同一个 chunk。两种 UI 的菜单逻辑都是按「单按键」写的
 * （text === "\x7f" 之类），整块喂进去必然误判——最典型的翻车是连按三次退格
 * 拿到 "\x7f\x7f\x7f"：既不等于 "\x7f"、又满足 `text >= " "`，于是被当成普通
 * 字符拼进命令镜像，镜像被污染后前缀过滤永远匹配不上，菜单就此假死到下次
 * 重启。所以必须先切分、再逐个交给按键逻辑。
 *
 * 切分规则：转义序列整体成键（不能被拆成 ESC + 字母，否则 ESC 会被误认成
 * 软打断）；其余按 Unicode code point 取一个字符（中文、emoji 不拆散代理对）。
 */
export function splitKeys(text: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const m = ESC_SEQ.exec(text.slice(i));
      if (m) {
        keys.push(m[0]);
        i += m[0].length;
        continue;
      }
      keys.push("\x1b");
      i += 1;
      continue;
    }
    // 按 code point 取一个字符：代理对（emoji 等）整体成键
    const ch = String.fromCodePoint(text.codePointAt(i) ?? text.charCodeAt(i));
    keys.push(ch);
    i += ch.length;
  }
  return keys;
}

/** C0 控制符与 DEL。ESC / \r / \t / \x7f 都在这里面 */
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * 可打印字符（含中文、emoji）。
 * DEL(0x7f) 必须算控制键——它是退格，只是碰巧满足 `>= " "`。
 */
export function isPrintableKey(s: string): boolean {
  return !CONTROL.test(s);
}

/**
 * 把 keys 里连续的可打印字符重新合并成一块。
 *
 * 切分是必须的（见 splitKeys），但真逐字符送给下游会出问题：粘贴或输入法
 * 整段上屏时，库每收到一个字符就全帧重绘一次，几百字符能卡出秒级延迟。
 * 而控制键恰好相反——库要求一个 chunk 恰好是一个按键序列，混进文本里会整块
 * 失配（合成方向键因此必须逐条写）。于是各取所需：只合并可打印字符的连续段，
 * 控制键与转义序列一律单独成块。
 */
export function coalesceText(keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const prev = out[out.length - 1];
    if (prev !== undefined && isPrintableKey(key) && isPrintableKey(prev)) {
      out[out.length - 1] = prev + key;
    } else {
      out.push(key);
    }
  }
  return out;
}

// ── 菜单框渲染（两种 UI 共用） ────────────────────────────────

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
/** 选中项反显：单靠一个 › 标记，↑↓ 快速切换时眼睛跟不上 */
const INVERT = "\x1b[7m";

/** 菜单内容区显示宽度（不含左右边框）。行宽固定不随终端变——卡片模式的
 * 补丁把行原样插进帧，超宽会撑破布局，源头保证 ≤ 最小合理终端宽 */
const MENU_INNER = 50;

const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** 显示宽度：剔除 ANSI 颜色序列后，CJK/全角按 2 列，其余按 1 列 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_SGR, "")) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x20000;
    w += wide ? 2 : 1;
  }
  return w;
}

function padTo(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

/** 按显示宽度截断，超出补省略号（省略号占 1 列，总宽仍 ≤ width） */
function ellipsis(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    w += cw;
    out += ch;
  }
  return `${out}…`;
}

/**
 * 渲染菜单框。selected 为高亮项（越界自动钳制）；无候选返回 []（= 隐藏）。
 * 最多展示 9 项，命令总数远小于此，纯防御。
 */
export function renderSlashMenu(items: SlashCommand[], selected: number): string[] {
  if (!items.length) return [];
  const total = MENU_INNER + 2;
  // "┌ 命令 " 前缀占 7 列，加收尾 "┐"，横线补满 total - 8 列
  const lines = [`┌ 命令 ${"─".repeat(total - 8)}┐`];
  // 行内三段：命令名列宽 + 说明列宽，两侧各留 1 列内边距。
  // 两段都要 padTo（不能只截不补），否则反显块宽窄不一、右边框对不齐
  const bodyW = MENU_INNER - 4;
  const nameW = 10;
  const descW = bodyW - nameW - 2;
  items.slice(0, 9).forEach((c, i) => {
    const active = i === Math.min(Math.max(selected, 0), items.length - 1);
    const mark = active ? `${CYAN}›${RESET}` : " ";
    const name = padTo(ellipsis(c.name, nameW), nameW);
    const desc = padTo(ellipsis(c.desc, descW), descW);
    // 选中项整块反显（反显里不再叠 DIM，颜色会打架）
    const body = active ? `${INVERT} ${name}${desc} ${RESET}` : ` ${name}${DIM}${desc}${RESET} `;
    lines.push(`│ ${mark} ${body} │`);
  });
  lines.push(`└${"─".repeat(total - 2)}┘`);
  return lines;
}

// ── 卡片模式：菜单帧行注入 ────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __raptorSlashMenu: string[] | undefined;
}

/** 卡片模式：更新菜单帧行（patch-tui.mjs 的补丁在渲染时读取）；空 = 隐藏 */
export function setCardSlashMenu(lines: string[]): void {
  globalThis.__raptorSlashMenu = lines.length ? lines : undefined;
}

/**
 * 卡片模式：强制库全帧重绘。库只在自身状态变化（打字/流事件/光标闪烁）时
 * paint，↑/↓ 换选中项不改它的任何状态，必须手动触发；库把重绘挂在 output
 * 的 resize 监听上，发出该事件是最省事的入口（无人监听时是无害 no-op）。
 */
export function repaintCardFrame(): void {
  process.stdout.emit("resize");
}
