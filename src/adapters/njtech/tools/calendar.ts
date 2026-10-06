/**
 * 日历与课表图工具：export_calendar（本机 .ics）/ export_schedule_image（课表 PNG/SVG 图）
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { loadLogoDataUri } from "../../../core/brand";
import { buildTermICS } from "../../../core/calendar/export";
import {
  generatedDir,
  recordDeliverable,
  sanitizeFileBase,
  uniquePath,
} from "../../../core/document/save";
import type { CourseData, ExamData } from "../../../core/model";
import { scheduleSvgToPng } from "../../../core/schedule-png";
import {
  renderTermScheduleSVG,
  renderWeekScheduleSVG,
  type ScheduleStyle,
} from "../../../core/schedule-svg";
import { school } from "../../../core/school";
import {
  fetchExamsSmart,
  fetchScheduleSmart,
  parseSemesterString,
  resolveWeek1Monday,
} from "../academics";
import { getCookie } from "../session";

/** 课表+考试的抓取与对齐（两个日历工具共用）：学期解析、渠道握手、交界期不串台 */
async function gatherCalendar(
  semester: string | undefined,
  include: "all" | "schedule" | "exams",
): Promise<
  | {
      ok: true;
      term: { year: number; semester: number; label: string };
      courses: CourseData[];
      exams: ExamData[];
    }
  | { ok: false; error: string }
> {
  const parsed = semester ? parseSemesterString(semester) : null;
  if (semester && !parsed) {
    return { ok: false, error: `学期格式无法解析：「${semester}」，应为「2026-2027-1」这类格式` };
  }

  const cookie = await getCookie();
  const failures: string[] = [];

  let courses: CourseData[] = [];
  let exams: ExamData[] = [];
  let term: { year: number; semester: number; label: string } | null = null;

  if (include !== "exams") {
    const r = await fetchScheduleSmart(cookie, parsed?.year, parsed?.semester);
    if (!r.ok) {
      failures.push(r.error);
    } else {
      term = r.data;
      courses = r.data.courses;
    }
  }

  if (include !== "schedule") {
    // 考试与课表对齐同一学期（自动探测时以课表结果为准，交界期不串台）
    const r = await fetchExamsSmart(
      cookie,
      term?.year ?? parsed?.year,
      term?.semester ?? parsed?.semester,
    );
    if (!r.ok) {
      failures.push(r.error);
    } else {
      term = term ?? r.data;
      exams = r.data.exams;
    }
  }

  if (!term || failures.length === (include === "all" ? 2 : 1)) {
    return {
      ok: false,
      error: `查询失败：${failures.join("；")}。请检查网络或稍后重试，不要凭空生成日历内容。`,
    };
  }
  return { ok: true, term, courses, exams };
}

export const calendarTools = {
  /** 日历导出（本机文件） */
  export_calendar: tool({
    description:
      "把课表/考试导出为 .ics 日历文件（iCalendar 标准）：整学期逐周展开、自动跳过放假日并生成「放假」全天事件、调休补课日按被换周几的课表补出、考试带提前 30 分钟提醒。用户说「导出课表到手机日历」「把考试加进日历」「生成 ics」时调用。文件存 data/generated 并回绝对路径，手机日历 App 导入即可（导入是一次性快照，课表变更后重新导出覆盖）。",
    inputSchema: z.object({
      semester: z
        .string()
        .optional()
        .describe("指定学期，格式如「2026-2027-1」；不填则自动探测最新学期"),
      include: z
        .enum(["all", "schedule", "exams"])
        .default("all")
        .describe("导出内容：all=课表+考试（默认），schedule=仅课表，exams=仅考试"),
    }),
    execute: async ({ semester, include }) => {
      const g = await gatherCalendar(semester, include);
      if (!g.ok) return { error: `日历导出失败：${g.error}` };

      const week1Monday = resolveWeek1Monday(g.term.year, g.term.semester).week1Monday;
      const result = buildTermICS({
        courses: g.courses,
        exams: g.exams,
        week1Monday,
        termLabel: g.term.label,
      });

      const dir = generatedDir();
      await fsp.mkdir(dir, { recursive: true });
      const semPart = `${g.term.year}-${g.term.semester === 3 ? 1 : 2}`;
      const base = include === "exams" ? `exams-${semPart}` : `calendar-${semPart}`;
      const filePath = uniquePath(dir, base, ".ics");
      await fsp.writeFile(filePath, result.ics, "utf8");
      const file = {
        filename: path.basename(filePath),
        filePath,
        bytes: Buffer.byteLength(result.ics, "utf8"),
      };
      recordDeliverable(file);

      return {
        file,
        term: g.term.label,
        counts: {
          课程事件: result.courseEvents,
          调休补课: result.makeupEvents,
          放假全天: result.holidayEvents,
          因假取消: result.holidaySkipped,
          考试: result.examEvents,
          ...(result.noTimeSkipped ? { 无节次跳过: result.noTimeSkipped } : {}),
        },
        usage:
          "把 .ics 文件发到手机后用日历 App 打开导入（iPhone 直接点开、安卓选日历应用）。整学期一次导入即可，重复导入不会产生重复事件。",
        note:
          !g.courses.length && !g.exams.length
            ? "课表与考试均已查通但本学期无数据，日历里只有假期标记（如有）"
            : undefined,
      };
    },
  }),

  /** 课表图片导出（PNG/SVG × 整学期汇总/单周） */
  export_schedule_image: tool({
    description:
      "把课表导出为图片（默认 PNG 位图，手机相册/QQ 直接存直接看；可选 SVG 矢量）。默认 classic 红头档案风——暖纸底+墨字+单一朱砂+楷体课名+印章 logo，CourseRaptor 招牌视觉，与 /schedule 网页同款；style=color 可换彩色课格风（每门课一个柔和色块）。两种形态：term=整学期汇总（默认，课格标注「2-16周(单)」这类周次，适合做壁纸或打印）、week=单周实际课表（自动处理放假与调休补课，可指定周次，默认本周）。文件名由你按用户语境拟定（filename 参数），如「国庆周课表」「我的秋课表壁纸」。用户说「导出课表图片」「生成课表壁纸」「把课表做成图」时调用。文件存 data/generated 并回绝对路径。",
    inputSchema: z.object({
      mode: z
        .enum(["term", "week"])
        .default("term")
        .describe("term=整学期汇总课表（默认）；week=某一教学周的实际课表（含放假调休）"),
      format: z
        .enum(["png", "svg"])
        .default("png")
        .describe("png=位图，手机直接保存查看（默认）；svg=矢量图，放大不糊、可再编辑"),
      style: z
        .enum(["classic", "color"])
        .default("classic")
        .describe(
          "classic=红头档案风（默认，CourseRaptor 招牌视觉，与 /schedule 网页同款）；color=彩色课格",
        ),
      filename: z
        .string()
        .optional()
        .describe(
          "图片文件名（不含扩展名，按 format 自动补 .png/.svg）。按用户说法和用途起个有意义的名字，如「国庆周课表」「期末冲刺课表壁纸」；不填则用 schedule-term/schedule-weekN 默认名",
        ),
      week: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("week 模式的教学周次（第几周）；不填则本周。term 模式忽略此参数"),
      semester: z
        .string()
        .optional()
        .describe("指定学期，格式如「2026-2027-1」；不填则自动探测最新学期"),
    }),
    execute: async ({ mode, format, style, filename, week, semester }) => {
      const g = await gatherCalendar(semester, "schedule");
      if (!g.ok) return { error: `课表图导出失败：${g.error}` };

      const semPart = `${g.term.year}-${g.term.semester === 3 ? 1 : 2}`;
      const logo = loadLogoDataUri() ?? undefined;
      let svgResult: ReturnType<typeof renderTermScheduleSVG>;
      let base: string;
      let resolvedWeek: number | undefined;

      if (mode === "week") {
        const terms = school().terms;
        const current = terms.weekOf(g.term.year, g.term.semester);
        const maxWeek = Math.max(1, ...g.courses.flatMap((c) => terms.expandWeeks(c.weeks)));
        resolvedWeek = week ?? current?.week;
        if (resolvedWeek == null) {
          return {
            error: `当前不在教学周内（${g.term.label}），请指定周次（1-${maxWeek}）再导出单周课表。`,
          };
        }
        if (resolvedWeek > maxWeek) {
          return { error: `本学期课表只到第 ${maxWeek} 周，没有第 ${resolvedWeek} 周的课。` };
        }
        const week1Monday = resolveWeek1Monday(g.term.year, g.term.semester).week1Monday;
        svgResult = renderWeekScheduleSVG({
          courses: g.courses,
          week: resolvedWeek,
          week1Monday,
          termLabel: g.term.label,
          style: style as ScheduleStyle,
          ...(logo ? { logoDataUri: logo } : {}),
        });
        base = `schedule-week${resolvedWeek}-${semPart}`;
      } else {
        svgResult = renderTermScheduleSVG({
          courses: g.courses,
          termLabel: g.term.label,
          style: style as ScheduleStyle,
          ...(logo ? { logoDataUri: logo } : {}),
        });
        base = `schedule-term-${semPart}`;
      }

      const dir = generatedDir();
      await fsp.mkdir(dir, { recursive: true });
      const payload: Buffer | string =
        format === "png" ? scheduleSvgToPng(svgResult.svg, svgResult.width * 2) : svgResult.svg;
      const ext = format === "png" ? ".png" : ".svg";
      // 模型自拟的文件名优先（去扩展名 + 同文档一道净化闸），缺省回落默认名
      const named = filename?.trim().replace(/\.(png|svg)$/i, "");
      const filePath = uniquePath(dir, named ? sanitizeFileBase(named) : base, ext);
      await fsp.writeFile(filePath, payload);
      const file = {
        filename: path.basename(filePath),
        filePath,
        bytes: typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.length,
      };
      recordDeliverable(file);

      const { counts } = svgResult;
      return {
        file,
        term: g.term.label,
        mode,
        style,
        format,
        ...(resolvedWeek != null ? { week: resolvedWeek } : {}),
        counts: {
          课格: counts.cells,
          课程条目: counts.courses,
          ...(counts.splitSlots ? { 并排时段: counts.splitSlots } : {}),
          ...(counts.unscheduled ? { 未排节次: counts.unscheduled } : {}),
        },
        usage:
          format === "png"
            ? "PNG 是位图，手机/QQ 直接保存查看即可（2 倍分辨率出图，放大不糊）。"
            : "SVG 是矢量图，任意放大不糊：浏览器/微信直接打开，需要 PNG 时可用浏览器打开后截图。",
        note: !g.courses.length ? "本学期课表为空，图里只有空网格" : undefined,
      };
    },
  }),
};
