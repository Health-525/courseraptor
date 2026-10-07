/**
 * 课表 SVG 渲染 — 纯数据到图形，不碰网络、不落盘
 *
 * 两个入口共用：AI 工具 export_schedule_image（学校适配器挂载）与网页
 * 直链 /api/schedule/image（channels/web/chat-web.ts）。两种形态：
 * - 整学期汇总：课程按 (星期, 节次) 定位，课格标注周次，同时段不同周次的
 *   课（冲突）横向并排分栏
 * - 单周：与网页周课表同口径——放假清空、调休按被补周几换课表、单双周
 *   过滤（换算真值在 core/calendar/week-plan.ts）。导出图是静态存档，
 *   不标「今天」（网页实时课表的当天高亮在 schedule-page.ts，互不影响）
 *
 * 两套风格（style 参数）：
 * - classic 红头档案：暖纸底 + 墨字 + 单一朱砂 + 楷体课名，与 /schedule 网页同源
 * - color 彩色课格：每门课一个稳定柔和色块（同亮度马卡龙底、文字一律墨色），
 *   品牌元素收敛成小节——顶部朱砂细条 + 底部「COURSERAPTOR · 生成于」小字
 *   落款，补课角标仍用朱砂，整体暖白底不脱离红头档案的血统
 *
 * 文字排版是 SVG 手工活：CJK 感知折行 + 超行省略号，长度全靠字宽估算
 * （中文全宽、ASCII 约 0.56 倍），宁可估宽不估窄，避免溢出课格。
 */

import { isoOf, planForDate, weekdayOf } from "./calendar/week-plan";
import type { CourseData } from "./model";
import { school } from "./school";

export type ScheduleStyle = "classic" | "color";

const FONT_KAI = "KaiTi, STKaiti, Kaiti SC, Georgia, serif";
const FONT_MONO = "ui-monospace, Cascadia Mono, Consolas, Liberation Mono, monospace";
const FONT_SANS = "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif";

/**
 * 课色盘：12 个同亮度、带纸感的稳定底色（课名哈希定色，跨周/跨形态同课同色）。
 * 关键实践：颜色只出现在卡片底，文字一律中性墨色——彩色文字 + 彩色底
 * 是「花」的根源，统一亮度则怎么排都不打架。
 */
const COURSE_PALETTE = [
  "#F3E1DB", // 朱红（呼应品牌朱砂）
  "#F4E4CE", // 杏橙
  "#F2ECC9", // 芥黄
  "#EDF3D9", // 黄绿
  "#E7F1E2", // 苔绿
  "#E5F0EA", // 青
  "#E4EDF5", // 天蓝
  "#E8E7F4", // 蓝紫
  "#EDE9F4", // 紫
  "#F4E5EB", // 藕粉
  "#F0E8DB", // 岩棕
  "#ECEEF2", // 灰蓝
] as const;

/** djb2（与日历 UID 同款哈希）：课色随课名稳定，跨周/跨形态同课同色 */
function courseColorOf(title: string): string {
  let h = 5381;
  for (let i = 0; i < title.length; i++) h = ((h << 5) + h + title.charCodeAt(i)) | 0;
  return COURSE_PALETTE[Math.abs(h) % COURSE_PALETTE.length];
}

/** 两个整数日期串的紧凑区间（"10/12-10/18"），周模式副题用 */
function shortDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 风格皮肤：配色 + 字体 + 几何尺寸一次打包，布局代码只认皮肤不看风格名 */
interface Skin {
  bg: string;
  gridRule: string; // 网格缝色（透出来当格线）
  gridBorder: string;
  ink: string;
  ink2: string;
  ink3: string;
  /** 品牌朱砂：classic 当主色，color 只出现在顶条/今天/角标 */
  accent: string;
  accentDeep: string;
  accentSoft: string;
  cardRadius: number;
  cardShadow: boolean;
  titleFont: string;
  nameFont: string;
  nameWeight: string;
  metaFont: string;
  /** 元信息 ASCII 测宽系数：mono 接近等宽取 0.62，黑体系实际更窄取 0.55（估宽会截断） */
  metaFactor: number;
  dayFont: string;
  /** 页头画不画朱砂印章（color 只留小字落款，不盖章） */
  seal: boolean;
  /** 顶部朱砂细条（color 的品牌小节） */
  brandBar: boolean;
  /** 画不画满格网格线（classic 红头档案要格线；color 卡片浮底、零格线噪音） */
  gridLines: boolean;
  /** 课格与所在格位边缘的留白 */
  cardPad: number;
  margin: number;
  titleH: number;
  timeW: number;
  dayW: number;
  headH: number;
  rowH: number;
  nameSize: number;
  nameLh: number;
  metaSize: number;
  metaLh: number;
}

const GAP = 1; // 网格缝：底色透出来当格线（与网页 gap:1px 同款）
const CARD_GAP = 4; // 并排分栏之间的缝

const SKINS: Record<ScheduleStyle, Skin> = {
  classic: {
    bg: "#F6F4ED",
    gridRule: "#E1DCCF",
    gridBorder: "#C9C1AF",
    ink: "#25221C",
    ink2: "#5A554A",
    ink3: "#6E6656",
    accent: "#AD392C",
    accentDeep: "#852B22",
    accentSoft: "#F3E3DE",
    cardRadius: 3,
    cardShadow: true,
    titleFont: FONT_KAI,
    nameFont: FONT_KAI,
    nameWeight: "600",
    metaFont: FONT_MONO,
    metaFactor: 0.62,
    dayFont: FONT_KAI,
    seal: true,
    brandBar: false,
    gridLines: true,
    cardPad: 4,
    margin: 28,
    titleH: 70,
    timeW: 88,
    dayW: 152,
    headH: 44,
    rowH: 80,
    nameSize: 15,
    nameLh: 19,
    metaSize: 10.5,
    metaLh: 13,
  },
  color: {
    bg: "#FDFCF9",
    gridRule: "#F0EDE6",
    gridBorder: "#E2DED2",
    ink: "#23201A",
    ink2: "#6B6558",
    ink3: "#98917F",
    accent: "#AD392C",
    accentDeep: "#852B22",
    accentSoft: "#F6E3DD",
    cardRadius: 9,
    cardShadow: false,
    titleFont: FONT_SANS,
    nameFont: FONT_SANS,
    nameWeight: "700",
    metaFont: FONT_SANS,
    metaFactor: 0.55,
    dayFont: FONT_SANS,
    seal: false,
    brandBar: true,
    gridLines: false,
    cardPad: 6,
    margin: 24,
    titleH: 50,
    timeW: 76,
    dayW: 132,
    headH: 38,
    rowH: 78,
    nameSize: 14,
    nameLh: 18,
    metaSize: 10,
    metaLh: 12.5,
  },
};

export interface ScheduleSvgCounts {
  /** 参与排布的课程条目（同一门课多个时段算多条） */
  courses: number;
  /** 画出的课格数 */
  cells: number;
  /** 同一时段多门课并排分栏的时段数 */
  splitSlots: number;
  /** 未能定位节次、落到脚注的课程条目 */
  unscheduled: number;
}

export interface ScheduleSvgResult {
  svg: string;
  width: number;
  height: number;
  counts: ScheduleSvgCounts;
}

// ── 文本工具：XML 转义 + CJK 感知折行 ───────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 单字符估宽：CJK/全角按全宽，其余按 0.56 倍（mono 数字按 0.62 由调用方传系数） */
function charW(ch: string, size: number, factor: number): number {
  const code = ch.codePointAt(0) ?? 0;
  const cjk =
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    code === 0x3000;
  return cjk ? size : size * factor;
}

function measure(text: string, size: number, factor = 0.56): number {
  let w = 0;
  for (const ch of text) w += charW(ch, size, factor);
  return w;
}

function wrapText(text: string, maxW: number, size: number, factor: number): string[] {
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = charW(ch, size, factor);
    if (curW + w > maxW && cur) {
      lines.push(cur);
      cur = ch;
      curW = w;
    } else {
      cur += ch;
      curW += w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** 折行后最多保留 maxLines 行，截断的末行以「…」收尾 */
function fitLines(
  text: string,
  maxW: number,
  size: number,
  maxLines: number,
  factor = 0.56,
): string[] {
  const lines = wrapText(text, maxW, size, factor);
  if (lines.length <= maxLines) return lines;
  const out = lines.slice(0, maxLines);
  let last = out[out.length - 1];
  while (last.length && measure(last, size, factor) + measure("…", size, factor) > maxW) {
    last = last.slice(0, -1);
  }
  out[out.length - 1] = `${last}…`;
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function stampOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datePlusDays(iso: string, days: number): Date {
  const d = new Date(`${iso}T00:00:00`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** 周次原文展示：「1-16」→「1-16周」，已含「周」或空的保持原样 */
function weeksLabel(weeks: string | undefined): string {
  const w = weeks?.trim();
  if (!w) return "";
  return w.includes("周") ? w : `${w}周`;
}

// ── 冲突排布：同一天里时段重叠的课程横向分栏 ────────────────────────

interface Slot {
  course: CourseData;
  start: number;
  end: number;
  /** 分栏列号（0 起） */
  col: number;
  /** 所在冲突簇的总栏数 */
  cols: number;
}

/**
 * 一天内的课格定位：按 [start,end] 传递重叠聚簇，簇内做区间着色——
 * 每门课放进第一条其行区间空闲的分栏，互不重叠的课共用一栏，
 * 只有真冲突时才把列宽摊薄（正方课表同款并排效果）。
 */
function layoutDayCourses(courses: CourseData[]): {
  slots: Slot[];
  unscheduled: CourseData[];
  splitSlots: number;
} {
  const unscheduled: CourseData[] = [];
  const valid: Array<{ course: CourseData; start: number; end: number }> = [];
  for (const c of courses) {
    const nums = c.periods.filter((p) => Number.isInteger(p) && p >= 1);
    if (!nums.length) {
      unscheduled.push(c);
      continue;
    }
    valid.push({ course: c, start: Math.min(...nums), end: Math.max(...nums) });
  }
  valid.sort((a, b) => a.start - b.start || a.end - b.end);

  const slots: Slot[] = [];
  let splitSlots = 0;
  let cluster: typeof valid = [];
  let clusterMaxEnd = 0;
  const flush = () => {
    if (!cluster.length) return;
    const colEnds: number[] = []; // 每栏当前占用到的末节次
    for (const item of cluster) {
      let col = colEnds.findIndex((e) => e < item.start);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(item.end);
      } else {
        colEnds[col] = item.end;
      }
      slots.push({ ...item, col, cols: colEnds.length });
    }
    if (colEnds.length > 1) splitSlots++;
    cluster = [];
    clusterMaxEnd = 0;
  };
  for (const item of valid) {
    if (cluster.length && item.start > clusterMaxEnd) flush();
    cluster.push(item);
    clusterMaxEnd = Math.max(clusterMaxEnd, item.end);
  }
  flush();
  return { slots, unscheduled, splitSlots };
}

// ── 课格卡片 ────────────────────────────────────────────────────────

/** 卡内统一内边距与行距：文字距卡边不贴不死，课名与元信息之间留呼吸 */
const CARD_PAD_X = 9;
const CARD_PAD_Y = 8;
const NAME_META_GAP = 5;

/**
 * 课格卡片：稳定纸色卡底 + 规范排版——课名（可折行）在上、元信息在下，
 * 高卡（跨节次）从顶部往下排、矮卡（单节次）整块垂直居中。
 * 不画任何边条装饰：颜色即卡片，内容即版面。
 */
function courseCard(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  course: CourseData;
  /** term 模式带周次行；week 模式该周已过滤，周次没有信息量 */
  withWeeks: boolean;
  skin: Skin;
  style: ScheduleStyle;
}): string {
  const { x, y, w, h, course, withWeeks, skin, style } = opts;
  const inner = w - CARD_PAD_X * 2;
  // 元信息只留地点（与 /schedule 网页课格同口径）：导出图是给同学自己
  // 看的，教师名不参与找教室，窄格里的版面留给课名
  const meta1 = course.location?.trim() || "地点待定";
  const meta2 = withWeeks ? weeksLabel(course.weeks) : "";
  const metas = [meta1, meta2].filter(Boolean);
  const metaH = metas.length * skin.metaLh;
  const nameMax = Math.max(
    1,
    Math.min(
      3,
      Math.floor((h - CARD_PAD_Y * 2 - (metas.length ? metaH + NAME_META_GAP : 0)) / skin.nameLh),
    ),
  );
  const nameLines = fitLines(course.title, inner, skin.nameSize, nameMax);

  const cardFill = courseColorOf(course.title);
  const nameFill = skin.ink;
  const metaFill = style === "color" ? skin.ink2 : skin.ink3;

  const contentH = nameLines.length * skin.nameLh + (metas.length ? NAME_META_GAP + metaH : 0);
  // 跨节次的高卡从顶部排（像真实的卡片内容），单节次矮卡整块居中
  const topAligned = h >= 110;
  let ty = topAligned ? y + CARD_PAD_Y + skin.nameSize : y + (h - contentH) / 2 + skin.nameSize; // 首行基线

  const parts: string[] = ["<g>"];
  parts.push(
    style === "classic"
      ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${cardFill}" filter="url(#cardShadow)"/>`
      : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${skin.cardRadius}" fill="${cardFill}"/>`,
  );
  for (const line of nameLines) {
    parts.push(
      `<text x="${x + CARD_PAD_X}" y="${ty.toFixed(1)}" font-family="${skin.nameFont}" font-size="${skin.nameSize}" font-weight="${skin.nameWeight}" fill="${nameFill}">${esc(line)}</text>`,
    );
    ty += skin.nameLh;
  }
  ty += NAME_META_GAP - (skin.nameLh - skin.metaSize); // 课名行距切换到元信息行距，中间留一道呼吸
  for (const m of metas) {
    for (const line of fitLines(m, inner, skin.metaSize, 1, skin.metaFactor)) {
      parts.push(
        `<text x="${x + CARD_PAD_X}" y="${(ty + 1).toFixed(1)}" font-family="${skin.metaFont}" font-size="${skin.metaSize}" fill="${metaFill}">${esc(line)}</text>`,
      );
      ty += skin.metaLh;
    }
  }
  parts.push("</g>");
  return parts.join("");
}

// ── 网格组装（两种形态、两套风格共用） ──────────────────────────────

interface DayColumn {
  weekday: number;
  headerMain: string;
  /** 日头右侧/下方小字（周模式带日期） */
  headerSub?: string;
  /** 角标（如「补课」） */
  tag?: string;
  /** 整列放假（周模式）：竖排虚线块 */
  holiday?: string;
  slots: Slot[];
  unscheduled: CourseData[];
  splitSlots: number;
}

interface TableMeta {
  /** term=课格带周次行；week=带「补课/放假」处理 */
  withWeeks: boolean;
}

function buildScheduleSvg(opts: {
  termLabel: string;
  /** 页头主标题：导出的「主体」——周模式是「第 N 周课表」，学期名进副题 */
  title: string;
  /** 副题小字：学期名（+周模式的日期区间） */
  subtitle: string;
  days: DayColumn[];
  meta: TableMeta;
  now: Date;
  style: ScheduleStyle;
  /** 项目 logo（data URI）：classic 嵌进印章、color 做页脚落款；缺省回退纯文字画法 */
  logoDataUri?: string;
}): ScheduleSvgResult {
  const { termLabel, title, subtitle, days, meta, now, style } = opts;
  const logo = opts.logoDataUri;
  const s = SKINS[style];

  const periodTimes = school().terms.periodTimes();
  const knownPeriods = Object.keys(periodTimes)
    .map(Number)
    .filter((p) => Number.isInteger(p) && p > 0);
  const maxCourseEnd = Math.max(0, ...days.flatMap((d) => d.slots.map((sl) => sl.end)));
  const periodCount = Math.max(10, ...knownPeriods, maxCourseEnd);

  const dayPitch = s.dayW + GAP;
  const rowPitch = s.rowH + GAP;
  const tableX = s.margin;
  const tableY = s.margin + s.titleH + 14;
  const tableW = s.timeW + GAP + days.length * dayPitch - GAP;
  const gridH = s.headH + GAP + periodCount * rowPitch - GAP;

  const counts: ScheduleSvgCounts = {
    courses: days.reduce((n, d) => n + d.slots.length + d.unscheduled.length, 0),
    cells: days.reduce((n, d) => n + d.slots.length, 0),
    splitSlots: days.reduce((n, d) => n + d.splitSlots, 0),
    unscheduled: days.reduce((n, d) => n + d.unscheduled.length, 0),
  };

  const footNotes: string[] = [];
  for (const d of days) {
    for (const c of d.unscheduled) {
      footNotes.push(
        `${d.headerMain}：${c.title}${c.weeks ? `（${weeksLabel(c.weeks)}）` : ""}——教务数据未给节次，无法入格`,
      );
    }
  }

  const height =
    tableY + gridH + (footNotes.length ? 14 + footNotes.length * 16 : 10) + s.margin + 20;
  const width = s.margin * 2 + tableW;
  const p: string[] = [];

  // 画布与页头
  p.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<title>课表 · ${esc(termLabel)}</title>`,
    `<defs><filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">`,
    `<feDropShadow dx="0" dy="1" stdDeviation="1.6" flood-color="#322A1F" flood-opacity="0.12"/>`,
    `</filter></defs>`,
    `<rect width="${width}" height="${height}" fill="${s.bg}"/>`,
  );
  if (s.brandBar) {
    // color 风格的品牌小节①：顶部一条朱砂细条（信笺口条），不抢课表主体
    p.push(`<rect x="0" y="0" width="${width}" height="2" fill="${s.accent}"/>`);
  }
  if (s.seal) {
    // classic 页头：朱砂印章（有 logo 嵌图、缺文件回退「课」字）+ 楷体学期名 + mono 副题 + 右侧时间戳
    const sc = `${s.margin + 18}`;
    const sy = `${s.margin + 30}`;
    p.push(`<g transform="rotate(-7 ${sc} ${sy})">`);
    p.push(
      `<circle cx="${sc}" cy="${sy}" r="16" fill="none" stroke="${s.accent}" stroke-width="2"/>`,
    );
    if (logo) {
      p.push(
        `<clipPath id="sealClip"><circle cx="${sc}" cy="${sy}" r="13"/></clipPath>`,
        `<image x="${s.margin + 18 - 13}" y="${s.margin + 30 - 13}" width="26" height="26" preserveAspectRatio="xMidYMid slice" clip-path="url(#sealClip)" href="${logo}"/>`,
      );
    } else {
      p.push(
        `<text x="${sc}" y="${s.margin + 35.5}" text-anchor="middle" font-family="${FONT_KAI}" font-size="17" fill="${s.accent}">课</text>`,
      );
    }
    p.push(
      `</g>`,
      `<text x="${s.margin + 44}" y="${s.margin + 26}" font-family="${s.titleFont}" font-size="21" letter-spacing="1" fill="${s.ink}">${esc(title)}</text>`,
      `<text x="${s.margin + 44}" y="${s.margin + 46}" font-family="${FONT_MONO}" font-size="10.5" letter-spacing="2" fill="${s.ink3}">COURSERAPTOR · SCHEDULE — ${esc(subtitle)}</text>`,
      `<text x="${width - s.margin}" y="${s.margin + 46}" text-anchor="end" font-family="${FONT_MONO}" font-size="10.5" fill="${s.ink3}">生成于 ${stampOf(now)}</text>`,
      `<line x1="${s.margin}" y1="${s.margin + 58}" x2="${width - s.margin}" y2="${s.margin + 58}" stroke="${s.gridBorder}" stroke-width="1"/>`,
    );
  } else {
    // color 页头：朱砂小竖条 + 主体大标题（第 N 周）；右侧副题（学期名等）
    p.push(
      `<rect x="${s.margin}" y="${s.margin + 12}" width="4" height="18" rx="2" fill="${s.accent}"/>`,
      `<text x="${s.margin + 12}" y="${s.margin + 27}" font-family="${s.titleFont}" font-size="16" font-weight="700" fill="${s.ink}">${esc(title)}</text>`,
      `<text x="${width - s.margin}" y="${s.margin + 27}" text-anchor="end" font-family="${s.titleFont}" font-size="11" font-weight="600" fill="${s.ink2}">${esc(subtitle)}</text>`,
    );
  }

  // ── 表格底盘：classic 满格网格线（缝透底当线）；color 零格线，卡片浮底 ──
  if (s.gridLines) {
    p.push(
      `<rect x="${tableX}" y="${tableY}" width="${tableW}" height="${gridH}" fill="${s.gridRule}" stroke="${s.gridBorder}" stroke-width="1"/>`,
      // 左上角「节次」
      `<rect x="${tableX}" y="${tableY}" width="${s.timeW}" height="${s.headH}" fill="${s.bg}"/>`,
      `<text x="${tableX + s.timeW / 2}" y="${tableY + s.headH / 2 + 4}" text-anchor="middle" font-family="${FONT_MONO}" font-size="11" letter-spacing="2" fill="${s.ink3}">节次</text>`,
    );
  } else {
    // color：时间轨一条细竖线
    p.push(
      `<line x1="${tableX + s.timeW}" y1="${tableY}" x2="${tableX + s.timeW}" y2="${tableY + gridH}" stroke="${s.gridRule}" stroke-width="1"/>`,
    );
  }

  // 日头
  days.forEach((d, i) => {
    const x = tableX + s.timeW + GAP + i * dayPitch;
    if (s.gridLines) {
      p.push(`<rect x="${x}" y="${tableY}" width="${s.dayW}" height="${s.headH}" fill="${s.bg}"/>`);
      const mainX = d.headerSub ? x + 10 : x + s.dayW / 2;
      p.push(
        `<text x="${mainX}" y="${tableY + (d.headerSub ? 19 : s.headH / 2 + 5)}" ${d.headerSub ? "" : 'text-anchor="middle"'} font-family="${s.dayFont}" font-size="15.5" fill="${s.ink}">${esc(d.headerMain)}</text>`,
      );
      if (d.headerSub) {
        p.push(
          `<text x="${x + 10}" y="${tableY + 33}" font-family="${FONT_MONO}" font-size="10" fill="${s.ink3}">${esc(d.headerSub)}</text>`,
        );
      }
      if (d.tag) {
        const tagW = measure(d.tag, 9, 0.62) + 8;
        p.push(
          `<rect x="${x + s.dayW - tagW - 8}" y="${tableY + 8}" width="${tagW}" height="15" rx="2" fill="${s.accentSoft}"/>`,
          `<text x="${x + s.dayW - tagW - 8 + tagW / 2}" y="${tableY + 19}" text-anchor="middle" font-family="${FONT_MONO}" font-size="9" fill="${s.accentDeep}">${esc(d.tag)}</text>`,
        );
      }
      return;
    }
    // color 日头：星期名居中 + 日期小字
    const cx = x + s.dayW / 2;
    p.push(
      `<text x="${cx}" y="${tableY + 18}" text-anchor="middle" font-family="${s.dayFont}" font-size="13.5" font-weight="600" fill="${s.ink}">${esc(d.headerMain)}</text>`,
    );
    if (d.headerSub) {
      p.push(
        `<text x="${cx}" y="${tableY + 33}" text-anchor="middle" font-family="${FONT_MONO}" font-size="9.5" fill="${s.ink3}">${esc(d.headerSub)}</text>`,
      );
    }
    if (d.tag) {
      const tagW = measure(d.tag, 9, 0.62) + 10;
      p.push(
        `<rect x="${x + s.dayW - tagW - 4}" y="${tableY + 4}" width="${tagW}" height="15" rx="7.5" fill="${s.accentSoft}"/>`,
        `<text x="${x + s.dayW - tagW - 4 + tagW / 2}" y="${tableY + 15}" text-anchor="middle" font-family="${FONT_MONO}" font-size="9" fill="${s.accentDeep}">${esc(d.tag)}</text>`,
      );
    }
  });

  // 节次列（classic 另画格底；color 只有文字，无格线）。
  // 节号与时间是「居中双行」：右对齐会把窄数字和宽时间挤在同一右缘，
  // 视觉上互相打架；分两行居中后上下各归其位
  const timeCx = tableX + s.timeW / 2;
  for (let period = 1; period <= periodCount; period++) {
    const y = tableY + s.headH + GAP + (period - 1) * rowPitch;
    const range = periodTimes[String(period)];
    if (s.gridLines) {
      p.push(`<rect x="${tableX}" y="${y}" width="${s.timeW}" height="${s.rowH}" fill="${s.bg}"/>`);
    }
    p.push(
      `<text x="${timeCx}" y="${y + s.rowH / 2 - 6}" text-anchor="middle" font-family="${FONT_MONO}" font-size="${s.gridLines ? 12.5 : 12}" font-weight="700" fill="${s.ink2}">${period}</text>`,
    );
    if (range) {
      p.push(
        `<text x="${timeCx}" y="${y + s.rowH / 2 + 13}" text-anchor="middle" font-family="${FONT_MONO}" font-size="8.5" fill="${s.ink3}">${esc(range)}</text>`,
      );
    }
    if (s.gridLines) {
      for (let i2 = 0; i2 < days.length; i2++) {
        const x = tableX + s.timeW + GAP + i2 * dayPitch;
        p.push(`<rect x="${x}" y="${y}" width="${s.dayW}" height="${s.rowH}" fill="${s.bg}"/>`);
      }
    }
  }

  // 整列放假（周模式）：虚线框 + 竖排名（旋转 90° 的「国庆节 放假」）
  days.forEach((d, i) => {
    if (!d.holiday) return;
    const x = tableX + s.timeW + GAP + i * dayPitch;
    const top = tableY + s.headH + GAP + s.cardPad;
    const h = gridH - s.headH - GAP - s.cardPad * 2;
    const label = `${d.holiday} 放假`;
    // rotate(-90) 后基线竖直、字形向基线左侧延伸，中心点右移半个字高才居中
    const cx = x + s.dayW / 2 + 7.5;
    p.push(
      `<rect x="${x + s.cardPad}" y="${top}" width="${s.dayW - s.cardPad * 2}" height="${h}" rx="${style === "color" ? 8 : 3}" fill="none" stroke="${s.gridBorder}" stroke-dasharray="4 3"/>`,
      `<text x="${cx}" y="${top + h / 2}" text-anchor="middle" font-family="${FONT_KAI}" font-size="15" letter-spacing="3" fill="${s.accentDeep}" transform="rotate(-90 ${cx} ${top + h / 2})">${esc(label)}</text>`,
    );
  });

  // 课格
  days.forEach((d, i) => {
    if (d.holiday) return;
    const x = tableX + s.timeW + GAP + i * dayPitch;
    for (const sl of d.slots) {
      const colW = (s.dayW - s.cardPad * 2 - (sl.cols - 1) * CARD_GAP) / sl.cols;
      const cx = x + s.cardPad + sl.col * (colW + CARD_GAP);
      const top = tableY + s.headH + GAP + (sl.start - 1) * rowPitch + s.cardPad;
      const h = (sl.end - sl.start + 1) * rowPitch - GAP - s.cardPad * 2;
      p.push(
        courseCard({
          x: round1(cx),
          y: round1(top),
          w: round1(colW),
          h: round1(h),
          course: sl.course,
          withWeeks: meta.withWeeks,
          skin: s,
          style,
        }),
      );
    }
  });

  // 脚注：未排节次的课 + color 风格的品牌小节②（右下小字落款）
  let fy = tableY + gridH + 22;
  for (const note of footNotes) {
    p.push(
      `<text x="${s.margin}" y="${fy}" font-family="${FONT_MONO}" font-size="11" fill="${s.ink3}">· ${esc(note)}</text>`,
    );
    fy += 16;
  }
  if (style === "color") {
    // 品牌小节②：右下落款「logo + COURSERAPTOR · 生成于」，小字不抢主体
    const credit = `COURSERAPTOR · 生成于 ${stampOf(now)}`;
    const creditW = measure(credit, 9, 0.62);
    if (logo) {
      p.push(
        `<image x="${width - s.margin - creditW - 18}" y="${height - 21}" width="12" height="12" href="${logo}"/>`,
      );
    }
    p.push(
      `<text x="${width - s.margin}" y="${height - 10}" text-anchor="end" font-family="${FONT_MONO}" font-size="9" letter-spacing="1" fill="${s.ink3}">${esc(credit)}</text>`,
    );
  }
  p.push("</svg>");
  return { svg: p.join("\n"), width, height, counts };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── 形态一：整学期汇总 ──────────────────────────────────────────────

/**
 * 整学期汇总课表：所有课程按 (星期, 节次) 定位，课格标注周次原文。
 * 周末没课的尾列自动收掉（保底周一～周五），图不至于拖两条空列。
 */
export function renderTermScheduleSVG(opts: {
  courses: CourseData[];
  termLabel: string;
  now?: Date;
  style?: ScheduleStyle;
  logoDataUri?: string;
}): ScheduleSvgResult {
  const { courses, termLabel } = opts;
  const now = opts.now ?? new Date();
  const style = opts.style ?? "classic";
  const terms = school().terms;

  const weekdays = [1, 2, 3, 4, 5, 6, 7];
  while (weekdays.length > 5 && !courses.some((c) => c.weekday === weekdays[weekdays.length - 1])) {
    weekdays.pop();
  }

  const days: DayColumn[] = weekdays.map((weekday) => {
    const { slots, unscheduled, splitSlots } = layoutDayCourses(
      courses.filter((c) => c.weekday === weekday),
    );
    return {
      weekday,
      headerMain: terms.weekdayName(weekday),
      slots,
      unscheduled,
      splitSlots,
    };
  });

  return buildScheduleSvg({
    termLabel,
    title: "整学期课表",
    subtitle: termLabel,
    days,
    meta: { withWeeks: true },
    now,
    style,
    ...(opts.logoDataUri ? { logoDataUri: opts.logoDataUri } : {}),
  });
}

// ── 形态二：单周课表 ────────────────────────────────────────────────

/**
 * 第 week 周的实际课表：放假清空、调休按被补周几换课表、单双周过滤
 * （真值在 planForDate）。导出图是静态存档，不标「今天」。
 */
export function renderWeekScheduleSVG(opts: {
  courses: CourseData[];
  week: number;
  /** 第 1 周周一（YYYY-MM-DD） */
  week1Monday: string;
  termLabel: string;
  now?: Date;
  style?: ScheduleStyle;
  logoDataUri?: string;
}): ScheduleSvgResult {
  const { courses, week, week1Monday, termLabel } = opts;
  const now = opts.now ?? new Date();
  const style = opts.style ?? "classic";
  const terms = school().terms;

  const monday = datePlusDays(week1Monday, (week - 1) * 7);
  const days: DayColumn[] = [];
  for (let i = 0; i < 7; i++) {
    const date = datePlusDays(week1Monday, (week - 1) * 7 + i);
    const iso = isoOf(date);
    const plan = planForDate(courses, iso, week1Monday);
    const { slots, unscheduled, splitSlots } = plan.holiday
      ? { slots: [], unscheduled: [], splitSlots: 0 }
      : layoutDayCourses(plan.courses);
    days.push({
      weekday: weekdayOf(date),
      headerMain: terms.weekdayName(weekdayOf(date)),
      headerSub: `${date.getMonth() + 1}/${date.getDate()}`,
      ...(plan.makeup ? { tag: "补课" } : {}),
      ...(plan.holiday ? { holiday: plan.holiday } : {}),
      slots,
      unscheduled,
      splitSlots,
    });
  }

  const sunday = datePlusDays(week1Monday, (week - 1) * 7 + 6);
  return buildScheduleSvg({
    termLabel,
    title: `第 ${week} 周课表`,
    subtitle: `${termLabel} · ${shortDate(monday)}-${shortDate(sunday)}`,
    days,
    meta: { withWeeks: false },
    now,
    style,
    ...(opts.logoDataUri ? { logoDataUri: opts.logoDataUri } : {}),
  });
}
