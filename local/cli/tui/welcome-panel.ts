/**
 * 欢迎面板的纯排版层：把结构化面板状态渲染成注入 @ai-sdk/tui 空状态的
 * string[]。不碰网络/文件，渲染逻辑可单测（tests/welcome-panel.test.ts）、
 * 可离线预览（scripts/preview-welcome.mts）；取数与逐段刷新在 welcome.ts。
 *
 * 排版口径必须与 @ai-sdk/tui 的补齐一致：库按「可见宽度」（ANSI 转义码
 * 不占列，中文/emoji 占 2 列）截断每行并在行尾补空格到框宽，这里测量若
 * 与库不一致，外框右边线会错位。codePointWidth 抄的就是库那张宽度表
 * （node_modules/@ai-sdk/tui 的 codePointWidth），升级依赖时留意同步。
 * 省略号用 ASCII "..."：中文省略号「…」在 CJK 字体下常渲染成 2 列而
 * 宽度表算 1 列，会顶歪边框。emoji 只用宽度表按 2 列计的区段
 * （U+1F300–U+1F5xx），⭐✅ 之类歧义宽度的符号不用。
 */

import { stripVTControlCharacters } from "node:util";
import { BOLD, BRIGHT_CYAN, DIM, dim, MINT, RED, RESET, YELLOW } from "./color";

export interface ScheduleRow {
  /** 形如 10:00-11:40；查不到节次时间时为空串 */
  time: string;
  title: string;
  location: string;
}

export interface TodoRow {
  title: string;
  /** 距今天的天数：负数=已逾期，0=今天，正数=未来 */
  days: number;
}

/** 栏目内容：hint=单行弱化提示（加载中/失败/空态），rows=条目列表 */
export type SectionRows<T> =
  | { kind: "hint"; text: string }
  | { kind: "rows"; rows: T[]; more: number };

export interface WelcomeState {
  now: Date;
  /** 形如「10月27日 周二」的日期文案（星期名依赖学校学期配置，调用方拼好） */
  dateLabel: string;
  /** 教学周序号，拿到课表后才有 */
  week?: number;
  webUrl: string | null;
  /** 未选学校：只渲染栏目题头与网页地址，栏目内容一律不出（用户 2026-10-04 指示） */
  blank: boolean;
  schedule: SectionRows<ScheduleRow>;
  todos: SectionRows<TodoRow>;
}

const INDENT = "  ";
/** 时间列宽度：11 列时间 + 2 列间隔，无时间的课也占位保持对齐 */
const TIME_COL = 13;

function codePointWidth(cp: number): number {
  if (cp === 9) return 4;
  if (cp < 32 || (cp >= 127 && cp < 160)) return 0;
  // 常见零宽：组合变音、变体选择符（emoji 尾缀 U+FE0F）、零宽连接符
  if (
    (cp >= 768 && cp <= 879) ||
    (cp >= 1155 && cp <= 1161) ||
    cp === 8205 ||
    (cp >= 65024 && cp <= 65039)
  ) {
    return 0;
  }
  const wide =
    (cp >= 4352 && cp <= 4447) ||
    cp === 9001 ||
    cp === 9002 ||
    (cp >= 11904 && cp <= 42191 && cp !== 12351) ||
    (cp >= 44032 && cp <= 55203) ||
    (cp >= 63744 && cp <= 64255) ||
    (cp >= 65040 && cp <= 65049) ||
    (cp >= 65072 && cp <= 65135) ||
    (cp >= 65280 && cp <= 65376) ||
    (cp >= 65504 && cp <= 65510) ||
    (cp >= 127744 && cp <= 128591) ||
    (cp >= 129280 && cp <= 129535) ||
    (cp >= 131072 && cp <= 262141);
  return wide ? 2 : 1;
}

/** 可见宽度：只喂纯文本（样式在测量之后包），与库的 visibleLength 同口径 */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += codePointWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** 截到 max 可见列，超长补 "..."（见文件头：不用「…」） */
export function truncateTo(s: string, max: number): string {
  if (max < 4) return [...s].slice(0, Math.max(0, max)).join("");
  if (textWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = codePointWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > max - 3) break;
    out += ch;
    w += cw;
  }
  return `${out}...`;
}

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return "夜深了";
  if (h < 9) return "早上好";
  if (h < 12) return "上午好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** 到期徽标：逾期红、今天/明天黄、更远的弱化，颜色即优先级 */
function todoBadge(days: number): string {
  if (days < 0) return `${RED}已逾期${RESET}`;
  if (days === 0) return `${YELLOW}今天${RESET}`;
  if (days === 1) return `${YELLOW}明天${RESET}`;
  return dim(`还有 ${days} 天`);
}

/** 徽标纯文本（量宽用），最长形态「还有 N 天」= 9 列，统一作为徽标区宽 */
function todoBadgeText(days: number): string {
  return days < 0 ? "已逾期" : days === 0 ? "今天" : days === 1 ? "明天" : `还有 ${days} 天`;
}

const sectionLabel = (emoji: string, label: string) =>
  `${emoji} ${BOLD}${BRIGHT_CYAN}${label}${RESET}`;

function scheduleLines(sec: SectionRows<ScheduleRow>, width: number): string[] {
  if (sec.kind === "hint") return [`${INDENT}${dim(sec.text)}`];
  // 时间列定宽，课名优先保量、地点最后让位截断
  const avail = width - INDENT.length - TIME_COL;
  const lines = sec.rows.map((r) => {
    const title = truncateTo(r.title, Math.max(8, avail - 12));
    const loc = r.location
      ? dim(truncateTo(` · ${r.location}`, Math.max(0, avail - textWidth(title))))
      : "";
    return `${INDENT}${dim(r.time.padEnd(TIME_COL))}${title}${loc}`;
  });
  if (sec.more > 0) lines.push(`${INDENT}${dim(`...还有 ${sec.more} 门，问我看全部`)}`);
  return lines;
}

function todoLines(sec: SectionRows<TodoRow>, width: number): string[] {
  if (sec.kind === "hint") return [`${INDENT}${dim(sec.text)}`];
  // 徽标右对齐成右缘整齐的一列（最长形态 9 列），窄终端整体收紧
  const badgeRight = Math.max(30, Math.min(64, width - 10));
  const lines = sec.rows.map((r) => {
    const badgeText = todoBadgeText(r.days);
    const title = truncateTo(r.title, badgeRight - 9 - INDENT.length - 1);
    const gap = Math.max(1, badgeRight - textWidth(badgeText) - INDENT.length - textWidth(title));
    return `${INDENT}${title}${" ".repeat(gap)}${todoBadge(r.days)}`;
  });
  if (sec.more > 0) lines.push(`${INDENT}${dim(`...还有 ${sec.more} 条，问我看全部`)}`);
  return lines;
}

/** 卡片最大内容宽度：更宽的终端整体居中，而不是把徽标列越拉越远、右半屏留白 */
const CARD_MAX = 76;

/** 从戴圆眼镜的小恐龙原型提取的字符轮廓；13 行可放进常见 24 行终端。 */
const RAPTOR_MASCOT = [
  "   ⣀⡤⠤⠖⠃ ⠘⠲⠤⠤⢤⡀",
  " ⢠⠞⠁ ⡠⠖⠒⠲⢄  ⢀⡴⣛⡖⠢⡄",
  "⡴⡟⠲⠤⣾ ⣴⣯⣕⠈⡷⠒⠺⠈⠶⢻ ⡽",
  " ⡇  ⢘⣦⢜⣋⣡⠜⠁    ⡈⠉⠳⡄",
  " ⠹⣄⢰⡋⢯⣙⣦⡀      ⠁ ⢠⠇",
  "  ⠘⢦⠹⡄  ⠙⢒⣦⣤⣤⣀⡴⠒⠚⠉",
  "   ⠈⡇⡇  ⡴⠋⢸⡀⠁        ⣀⣀⡀",
  "   ⣰⢳⠃ ⣠⠇  ⠙⢦⣀    ⢀⡴⠋⠁⣠⠟",
  " ⢠⠞⠁⢺⢀⡞⠁     ⠈⠳⣄⣠⠖⠋  ⡼⠁",
  " ⠘⠦⢤⡸⣼⣄⣀⣠           ⡼⠁",
  "    ⡇⠘⠦⣄⣈⣇       ⣀⡤⠞⠁",
  "   ⣀⡇  ⢰⡋⠉⠉⢳   ⢸⡉⠁",
  "  ⠘⠧⠤⠤⠤⠖⠃ ⠰⣯⢤ ⡤⣤⠟",
];
const MASCOT_WIDTH = Math.max(...RAPTOR_MASCOT.map(textWidth));
const MASCOT_GAP = 3;

/**
 * 渲染整块面板。宽终端（>CARD_MAX+4 列正文区）时卡片按 CARD_MAX 定宽居中，
 * 两侧对称留白；行预算：外框正文区高度 = 终端行数 - 5（24 行终端即 19 行），
 * 常规宽度在信息右侧展示字符小恐龙，窄终端隐藏；页脚与 URL 始终独占整行。
 * 每栏目最多 4 条 + 1 行「还有 N」，条目数在 welcome.ts 截断。
 */
export function buildWelcomeLines(s: WelcomeState, contentWidth: number): string[] {
  const frame = Math.max(36, contentWidth);
  const width = Math.min(CARD_MAX, frame);
  const margin = " ".repeat(Math.floor((frame - width) / 2));
  const showMascot = width >= CARD_MAX;
  const infoWidth = showMascot ? width - MASCOT_WIDTH - MASCOT_GAP : width;
  const meta = `· ${s.dateLabel}${s.week ? ` · 第${s.week}周` : ""}`;
  let lines: string[] = [
    `👋 ${BOLD}${greeting(s.now)}${RESET} ${dim(meta)}`,
    "",
    sectionLabel("📅", "今日课表"),
  ];
  if (!s.blank) lines.push(...scheduleLines(s.schedule, infoWidth));
  lines.push("", sectionLabel("📋", "一周内待办"));
  if (!s.blank) lines.push(...todoLines(s.todos, infoWidth));
  lines.push("");
  if (showMascot) {
    while (lines.length < RAPTOR_MASCOT.length) lines.push("");
    lines = lines.map((line, index) => {
      const visible = textWidth(stripVTControlCharacters(line));
      const padding = " ".repeat(Math.max(0, infoWidth - visible) + MASCOT_GAP);
      const mascot = (RAPTOR_MASCOT[index] ?? "").padEnd(MASCOT_WIDTH);
      return `${line}${padding}${MINT}${mascot}${RESET}`;
    });
  }
  // 说明后缀放得下才带：URL 本身不可折行，窄终端优先保地址完整
  if (s.webUrl) {
    const base = `💬 网页对话  ${s.webUrl}`;
    lines.push(textWidth(base) + 16 <= width ? `${base} ${dim("· 浏览器打开即聊")}` : base);
  }
  // 分隔线铺满卡片内宽，居中后即成卡片底缘，不随终端拉伸
  lines.push(dim("─".repeat(width - 4)));
  // 页脚按宽度二选一：放不下就换短文案，宁可措辞紧凑也不让库把行截断——
  // Star 行被截会切掉 URL 本体，链接就废了
  const shortcuts = `${INDENT}滚轮/↑↓ 滚动 · ESC 打断回复 · 输入 / 唤出命令菜单 · Ctrl+C 退出`;
  const shortcutsShort = `${INDENT}滚轮/↑↓ 滚动 · ESC 打断 · / 唤出菜单 · Ctrl+C 退出`;
  const star = `${INDENT}🌟 觉得好用就点个 Star：`;
  const starShort = `${INDENT}🌟 Star：`;
  const starUrl = "https://github.com/Health-525/courseraptor";
  lines.push(
    dim(textWidth(shortcuts) <= width ? shortcuts : shortcutsShort),
    // Star 行的 URL 不着色也不省略 https:// 前缀：终端据此识别可点击链接
    textWidth(star) + starUrl.length <= width
      ? `${DIM}${star}${RESET}${starUrl}`
      : `${DIM}${starShort}${RESET}${starUrl}`,
  );
  // 空行不加前导空格：视觉等价，diff/选中复制时更干净
  return lines.map((l) => (l ? margin + l : l));
}
