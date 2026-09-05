/**
 * 日历工具：export_calendar（本机 .ics）/ publish_calendar（GitHub/Gitee 发布，手机订阅）
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";

import { buildTermICS } from "../calendar-export";
import { config } from "../config";
import { generatedDir, recordDeliverable, uniquePath } from "../document/save";
import { publishCalendarToGitee } from "../gitee-publish";
import { publishCalendarToGithub } from "../github-publish";
import {
  fetchExamsSmart,
  fetchScheduleSmart,
  parseSemesterString,
  resolveWeek1Monday,
} from "../jwgl/academics";
import type { CourseData, ExamData } from "../jwgl/types";
import { getCookie } from "./session";

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
      "把课表/考试导出为 .ics 日历文件（iCalendar 标准）：整学期逐周展开、自动跳过放假日并生成「放假」全天事件、调休补课日按被换周几的课表补出、考试带提前 30 分钟提醒。用户说「导出课表到手机日历」「把考试加进日历」「生成 ics」时调用。文件存 data/generated 并回绝对路径，手机日历 App 导入即可。要让手机「订阅自动更新」用 publish_calendar（发布到 Gitee/GitHub），两者区别：导入是一次性快照，订阅会随重新发布自动刷新。",
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

  /** 日历发布（GitHub/Gitee 公开仓库，手机订阅自动更新） */
  publish_calendar: tool({
    description:
      "把整学期课表/考试日历发布到用户配置的代码托管平台（Gitee 国内直连、GitHub 海外），建公开仓库并返回手机日历可「订阅」的链接——订阅后课表变化重新发布，手机自动更新，不用反复导文件。用户说「发布课表」「让手机订阅日历」「同步到手机日历」时用。国内手机优先给 Gitee 链接（github.io/raw 在国内常打不开）。⚠️ 首次发布是真实的外网操作且内容公开：必须先向用户说明「课表/考试安排会公开、任何拿到链接的人可见」，确认后再调用；用户已明确指示要发布/订阅时算已确认。课表有变（调课/放假落盘/新学期）重新调用即覆盖更新。",
    inputSchema: z.object({
      semester: z
        .string()
        .optional()
        .describe("指定学期，格式如「2026-2027-1」；不填则自动探测最新学期"),
      include: z
        .enum(["all", "schedule", "exams"])
        .default("all")
        .describe("发布内容：all=课表+考试（默认），schedule=仅课表，exams=仅考试"),
      repoName: z.string().optional().describe("仓库名（默认 courseraptor-calendar；一般不用改）"),
    }),
    execute: async ({ semester, include, repoName }) => {
      // 配了哪个平台的令牌就发哪个；都配了就双发（链接都给，用户手机挑能访问的）
      const wanted: Array<"gitee" | "github"> = [];
      if (config.giteeToken) wanted.push("gitee");
      if (config.githubToken) wanted.push("github");
      if (!wanted.length) {
        return {
          error:
            "还没配置代码托管平台的令牌。国内手机订阅推荐 Gitee：到 gitee.com → 设置 → 私人令牌生成（勾选 projects、user_info），填进 .env 的 GITEE_TOKEN=；海外/电脑可用 GitHub：github.com → Settings → Developer settings → Personal access tokens（经典令牌勾 repo），填 GITHUB_TOKEN=。配好任一后重启再试。",
          needSetup: true,
        };
      }

      const g = await gatherCalendar(semester, include);
      if (!g.ok) return { error: `日历发布中止（没查到数据就不发）：${g.error}` };

      const week1Monday = resolveWeek1Monday(g.term.year, g.term.semester).week1Monday;
      const { ics, ...counts } = buildTermICS({
        courses: g.courses,
        exams: g.exams,
        week1Monday,
        termLabel: g.term.label,
      });

      const links: Array<Record<string, string>> = [];
      const failed: Array<{ platform: string; error: string }> = [];

      if (wanted.includes("gitee")) {
        const r = await publishCalendarToGitee({ token: config.giteeToken!, ics, repoName });
        if (r.ok) {
          links.push({
            platform: "gitee",
            label: "国内手机优先用这个（直连，更新及时）",
            subscribeUrl: r.data.subscribeUrl,
            webcalUrl: r.data.webcalUrl,
            repoUrl: r.data.repoUrl,
          });
        } else {
          failed.push({ platform: "gitee", error: r.error });
        }
      }

      if (wanted.includes("github")) {
        const r = await publishCalendarToGithub({ token: config.githubToken!, ics, repoName });
        if (r.ok) {
          const d = r.data;
          links.push({
            platform: "github",
            label: "海外/电脑用；国内访问 GitHub 常不稳定",
            subscribeUrl: d.subscribeUrl,
            webcalUrl: d.webcalUrl,
            repoUrl: d.repoUrl,
          });
        } else {
          failed.push({ platform: "github", error: r.error });
        }
      }

      if (!links.length) {
        return {
          error: `日历发布失败（所有平台都没发出去）：${failed.map((f) => `${f.platform}：${f.error}`).join("；")}`,
          needSetup: failed.some((f) => f.error.includes("令牌")) ? true : undefined,
        };
      }

      return {
        published: true,
        term: g.term.label,
        links,
        failed: failed.length ? failed : undefined,
        counts,
        /** 给模型的话术素材：手机端订阅步骤 */
        howToSubscribe: {
          iPhone: "设置 → 日历 → 日历账户 → 添加其他 → 添加订阅的日历，粘贴订阅链接",
          android: "日历 App 的「订阅日历/通过 URL 添加」（或装 ICSx⁵ 等订阅 App），粘贴订阅链接",
        },
        notes: [
          "课表变化（调课/放假/新学期）后重新说一声「更新手机日历」即可，订阅端自动刷新",
          "订阅是拉取式：手机按系统刷新周期更新（iOS 默认可到几小时一次），刚发布完稍等片刻属正常",
        ],
        privacy:
          "日历公开在托管平台上，任何拿到链接的人都能看到课程与考试安排；想撤下就到对应平台删除该仓库",
      };
    },
  }),
};
