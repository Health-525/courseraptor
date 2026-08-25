/**
 * CourseRaptor agent 工具集
 * 12 个工具：选课 5 + 查询 3 + 通知 3 + 记忆 1
 */

import { tool } from "ai";
import { z } from "zod";

import { config } from "../config";
import { fetchAttachment } from "../attachments";
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
  NJTECH_PERIOD_TIMES,
} from "../jwgl/academics";
import { fetchAllGrades } from "../jwgl/grades";
import { fetchJwcNews, fetchJwcArticle } from "../jwgl/news";
import {
  inspectXk,
  searchCourses,
  fetchJxbList,
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

/** 节次号 -> 上课时间段，如 [7,8] -> "16:00-17:40" */
function periodTimeRange(periods: number[]): string | undefined {
  if (!periods.length) return undefined;
  const first = NJTECH_PERIOD_TIMES[String(periods[0])];
  const last = NJTECH_PERIOD_TIMES[String(periods[periods.length - 1])];
  if (!first || !last) return undefined;
  return `${first.split("-")[0]}-${last.split("-")[1]}`;
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

  /** 3. 查教学班列表（同门课各班对比） */
  search_jxb: tool({
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

      const codes = [
        ...new Set(courses.map((c) => c.courseCode).filter(Boolean)),
      ].slice(0, 3);
      if (codes.length === 0) {
        return {
          error:
            "未查到该课程。选课未开放（isXkOpen=false）时课程/教学班接口均不可查，可先调 get_xk_status 确认。",
        };
      }

      const result = [];
      for (const code of codes) {
        let list: XkCourse[];
        try {
          list = await fetchJxbList(session, { courseCode: code });
        } catch (e) {
          if ((e as Error).message === "SESSION_EXPIRED") {
            invalidateXkSession();
            session = await getXkSession(true);
            list = await fetchJxbList(session, { courseCode: code });
          } else throw e;
        }
        result.push({
          courseCode: code,
          courseName:
            courses.find((c) => c.courseCode === code)?.courseName || code,
          jxbCount: list.length,
          classes: list.map(courseBrief),
        });
      }
      return {
        isXkOpen: session.isXkOpen,
        matchedCourses: codes.length,
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

  /** 6. 课表查询 */
  get_schedule: tool({
    description:
      "查询课表，返回每门课的上课时间、地点、教师、周次。默认自动探测最新有课表的学期（学期交界期也不会查错）；也可指定学期，如「2026-2027-1」。",
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
      const week = currentWeekOf(r.year, r.semester);
      return {
        term: r.label,
        currentWeek: week ? `第 ${week.week} 周` : "未开学或不在教学周内",
        week1Monday: week?.week1Monday,
        weekNote: week?.estimated
          ? "开学日期为估算值（校历发布后校准）"
          : undefined,
        total: r.courses.length,
        courses: r.courses.map((c) => ({
          title: c.title,
          weekday: WEEKDAY_NAMES[c.weekday] ?? `周${c.weekday}`,
          periods: c.periods.join(","),
          time: periodTimeRange(c.periods),
          weeks: c.weeks,
          location: c.location,
          teacher: c.teacher,
        })),
        note: r.courses.length === 0 ? "课表为空（假期或学期未排课属正常）" : undefined,
      };
    },
  }),

  /** 7. 成绩查询 */
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

  /** 8. 考试安排 */
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
      const { label, exams } = await fetchExamsSmart(
        cookie,
        parsed?.year,
        parsed?.semester
      );
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

  /** 9. 教务处官网通知 */
  get_jwc_news: tool({
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

  /** 10. 通知正文阅读 */
  read_jwc_notice: tool({
    description:
      "读取一篇教务处通知的正文全文（get_jwc_news 只返回标题列表，具体时间安排都在正文里）。输入通知 URL（来自 get_jwc_news 结果的 items[].url），返回正文文本与附件下载链接。用户问「选课几点开始」「补选什么时候截止」「通知里怎么说的」时：先 get_jwc_news 找到相关通知，再用本工具读正文。",
    inputSchema: z.object({
      url: z
        .string()
        .describe("通知文章 URL（来自 get_jwc_news 返回的 items[].url）"),
    }),
    execute: async ({ url }) => {
      if (!/^https?:\/\/jwc\.njtech\.edu\.cn\//.test(url)) {
        return { error: "仅支持 jwc.njtech.edu.cn 域名下的通知 URL" };
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

  /** 11. 附件获取（Firecrawl 云解析 / 本地下载） */
  fetch_attachment: tool({
    description:
      "获取通知的文件附件（.pdf/.doc/.xls 等，URL 来自 read_jwc_notice 返回的 attachments）。配置了 FIRECRAWL_API_KEY 时通过 Firecrawl 把附件解析成 markdown 文本直接返回；未配置时下载到本地 downloads 目录并返回文件路径。问「附件里怎么说的」「把附件内容读出来」时调用。",
    inputSchema: z.object({
      url: z.string().describe("附件下载 URL（来自 read_jwc_notice 的 attachments[].url）"),
    }),
    execute: async ({ url }) => {
      const isNjtech = /^https?:\/\/[a-z0-9.-]*\.njtech\.edu\.cn\//.test(url);
      if (!isNjtech && !config.firecrawlApiKey) {
        return {
          error:
            "未配置 FIRECRAWL_API_KEY 时，仅支持 njtech.edu.cn 域名的附件下载",
        };
      }
      return await fetchAttachment(url);
    },
  }),

  /** 12. 长期记忆维护 */
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
