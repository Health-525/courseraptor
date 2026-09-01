/**
 * 选课与抢课工具：check_selection_status / search_courses / search_classes
 *               watch_courses / grab_course / grab_plan
 * 包含抢课循环（watchLoop / grabPlanLoop）与课程摘要辅助。
 */

import { tool } from "ai";
import { z } from "zod";

import { config } from "../config";
import {
  fetchJxbList,
  inspectXk,
  matchTargets,
  roundRefOf,
  searchCourses,
  submitCourse,
  type XkCourse,
  type XkSession,
  type XkTarget,
} from "../jwgl/xk";
import { getXkSession, invalidateXkSession, pollDelay } from "./session";

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

type LoopEvent = { time: string; message: string };

/**
 * 抢课/盯课循环的会话管理器。
 * 统一处理：SESSION_EXPIRED 线性退避重登、线路抖动连续 5 次放弃、
 * 45 秒限频刷新会话、提交后会话失效重登。
 * 两个循环（watchLoop / grabPlanLoop）之前各自维护一套状态，
 * 退避参数和错误计数逻辑容易漂移；这里收口到一处。
 */
class XkSessionLoop {
  session: XkSession;
  private consecutiveErrors = 0;
  private sessionExpireStreak = 0;
  private lastSessionRefresh = 0;
  private readonly events: LoopEvent[];

  private constructor(session: XkSession, events: LoopEvent[]) {
    this.session = session;
    this.events = events;
  }

  static async start(events: LoopEvent[]): Promise<XkSessionLoop> {
    const session = await getXkSession();
    return new XkSessionLoop(session, events);
  }

  /**
   * 搜索课程，自动处理会话失效与线路抖动。
   * 返回 null 表示本轮应跳过（调用方 continue）；
   * 返回课程数组表示正常结果。
   * @param keyword 课程名关键词（透传给 searchCourses）
   * @param errorLabel 错误事件前缀，如「查询」「[创新创业类] 查询」
   * @param delayOnError 普通线路抖动后的退避毫秒数（watchLoop=2000，grabPlanLoop=0 因为内层 for 要继续处理其他类别）
   */
  async search(
    keyword: string | undefined,
    errorLabel = "查询",
    delayOnError = 2000,
  ): Promise<XkCourse[] | null> {
    try {
      const courses = await searchCourses(this.session, keyword);
      this.consecutiveErrors = 0;
      this.sessionExpireStreak = 0;
      return courses;
    } catch (e) {
      if ((e as Error).message === "SESSION_EXPIRED") {
        // 重登 = 登录 + 入口页 + 每个轮次 Display，本身就有好几个请求；
        // 不延迟的话，会话持续失效会变成无退避热循环，几分钟内把教务系统
        // 打爆（全局令牌桶只限速不限量）。按连续次数线性退避，上限 10s。
        this.sessionExpireStreak++;
        await pollDelay(Math.min(2000 * this.sessionExpireStreak, 10_000));
        invalidateXkSession();
        this.session = await getXkSession(true);
        return null;
      }
      // 教务线路抖动容错：连续 5 次异常才放弃，单次异常记录后继续
      this.consecutiveErrors++;
      if (this.consecutiveErrors >= 5) throw e;
      this.events.push({
        time: now(),
        message: `${errorLabel}异常（连续 ${this.consecutiveErrors}/5）：${(e as Error).message.slice(0, 60)}`,
      });
      if (delayOnError > 0) await pollDelay(delayOnError);
      return null;
    }
  }

  /**
   * 限频刷新会话（45s）：当课程列表为空或 xkkzId 为空时触发。
   * 抢课模式下会话可能建于开放前（xkkzId 空），或新一轮次在监控期间
   * 才出现（如 12:00 通识选修轮上线新 tab），需要定期重登解析轮次列表。
   */
  async maybeRefresh(courses: XkCourse[], enabled: boolean): Promise<void> {
    if (
      enabled &&
      Date.now() - this.lastSessionRefresh > 45000 &&
      (courses.length === 0 || !this.session.xkkzId)
    ) {
      this.lastSessionRefresh = Date.now();
      invalidateXkSession();
      this.session = await getXkSession(true);
      this.events.push({
        time: now(),
        message: `刷新选课会话：轮次=[${this.session.rounds.map((r) => r.tabName || r.kklxdm).join("、")}]`,
      });
    }
  }

  /** 提交课程后若返回 SESSION_EXPIRED，重新登录；返回是否确实刷新了 */
  async refreshIfExpired(message: string): Promise<boolean> {
    if (message === "SESSION_EXPIRED") {
      invalidateXkSession();
      this.session = await getXkSession(true);
      return true;
    }
    return false;
  }
}

// ── 监控/抢课共用循环 ─────────────────────────────────────────

interface LoopResult {
  rounds: number;
  durationSec: number;
  isXkOpen: boolean;
  events: Array<{ time: string; message: string }>;
  grabbed: { courseName: string; teacher: string; message: string } | null;
  submitAttempts: number;
  lastSnapshot: Array<{
    courseName: string;
    teacher: string;
    selected: number;
    capacity: number;
    remain: number;
  }>;
}

async function watchLoop(
  targets: XkTarget[],
  durationSec: number,
  grab: boolean,
): Promise<LoopResult> {
  const deadline = Date.now() + durationSec * 1000;
  const events: LoopResult["events"] = [];
  const loop = await XkSessionLoop.start(events);
  let rounds = 0;
  let submitAttempts = 0;
  let grabbed: LoopResult["grabbed"] = null;
  let lastSnapshot: LoopResult["lastSnapshot"] = [];

  // 单目标时按关键词缩小服务端查询范围：课程列表分页只拉第一页（100 条），
  // 通识选修课程数百门，不带关键词目标可能不在第一页
  const keyword = targets.length === 1 ? targets[0].courseName : undefined;

  while (Date.now() < deadline) {
    rounds++;
    const courses = await loop.search(keyword);
    if (courses === null) continue; // 会话失效或线路抖动，已由 XkSessionLoop 处理

    // 抢课模式：①会话建于开放前（xkkzId 空）或 ②全部轮次查询为空
    // （新一轮次可能在监控期间才出现，如 12:00 通识选修轮上线新 tab）
    // -> 限频刷新会话，重新解析轮次列表
    await loop.maybeRefresh(courses, grab);

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
          const result = await submitCourse(loop.session, course);
          if (result.ok) {
            grabbed = {
              courseName: course.courseName,
              teacher: course.teacher,
              message: result.message,
            };
            break;
          }
          events.push({ time: now(), message: `提交失败：${result.message}` });
          if (await loop.refreshIfExpired(result.message)) break;
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
    isXkOpen: loop.session.isXkOpen,
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
  durationSec: number,
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
  const events: Array<{ time: string; message: string }> = [];
  const loop = await XkSessionLoop.start(events);
  let rounds = 0;
  let submitAttempts = 0;
  const state = groups.map((g) => ({
    category: g.category,
    courseNames: g.courseNames,
    idx: 0,
    grabbed: "",
    tried: [] as string[],
    fullRounds: 0,
    missRounds: 0,
    done: false,
    /** 备选已用尽（区别于 done：不是抢到了，是没得抢了） */
    exhausted: false,
  }));

  while (Date.now() < deadline) {
    if (state.every((s) => s.done)) break;
    rounds++;

    for (const s of state) {
      if (s.done) continue;
      // 备选已用尽：不标记的话主循环只认 done，会白转到 deadline（最长 600s）
      if (s.idx >= s.courseNames.length) {
        s.exhausted = true;
        s.done = true;
        events.push({
          time: now(),
          message: `[${s.category}] 备选已用尽，停止该类`,
        });
        continue;
      }
      const name = s.courseNames[s.idx];

      // 按候选课程名做服务端过滤（课程列表分页只拉第一页）
      // 内层 for 里普通错误不 delay：这一轮这个类别搜失败了，先处理其他类别，
      // 下一轮 while 再重试；delay 会阻塞其他类别的处理。
      const courses = await loop.search(name, `[${s.category}] 查询`, 0);
      if (courses === null) continue;

      // 抢课期间刷新会话（限频 45s）：①建于开放前（xkkzId 空）或
      // ②当前候选查无结果（新一轮次可能在监控期间才出现，如 12:00
      // 通识选修轮上线新 tab），刷新后重新解析轮次列表
      await loop.maybeRefresh(courses, true);

      const matched = courses.filter(
        (c) => c.courseName.includes(name) || name.includes(c.courseName),
      );
      const available = matched.filter((c) => c.remain > 0);

      if (available.length > 0) {
        submitAttempts++;
        const course = available[0];
        if (!s.tried.includes(course.courseName)) s.tried.push(course.courseName);
        const result = await submitCourse(loop.session, course);
        if (result.ok) {
          s.grabbed = course.courseName;
          s.done = true; // 该类抢到一门即停，绝不重复抢同类学分
          events.push({
            time: now(),
            message: `🎉 [${s.category}] 抢到：${course.courseName}（${course.teacher || "网课"}）-${result.message}，该类收手`,
          });
        } else {
          // SESSION_EXPIRED 时只刷新会话不记事件（下一轮重试），其他错误才记录
          const expired = await loop.refreshIfExpired(result.message);
          if (!expired) {
            events.push({
              time: now(),
              message: `[${s.category}] 提交失败：${result.message}`,
            });
          }
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
      note: s.exhausted ? "备选已用尽" : undefined,
    })),
    events,
    submitAttempts,
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
          session.isXkOpen === false ? "当前选课未开放，接口可能被拦截，数据为空属正常" : undefined,
      };
    },
  }),

  /** 盯课监控（有限时长，不提交选课） */
  watch_courses: tool({
    description:
      "在指定时长内轮询监控目标课程的余量变化（默认 60 秒，每轮间隔约 3 秒含随机抖动）。只观察不提交选课。返回期间的全部事件（何时出现余量）与结束时的余量快照。",
    inputSchema: z.object({
      targets: z
        .array(
          z.object({
            courseName: z.string().describe("课程名关键词（包含即命中）"),
            teacher: z.string().optional().describe("教师名（可选，模糊匹配）"),
          }),
        )
        .min(1)
        .describe("要监控的目标课程列表"),
      durationSec: z.number().int().min(10).max(300).default(60).describe("监控时长（秒）"),
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

  /** 自动抢课（真实提交选课操作！） */
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

  /** 分类抢课计划（每类一门即停） */
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
          }),
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
};
