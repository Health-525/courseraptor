/**
 * 课程对比工具：compare_courses
 * 只读分析工具——输入若干课程名，自动查出各教学班明细、与学生当前已选课程
 * 做时间冲突检测，返回按「可不可选」分组的对比表。
 *
 * 不提交选课、不写任何数据，纯查询 + 内存计算。
 */

import { tool } from "ai";
import { z } from "zod";
import {
  NJTECH_PERIOD_TIMES,
  parseSksjSegments,
  periodTimeRange,
  type SkwjSegment,
  segmentsOverlap,
  WEEKDAY_NAMES,
} from "../jwgl/academics";
import { type EnrolledClass, fetchEnrolledClasses } from "../jwgl/portal";
import { getCookie, getXkSession, invalidateXkSession } from "../jwgl/session";
import { fetchJxbList, roundRefOf, searchCourses, type XkCourse } from "../jwgl/xk";

/** 从教学班原始数据取 sksj 字符串（课表时间字符串） */
function classSchedule(c: XkCourse): string {
  return String(c.raw?.sksj ?? "");
}

function classVenue(c: XkCourse): string {
  return String(c.raw?.jxdd ?? "");
}

/** 把已选课程的 time 字段（sksj）解析成时段数组 */
function parseEnrolledTime(time: string): SkwjSegment[] {
  return parseSksjSegments(time);
}

/**
 * 检查候选教学班是否与已选课程的任一时段冲突。
 * 返回冲突的已选课程名列表（空=无冲突）。
 */
function findConflicts(
  candidate: SkwjSegment[],
  enrolled: { courseName: string; segments: SkwjSegment[] }[],
): string[] {
  const conflicts: string[] = [];
  for (const e of enrolled) {
    for (const seg of candidate) {
      if (e.segments.some((es) => segmentsOverlap(seg, es))) {
        if (!conflicts.includes(e.courseName)) conflicts.push(e.courseName);
        break;
      }
    }
  }
  return conflicts;
}

/** 教学班对比行 */
interface ClassRow {
  courseName: string;
  teacher: string;
  schedule: string;
  venue: string;
  capacity: number;
  selected: number;
  remain: number;
  /** 与已选课程冲突的课程名列表（空=不冲突） */
  conflictsWith: string[];
  /** 状态标签：available / full / conflict / noperiod */
  status: "available" | "full" | "conflict" | "noperiod";
}

/** 格式化时段为人类可读的「周X 第N-M节（时间）·N-M周」 */
function formatSegments(segs: SkwjSegment[]): string {
  if (!segs.length) return "时间未解析";
  return segs
    .map((s) => {
      const weekday = WEEKDAY_NAMES[s.weekday] ?? `周${s.weekday}`;
      const periodStr = s.periods.length
        ? `第${s.periods[0]}-${s.periods[s.periods.length - 1]}节`
        : "节次未知";
      const timeStr = periodTimeRange(s.periods) ?? "";
      const weeksStr = s.weeks ? `${s.weeks}周` : "全学期";
      return [weekday, periodStr, timeStr, weeksStr].filter(Boolean).join(" ");
    })
    .join("; ");
}

export const courseCompareTools = {
  compare_courses: tool({
    description:
      "只读对比工具：输入若干课程名关键词，查出每门课所有教学班的教师、时间、地点、余量，并自动与学生当前已选课程做时间冲突检测，返回按状态分组的对比表（可用的/满员的/时间冲突的）。帮助学生找到「时间不冲突、有余量」的教学班。全程不提交选课、不修改任何数据。选课未开放时查不到教学班明细属正常。",
    inputSchema: z.object({
      courseNames: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe('要对比的课程名关键词列表（最多5门），如["操作系统原理","计算机网络"]'),
    }),
    execute: async ({ courseNames }) => {
      // 1. 取已选课程（用于冲突检测）
      const cookie = await getCookie();
      let enrolled: EnrolledClass[] = [];
      try {
        enrolled = await fetchEnrolledClasses(cookie);
      } catch {
        // 已选课程查询失败不阻断对比——没有冲突基线时所有班都标 noperiod
        enrolled = [];
      }
      const enrolledSegments = enrolled.map((e) => ({
        courseName: e.courseName,
        segments: parseEnrolledTime(e.time),
      }));

      // 2. 逐门课查教学班明细（复用 search_classes 的核心逻辑）
      let session = await getXkSession();
      const courseResults: Array<{
        courseName: string;
        found: boolean;
        classes: ClassRow[];
        note?: string;
      }> = [];

      for (const courseName of courseNames) {
        const searchOnce = async (): Promise<XkCourse[]> => {
          try {
            return await searchCourses(session, courseName);
          } catch (e) {
            if ((e as Error).message === "SESSION_EXPIRED") {
              invalidateXkSession();
              session = await getXkSession(true);
              return await searchCourses(session, courseName);
            }
            throw e;
          }
        };

        let courses: XkCourse[];
        try {
          courses = await searchOnce();
        } catch (e) {
          courseResults.push({
            courseName,
            found: false,
            classes: [],
            note: `查询失败：${(e as Error).message.slice(0, 80)}`,
          });
          continue;
        }

        // 按课程号去重，保留携带轮次凭证的课程对象
        const byCode = new Map<string, XkCourse>();
        for (const c of courses) {
          if (c.courseCode && !byCode.has(c.courseCode)) byCode.set(c.courseCode, c);
        }
        const picked = [...byCode.values()].slice(0, 3);

        if (picked.length === 0) {
          courseResults.push({
            courseName,
            found: false,
            classes: [],
            note: session.isXkOpen ? "未查到该课程的教学班" : "选课未开放，教学班明细不可查",
          });
          continue;
        }

        const rows: ClassRow[] = [];
        for (const course of picked) {
          const ref = roundRefOf(course, session);
          let list: XkCourse[];
          try {
            list = await fetchJxbList(session, { ...ref, courseCode: course.courseCode });
          } catch (e) {
            if ((e as Error).message === "SESSION_EXPIRED") {
              invalidateXkSession();
              session = await getXkSession(true);
              list = await fetchJxbList(session, { ...ref, courseCode: course.courseCode });
            } else {
              rows.push({
                courseName: course.courseName || course.courseCode,
                teacher: "查询失败",
                schedule: "",
                venue: "",
                capacity: 0,
                selected: 0,
                remain: 0,
                conflictsWith: [],
                status: "noperiod",
              });
              continue;
            }
          }

          for (const cls of list) {
            const sksj = classSchedule(cls);
            const segs = parseSksjSegments(sksj);
            const conflicts = segs.length ? findConflicts(segs, enrolledSegments) : [];
            const remain = cls.unlimited ? Infinity : cls.remain;
            let status: ClassRow["status"];
            if (conflicts.length > 0) status = "conflict";
            else if (remain > 0 || cls.unlimited) status = "available";
            else status = "full";
            if (!segs.length && !sksj) status = "noperiod";

            rows.push({
              courseName: course.courseName || course.courseCode,
              teacher: cls.teacher || "未知",
              schedule: sksj ? formatSegments(segs) : "未提供时间",
              venue: classVenue(cls) || "未提供",
              capacity: cls.capacity || 0,
              selected: cls.selected || 0,
              remain: cls.unlimited ? -1 : cls.remain,
              conflictsWith: conflicts,
              status,
            });
          }
        }

        // 排序：可用的 > 无时间 > 满员 > 冲突；同状态内按余量降序
        const statusOrder: Record<ClassRow["status"], number> = {
          available: 0,
          noperiod: 1,
          full: 2,
          conflict: 3,
        };
        rows.sort((a, b) => {
          const d = statusOrder[a.status] - statusOrder[b.status];
          if (d !== 0) return d;
          return (b.remain === -1 ? Infinity : b.remain) - (a.remain === -1 ? Infinity : a.remain);
        });

        courseResults.push({
          courseName,
          found: true,
          classes: rows,
        });
      }

      // 3. 汇总
      const allRows = courseResults.flatMap((r) => r.classes);
      const available = allRows.filter((r) => r.status === "available").length;
      const conflict = allRows.filter((r) => r.status === "conflict").length;
      const full = allRows.filter((r) => r.status === "full").length;

      return {
        isXkOpen: session.isXkOpen,
        courses: courseResults,
        enrolledBaseline: enrolled.length
          ? enrolled.map((e) => `${e.courseName}（${e.time || "时间未解析"}）`)
          : ["未查到已选课程，冲突检测无基线"],
        summary: `对比 ${courseNames.length} 门课共 ${allRows.length} 个教学班：${available} 个可用、${conflict} 个时间冲突、${full} 个满员`,
      };
    },
  }),
};
