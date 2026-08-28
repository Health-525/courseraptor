/**
 * CourseRaptor agent 工具集
 * 17 个工具：选课 6 + 查询 7 + 通知 3 + 记忆 1
 */

import { tool } from "ai";
import { z } from "zod";

import { config } from "../config";
import { fetchAttachment } from "../attachments";
import {
  fetchProfile,
  fetchRetakeCourses,
  fetchEnrolledClasses,
  fetchLabGradesSmart,
} from "../jwgl/portal";
import {
  addMemory,
  updateMemory,
  deleteMemory,
  loadMemory,
} from "../memory/longterm";
import {
  fetchScheduleSmart,
  fetchExamsSmart,
  parseSemesterString,
  currentWeekOf,
  buildWeekIndex,
  periodTimeRange,
  WEEKDAY_NAMES,
} from "../jwgl/academics";
import { fetchAllGrades } from "../jwgl/grades";
import { fetchJwcNews, fetchJwcArticle } from "../jwgl/news";
import {
  inspectXk,
  searchCourses,
  fetchJxbList,
  submitCourse,
  matchTargets,
  roundRefOf,
  type XkCourse,
  type XkTarget,
} from "../jwgl/xk";
import {
  getCookie,
  getXkSession,
  invalidateXkSession,
  pollDelay,
} from "./session";

function now(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

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
  let consecutiveErrors = 0;
  let lastSessionRefresh = 0;

  // 单目标时按关键词缩小服务端查询范围：课程列表分页只拉第一页（100 条），
  // 通识选修课程数百门，不带关键词目标可能不在第一页
  const keyword = targets.length === 1 ? targets[0].courseName : undefined;

  while (Date.now() < deadline) {
    rounds++;
    let courses: XkCourse[] = [];
    try {
      courses = await searchCourses(session, keyword);
      consecutiveErrors = 0;
    } catch (e) {
      if ((e as Error).message === "SESSION_EXPIRED") {
        invalidateXkSession();
        session = await getXkSession(true);
        continue;
      }
      // 教务线路抖动容错：连续 5 次异常才放弃，单次异常记录后继续
      consecutiveErrors++;
      if (consecutiveErrors >= 5) throw e;
      events.push({
        time: now(),
        message: `查询异常（连续 ${consecutiveErrors}/5）：${(e as Error).message.slice(0, 60)}`,
      });
      await pollDelay(2000);
      continue;
    }

    // 抢课模式：①会话建于开放前（xkkzId 空）或 ②全部轮次查询为空
    // （新一轮次可能在监控期间才出现，如 12:00 通识选修轮上线新 tab）
    // -> 限频刷新会话，重新解析轮次列表
    if (
      grab &&
      Date.now() - lastSessionRefresh > 45000 &&
      (courses.length === 0 || !session.xkkzId)
    ) {
      lastSessionRefresh = Date.now();
      invalidateXkSession();
      session = await getXkSession(true);
      events.push({
        time: now(),
        message: `刷新选课会话：轮次=[${session.rounds.map((r) => r.tabName || r.kklxdm).join("、")}]`,
      });
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

// ── 分类抢课计划循环（每类抢到一门即停，类间互不影响）─────────

interface PlanGroup {
  category: string;
  courseNames: string[];
}

async function grabPlanLoop(
  groups: PlanGroup[],
  durationSec: number
): Promise<{
  durationSec: number;
  rounds: number;
  results: Array<{
    category: string;
    grabbed: string | null;
    tried: string[];
    note?: string;
  }>;
  events: Array<{ time: string; message: string }>;
  submitAttempts: number;
}> {
  const deadline = Date.now() + durationSec * 1000;
  let session = await getXkSession();
  let rounds = 0;
  let submitAttempts = 0;
  const events: Array<{ time: string; message: string }> = [];
  const state = groups.map((g) => ({
    category: g.category,
    courseNames: g.courseNames,
    idx: 0,
    grabbed: "",
    tried: [] as string[],
    fullRounds: 0,
    missRounds: 0,
    done: false,
  }));
  let consecutiveErrors = 0;
  let lastSessionRefresh = 0;

  while (Date.now() < deadline) {
    if (state.every((s) => s.done)) break;
    rounds++;

    for (const s of state) {
      if (s.done || s.idx >= s.courseNames.length) continue;
      const name = s.courseNames[s.idx];

      let courses: XkCourse[] = [];
      try {
        // 按候选课程名做服务端过滤（课程列表分页只拉第一页）
        courses = await searchCourses(session, name);
        consecutiveErrors = 0;
      } catch (e) {
        if ((e as Error).message === "SESSION_EXPIRED") {
          invalidateXkSession();
          session = await getXkSession(true);
          continue;
        }
        consecutiveErrors++;
        if (consecutiveErrors >= 5) throw e;
        events.push({
          time: now(),
          message: `[${s.category}] 查询异常（${consecutiveErrors}/5）：${(e as Error).message.slice(0, 50)}`,
        });
        continue;
      }

      // 抢课期间刷新会话（限频 45s）：①建于开放前（xkkzId 空）或
      // ②当前候选查无结果（新一轮次可能在监控期间才出现，如 12:00
      // 通识选修轮上线新 tab），刷新后重新解析轮次列表
      if (
        Date.now() - lastSessionRefresh > 45000 &&
        (courses.length === 0 || !session.xkkzId)
      ) {
        lastSessionRefresh = Date.now();
        invalidateXkSession();
        session = await getXkSession(true);
        events.push({
          time: now(),
          message: `刷新选课会话：轮次=[${session.rounds.map((r) => r.tabName || r.kklxdm).join("、")}]`,
        });
      }

      const matched = courses.filter(
        (c) => c.courseName.includes(name) || name.includes(c.courseName)
      );
      const available = matched.filter((c) => c.remain > 0);

      if (available.length > 0) {
        submitAttempts++;
        const course = available[0];
        if (!s.tried.includes(course.courseName)) s.tried.push(course.courseName);
        const result = await submitCourse(session, course);
        if (result.ok) {
          s.grabbed = course.courseName;
          s.done = true; // 该类抢到一门即停，绝不重复抢同类学分
          events.push({
            time: now(),
            message: `🎉 [${s.category}] 抢到：${course.courseName}（${course.teacher || "网课"}）-${result.message}，该类收手`,
          });
        } else if (result.message === "SESSION_EXPIRED") {
          invalidateXkSession();
          session = await getXkSession(true);
        } else {
          events.push({
            time: now(),
            message: `[${s.category}] 提交失败：${result.message}`,
          });
        }
      } else if (matched.length > 0) {
        // 候选存在但满员：连续 3 轮满员换下一个备选
        s.fullRounds++;
        if (s.fullRounds >= 3) {
          events.push({
            time: now(),
            message: `[${s.category}] ${name} 持续满员，切换备选：${s.courseNames[s.idx + 1] ?? "（无更多备选）"}`,
          });
          s.idx++;
          s.fullRounds = 0;
        }
      } else {
        // 候选未出现在可选列表：连续 5 轮未出现换下一个
        s.missRounds++;
        if (s.missRounds >= 5) {
          events.push({
            time: now(),
            message: `[${s.category}] ${name} 未出现在列表，切换备选：${s.courseNames[s.idx + 1] ?? "（无更多备选）"}`,
          });
          s.idx++;
          s.missRounds = 0;
        }
      }
    }
    await pollDelay(2500);
  }

  return {
    durationSec,
    rounds,
    results: state.map((s) => ({
      category: s.category,
      grabbed: s.grabbed || null,
      tried: s.tried,
      note: s.idx >= s.courseNames.length && !s.done ? "备选已用尽" : undefined,
    })),
    events,
    submitAttempts,
  };
}

// ── 工具定义 ─────────────────────────────────────────────────

const raptorToolsAll = {
  /** 1. 查询选课模块状态 */
  check_selection_status: tool({
    description:
      "查询南京工业大学教务系统「自主选课」模块的当前状态：选课是否开放（iskxk）、选课控制 ID（xkkzId）、以及课程查询接口是否仍返回「加密串错误」（防爬拦截）。回答任何选课相关问题前建议先调用此工具确认状态。",
    inputSchema: z.object({}),
    execute: async () => {
      const result = await inspectXk(
        config.jwglUsername,
        config.jwglPassword
      );
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
            ? "未查询到课程。若选课未开放（isXkOpen=false）属正常；若已开放仍为空，可能是接口被「加密串」拦截，建议调用 check_selection_status 检查。"
            : courses.length > 30
              ? `仅显示前 30 条（共 ${courses.length} 条）`
              : undefined,
      };
    },
  }),

  /** 3. 查教学班列表（同门课各班对比） */
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
          if ((e as Error).message === "SESSION_EXPIRED") {
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
          if ((e as Error).message === "SESSION_EXPIRED") {
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
          session.isXkOpen === false
            ? "当前选课未开放，接口可能被拦截，数据为空属正常"
            : undefined,
      };
    },
  }),

  /** 4. 盯课监控（有限时长，不提交选课） */
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

  /** 5. 自动抢课（真实提交选课操作！） */
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

  /** 6. 分类抢课计划（每类一门即停） */
  grab_plan: tool({
    description:
      "分类抢课计划（真实提交选课！）：按类别分组抢课，每个类别抢到一门立即停止该类、绝不重复抢同类学分，类别之间互不影响。组内候选按优先级排列，当前候选满员（连续 3 轮）或未出现（连续 5 轮）自动切换下一个备选。适合通识选修按类补学分（如创新创业类和人文类各抢一门网课）。调用前与用户确认分组计划。",
    inputSchema: z.object({
      groups: z
        .array(
          z.object({
            category: z.string().describe("类别名，如「创新创业类」「人文类」"),
            courseNames: z
              .array(z.string())
              .min(1)
              .describe("该类候选课程名（按优先级排序，第一个为主目标）"),
          })
        )
        .min(1)
        .describe("分类抢课计划（每类抢到一门即停）"),
      durationSec: z
        .number()
        .int()
        .min(10)
        .max(600)
        .default(600)
        .describe("总时长上限（秒），默认 600"),
    }),
    execute: async ({ groups, durationSec }) => {
      const result = await grabPlanLoop(groups, durationSec);
      const okCount = result.results.filter((r) => r.grabbed).length;
      return {
        ...result,
        successCount: okCount,
        summary:
          `抢到 ${okCount}/${groups.length} 类：` +
          result.results.map((r) => `${r.category}=${r.grabbed ?? "未抢到"}`).join("；"),
      };
    },
  }),

  /** 7. 课表查询 */
  get_schedule: tool({
    description:
      "查询课表，返回每门课的上课时间、地点、教师、周次。默认自动探测最新有课表的学期（学期交界期也不会查错）；也可指定学期，如「2026-2027-1」。返回的 byWeek 是按周预分组好的索引（week -> 该周的课，已格式化可直接引用）：用户问「第一周的课」「第 5 周有什么」「这周哪几天有课」时，直接查 byWeek 对应 week 即可，不要自己解析 courses[].weeks 里的周次表达式。byWeek 里没有的周次即该周无课。",
    inputSchema: z.object({
      semester: z
        .string()
        .optional()
        .describe('指定学期，格式如「2026-2027-1」或「2025-2026-2」；不填则自动探测最新学期'),
    }),
    execute: async ({ semester }) => {
      const parsed = semester ? parseSemesterString(semester) : null;
      if (semester && !parsed) {
        return { error: `学期格式无法解析：「${semester}」，应为「2026-2027-1」这类格式` };
      }
      const cookie = await getCookie();
      const r = await fetchScheduleSmart(cookie, parsed?.year, parsed?.semester);
      // 拿不到 ≠ 没有：断网/会话失效必须如实说，不能让用户以为这学期没课
      if (!r.ok) {
        return {
          error: `课表查询失败：${r.error}。这与「课表为空」不是一回事，请检查网络或稍后重试。`,
        };
      }
      const term = r.data;
      const week = currentWeekOf(term.year, term.semester);
      return {
        term: term.label,
        currentWeek: week ? `第 ${week.week} 周` : "未开学或不在教学周内",
        week1Monday: week?.week1Monday,
        /** recorded=通知实测 / known=人工校准 / estimated=按月份估算 */
        weekSource: week?.source,
        weekNote: !week
          ? undefined
          : week.source === "estimated"
            ? `⚠️ 开学日期是估算值（${week.evidence ?? "未见校历原文"}），把报到注册通知链接发我可校准`
            : week.evidence,
        total: term.courses.length,
        courses: term.courses.map((c) => ({
          title: c.title,
          weekday: WEEKDAY_NAMES[c.weekday] ?? `周${c.weekday}`,
          periods: c.periods.join(","),
          time: periodTimeRange(c.periods),
          weeks: c.weeks,
          location: c.location,
          teacher: c.teacher,
        })),
        /**
         * 按周预分组索引：week -> 该周要上的课（已格式化，可直接引用）。
         * 用户问「第一周的课」「第 5 周有什么」时直接查表，不要再自己解析
         * weeks 字段里的 "2-6,8-12" 这类表达式——那部分已由工具层算好。
         * 只含有课的周；缺失的周次即该周无课。
         */
        byWeek: buildWeekIndex(term.courses),
        note:
          term.courses.length === 0
            ? "课表已查通但无排课（假期或学期未排课属正常）"
            : undefined,
      };
    },
  }),

  /** 8. 成绩查询 */
  get_grades: tool({
    description: "查询全部学期的成绩与 GPA（按 NJTECH 绩点规则计算，重复课程取最高分）。",
    inputSchema: z.object({}),
    execute: async () => {
      const cookie = await getCookie();
      const result = await fetchAllGrades(cookie, config.jwglUsername);

      // 通识选修六类统计（选修性质 + 通识教育课，成绩接口自带课程归属 kcgsmc）
      const geByCat = new Map<string, { credits: number; courses: string[] }>();
      for (const g of result.allCourses) {
        if (g.type !== "选修" || !g.courseClass?.includes("通识") || !g.category) continue;
        const e = geByCat.get(g.category) ?? { credits: 0, courses: [] };
        e.credits += parseFloat(g.credit) || 0;
        e.courses.push(`${g.course}(${g.credit}分)`);
        geByCat.set(g.category, e);
      }
      const GE_REQUIRED = ["创新创业类", "公共艺术类", "人文类", "社会类", "自然类", "AI前沿技术类"];
      const covered = (c: string) =>
        [...geByCat.keys()].some((k) => k === c || k.includes(c) || c.includes(k));
      const generalElectives = {
        byCategory: [...geByCat.entries()].map(([category, e]) => ({
          category,
          credits: e.credits,
          courses: e.courses,
        })),
        missingCategories: GE_REQUIRED.filter((c) => !covered(c)),
        note: "六类要求：创新创业/公共艺术(美育)/人文/社会/自然/AI前沿；「大学英语拓展课程」是否计入人文以培养方案为准",
      };

      return {
        gpa: result.gpa,
        gpaBasis: result.gpaBasis,
        // 语义：这是计入 GPA 的必修课学分和，不是总修学分。转述时别说成「总学分」。
        requiredCredits: result.requiredCredits,
        passFailCredits: result.passFailCredits || 0,
        requiredCourses: result.requiredCourses,
        courseCount: result.allCourses.length,
        failedTerms: result.failedTerms?.length ? result.failedTerms : undefined,
        generalElectives,
        courses: result.allCourses.map((g) => ({
          course: g.course,
          courseCode: g.courseCode || undefined,
          score: g.score,
          credit: g.credit,
          type: g.type,
          semester: g.semester,
        })),
      };
    },
  }),

  /** 9. 考试安排 */
  get_exams: tool({
    description:
      "查询考试安排：科目、日期、时间、考场、座位号。默认自动探测最新学期（也可指定，如「2026-2027-1」）。",
    inputSchema: z.object({
      semester: z
        .string()
        .optional()
        .describe('指定学期，格式如「2026-2027-1」；不填则自动探测最新学期'),
    }),
    execute: async ({ semester }) => {
      const parsed = semester ? parseSemesterString(semester) : null;
      if (semester && !parsed) {
        return { error: `学期格式无法解析：「${semester}」，应为「2026-2027-1」这类格式` };
      }
      const cookie = await getCookie();
      const r = await fetchExamsSmart(cookie, parsed?.year, parsed?.semester);
      if (!r.ok) {
        return { error: `考试查询失败：${r.error}（不是「暂无考试」，是没查到）` };
      }
      const { label, exams } = r.data;
      return {
        term: label,
        total: exams.length,
        exams: exams.map((e) => ({
          subject: e.subject,
          date: e.date,
          time: e.time,
          location: e.location,
          seatNumber: e.seatNumber || undefined,
        })),
        note: exams.length === 0 ? "该学期暂无考试安排" : undefined,
      };
    },
  }),

  /** 10. 学籍个人信息 */
  get_student_info: tool({
    description:
      "查询学籍个人信息：姓名、学号、性别、学院、专业、班级、年级、学制、入学/毕业日期等（从教务系统个人信息页解析）。需要确认用户身份信息、或查询班级/专业信息时调用。",
    inputSchema: z.object({}),
    execute: async () => {
      const cookie = await getCookie();
      const profile = await fetchProfile(cookie);
      // 敏感字段打码（只留前4后4），避免完整证件/卡号进入模型上下文
      const SENSITIVE = /证件号码|银行卡|考生号/;
      const masked: Record<string, string> = {};
      let maskedCount = 0;
      for (const [k, v] of Object.entries(profile)) {
        if (SENSITIVE.test(k) && v.length > 8) {
          masked[k] = `${v.slice(0, 4)}****${v.slice(-4)}`;
          maskedCount++;
        } else {
          masked[k] = v;
        }
      }
      const keys = Object.keys(masked);
      return {
        total: keys.length,
        info: masked,
        maskedNote: maskedCount > 0 ? `${maskedCount} 个敏感字段已打码` : undefined,
        note: keys.length === 0 ? "个人信息页解析失败（页面结构可能变化）" : undefined,
      };
    },
  }),

  /** 11. 已选课程教学班 */
  get_enrolled_courses: tool({
    description:
      "查询本学期已选的课程教学班列表：课程名、教学班、教师、上课时间、地点、学分、课程性质（必修/选修）。注意：与课表（get_schedule）互补，这里按教学班维度、含选课属性。",
    inputSchema: z.object({}),
    execute: async () => {
      const cookie = await getCookie();
      const classes = await fetchEnrolledClasses(cookie);
      return {
        total: classes.length,
        courses: classes,
        note: classes.length === 0 ? "暂无已选课程（学期初未选课属正常）" : undefined,
      };
    },
  }),

  /** 12. 可重修课程 */
  get_retake_courses: tool({
    description:
      "查询可重修的课程列表（历年开课记录，含课程号/开课学院/学分）。用户问「××能不能重修」「重修有哪些课」或计划重修时调用；可用 keyword 过滤课程名。",
    inputSchema: z.object({
      keyword: z.string().optional().describe("课程名关键词过滤（可选）"),
    }),
    execute: async ({ keyword }) => {
      const cookie = await getCookie();
      const all = await fetchRetakeCourses(cookie);
      const filtered = keyword
        ? all.filter((c) => c.courseName.includes(keyword))
        : all;
      return {
        total: filtered.length,
        totalAll: all.length,
        courses: filtered.slice(0, 40).map((c) => ({
          ...c,
          semester: c.semester || undefined,
        })),
        note:
          filtered.length > 40
            ? `仅显示前 40 条（共 ${filtered.length} 条，可加 keyword 过滤）`
            : undefined,
      };
    },
  }),

  /** 13. 实验成绩 */
  get_lab_grades: tool({
    description:
      "查询实验课程成绩（按学期，默认自动探测最新学期，也可指定如「2026-2027-1」）。没有实验课的学期返回空属正常。",
    inputSchema: z.object({
      semester: z
        .string()
        .optional()
        .describe('指定学期，格式如「2026-2027-1」；不填则自动探测最新学期'),
    }),
    execute: async ({ semester }) => {
      const parsed = semester ? parseSemesterString(semester) : null;
      if (semester && !parsed) {
        return { error: `学期格式无法解析：「${semester}」，应为「2026-2027-1」这类格式` };
      }
      const cookie = await getCookie();
      const { label, items } = await fetchLabGradesSmart(
        cookie,
        parsed?.year,
        parsed?.semester
      );
      return {
        term: label,
        total: items.length,
        items: items.slice(0, 30),
        note: items.length === 0 ? "该学期暂无实验成绩（无实验课属正常）" : undefined,
      };
    },
  }),

  /** 14. 教务处官网通知 */
  get_news: tool({
    description:
      "抓取南京工业大学教务处官网（jwc.njtech.edu.cn）的最新通知，涵盖三个板块：公告通知（含选课/考试/学籍等重要安排）、教学动态、考试排课。公开页面无需登录。用户问「最近有什么教务通知」「选课什么时候开始」「有没有关于××的通知」时调用。",
    inputSchema: z.object({
      category: z
        .enum(["公告通知", "教学动态", "考试排课"])
        .optional()
        .describe("只看某个板块（可选，默认全部）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(10)
        .describe("返回条数（默认 10）"),
    }),
    execute: async ({ category, limit }) => {
      const items = await fetchJwcNews([], 30);
      const filtered = category
        ? items.filter((i) => i.category === category)
        : items;
      return {
        total: filtered.length,
        items: filtered.slice(0, limit).map((i) => ({
          title: i.title,
          date: i.date,
          category: i.category,
          url: i.url,
        })),
        note:
          filtered.length === 0
            ? "未抓到通知（官网结构可能变化或网络异常）"
            : undefined,
      };
    },
  }),

  /** 15. 通知正文阅读 */
  read_notice: tool({
    description:
      "读取学校官网任意文章页面的正文全文（webplus CMS 结构解析）。两种用法：① 读 get_news 列表里的通知（用 items[].url）；② 直接读用户贴出来的链接（如 https://jwc.njtech.edu.cn/info/1158/6876.htm，用户发来 jwc/学校官网链接时就用本工具读）。返回标题、正文全文与附件下载链接。",
    inputSchema: z.object({
      url: z
        .string()
        .describe("文章页 URL（jwc.njtech.edu.cn 或其他 njtech.edu.cn 子域）"),
    }),
    execute: async ({ url }) => {
      if (!/^https?:\/\/[a-z0-9.-]*\.njtech\.edu\.cn\//.test(url)) {
        return { error: "仅支持 njtech.edu.cn 域名下的文章 URL" };
      }
      try {
        const article = await fetchJwcArticle(url);
        const MAX = 6000;
        return {
          title: article.title,
          text: article.text.slice(0, MAX),
          truncated: article.text.length > MAX || undefined,
          attachments: article.attachments.length
            ? article.attachments
            : undefined,
          note:
            article.text.length === 0
              ? "正文为空（可能内容在附件里，见 attachments；或页面结构变化）"
              : undefined,
        };
      } catch (e) {
        return { error: `通知抓取失败：${(e as Error).message.slice(0, 100)}` };
      }
    },
  }),

  /** 15. 附件获取（Firecrawl 云解析 / 本地下载） */
  fetch_attachment: tool({
    description:
      "获取并解析通知的文件附件（URL 与文件名来自 read_notice 返回的 attachments）。docx/xlsx/pdf 自动本地解析成文本直接返回（离线零费用，网课目录、课程清单都能读）；其他格式下载到本地 downloads 目录返回路径。问「附件里有哪些课」「网课目录读一下」时调用。",
    inputSchema: z.object({
      url: z.string().describe("附件下载 URL（read_notice 返回的 attachments[].url）"),
      name: z
        .string()
        .optional()
        .describe("附件文件名（read_notice 返回的 attachments[].name，含扩展名）"),
    }),
    execute: async ({ url, name }) => {
      const isNjtech = /^https?:\/\/[a-z0-9.-]*\.njtech\.edu\.cn\//.test(url);
      if (!isNjtech && !config.firecrawlApiKey) {
        return {
          error:
            "仅支持 njtech.edu.cn 域名的附件（未配置 FIRECRAWL_API_KEY 时）",
        };
      }
      try {
        return await fetchAttachment(url, name);
      } catch (e) {
        return { error: `附件获取失败：${(e as Error).message.slice(0, 120)}` };
      }
    },
  }),

  /** 17. 长期记忆维护 */
  save_memory: tool({
    description:
      "长期记忆维护（跨会话持久，存于本地 memory.json，启动时自动注入新会话）。值得跨会话记住的信息出现时主动调用：用户偏好（年级/作息）、要抢/盯的目标课程、重要时间结论（选课考试安排）、任务状态。用户说「记住××」必须立即调用。",
    inputSchema: z.object({
      action: z
        .enum(["add", "update", "delete", "list"])
        .describe("add=新增条目，update=按 id 改内容，delete=按 id 删除，list=列出全部"),
      content: z
        .string()
        .optional()
        .describe("条目内容（add 必填；update 时为新内容）"),
      category: z
        .string()
        .optional()
        .describe('分类，如「用户偏好」「选课」「任务」（add 可选，默认「事实」）'),
      id: z.string().optional().describe("目标条目 id（update/delete 必填，来自 list 或提示词里的 [id]）"),
    }),
    execute: async ({ action, content, category, id }) => {
      if (action === "add") {
        if (!content?.trim()) return { error: "add 需要 content" };
        const { entry, total } = await addMemory(content.trim(), category?.trim() || undefined);
        return { ok: true, saved: entry, totalEntries: total };
      }
      if (action === "update") {
        if (!id || !content?.trim()) return { error: "update 需要 id 和 content（新内容）" };
        const entry = await updateMemory(id, content.trim());
        return entry ? { ok: true, updated: entry } : { error: `未找到条目 ${id}` };
      }
      if (action === "delete") {
        if (!id) return { error: "delete 需要 id" };
        const ok = await deleteMemory(id);
        return ok ? { ok: true, deletedId: id } : { error: `未找到条目 ${id}` };
      }
      const entries = await loadMemory();
      return { total: entries.length, entries };
    },
  }),
};

// 抢课相关工具按开关条件构建，而不是全建好再 delete——
// 之前 raptorTools 的类型内容和运行时内容不一致，TS 完全帮不上忙。
const GRAB_TOOLS = ["watch_courses", "grab_course", "grab_plan"] as const;

export const raptorTools: typeof raptorToolsAll = config.enableGrab
  ? raptorToolsAll
  : Object.fromEntries(
      Object.entries(raptorToolsAll).filter(([name]) => !(GRAB_TOOLS as readonly string[]).includes(name))
    ) as typeof raptorToolsAll;

