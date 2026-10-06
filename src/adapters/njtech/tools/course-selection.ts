/**
 * 选课查询工具：check_selection_status / search_courses / search_classes
 *               list_choosed_courses
 * 含课程摘要辅助。
 */

import { tool } from "ai";
import { z } from "zod";

import { config } from "../../../core/config";
import { isSessionExpiredError } from "../../../core/errors";
import { getXkSession, invalidateXkSession } from "../session";
import {
  type ChoosedCourse,
  fetchChoosedList,
  fetchJxbList,
  inspectXk,
  roundRefOf,
  searchCourses,
  type XkCourse,
} from "../xk";

function courseBrief(c: XkCourse) {
  const raw = (c.raw ?? {}) as Record<string, unknown>;
  return {
    courseName: c.courseName,
    courseCode: c.courseCode,
    teacher: c.teacher,
    credit: c.credit,
    capacity: c.capacity,
    selected: c.selected,
    remain: c.remain,
    jxbId: c.jxbId,
    ...(raw.sksj ? { schedule: String(raw.sksj) } : {}),
    ...(raw.jxdd ? { venue: String(raw.jxdd) } : {}),
  };
}

// ── 工具定义 ─────────────────────────────────────────────────

export const courseSelectionTools = {
  /** 查询选课模块状态 */
  check_selection_status: tool({
    description:
      "查询南京工业大学教务系统「自主选课」模块的当前状态：选课是否开放（iskxk）、选课控制 ID（xkkzId）、以及课程查询接口是否仍返回「加密串错误」（防爬拦截）。回答任何选课相关问题前建议先调用此工具确认状态。",
    inputSchema: z.object({}),
    execute: async () => {
      const result = await inspectXk(config.jwglUsername, config.jwglPassword);
      const okRounds = result.rounds.filter((r) => r.status === "ok");
      return {
        isXkOpen: result.isXkOpen,
        isXkOpenLabel: result.isXkOpen ? "选课开放中" : "当前不属于选课阶段",
        xkkzId: result.xkkzId ?? "未下发（选课未开放时不发放）",
        hasXkkzXh: result.hasXkkzXh,
        courseQueryBlocked: result.courseQueryBlocked,
        /** 自检结论必须可直接引用：blocked 才说被拦截，empty 要说清楚是没数据 */
        courseQueryNote: result.courseQueryBlocked
          ? "课程查询接口被加密串拦截，需复测"
          : result.isXkOpen
            ? `课程查询接口正常（${okRounds.length}/${result.rounds.length} 个轮次返回数据）`
            : "课程查询接口无加密串错误；当前非选课阶段，返回空属正常",
        rounds: result.rounds.map((r) => ({
          tab: r.tabName,
          status: r.status,
          sentXkkzXh: r.sentXkkzXh,
          parsedVia: r.parsedVia,
          courseCount: r.courseCount,
          message: r.message,
        })),
      };
    },
  }),

  /** 搜课程查余量 */
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
            ? "未查询到课程。若选课未开放（isXkOpen=false）属正常；若已开放仍为空，可能是接口被「加密串」拦截，建议调用 check_selection_status 检查。"
            : courses.length > 30
              ? `仅显示前 30 条（共 ${courses.length} 条）`
              : undefined,
      };
    },
  }),

  /** 查教学班列表（同门课各班对比） */
  search_classes: tool({
    description:
      "查某门课程下所有教学班的明细：每个班的教师、上课时间、地点、容量、已选人数、剩余名额。适合「这门课哪个老师还有名额」「周几的班还开着」这类对比问题。输入课程名关键词，自动匹配课程号后展开教学班。",
    inputSchema: z.object({
      courseName: z.string().describe("课程名关键词（模糊匹配），如「操作系统原理」"),
    }),
    execute: async ({ courseName }) => {
      let session = await getXkSession();

      const searchOnce = async () => {
        try {
          return await searchCourses(session, courseName);
        } catch (e) {
          if (isSessionExpiredError(e)) {
            invalidateXkSession();
            session = await getXkSession(true);
            return await searchCourses(session, courseName);
          }
          throw e;
        }
      };
      const courses = await searchOnce();

      // 按课程号去重，但必须留住课程对象本身——它带着所在轮次的凭证。
      // 只取 courseCode 会丢掉 kklxdm/xkkzId/xkkzXh，于是通识选修轮的课
      // 会拿主修轮的凭证去问教学班明细，查不到或查错。
      const byCode = new Map<string, XkCourse>();
      for (const c of courses) {
        if (c.courseCode && !byCode.has(c.courseCode)) byCode.set(c.courseCode, c);
      }
      const picked = [...byCode.values()].slice(0, 3);
      if (picked.length === 0) {
        return {
          error:
            "未查到该课程。选课未开放（isXkOpen=false）时课程/教学班接口均不可查，可先调 check_selection_status 确认。",
        };
      }

      const result = [];
      for (const course of picked) {
        // 轮次凭证必填：跨轮次查询会失败，类型层面已强制
        const ref = roundRefOf(course, session);
        let list: XkCourse[];
        try {
          list = await fetchJxbList(session, { ...ref, courseCode: course.courseCode });
        } catch (e) {
          if (isSessionExpiredError(e)) {
            invalidateXkSession();
            session = await getXkSession(true);
            list = await fetchJxbList(session, { ...ref, courseCode: course.courseCode });
          } else throw e;
        }
        result.push({
          courseCode: course.courseCode,
          courseName: course.courseName || course.courseCode,
          roundTab: String(course.raw?._roundTab ?? "") || undefined,
          jxbCount: list.length,
          classes: list.map(courseBrief),
        });
      }
      return {
        isXkOpen: session.isXkOpen,
        matchedCourses: picked.length,
        courses: result,
        note:
          session.isXkOpen === false ? "当前选课未开放，接口可能被拦截，数据为空属正常" : undefined,
      };
    },
  }),

  /** 本轮已选课程查询 */
  list_choosed_courses: tool({
    description:
      "查询本轮选课已选中的课程列表（选课模块维度，含课程号）。刚在教务系统选完课想核对是否选上时用。本工具只在选课轮次内有数据。",
    inputSchema: z.object({}),
    execute: async () => {
      let session = await getXkSession();
      let list: ChoosedCourse[];
      try {
        list = await fetchChoosedList(session);
      } catch (e) {
        if (!isSessionExpiredError(e)) throw e;
        invalidateXkSession();
        session = await getXkSession(true);
        list = await fetchChoosedList(session);
      }
      return {
        isXkOpen: session.isXkOpen,
        total: list.length,
        courses: list.map((c) => ({
          courseName: c.courseName || c.courseCode,
          courseCode: c.courseCode,
          ...(c.teacher ? { teacher: c.teacher } : {}),
        })),
        note:
          list.length === 0
            ? "本轮已选为空。非选课阶段该接口无数据属正常；若刚在教务系统选完仍为空，可能是轮次未同步，稍后再查。"
            : undefined,
      };
    },
  }),
};
