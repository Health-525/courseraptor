/**
 * 课表 SVG 渲染 — 纯数据到图形，不碰网络、不落盘
 *
 * 两个入口共用：AI 工具 export_schedule_image（adapters/njtech/tools/calendar.ts）
 * 与网页直链 /api/schedule/image（channels/web/chat-web.ts）。两种形态：
 * - 整学期汇总：课程按 (星期, 节次) 定位，课格标注周次，同时段不同周次的
 *   课（冲突）横向并排分栏
 * - 单周：与网页周课表同口径——放假清空、调休按被补周几换课表、单双周
 *   过滤（换算真值在 core/calendar/week-plan.ts），今天列铺底突出
 *
 * 两套风格（style 参数）：
 * - classic 红头档案：暖纸底 + 墨字 + 单一朱砂 + 楷体课名，与 /schedule 网页同源
 * - color 彩色课格：每门课一个稳定柔和色块（WakeUp 式手机壁纸友好），
 *   品牌元素收敛成小节——顶部朱砂细条 + 底部「COURSERAPTOR · 生成于」小字
 *   落款，今天列与补课角标仍用朱砂，整体暖白底不脱离红头档案的血统
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

/** color 风格的课色盘：柔和底 + 同色系深字，12 个分离度大的色相轮转 */
const COURSE_PALETTE = [
  { bg: "#FCE7E3", fg: "#A83B2F" }, // 朱红（呼应品牌朱砂）
  { bg: "#FCEBD9", fg: "#B0641D" }, // 杏橙
  { bg: "#FAF1CC", fg: "#8C751B" }, // 芥黄
  { bg: "#EDF5E0", fg: "#5A7D2F" }, // 黄绿
  { bg: "#E4F3E4", fg: "#3E7B43" }, // 苔绿
  { bg: "#DFF1EE", fg: "#2C7A6F" }, // 青
  { bg: "#E3EDFA", fg: "#3C6EAD" }, // 天蓝
  { bg: "#E5E9FA", fg: "#46539F" }, // 蓝紫
  { bg: "#ECE7F8", fg: "#62519A" }, // 紫
  { bg: "#F9E5ED", fg: "#A74D73" }, // 藕粉
  { bg: "#F1E8DD", fg: "#7C5F41" }, // 岩棕
  { bg: "#E7EBEF", fg: "#4E5A6B" }, // 灰蓝（无描边色块里底色要压得住暖白纸面）
] as const;

/** djb2（与日历 UID 同款哈希）：课色随课名稳定，跨周/跨形态同课同色 */
function courseColorOf(title: string): { bg: string; fg: string } {
  let h = 5381;
  for (let i = 0; i < title.length; i++) h = ((h << 5) + h + title.charCodeAt(i)) | 0;
  return COURSE_PALETTE[Math.abs(h) % COURSE_PALETTE.length];
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
  /** 今天列铺底 */
  todayCol: string;
  card: string; // classic 的课格底色（color 用课色）
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
const CARD_PAD = 4; // 课格与格线之间留白
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
    todayCol: "#F3E3DE",
    card: "#FCFBF7",
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
    margin: 28,
    titleH: 70,
    timeW: 88,
    dayW: 152,
    headH: 44,
    rowH: 80,
    nameSize: 14.5,
    nameLh: 18,
    metaSize: 10.5,
    metaLh: 12.5,
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
    todayCol: "#F8E7DA",
    card: "#FFFFFF",
    cardRadius: 6,
    cardShadow: false,
    titleFont: FONT_SANS,
    nameFont: FONT_SANS,
    nameWeight: "700",
    metaFont: FONT_SANS,
    metaFactor: 0.55,
    dayFont: FONT_SANS,
    seal: false,
    brandBar: true,
    margin: 20,
    titleH: 50,
    timeW: 60,
    dayW: 132,
    headH: 38,
    rowH: 78,
    nameSize: 13.5,
    nameLh: 17,
    metaSize: 10,
    metaLh: 12,
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

/** 课格文字块：课名 + 元信息，整块在卡片内垂直居中（样式随皮肤走） */
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
  const inner = w - 8 - 3;
  // 并排分栏的窄卡放不下「地点 · 教师」整行时优先保地点（教师名让位）
  const narrow = w < skin.dayW * 0.7;
  const meta1 = narrow
    ? course.location?.trim() || "地点待定"
    : [course.location?.trim() || "地点待定", course.teacher?.trim()].filter(Boolean).join(" · ");
  const meta2 = withWeeks ? weeksLabel(course.weeks) : "";
  const metas = [meta1, meta2].filter(Boolean);

  const metaH = metas.length * skin.metaLh;
  const nameMax = Math.max(
    1,
    Math.min(3, Math.floor((h - 8 - (metas.length ? metaH + 4 : 0)) / skin.nameLh)),
  );
  const nameLines = fitLines(course.title, inner, skin.nameSize, nameMax);

  const color = style === "color" ? courseColorOf(course.title) : null;
  const cardFill = color ? color.bg : skin.card;
  const nameFill = color ? color.fg : skin.ink;
  const metaFill = color ? color.fg : skin.ink3;

  const contentH = nameLines.length * skin.nameLh + (metas.length ? 4 + metaH : 0);
  let ty = y + (h - contentH) / 2 + skin.nameSize; // 首行基线

  const parts: string[] = ["<g>"];
  if (style === "classic") {
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${cardFill}" filter="url(#cardShadow)"/>`,
      `<rect x="${x}" y="${y}" width="3" height="${h}" rx="1.5" fill="${skin.accent}"/>`,
    );
  } else {
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${skin.cardRadius}" fill="${cardFill}"/>`,
    );
  }
  for (const line of nameLines) {
    parts.push(
      `<text x="${x + 8}" y="${ty.toFixed(1)}" font-family="${skin.nameFont}" font-size="${skin.nameSize}" font-weight="${skin.nameWeight}" fill="${nameFill}">${esc(line)}</text>`,
    );
    ty += skin.nameLh;
  }
  ty += 4 - (skin.nameLh - skin.metaSize); // 元信息行距从课名行距切换过来
  for (const m of metas) {
    for (const line of fitLines(m, inner, skin.metaSize, 1, skin.metaFactor)) {
      parts.push(
        `<text x="${x + 8}" y="${(ty + 1).toFixed(1)}" font-family="${skin.metaFont}" font-size="${skin.metaSize}" fill="${metaFill}"${color ? ' fill-opacity="0.82"' : ""}>${esc(line)}</text>`,
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
  isToday: boolean;
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
  subtitle: string;
  days: DayColumn[];
  meta: TableMeta;
  now: Date;
  style: ScheduleStyle;
  /** 项目 logo（data URI）：classic 嵌进印章、color 做页脚落款；缺省回退纯文字画法 */
  logoDataUri?: string;
}): ScheduleSvgResult {
  const { termLabel, subtitle, days, meta, now, style } = opts;
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
    p.push(`<rect x="0" y="0" width="${width}" height="3" fill="${s.accent}"/>`);
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
      `<text x="${s.margin + 44}" y="${s.margin + 26}" font-family="${s.titleFont}" font-size="21" letter-spacing="1" fill="${s.ink}">${esc(termLabel)}</text>`,
      `<text x="${s.margin + 44}" y="${s.margin + 46}" font-family="${FONT_MONO}" font-size="10.5" letter-spacing="2" fill="${s.ink3}">COURSERAPTOR · SCHEDULE — ${esc(subtitle)}</text>`,
      `<text x="${width - s.margin}" y="${s.margin + 46}" text-anchor="end" font-family="${FONT_MONO}" font-size="10.5" fill="${s.ink3}">生成于 ${stampOf(now)}</text>`,
      `<line x1="${s.margin}" y1="${s.margin + 58}" x2="${width - s.margin}" y2="${s.margin + 58}" stroke="${s.gridBorder}" stroke-width="1"/>`,
    );
  } else {
    // color 页头：粗体学期名 + 小字副题，日期戳靠右；品牌只在顶条与页脚小字
    p.push(
      `<text x="${s.margin}" y="${s.margin + 24}" font-family="${s.titleFont}" font-size="16" font-weight="700" fill="${s.ink}">${esc(termLabel)}</text>`,
      `<text x="${s.margin}" y="${s.margin + 42}" font-family="${FONT_MONO}" font-size="9.5" letter-spacing="1" fill="${s.ink3}">${esc(subtitle)}</text>`,
      `<text x="${width - s.margin}" y="${s.margin + 42}" text-anchor="end" font-family="${FONT_MONO}" font-size="9.5" fill="${s.ink3}">${stampOf(now)}</text>`,
    );
  }

  // 网格底色 + 外框（缝里透出的就是格线）
  p.push(
    `<rect x="${tableX}" y="${tableY}" width="${tableW}" height="${gridH}" fill="${s.gridRule}" stroke="${s.gridBorder}" stroke-width="1"/>`,
    // 左上角「节次」
    `<rect x="${tableX}" y="${tableY}" width="${s.timeW}" height="${s.headH}" fill="${s.bg}"/>`,
    `<text x="${tableX + s.timeW - 8}" y="${tableY + s.headH / 2 + 4}" text-anchor="end" font-family="${FONT_MONO}" font-size="11" letter-spacing="2" fill="${s.ink3}">节次</text>`,
  );

  // 日头
  days.forEach((d, i) => {
    const x = tableX + s.timeW + GAP + i * dayPitch;
    p.push(
      `<rect x="${x}" y="${tableY}" width="${s.dayW}" height="${s.headH}" fill="${d.isToday ? s.todayCol : s.bg}"/>`,
    );
    if (d.isToday) {
      p.push(`<rect x="${x}" y="${tableY}" width="${s.dayW}" height="2" fill="${s.accent}"/>`);
    }
    const mainX = d.headerSub ? x + 10 : x + s.dayW / 2;
    p.push(
      `<text x="${mainX}" y="${tableY + (d.headerSub ? 19 : s.headH / 2 + 5)}" ${d.headerSub ? "" : 'text-anchor="middle"'} font-family="${s.dayFont}" font-size="${style === "color" ? 13.5 : 15.5}" font-weight="${style === "color" ? 600 : 400}" fill="${d.isToday ? s.accentDeep : s.ink}">${esc(d.headerMain)}</text>`,
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
  });

  // 节次列 + 空格底（今天列铺底）
  for (let period = 1; period <= periodCount; period++) {
    const y = tableY + s.headH + GAP + (period - 1) * rowPitch;
    const range = periodTimes[String(period)];
    p.push(
      `<rect x="${tableX}" y="${y}" width="${s.timeW}" height="${s.rowH}" fill="${s.bg}"/>`,
      `<text x="${tableX + s.timeW - 8}" y="${y + s.rowH / 2 - 3}" text-anchor="end" font-family="${FONT_MONO}" font-size="12" fill="${s.ink2}">${period}</text>`,
    );
    if (range) {
      p.push(
        `<text x="${tableX + s.timeW - 8}" y="${y + s.rowH / 2 + 12}" text-anchor="end" font-family="${FONT_MONO}" font-size="9" fill="${s.ink3}">${esc(range)}</text>`,
      );
    }
    days.forEach((d, i) => {
      const x = tableX + s.timeW + GAP + i * dayPitch;
      p.push(
        `<rect x="${x}" y="${y}" width="${s.dayW}" height="${s.rowH}" fill="${d.isToday ? s.todayCol : s.bg}"/>`,
      );
    });
  }

  // 整列放假（周模式）：虚线框 + 竖排名（旋转 90° 的「国庆节 放假」）
  days.forEach((d, i) => {
    if (!d.holiday) return;
    const x = tableX + s.timeW + GAP + i * dayPitch;
    const top = tableY + s.headH + GAP + CARD_PAD;
    const h = gridH - s.headH - GAP - CARD_PAD * 2;
    const label = `${d.holiday} 放假`;
    // rotate(-90) 后基线竖直、字形向基线左侧延伸，中心点右移半个字高才居中
    const cx = x + s.dayW / 2 + 7.5;
    p.push(
      `<rect x="${x + CARD_PAD}" y="${top}" width="${s.dayW - CARD_PAD * 2}" height="${h}" rx="3" fill="none" stroke="${s.gridBorder}" stroke-dasharray="4 3"/>`,
      `<text x="${cx}" y="${top + h / 2}" text-anchor="middle" font-family="${FONT_KAI}" font-size="15" letter-spacing="3" fill="${s.accentDeep}" transform="rotate(-90 ${cx} ${top + h / 2})">${esc(label)}</text>`,
    );
  });

  // 课格
  days.forEach((d, i) => {
    if (d.holiday) return;
    const x = tableX + s.timeW + GAP + i * dayPitch;
    for (const sl of d.slots) {
      const colW = (s.dayW - CARD_PAD * 2 - (sl.cols - 1) * CARD_GAP) / sl.cols;
      const cx = x + CARD_PAD + sl.col * (colW + CARD_GAP);
      const top = tableY + s.headH + GAP + (sl.start - 1) * rowPitch + CARD_PAD;
      const h = (sl.end - sl.start + 1) * rowPitch - GAP - CARD_PAD * 2;
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
      isToday: false,
      slots,
      unscheduled,
      splitSlots,
    };
  });

  return buildScheduleSvg({
    termLabel,
    subtitle: "整学期课表汇总",
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
 * （真值在 planForDate）。今天落在本周时铺底突出。
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
  const todayIso = isoOf(now);

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
      headerSub: `${date.getMonth() + 1}/${date.getDate()}${iso === todayIso ? " ·今" : ""}`,
      ...(plan.makeup ? { tag: "补课" } : {}),
      isToday: iso === todayIso,
      ...(plan.holiday ? { holiday: plan.holiday } : {}),
      slots,
      unscheduled,
      splitSlots,
    });
  }

  return buildScheduleSvg({
    termLabel,
    subtitle: `第 ${week} 周课表（${isoOf(monday)} 起）`,
    days,
    meta: { withWeeks: false },
    now,
    style,
    ...(opts.logoDataUri ? { logoDataUri: opts.logoDataUri } : {}),
  });
}
