/**
 * 日历导出工具：export_calendar
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";

import { buildTermICS } from "../calendar-export";
import { generatedDir, recordDeliverable, uniquePath } from "../document/save";
import {
  fetchExamsSmart,
  fetchScheduleSmart,
  parseSemesterString,
  resolveWeek1Monday,
} from "../jwgl/academics";
import type { CourseData, ExamData } from "../jwgl/types";
import { getCookie } from "./session";

export const calendarTools = {
  /** 日历导出 */
  export_calendar: tool({
    description:
      "把课表/考试导出为 .ics 日历文件（iCalendar 标准）：整学期逐周展开、自动跳过放假日并生成「放假」全天事件、调休补课日按被换周几的课表补出、考试带提前 30 分钟提醒。用户说「导出课表到手机日历」「把考试加进日历」「生成 ics」时调用。文件存 data/generated 并回绝对路径，手机日历 App 导入即可。",
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
      const parsed = semester ? parseSemesterString(semester) : null;
      if (semester && !parsed) {
        return { error: `学期格式无法解析：「${semester}」，应为「2026-2027-1」这类格式` };
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
          error: `日历导出失败：${failures.join("；")}。请检查网络或稍后重试，不要凭空生成日历内容。`,
        };
      }

      const week1Monday = resolveWeek1Monday(term.year, term.semester).week1Monday;
      const result = buildTermICS({ courses, exams, week1Monday, termLabel: term.label });

      const dir = generatedDir();
      await fsp.mkdir(dir, { recursive: true });
      const semPart = `${term.year}-${term.semester === 3 ? 1 : 2}`;
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
        term: term.label,
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
          !courses.length && !exams.length
            ? "课表与考试均已查通但本学期无数据，日历里只有假期标记（如有）"
            : undefined,
      };
    },
  }),
};
