/**
 * CourseRaptor agent 工具集
 * 23 个工具：选课 6 + 查询 7 + 通知 3 + 文件数据 4 + 天气 1 + 记忆 1 + 校历 1
 */

import { tool } from "ai";
import { z } from "zod";

import { config } from "../config";
import { fetchAttachment, openLocalFile } from "../attachments";
import {
  getMeta,
  readStoredBuffer,
  listAttachments,
  deleteAttachment,
  clearAttachments,
  attachmentStats,
} from "../attachment-store";
import { loadWorkbook, querySheet, distinctValues, sheetOverview } from "../spreadsheet";
import { runSandboxedJs } from "../sandbox-js";
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
  archiveMemory,
  loadMemory,
  loadUserGrade,
} from "../memory/longterm";
import {
  fetchScheduleSmart,
  fetchExamsSmart,
  parseSemesterString,
  currentWeekOf,
  resolveWeek1Monday,
  buildWeekIndex,
  periodTimeRange,
  WEEKDAY_NAMES,
} from "../jwgl/academics";
import {
  annotateWeekGroups,
  listSpecialDays,
  specialOnDate,
  recordSpecialDays,
  removeSpecialDays,
  loadHolidayStore,
  type SpecialDayRecord,
} from "../jwgl/term-holidays";
import { saveScheduleCache } from "../schedule-cache";
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
import { fetchWeather, defaultWeatherCity } from "../weather";

function now(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

// ── 通知相关性 ────────────────────────────────────────────────
// 教务处一次发十几条，其中大半跟具体某个学生无关。过去全靠模型逐条判断，
// 判断质量时好时坏；这里按「是否点名本年级 / 是否需本人行动」固化成规则。

type RelevanceLevel = "high" | "medium" | "low";

/** 视情况才看：只在本人有对应需求时才相关，判定要早于 MUST_DO */
const SITUATIONAL = ["补修", "重修", "转专业", "辅修", "免修", "缓考", "交流", "学籍", "毕业", "学位", "先修"];
/** 全校性需要本人动手的事 */
const MUST_DO = ["报到", "注册", "教材", "开学", "选课", "考试", "补考", "停开", "补退选", "放假", "缴费"];
/** 与学生日常无关的行政类 */
const IRRELEVANT = ["公示", "课题", "申报", "增设", "评审", "立项", "结题", "获奖", "专项", "教研", "教改"];

function relevanceOf(
  title: string,
  grade: string | null
): { level: RelevanceLevel; reason?: string } {
  // 归一化：去掉括号与空白，否则「补（缓）考」这种写法匹配不到「缓考」
  const flat = title.replace(/[（）()【】\[\]\s]/g, "");
  const gradeInTitle = flat.match(/(\d{4})\s*级/);
  if (grade && gradeInTitle) {
    return gradeInTitle[1] === grade
      ? { level: "high", reason: `点名 ${grade} 级` }
      : { level: "low", reason: `面向 ${gradeInTitle[1]} 级，非你所在年级` };
  }
  if (SITUATIONAL.some((w) => flat.includes(w))) {
    return { level: "medium", reason: "视个人情况" };
  }
  if (MUST_DO.some((w) => flat.includes(w))) {
    return { level: "high", reason: "需本人办理" };
  }
  if (IRRELEVANT.some((w) => flat.includes(w))) {
    return { level: "low", reason: "行政公示类" };
  }
  return { level: "low" };
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
  /** 连续「会话失效」次数：重登本身就要打好几个请求，必须退避 */
  let sessionExpireStreak = 0;

  // 单目标时按关键词缩小服务端查询范围：课程列表分页只拉第一页（100 条），
  // 通识选修课程数百门，不带关键词目标可能不在第一页
  const keyword = targets.length === 1 ? targets[0].courseName : undefined;

  while (Date.now() < deadline) {
    rounds++;
    let courses: XkCourse[] = [];
    try {
      courses = await searchCourses(session, keyword);
      consecutiveErrors = 0;
      sessionExpireStreak = 0;
    } catch (e) {
      if ((e as Error).message === "SESSION_EXPIRED") {
        // 重登 = 登录 + 入口页 + 每个轮次 Display，本身就有好几个请求；
        // 这里不延迟的话，会话持续失效会变成无退避热循环，几分钟内把教务系统
        // 打爆（全局令牌桶只限速不限量）。按连续次数线性退避，上限 10s。
        sessionExpireStreak++;
        await pollDelay(Math.min(2000 * sessionExpireStreak, 10_000));
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
    /** 备选已用尽（区别于 done：不是抢到了，是没得抢了） */
    exhausted: false,
  }));
  let consecutiveErrors = 0;
  let lastSessionRefresh = 0;
  /** 连续「会话失效」次数：重登本身就要打好几个请求，必须退避 */
  let sessionExpireStreak = 0;

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

      let courses: XkCourse[] = [];
      try {
        // 按候选课程名做服务端过滤（课程列表分页只拉第一页）
        courses = await searchCourses(session, name);
        consecutiveErrors = 0;
        sessionExpireStreak = 0;
      } catch (e) {
        if ((e as Error).message === "SESSION_EXPIRED") {
          // 同 watchLoop：重登要好几个请求，不延迟会在会话持续失效时热循环
          sessionExpireStreak++;
          await pollDelay(Math.min(2000 * sessionExpireStreak, 10_000));
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
      note: s.exhausted ? "备选已用尽" : undefined,
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
      "查询课表，返回每门课的上课时间、地点、教师、周次。默认自动探测最新有课表的学期（学期交界期也不会查错）；也可指定学期，如「2026-2027-1」。返回的 byWeek 是按周预分组好的索引（week -> 该周的课，已格式化可直接引用）：用户问「第一周的课」「第 5 周有什么」「这周哪几天有课」时，直接查 byWeek 对应 week 即可，不要自己解析 courses[].weeks 里的周次表达式。byWeek 里没有的周次即该周无课。注意：week 里带 holiday 字段表示该周放假日（普通课表作废，直接按放假安排回答），带 makeup 字段是调休补课日按被换周几课表补出的行——这两类覆盖普通课表，别按原始周一~周日回答。specialDays 是已落盘的全部放假/调休安排，todaySpecial 是今天的。",
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
      // 未指定学期（即自动探测的最新学期）时顺带刷新本地缓存，
      // TUI 启动面板读缓存就够，不必每次登录都请求教务系统
      if (!semester) saveScheduleCache(term);
      const week = currentWeekOf(term.year, term.semester);
      // 假期/调休按日期叠周需要 week1Monday；currentWeekOf 在假期里返回 null，
      // 但周分组照样要标注，所以直接从真值源取
      const week1Monday =
        week?.week1Monday ?? resolveWeek1Monday(term.year, term.semester).week1Monday;
      const now = new Date();
      const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const today = specialOnDate(todayIso);
      const specialDays = listSpecialDays();
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
         * holiday=该周放假日（课表作废）；makeup=调休补课行（按被换周几的课表）。
         */
        byWeek: annotateWeekGroups(
          term.courses,
          week1Monday,
          buildWeekIndex(term.courses)
        ),
        /** 已落盘的放假/调休安排（空数组 = 教务处还没发通知，没记录） */
        specialDays,
        specialDaysSource: loadHolidayStore().source,
        // 放假/调休的唯一合法来源是教务处通知：没有落盘记录时明确提醒模型
        // 去查通知，而不是让它拿校历或印象回答「国庆放几天」这类问题
        specialDaysNote: specialDays.length
          ? undefined
          : "尚无放假/调休落盘记录。法定节假日（国庆/元旦/清明/五一/端午/中秋/寒暑假）的具体安排以教务处通知为准：用户问放假安排、或问的课表周临近节假日时，先 get_news 查「放假/调休」相关通知，读到就 read_notice + set_holidays 落盘；查无通知再按「按国务院文件执行、另行通知」回答。",
        todaySpecial: today ? { date: todayIso, ...today } : undefined,
        note:
          term.courses.length === 0
            ? "课表已查通但无排课（假期或学期未排课属正常）"
            : undefined,
      };
    },
  }),

  /** 7b. 放假/调休落盘 */
  set_holidays: tool({
    description:
      "记录放假/调休安排到本地日历（get_schedule 之后的查询会自动叠加）。触发时机：教务处发布放假安排通知（get_news 标题含「放假」「调休」「节假日」）或用户转述放假安排时。流程：先 read_notice 读通知正文，把安排逐日拆成 days——放假日传 type=holiday + name（节日名）；调休补课日（如「10月10日（星期六）上课」）传 type=makeup + follows=按周几的课表上课（1-7=周一～周日）。同日期重复写入以新记录为准；通知更正/撤回某天时传 remove 数组删除。",
    inputSchema: z.object({
      days: z
        .array(
          z.object({
            date: z.string().describe("日期，YYYY-MM-DD"),
            type: z.enum(["holiday", "makeup"]),
            name: z.string().optional().describe("holiday：节日名，如「国庆节」"),
            follows: z
              .number()
              .int()
              .min(1)
              .max(7)
              .optional()
              .describe("makeup 必填：按周几的课表上课（1-7=周一～周日）"),
          })
        )
        .min(1)
        .describe("逐日安排（通知里的每一天一条）"),
      remove: z.array(z.string()).optional().describe("要删除记录的日期（通知更正/撤回时用）"),
      source: z.string().optional().describe("依据：通知标题或文号"),
    }),
    execute: async ({ days, remove, source }) => {
      const removed = remove?.length ? removeSpecialDays(remove) : 0;
      const r = recordSpecialDays(days as SpecialDayRecord[], source);
      if (r.rejected.length) {
        return {
          recorded: r.recorded,
          removed,
          error: `以下日期无效（格式应为 YYYY-MM-DD，且 makeup 必须带 follows）：${r.rejected.join("、")}。请核对通知原文后重试。`,
        };
      }
      const holidays = days.filter((d) => d.type === "holiday").length;
      return {
        recorded: r.recorded,
        removed,
        summary: `已落盘 ${r.recorded} 天（放假 ${holidays} 天、调休补课 ${r.recorded - holidays} 天）${source ? `，依据：${source}` : ""}。之后 get_schedule 会自动叠加。`,
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
      "抓取南京工业大学教务处官网（jwc.njtech.edu.cn）的最新通知，涵盖三个板块：公告通知（含选课/考试/学籍等重要安排）、教学动态、考试排课。公开页面无需登录。用户问「最近有什么教务通知」「选课什么时候开始」「有没有关于××的通知」时调用。每条带 relevance：high=需本人行动（点名本年级或全校性必办）、medium=视个人情况（补修/重修/转专业等）、low=基本无关（其他年级或行政公示）。回答时优先讲 high 的，low 的一句带过，不要平铺全部。",
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
      const grade = await loadUserGrade();
      const scored = filtered.slice(0, limit).map((i) => {
        const { level, reason } = relevanceOf(i.title, grade);
        return {
          title: i.title,
          date: i.date,
          category: i.category,
          /** high=需本人行动 / medium=视情况 / low=基本无关 */
          relevance: level,
          relevanceReason: reason,
          url: i.url,
        };
      });
      const mustSee = scored.filter((i) => i.relevance === "high").length;
      return {
        total: filtered.length,
        /** 年级依据；取不到就退化成纯关键词判断 */
        gradeBasis: grade ?? undefined,
        mustSeeCount: mustSee,
        items: scored,
        note:
          filtered.length === 0
            ? "未抓到通知（官网结构可能变化或网络异常）"
            : grade
              ? `已按你所在「${grade} 级」标记相关性：high ${mustSee} 条需要你行动。回答时先给 high 的，low 的一条带过即可。`
              : "未识别到你的年级，相关性按关键词粗判。",
      };
    },
  }),

  /** 16. 通知正文阅读 */
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

  /** 17. 附件获取（自动缓存，表格回概览、长文可分页/检索） */
  fetch_attachment: tool({
    description:
      "获取并解析通知的文件附件（URL 与文件名来自 read_notice 返回的 attachments）。自动落盘缓存：同一附件再查不用重新下载。xlsx/xls/csv 表格 → 回概览（表头+每 sheet 前 15 行+总行数），千行明细必须用 query_table 按关键词/条件筛选，别想着一口读完；docx/pdf/txt → 全文分页（offset/limit 续读）或直接 keyword 定位（返回含关键词的上下文段落，适合找「我的专业/班级/时间」）。问「附件里有哪些课」「网课目录读一下」时调用。",
    inputSchema: z.object({
      url: z.string().describe("附件下载 URL（read_notice 返回的 attachments[].url）"),
      name: z
        .string()
        .optional()
        .describe("附件文件名（read_notice 返回的 attachments[].name，含扩展名）"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("长文本续读起点（用上次返回的 nextOffset）"),
      limit: z.number().int().min(500).max(20000).optional().describe("长文本单页长度（默认 6000）"),
      keyword: z
        .string()
        .optional()
        .describe("长文本关键词定位：只回含该词的上下文片段，省去通读"),
      refresh: z.boolean().optional().describe("忽略缓存强制重新下载（默认用缓存）"),
    }),
    execute: async ({ url, name, offset, limit, keyword, refresh }) => {
      const isNjtech = /^https?:\/\/[a-z0-9.-]*\.njtech\.edu\.cn\//.test(url);
      if (!isNjtech && !config.firecrawlApiKey) {
        return {
          error:
            "仅支持 njtech.edu.cn 域名的附件（未配置 FIRECRAWL_API_KEY 时）",
        };
      }
      try {
        return await fetchAttachment(url, name, { offset, limit, keyword, refresh });
      } catch (e) {
        return { error: `附件获取失败：${(e as Error).message.slice(0, 120)}` };
      }
    },
  }),

  /** 18. 读取本机文件（用户给路径） */
  read_local_file: tool({
    description:
      "读取用户电脑上的文件（用户告诉你路径时用，如「我下载了网课目录，在 D:\\\\Downloads\\\\xx.xlsx」）。docx/pdf/txt/md 回全文分页（offset 续读、keyword 定位），xlsx/xls/csv 回表格概览（后续用 query_table 筛选）。只读入缓存副本，绝不修改用户文件。路径必须是用户明确给出的，不要自行扫描猜测。",
    inputSchema: z.object({
      path: z.string().describe("本机文件绝对路径（用户提供的）"),
      offset: z.number().int().min(0).optional().describe("长文本续读起点"),
      limit: z.number().int().min(500).max(20000).optional().describe("长文本单页长度（默认 6000）"),
      keyword: z.string().optional().describe("长文本关键词定位（返回上下文片段）"),
      refresh: z.boolean().optional().describe("文件内容变了？忽略缓存重读"),
    }),
    execute: async ({ path: p, offset, limit, keyword, refresh }) => {
      try {
        return await openLocalFile(p, { offset, limit, keyword, refresh });
      } catch (e) {
        return { error: (e as Error).message.slice(0, 200) };
      }
    },
  }),

  /** 19. 表格筛选查询（大表按需取行） */
  query_table: tool({
    description:
      "对已缓存的表格（id 来自 fetch_attachment / read_local_file 返回的 id 字段）做结构化查询，替代「通读整个 Excel」。action：sheets=看所有 sheet 的表头与行数（默认 sheet 不确定时先这个）；rows=按分页/排序读行；filter=关键词（keyword 全列模糊匹配）+ 多条件（where，col/op/value，AND 关系，op 支持 contains/eq/ne/gt/ge/lt/le/regex/empty/notEmpty，数值条件自动按数字比较）+ 排序（sortBy/sortDesc）+ 分页（offset/limit）；values=某列去重计数（如「表里有哪些学院」）。典型用法：学生问「网课目录里我们专业大三要上哪门」→ filter 用 where 专业列 contains + keyword 年级。结果行用「 | 」拼接，表头在 headers。",
    inputSchema: z.object({
      id: z.string().describe("附件缓存 id"),
      action: z
        .enum(["sheets", "rows", "filter", "values"])
        .default("sheets")
        .describe("查询类型"),
      sheet: z.string().optional().describe("sheet 名（可模糊；省略用第一个）"),
      keyword: z.string().optional().describe("filter：任意列（或 keywordCols）包含，不分大小写"),
      keywordCols: z.array(z.string()).optional().describe("限定关键词检索的列"),
      where: z
        .array(
          z.object({
            col: z.string().describe("列名（支持精确/模糊/1-based 序号）"),
            op: z.enum([
              "contains",
              "notContains",
              "eq",
              "ne",
              "gt",
              "ge",
              "lt",
              "le",
              "regex",
              "empty",
              "notEmpty",
            ]),
            value: z.string().optional().describe("比较值（empty/notEmpty 省略）"),
          })
        )
        .optional()
        .describe("filter：多条件 AND"),
      col: z.string().optional().describe("values：目标列"),
      columns: z.array(z.string()).optional().describe("只返回这些列（省 token）"),
      sortBy: z.string().optional().describe("按列排序（数字列按数值）"),
      sortDesc: z.boolean().optional().describe("降序"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(40).describe("本次最多返回行数"),
    }),
    execute: async (input) => {
      const meta = getMeta(input.id);
      if (!meta) {
        return {
          error: `缓存中不存在 id=${input.id} 的表格（可能已清理）。先 fetch_attachment 或 read_local_file 重新获取。`,
        };
      }
      const buf = readStoredBuffer(meta.id);
      const sheets = buf ? loadWorkbook(buf, meta.filename) : null;
      if (!sheets) {
        return { error: `「${meta.filename}」不是可解析的表格文件（支持 xlsx/xls/csv/tsv）` };
      }
      let sheet;
      if (input.sheet?.trim()) {
        const q = input.sheet.trim().toLowerCase();
        sheet =
          sheets.find((s) => s.name.toLowerCase() === q) ??
          sheets.find((s) => s.name.toLowerCase().includes(q));
        if (!sheet) {
          return {
            error: `无 sheet「${input.sheet}」（现有：${sheets.map((s) => s.name).join("、")}）`,
          };
        }
      } else if (sheets.length === 1) {
        sheet = sheets[0];
      } else if (input.action === "sheets") {
        // 多 sheet 不指定：直接给全部概览
        return {
          id: meta.id,
          filename: meta.filename,
          sheets: sheets.map((s) => sheetOverview(s, 5)),
          note: "多 sheet 表格：确认目标后带 sheet 参数再查。",
        };
      } else {
        sheet = sheets[0];
      }
      const sheetNote =
        sheets.length > 1
          ? `当前 sheet=「${sheet.name}」（全部：${sheets.map((s) => s.name).join("、")}）`
          : undefined;
      try {
        if (input.action === "sheets") {
          return {
            id: meta.id,
            filename: meta.filename,
            sheets: sheets.map((s) => sheetOverview(s, 5)),
            sheetNote,
          };
        }
        if (input.action === "values") {
          if (!input.col?.trim()) return { error: "values 需要 col（目标列名）" };
          const values = distinctValues(sheet, input.col);
          return {
            id: meta.id,
            sheet: sheet.name,
            col: sheet.headers[0] !== undefined && input.col ? input.col : undefined,
            distinct: values.length,
            values,
            totalRows: sheet.rows.length,
            sheetNote,
          };
        }
        if (input.action === "filter" && !input.keyword?.trim() && !input.where?.length) {
          return { error: "filter 至少要给 keyword 或 where 一个条件（全表读取用 action=rows 分页）" };
        }
        const r = querySheet(sheet, {
          keyword: input.keyword,
          keywordCols: input.keywordCols,
          where: input.where,
          columns: input.columns,
          sortBy: input.sortBy,
          sortDesc: input.sortDesc,
          offset: input.offset,
          limit: input.limit,
        });
        return {
          id: meta.id,
          sheet: sheet.name,
          totalRows: sheet.rows.length,
          matched: r.matched,
          offset: r.offset,
          returned: r.returned,
          headers: r.headers,
          rows: r.rows.map((x) => x.join(" | ")),
          nextOffset: r.truncated ? r.offset + r.returned : undefined,
          note: r.truncated
            ? `还有 ${r.matched - r.offset - r.returned} 行未返回，用 offset=${r.offset + r.returned} 续取`
            : undefined,
          sheetNote,
        };
      } catch (e) {
        return { error: (e as Error).message.slice(0, 300) };
      }
    },
  }),

  /** 20. 沙箱 JS 计算台 */
  run_js: tool({
    description:
      "沙箱 JavaScript：对已经拿到的数据做去重、计数、分组求和、正则摘取、排序、JSON/文本转换等小计算。约束：无网络无磁盘（禁用 require/process/fetch），3 秒超时，输出截断；最后一条表达式的值就是结果，多行逻辑用 console.log 输出。数据先用 query_table 筛小，再把数组/JSON 贴进代码——别把千行大表整个塞进来。",
    inputSchema: z.object({
      code: z.string().describe("要执行的 JS 代码（纯计算与文本处理）"),
    }),
    execute: async ({ code }) => runSandboxedJs(code),
  }),

  /** 21. 附件缓存管理（可删自己下载的） */
  manage_attachments: tool({
    description:
      "管理附件缓存（data/attachments/，只存 agent 自己下载/读入的副本）：list=列出全部缓存（id/文件名/大小/来源）；delete=按 id 删除一条；delete_all=清空。附件任务答完、用户不再需要追问明细时可主动清理省磁盘。安全边界：只认缓存索引，用户本机原文件（read_local_file 也只是读副本）永远不会被删。",
    inputSchema: z.object({
      action: z.enum(["list", "delete", "delete_all"]),
      id: z.string().optional().describe("delete 必填：缓存 id"),
    }),
    execute: async ({ action, id }) => {
      if (action === "list") {
        const stats = attachmentStats();
        return {
          count: stats.count,
          totalSizeMB: (stats.totalBytes / 1024 / 1024).toFixed(1),
          files: listAttachments().map((m) => ({
            id: m.id,
            filename: m.filename,
            kind: m.kind,
            format: m.format,
            sizeKB: (m.size / 1024).toFixed(0),
            fetchedAt: m.fetchedAt.slice(0, 10),
            source: m.source === "url" ? m.url : m.originPath,
            sheets: m.sheetNames?.length ? m.sheetNames.join("、") : undefined,
            textLength: m.textLength,
          })),
          note: stats.count ? "追问附件内容前先 list，别重新下载。" : undefined,
        };
      }
      if (action === "delete") {
        if (!id?.trim()) return { error: "delete 需要 id（来自 list）" };
        const ok = await deleteAttachment(id);
        return ok
          ? { ok: true, deletedId: id.trim(), note: "已删除缓存副本" }
          : { error: `未找到缓存 id=${id}（可能已删过；list 确认）` };
      }
      const removed = await clearAttachments();
      return { ok: true, removed, note: "已清空附件缓存（不涉及用户本机原文件）" };
    },
  }),

  /** 22. 天气查询 */
  get_weather: tool({
    description:
      "查询天气：实况（温度/体感/湿度/风）+ 未来若干天预报。天气码已翻成中文，并给出带伞与穿衣建议。默认查学校所在城市（南京工业大学→南京），用户提到别的城市就用 city 传（如「三亚」）。用户问「明天冷不冷」「要带伞吗」「周末天气」「老家天气」时直接调用，不要反问城市。",
    inputSchema: z.object({
      city: z
        .string()
        .optional()
        .describe("中文城市名，如「南京」「海口」；不填则查学校所在城市"),
      days: z
        .number()
        .int()
        .min(1)
        .max(14)
        .default(7)
        .describe("预报天数（默认 7，最多 14）"),
    }),
    execute: async ({ city, days }) => {
      const wanted = city?.trim();
      const r = await fetchWeather(wanted || defaultWeatherCity(), days);
      if (!r.ok) {
        // 与课表同一套契约：查不到 ≠ 天气好，别让模型拿空数据编一个晴天
        return {
          error: `天气查询失败：${r.error}。这与「当地天气晴好」不是一回事，请如实告知用户查询失败。`,
        };
      }
      const w = r.data;
      return {
        city: w.city,
        localTime: w.localTime,
        now: {
          text: w.now.text,
          tempC: w.now.tempC,
          feelsLikeC: w.now.feelsLikeC,
          humidity: `${w.now.humidity}%`,
          wind: `${w.now.windKmh} km/h`,
        },
        days: w.days.map((d) => ({
          date: d.date,
          weekday: d.weekday,
          text: d.text,
          temp: `${d.minC}~${d.maxC}℃`,
          rainChance: d.rainChance == null ? undefined : `${d.rainChance}%`,
        })),
        advice: w.advice.length ? w.advice : undefined,
        note: wanted
          ? undefined
          : `未指定城市，按学校所在地查询：${w.city}。用户想查别的地方，让他直接说城市名。`,
      };
    },
  }),

  /** 23. 长期记忆维护 */
  save_memory: tool({
    description:
      "长期记忆维护（跨会话持久，存于本地 memory.json，启动时自动注入新会话）。值得跨会话记住的信息出现时主动调用：用户偏好（年级/作息）、要抢/盯的目标课程、重要时间结论（选课考试安排）、任务状态。用户说「记住××」必须立即调用。",
    inputSchema: z.object({
      action: z
        .enum(["add", "update", "delete", "list", "archive"])
        .describe(
          "add=新增条目，update=按 id 改内容，delete=按 id 删除，list=列出全部，archive=按 id 归档（事情办完但想留档时用，归档后不再进入提示词）"
        ),
      content: z
        .string()
        .optional()
        .describe("条目内容（add 必填；update 时为新内容）"),
      category: z
        .string()
        .optional()
        .describe('分类，如「用户偏好」「选课」「任务」（add 可选，默认「事实」）'),
      id: z.string().optional().describe("目标条目 id（update/delete/archive 必填，来自 list 或提示词里的 [id]）"),
      expiresAt: z
        .string()
        .optional()
        .describe("过期时间（ISO 日期，如 2026-09-15）。到点后自动不再进入提示词，适合一次性安排/任务类记忆"),
    }),
    execute: async ({ action, content, category, id, expiresAt }) => {
      if (action === "add") {
        if (!content?.trim()) return { error: "add 需要 content" };
        const { entry, total, merged } = await addMemory(
          content.trim(),
          category?.trim() || undefined,
          expiresAt
        );
        return {
          ok: true,
          saved: entry,
          totalEntries: total,
          merged,
          note: merged ? "与已有条目重复，已合并为较新的表述" : undefined,
        };
      }
      if (action === "archive") {
        if (!id) return { error: "archive 需要 id" };
        const entry = await archiveMemory(id);
        return entry
          ? { ok: true, archived: entry, note: "已归档，后续会话不再注入" }
          : { error: `未找到条目 ${id}` };
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

