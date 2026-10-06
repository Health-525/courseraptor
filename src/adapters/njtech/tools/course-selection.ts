/**
 * 选课查询工具：check_selection_status / search_courses / search_classes
 *               list_choosed_courses / drop_course
 * 包含退课目标定位与课程摘要辅助。
 */

import { tool } from "ai";
import { z } from "zod";

import { config } from "../../../core/config";
import { isSessionExpiredError, SESSION_EXPIRED_MESSAGE } from "../../../core/errors";
import { getXkSession, invalidateXkSession } from "../session";
import {
  type ChoosedCourse,
  fetchChoosedList,
  fetchJxbList,
  inspectXk,
  quitCourse,
  roundRefOf,
  searchCourses,
  type XkCourse,
  type XkSession,
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

// ── 退课辅助 ─────────────────────────────────────────────────

/** 名称双向包含匹配：候选列表项名包含关键词，或关键词包含候选名 */
function matchByName(name: string, c: { courseName: string }): boolean {
  return c.courseName.includes(name) || name.includes(c.courseName);
}

/**
 * 退课目标定位：已选行自带教学班 ID 直接用；缺失时按轮次扫教学班列表补齐。
 * 多个教学班无法唯一确定时返回 error——宁可让用户再指认一次，不能退错班。
 */
async function resolveQuitJxbId(
  session: XkSession,
  target: ChoosedCourse,
  teacher?: string,
): Promise<{ jxbId: string; classBrief?: string } | { error: string; classes?: unknown[] }> {
  if (target.jxbId) return { jxbId: target.jxbId };

  if (!target.courseCode) {
    return { error: `已选行缺少课程号与教学班 ID，无法定位退课目标：${target.courseName}` };
  }

  // 已选课程所在轮次未知，逐轮次查询教学班列表（每轮凭证独立）
  const byId = new Map<string, XkCourse>();
  for (const r of session.rounds) {
    try {
      const list = await fetchJxbList(session, {
        kklxdm: r.kklxdm,
        xkkzId: r.xkkzId,
        xkkzXh: r.xh,
        courseCode: target.courseCode,
      });
      for (const c of list) if (c.jxbId) byId.set(c.jxbId, c);
    } catch {
      // 单轮次查询失败跳过，其他轮次仍可能命中
    }
  }

  let picked = [...byId.values()];
  if (teacher) {
    const filtered = picked.filter((c) => c.teacher.includes(teacher));
    // 教师过滤有命中才收窄；全军覆没则保留全量，走下面的多班报错路径让用户看清
    if (filtered.length > 0) picked = filtered;
  }

  if (picked.length === 1) {
    const c = picked[0];
    return {
      jxbId: c.jxbId,
      classBrief: [c.teacher || "教师未知", String(c.raw?.sksj ?? "")].filter(Boolean).join(" "),
    };
  }
  if (picked.length === 0) {
    return { error: `未查到「${target.courseName}」的教学班明细，未提交退课` };
  }
  return {
    error: `「${target.courseName}」有 ${picked.length} 个教学班，无法确定用户选的是哪个，未提交退课`,
    classes: picked.map((c) => ({ teacher: c.teacher, schedule: String(c.raw?.sksj ?? "") })),
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
      "查询本轮选课已选中的课程列表（选课模块维度，含课程号）。刚在教务系统选完课想核对是否选上、退课前看现状时用。与 get_enrolled_courses（选课名单维度，含时间地点学分）互补；本工具只在选课轮次内有数据。",
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

  /** 退课（真实提交退课操作！） */
  drop_course: tool({
    description:
      "退课（真实提交退课操作！）：从本轮已选课程中退掉一门。必须由用户明确点名要退的课程后才可调用，绝不批量退课。课程名匹配到多门、或教学班无法唯一定位时不会提交，会返回明细让用户指认。",
    inputSchema: z.object({
      courseName: z.string().describe("要退的课程名关键词（与用户点名的课程一致）"),
      teacher: z.string().optional().describe("教师名（可选，同门课多个教学班时用于定位）"),
    }),
    execute: async ({ courseName, teacher }) => {
      let session = await getXkSession();

      const choosedOnce = async (): Promise<ChoosedCourse[]> => {
        try {
          return await fetchChoosedList(session);
        } catch (e) {
          if (!isSessionExpiredError(e)) throw e;
          invalidateXkSession();
          session = await getXkSession(true);
          return await fetchChoosedList(session);
        }
      };

      const choosed = await choosedOnce();
      if (choosed.length === 0) {
        return {
          dropped: false,
          error: "本轮已选课程为空，无可退课程（非选课阶段该接口无数据属正常）",
        };
      }

      const matches = choosed.filter((c) => matchByName(courseName, c));
      if (matches.length === 0) {
        return {
          dropped: false,
          error: `已选课程中没有匹配「${courseName}」的，未提交退课。当前已选：`,
          choosed: choosed.map((c) => c.courseName || c.courseCode),
        };
      }
      // 多门命中绝不猜——退错课的代价是用户想要的课没了，让用户指名
      if (matches.length > 1) {
        return {
          dropped: false,
          error: `「${courseName}」匹配到 ${matches.length} 门已选课程，未提交退课。请让用户指明其中一门：`,
          matches: matches.map((c) => c.courseName || c.courseCode),
        };
      }
      const target = matches[0];

      const resolved = await resolveQuitJxbId(session, target, teacher);
      if ("error" in resolved) {
        return { dropped: false, ...resolved };
      }

      let result = await quitCourse(session, resolved.jxbId);
      if (result.message === SESSION_EXPIRED_MESSAGE) {
        invalidateXkSession();
        session = await getXkSession(true);
        result = await quitCourse(session, resolved.jxbId);
      }

      // 成功后复查已选列表确认真退掉了（best-effort，失败不影响结论）
      let remaining: string[] | undefined;
      if (result.ok) {
        try {
          remaining = (await fetchChoosedList(session)).map((c) => c.courseName || c.courseCode);
        } catch {
          remaining = undefined;
        }
      }

      return {
        dropped: result.ok,
        courseName: target.courseName || target.courseCode,
        ...(resolved.classBrief ? { classBrief: resolved.classBrief } : {}),
        message: result.message,
        ...(remaining !== undefined ? { remainingChoosed: remaining } : {}),
        summary: result.ok
          ? `✅ 已退掉「${target.courseName}」${resolved.classBrief ? `（${resolved.classBrief}）` : ""}：${result.message}`
          : `❌ 退课未成功：${result.message}`,
      };
    },
  }),
};
