/**
 * 课表 SVG 渲染 — 纯数据到图形，不碰网络、不落盘
 *
 * 与 /schedule 网页同一份「红头档案」视觉（暖纸底 + 墨字 + 单一朱砂红），
 * 供两个入口共用：AI 工具 export_schedule_svg（adapters/njtech/tools/calendar.ts）
 * 与网页直链 /api/schedule/svg（channels/web/chat-web.ts）。两种形态：
 * - 整学期汇总：课程按 (星期, 节次) 定位，课格标注周次，同时段不同周次的
 *   课（冲突）横向并排分栏
 * - 单周：与网页周课表同口径——放假清空、调休按被补周几换课表、单双周
 *   过滤（换算真值在 core/calendar/week-plan.ts），今天列朱砂铺底
 *
 * 文字排版是 SVG 手工活：CJK 感知折行 + 超行省略号，长度全靠字宽估算
 * （中文全宽、ASCII 约 0.56 倍），宁可估宽不估窄，避免溢出课格。
 */

import { isoOf, planForDate, weekdayOf } from "./calendar/week-plan";
import type { CourseData } from "./model";
import { school } from "./school";

// ── 设计令牌：与 channels/web 各页同源的「红头档案」配色 ──────────────
const C = {
  paper: "#F6F4ED",
  paperDeep: "#F0EDE4",
  card: "#FCFBF7",
  ink: "#25221C",
  ink2: "#5A554A",
  ink3: "#6E6656",
  rule: "#E1DCCF",
  rule2: "#C9C1AF",
  accent: "#AD392C",
  accentDeep: "#852B22",
  accentSoft: "#F3E3DE",
} as const;

const FONT_KAI = "KaiTi, STKaiti, Kaiti SC, Georgia, serif";
const FONT_MONO = "ui-monospace, Cascadia Mono, Consolas, Liberation Mono, monospace";

// ── 几何常量（px）────────────────────────────────────────────────────
const MARGIN = 28;
const TITLE_H = 70;
const TIME_W = 88;
const DAY_W = 152;
const HEAD_H = 44;
const ROW_H = 80;
const GAP = 1; // 网格缝：底色透出来当格线（与网页 gap:1px 同款）
const CARD_PAD = 4; // 课格与格线之间留白
const CARD_GAP = 4; // 并排分栏之间的缝
const NAME_SIZE = 14.5;
const NAME_LH = 18;
const META_SIZE = 10.5;
const META_LH = 12.5;

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

/** 课格文字块：课名（楷体）+ 元信息（mono 小字），整块在卡片内垂直居中 */
function courseCard(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  course: CourseData;
  /** term 模式带周次行；week 模式该周已过滤，周次没有信息量 */
  withWeeks: boolean;
}): string {
  const { x, y, w, h, course, withWeeks } = opts;
  const inner = w - 8 - 3; // 左侧朱砂条 3px + 内边距
  // 并排分栏的窄卡放不下「地点 · 教师」整行时优先保地点（教师名让位）
  const narrow = w < DAY_W * 0.7;
  const meta1 = narrow
    ? course.location?.trim() || "地点待定"
    : [course.location?.trim() || "地点待定", course.teacher?.trim()].filter(Boolean).join(" · ");
  const meta2 = withWeeks ? weeksLabel(course.weeks) : "";
  const metas = [meta1, meta2].filter(Boolean);

  const metaH = metas.length * META_LH;
  const nameMax = Math.max(
    1,
    Math.min(3, Math.floor((h - 8 - (metas.length ? metaH + 4 : 0)) / NAME_LH)),
  );
  const nameLines = fitLines(course.title, inner, NAME_SIZE, nameMax);

  const contentH = nameLines.length * NAME_LH + (metas.length ? 4 + metaH : 0);
  let ty = y + (h - contentH) / 2 + NAME_SIZE; // 首行基线

  const parts: string[] = [
    `<g>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${C.card}" filter="url(#cardShadow)"/>`,
    `<rect x="${x}" y="${y}" width="3" height="${h}" rx="1.5" fill="${C.accent}"/>`,
  ];
  for (const line of nameLines) {
    parts.push(
      `<text x="${x + 8}" y="${ty.toFixed(1)}" font-family="${FONT_KAI}" font-size="${NAME_SIZE}" font-weight="600" fill="${C.ink}">${esc(line)}</text>`,
    );
    ty += NAME_LH;
  }
  ty += 4 - (NAME_LH - META_SIZE); // 元信息行距从课名行距切换过来
  for (const m of metas) {
    for (const line of fitLines(m, inner, META_SIZE, 1, 0.62)) {
      parts.push(
        `<text x="${x + 8}" y="${(ty + 1).toFixed(1)}" font-family="${FONT_MONO}" font-size="${META_SIZE}" fill="${C.ink3}">${esc(line)}</text>`,
      );
      ty += META_LH;
    }
  }
  parts.push("</g>");
  return parts.join("");
}

// ── 网格组装（两种形态共用） ─────────────────────────────────────────

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
}): ScheduleSvgResult {
  const { termLabel, subtitle, days, meta, now } = opts;

  const periodTimes = school().terms.periodTimes();
  const knownPeriods = Object.keys(periodTimes)
    .map(Number)
    .filter((p) => Number.isInteger(p) && p > 0);
  const maxCourseEnd = Math.max(0, ...days.flatMap((d) => d.slots.map((s) => s.end)));
  const periodCount = Math.max(10, ...knownPeriods, maxCourseEnd);

  const dayPitch = DAY_W + GAP;
  const rowPitch = ROW_H + GAP;
  const tableX = MARGIN;
  const tableY = MARGIN + TITLE_H + 14;
  const tableW = TIME_W + GAP + days.length * dayPitch - GAP;
  const gridH = HEAD_H + GAP + periodCount * rowPitch - GAP;

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

  const height = tableY + gridH + (footNotes.length ? 12 + footNotes.length * 16 : 8) + MARGIN;
  const width = MARGIN * 2 + tableW;
  const p: string[] = [];

  // 画布与页头（暖纸底、朱砂印章、学期标题、生成时间戳）
  p.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<title>课表 · ${esc(termLabel)}</title>`,
    `<defs><filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">`,
    `<feDropShadow dx="0" dy="1" stdDeviation="1.6" flood-color="#322A1F" flood-opacity="0.12"/>`,
    `</filter></defs>`,
    `<rect width="${width}" height="${height}" fill="${C.paper}"/>`,
    // 印章：朱砂圈 + 楷体「课」字，微倾（与网页页头 rotate(-7deg) 同款）
    `<g transform="rotate(-7 ${MARGIN + 18} ${MARGIN + 30})">`,
    `<circle cx="${MARGIN + 18}" cy="${MARGIN + 30}" r="16" fill="none" stroke="${C.accent}" stroke-width="2"/>`,
    `<text x="${MARGIN + 18}" y="${MARGIN + 35.5}" text-anchor="middle" font-family="${FONT_KAI}" font-size="17" fill="${C.accent}">课</text>`,
    `</g>`,
    `<text x="${MARGIN + 44}" y="${MARGIN + 26}" font-family="${FONT_KAI}" font-size="21" letter-spacing="1" fill="${C.ink}">${esc(termLabel)}</text>`,
    `<text x="${MARGIN + 44}" y="${MARGIN + 46}" font-family="${FONT_MONO}" font-size="10.5" letter-spacing="2" fill="${C.ink3}">COURSERAPTOR · SCHEDULE — ${esc(subtitle)}</text>`,
    `<text x="${width - MARGIN}" y="${MARGIN + 46}" text-anchor="end" font-family="${FONT_MONO}" font-size="10.5" fill="${C.ink3}">生成于 ${stampOf(now)}</text>`,
    `<line x1="${MARGIN}" y1="${MARGIN + 58}" x2="${width - MARGIN}" y2="${MARGIN + 58}" stroke="${C.rule2}" stroke-width="1"/>`,
  );

  // 网格底色 + 外框（缝里透出的就是格线）
  p.push(
    `<rect x="${tableX}" y="${tableY}" width="${tableW}" height="${gridH}" fill="${C.rule}" stroke="${C.rule2}" stroke-width="1"/>`,
    // 左上角「节次」
    `<rect x="${tableX}" y="${tableY}" width="${TIME_W}" height="${HEAD_H}" fill="${C.paper}"/>`,
    `<text x="${tableX + TIME_W - 8}" y="${tableY + HEAD_H / 2 + 4}" text-anchor="end" font-family="${FONT_MONO}" font-size="11" letter-spacing="2" fill="${C.ink3}">节次</text>`,
  );

  // 日头
  days.forEach((d, i) => {
    const x = tableX + TIME_W + GAP + i * dayPitch;
    p.push(
      `<rect x="${x}" y="${tableY}" width="${DAY_W}" height="${HEAD_H}" fill="${d.isToday ? C.accentSoft : C.paper}"/>`,
    );
    if (d.isToday) {
      p.push(`<rect x="${x}" y="${tableY}" width="${DAY_W}" height="2" fill="${C.accent}"/>`);
    }
    const mainX = d.headerSub ? x + 10 : x + DAY_W / 2;
    const mainAnchor = d.headerSub ? "start" : "middle";
    p.push(
      `<text x="${mainX}" y="${tableY + (d.headerSub ? 20 : HEAD_H / 2 + 5)}" ${d.headerSub ? "" : `text-anchor="${mainAnchor}"`} font-family="${FONT_KAI}" font-size="15.5" fill="${d.isToday ? C.accentDeep : C.ink}">${esc(d.headerMain)}</text>`,
    );
    if (d.headerSub) {
      p.push(
        `<text x="${x + 10}" y="${tableY + 35}" font-family="${FONT_MONO}" font-size="10" fill="${C.ink3}">${esc(d.headerSub)}</text>`,
      );
    }
    if (d.tag) {
      const tagW = measure(d.tag, 9, 0.62) + 8;
      p.push(
        `<rect x="${x + DAY_W - tagW - 8}" y="${tableY + 9}" width="${tagW}" height="15" rx="2" fill="${C.accentSoft}"/>`,
        `<text x="${x + DAY_W - tagW - 8 + tagW / 2}" y="${tableY + 20}" text-anchor="middle" font-family="${FONT_MONO}" font-size="9" fill="${C.accentDeep}">${esc(d.tag)}</text>`,
      );
    }
  });

  // 节次列 + 空格底（今天列朱砂铺底）
  for (let period = 1; period <= periodCount; period++) {
    const y = tableY + HEAD_H + GAP + (period - 1) * rowPitch;
    const range = periodTimes[String(period)];
    p.push(
      `<rect x="${tableX}" y="${y}" width="${TIME_W}" height="${ROW_H}" fill="${C.paper}"/>`,
      `<text x="${tableX + TIME_W - 8}" y="${y + ROW_H / 2 - 3}" text-anchor="end" font-family="${FONT_MONO}" font-size="13" fill="${C.ink2}">${period}</text>`,
    );
    if (range) {
      p.push(
        `<text x="${tableX + TIME_W - 8}" y="${y + ROW_H / 2 + 13}" text-anchor="end" font-family="${FONT_MONO}" font-size="10" fill="${C.ink3}">${esc(range)}</text>`,
      );
    }
    days.forEach((d, i) => {
      const x = tableX + TIME_W + GAP + i * dayPitch;
      p.push(
        `<rect x="${x}" y="${y}" width="${DAY_W}" height="${ROW_H}" fill="${d.isToday ? C.accentSoft : C.paper}"/>`,
      );
    });
  }

  // 整列放假（周模式）：虚线框 + 竖排名（旋转 90° 的「国庆节 放假」）
  days.forEach((d, i) => {
    if (!d.holiday) return;
    const x = tableX + TIME_W + GAP + i * dayPitch;
    const top = tableY + HEAD_H + GAP + CARD_PAD;
    const h = gridH - HEAD_H - GAP - CARD_PAD * 2;
    const label = `${d.holiday} 放假`;
    // rotate(-90) 后基线竖直、字形向基线左侧延伸，中心点右移半个字高才居中
    const cx = x + DAY_W / 2 + 7.5;
    p.push(
      `<rect x="${x + CARD_PAD}" y="${top}" width="${DAY_W - CARD_PAD * 2}" height="${h}" rx="3" fill="none" stroke="${C.rule2}" stroke-dasharray="4 3"/>`,
      `<text x="${cx}" y="${top + h / 2}" text-anchor="middle" font-family="${FONT_KAI}" font-size="15" letter-spacing="3" fill="${C.accentDeep}" transform="rotate(-90 ${cx} ${top + h / 2})">${esc(label)}</text>`,
    );
  });

  // 课格
  days.forEach((d, i) => {
    if (d.holiday) return;
    const x = tableX + TIME_W + GAP + i * dayPitch;
    for (const s of d.slots) {
      const colW = (DAY_W - CARD_PAD * 2 - (s.cols - 1) * CARD_GAP) / s.cols;
      const cx = x + CARD_PAD + s.col * (colW + CARD_GAP);
      const top = tableY + HEAD_H + GAP + (s.start - 1) * rowPitch + CARD_PAD;
      const h = (s.end - s.start + 1) * rowPitch - GAP - CARD_PAD * 2;
      p.push(
        courseCard({
          x: round1(cx),
          y: round1(top),
          w: round1(colW),
          h: round1(h),
          course: s.course,
          withWeeks: meta.withWeeks,
        }),
      );
    }
  });

  // 脚注：未排节次的课
  let fy = tableY + gridH + 22;
  for (const note of footNotes) {
    p.push(
      `<text x="${MARGIN}" y="${fy}" font-family="${FONT_MONO}" font-size="11" fill="${C.ink3}">· ${esc(note)}</text>`,
    );
    fy += 16;
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
}): ScheduleSvgResult {
  const { courses, termLabel } = opts;
  const now = opts.now ?? new Date();
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
  });
}

// ── 形态二：单周课表 ────────────────────────────────────────────────

/**
 * 第 week 周的实际课表：放假清空、调休按被补周几换课表、单双周过滤
 * （真值在 planForDate）。今天落在本周时朱砂铺底突出。
 */
export function renderWeekScheduleSVG(opts: {
  courses: CourseData[];
  week: number;
  /** 第 1 周周一（YYYY-MM-DD） */
  week1Monday: string;
  termLabel: string;
  now?: Date;
}): ScheduleSvgResult {
  const { courses, week, week1Monday, termLabel } = opts;
  const now = opts.now ?? new Date();
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
  });
}
