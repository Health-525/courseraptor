/**
 * CourseRaptor agent 工具集
 * 7 个工具：选课状态 / 搜课 / 盯课 / 抢课 / 课表 / 成绩 / 考试
 */

import { tool } from "ai";
import { z } from "zod";

import { config } from "../config";
import { fetchSchedule, fetchExams } from "../jwgl/academics";
import { fetchAllGrades } from "../jwgl/grades";
import {
  inspectXk,
  searchCourses,
  submitCourse,
  matchTargets,
  type XkCourse,
  type XkTarget,
} from "../jwgl/xk";
import {
  getCookie,
  getXkSession,
  invalidateXkSession,
  pollDelay,
} from "./session";

const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function now(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function courseBrief(c: XkCourse) {
  return {
    courseName: c.courseName,
    courseCode: c.courseCode,
    teacher: c.teacher,
    credit: c.credit,
    capacity: c.capacity,
    selected: c.selected,
    remain: c.remain,
    jxbId: c.jxbId,
  };
}

// ── 监控/抢课共用循环 ─────────────────────────────────────────

interface LoopResult {
  rounds: number;
  durationSec: number;
  isXkOpen: boolean;
  events: Array<{ time: string; message: string }>;
  grabbed: { courseName: string; teacher: string; message: string } | null;
  submitAttempts: number;
  lastSnapshot: Array<{ courseName: string; teacher: string; selected: number; capacity: number; remain: number }>;
}

async function watchLoop(
  targets: XkTarget[],
  durationSec: number,
  grab: boolean
): Promise<LoopResult> {
  const deadline = Date.now() + durationSec * 1000;
  let session = await getXkSession();
  let rounds = 0;
  let submitAttempts = 0;
  let grabbed: LoopResult["grabbed"] = null;
  const events: LoopResult["events"] = [];
  let lastSnapshot: LoopResult["lastSnapshot"] = [];

  while (Date.now() < deadline) {
    rounds++;
    let courses: XkCourse[] = [];
    try {
      courses = await searchCourses(session);
    } catch (e) {
      if ((e as Error).message === "SESSION_EXPIRED") {
        invalidateXkSession();
        session = await getXkSession(true);
        continue;
      }
      throw e;
    }

    const matched = courses.filter((c) => matchTargets(c, targets));
    lastSnapshot = matched.map((c) => ({
      courseName: c.courseName,
      teacher: c.teacher,
      selected: c.selected,
      capacity: c.capacity,
      remain: c.remain,
    }));
    const available = matched.filter((c) => c.remain > 0);

    if (available.length > 0) {
      events.push({
        time: now(),
        message: `发现余量：${available
          .map((c) => `${c.courseName}（${c.teacher}）余量 ${c.remain}`)
          .join("；")}`,
      });

      if (grab) {
        for (const course of available) {
          submitAttempts++;
          const result = await submitCourse(session, course);
          if (result.ok) {
            grabbed = {
              courseName: course.courseName,
              teacher: course.teacher,
              message: result.message,
            };
            break;
          }
          events.push({ time: now(), message: `提交失败：${result.message}` });
          if (result.message === "SESSION_EXPIRED") {
            invalidateXkSession();
            session = await getXkSession(true);
            break;
          }
          if (submitAttempts >= 10) {
            events.push({ time: now(), message: "提交失败次数达到上限（10 次），停止重试" });
            break;
          }
        }
        if (grabbed) break;
      }
    }

    await pollDelay(3000);
  }

  return {
    rounds,
    durationSec,
    isXkOpen: session.isXkOpen,
    events,
    grabbed,
    submitAttempts,
    lastSnapshot,
  };
}

// ── 工具定义 ─────────────────────────────────────────────────

export const raptorTools = {
  /** 1. 查询选课模块状态 */
  get_xk_status: tool({
    description:
      "查询南京工业大学教务系统「自主选课」模块的当前状态：选课是否开放（iskxk）、选课控制 ID（xkkzId）、以及课程查询接口是否仍返回「加密串错误」（防爬拦截）。回答任何选课相关问题前建议先调用此工具确认状态。",
    inputSchema: z.object({}),
    execute: async () => {
      const result = await inspectXk(
        config.jwglUsername,
        config.jwglPassword
      );
      const encryptedError = result.courseListRaw.includes("加密串");
      return {
        isXkOpen: result.isXkOpen,
        isXkOpenLabel: result.isXkOpen ? "选课开放中" : "当前不属于选课阶段",
        xkkzId: result.xkkzId ?? "未下发（选课未开放时不发放）",
        courseQueryBlocked: encryptedError,
        courseQueryNote: encryptedError
          ? "课程查询接口仍被防爬拦截（加密串错误），选课开放后需复测"
          : "课程查询接口无加密串错误",
        courseQueryRawHead: result.courseListRaw.slice(0, 200),
      };
    },
  }),

  /** 2. 搜课程查余量 */
  search_courses: tool({
    description:
      "按关键词搜索可选课程列表，返回每个教学班的课程名、教师、容量、已选人数、剩余名额。选课未开放或接口被拦截时可能返回空列表。",
    inputSchema: z.object({
      keyword: z.string().describe("课程名关键词（模糊匹配），如「高等数学」「羽毛球」"),
    }),
    execute: async ({ keyword }) => {
      const session = await getXkSession();
      const courses = await searchCourses(session, keyword);
      return {
        isXkOpen: session.isXkOpen,
        total: courses.length,
        courses: courses.slice(0, 30).map(courseBrief),
        note:
          courses.length === 0
            ? "未查询到课程。若选课未开放（isXkOpen=false）属正常；若已开放仍为空，可能是接口被「加密串」拦截，建议调用 get_xk_status 检查。"
            : courses.length > 30
              ? `仅显示前 30 条（共 ${courses.length} 条）`
              : undefined,
      };
    },
  }),

  /** 3. 盯课监控（有限时长，不提交选课） */
  watch_courses: tool({
    description:
      "在指定时长内轮询监控目标课程的余量变化（默认 60 秒，每轮间隔约 3 秒含随机抖动）。只观察不提交选课。返回期间的全部事件（何时出现余量）与结束时的余量快照。",
    inputSchema: z.object({
      targets: z
        .array(
          z.object({
            courseName: z.string().describe("课程名关键词（包含即命中）"),
            teacher: z.string().optional().describe("教师名（可选，模糊匹配）"),
          })
        )
        .min(1)
        .describe("要监控的目标课程列表"),
      durationSec: z
        .number()
        .int()
        .min(10)
        .max(300)
        .default(60)
        .describe("监控时长（秒）"),
    }),
    execute: async ({ targets, durationSec }) => {
      const result = await watchLoop(targets, durationSec, false);
      return {
        ...result,
        summary: result.events.length
          ? `监控 ${durationSec} 秒（${result.rounds} 轮），共发现 ${result.events.length} 次余量事件`
          : `监控 ${durationSec} 秒（${result.rounds} 轮），目标课程始终无余量`,
      };
    },
  }),

  /** 4. 自动抢课（真实提交选课操作！） */
  grab_course: tool({
    description:
      "抢课模式：轮询监控目标课程，一出现余量立即自动提交选课请求，成功后停止。注意：此工具会真实提交选课操作，调用前务必先与用户确认目标课程。默认跑 120 秒。",
    inputSchema: z.object({
      courseName: z.string().describe("要抢的课程名关键词"),
      teacher: z.string().optional().describe("教师名（可选，用于精确匹配教学班）"),
      durationSec: z
        .number()
        .int()
        .min(10)
        .max(600)
        .default(120)
        .describe("抢课时长上限（秒），到时未抢到则返回过程记录"),
    }),
    execute: async ({ courseName, teacher, durationSec }) => {
      const targets: XkTarget[] = [{ courseName, teacher }];
      const result = await watchLoop(targets, durationSec, true);
      return {
        ...result,
        success: result.grabbed !== null,
        summary: result.grabbed
          ? `🎉 抢课成功：${result.grabbed.courseName}（${result.grabbed.teacher}）-${result.grabbed.message}`
          : `⏱ ${durationSec} 秒内未抢到（${result.rounds} 轮监控，${result.submitAttempts} 次提交）。结束时的余量快照见 lastSnapshot。`,
      };
    },
  }),

  /** 5. 课表查询 */
  get_schedule: tool({
    description: "查询本学期课表（自动推断当前学年学期），返回每门课的上课时间、地点、教师、周次。",
    inputSchema: z.object({}),
    execute: async () => {
      const cookie = await getCookie();
      const courses = await fetchSchedule(cookie);
      return {
        total: courses.length,
        courses: courses.map((c) => ({
          title: c.title,
          weekday: WEEKDAY_NAMES[c.weekday] ?? `周${c.weekday}`,
          periods: c.periods.join(","),
          weeks: c.weeks,
          location: c.location,
          teacher: c.teacher,
        })),
        note: courses.length === 0 ? "课表为空（假期或学期末属正常）" : undefined,
      };
    },
  }),

  /** 6. 成绩查询 */
  get_grades: tool({
    description: "查询全部学期的成绩与 GPA（按 NJTECH 绩点规则计算，重复课程取最高分）。",
    inputSchema: z.object({}),
    execute: async () => {
      const cookie = await getCookie();
      const result = await fetchAllGrades(cookie, config.jwglUsername);
      return {
        gpa: result.gpa,
        totalCredits: result.totalCredits,
        requiredCourses: result.requiredCourses,
        courseCount: result.allCourses.length,
        courses: result.allCourses.map((g) => ({
          course: g.course,
          score: g.score,
          credit: g.credit,
          type: g.type,
          semester: g.semester,
        })),
      };
    },
  }),

  /** 7. 考试安排 */
  get_exams: tool({
    description: "查询本学期考试安排：科目、日期、时间、考场、座位号。",
    inputSchema: z.object({}),
    execute: async () => {
      const cookie = await getCookie();
      const exams = await fetchExams(cookie);
      return {
        total: exams.length,
        exams: exams.map((e) => ({
          subject: e.subject,
          date: e.date,
          time: e.time,
          location: e.location,
          seatNumber: e.seatNumber || undefined,
        })),
        note: exams.length === 0 ? "暂无考试安排" : undefined,
      };
    },
  }),
};
