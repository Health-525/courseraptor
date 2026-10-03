/**
 * 日历与课表图工具：export_calendar / export_schedule_image / publish_calendar
 * （与 njtech/tools/calendar.ts 同构：core 的构建器都是学校无关的，
 *  这里只把抓取与学期解析换成河北农大的实现）
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { loadLogoDataUri } from "../../../core/brand";
import { buildTermICS } from "../../../core/calendar/export";
import { config } from "../../../core/config";
import {
  generatedDir,
  recordDeliverable,
  sanitizeFileBase,
  uniquePath,
} from "../../../core/document/save";
import { publishCalendarToGitee } from "../../../core/gitee-publish";
import { publishCalendarToGithub } from "../../../core/github-publish";
import type { CourseData, ExamData } from "../../../core/model";
import { scheduleSvgToPng } from "../../../core/schedule-png";
import {
  renderTermScheduleSVG,
  renderWeekScheduleSVG,
  type ScheduleStyle,
} from "../../../core/schedule-svg";
import { school } from "../../../core/school";
import {
  fetchExamsSmart,
  fetchScheduleSmart,
  parseSemesterString,
  resolveWeek1Monday,
} from "../academics";
import { getCookie } from "../session";

/** 课表+考试的抓取与对齐（两个日历工具共用）：学期解析、交界期不串台 */
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

  /** 课表图片导出（PNG/SVG × 整学期汇总/单周） */
  export_schedule_image: tool({
    description:
      "把课表导出为图片（默认 PNG 位图，手机相册/QQ 直接存直接看；可选 SVG 矢量）。默认 classic 红头档案风——暖纸底+墨字+单一朱砂+楷体课名+印章 logo，CourseRaptor 招牌视觉，与 /schedule 网页同款；style=color 可换彩色课格风。两种形态：term=整学期汇总（默认，课格标注「2-16周(单)」这类周次，适合做壁纸或打印）、week=单周实际课表（自动处理放假与调休补课，可指定周次，默认本周）。文件名由你按用户语境拟定（filename 参数），如「国庆周课表」「我的秋课表壁纸」。用户说「导出课表图片」「生成课表壁纸」「把课表做成图」时调用。文件存 data/generated 并回绝对路径。",
    inputSchema: z.object({
      mode: z
        .enum(["term", "week"])
        .default("term")
        .describe("term=整学期汇总课表（默认）；week=某一教学周的实际课表（含放假调休）"),
      format: z
        .enum(["png", "svg"])
        .default("png")
        .describe("png=位图，手机直接保存查看（默认）；svg=矢量图，放大不糊、可再编辑"),
      style: z
        .enum(["classic", "color"])
        .default("classic")
        .describe(
          "classic=红头档案风（默认，CourseRaptor 招牌视觉，与 /schedule 网页同款）；color=彩色课格",
        ),
      filename: z
        .string()
        .optional()
        .describe(
          "图片文件名（不含扩展名，按 format 自动补 .png/.svg）。按用户说法和用途起个有意义的名字，如「国庆周课表」「期末冲刺课表壁纸」；不填则用 schedule-term/schedule-weekN 默认名",
        ),
      week: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("week 模式的教学周次（第几周）；不填则本周。term 模式忽略此参数"),
      semester: z
        .string()
        .optional()
        .describe("指定学期，格式如「2026-2027-1」；不填则自动探测最新学期"),
    }),
    execute: async ({ mode, format, style, filename, week, semester }) => {
      const g = await gatherCalendar(semester, "schedule");
      if (!g.ok) return { error: `课表图导出失败：${g.error}` };

      const semPart = `${g.term.year}-${g.term.semester === 3 ? 1 : 2}`;
      const logo = loadLogoDataUri() ?? undefined;
      let svgResult: ReturnType<typeof renderTermScheduleSVG>;
      let base: string;
      let resolvedWeek: number | undefined;

      if (mode === "week") {
        const terms = school().terms;
        const current = terms.weekOf(g.term.year, g.term.semester);
        const maxWeek = Math.max(1, ...g.courses.flatMap((c) => terms.expandWeeks(c.weeks)));
        resolvedWeek = week ?? current?.week;
        if (resolvedWeek == null) {
          return {
            error: `当前不在教学周内（${g.term.label}），请指定周次（1-${maxWeek}）再导出单周课表。`,
          };
        }
        if (resolvedWeek > maxWeek) {
          return { error: `本学期课表只到第 ${maxWeek} 周，没有第 ${resolvedWeek} 周的课。` };
        }
        const week1Monday = resolveWeek1Monday(g.term.year, g.term.semester).week1Monday;
        svgResult = renderWeekScheduleSVG({
          courses: g.courses,
          week: resolvedWeek,
          week1Monday,
          termLabel: g.term.label,
          style: style as ScheduleStyle,
          ...(logo ? { logoDataUri: logo } : {}),
        });
        base = `schedule-week${resolvedWeek}-${semPart}`;
      } else {
        svgResult = renderTermScheduleSVG({
          courses: g.courses,
          termLabel: g.term.label,
          style: style as ScheduleStyle,
          ...(logo ? { logoDataUri: logo } : {}),
        });
        base = `schedule-term-${semPart}`;
      }

      const dir = generatedDir();
      await fsp.mkdir(dir, { recursive: true });
      const payload: Buffer | string =
        format === "png" ? scheduleSvgToPng(svgResult.svg, svgResult.width * 2) : svgResult.svg;
      const ext = format === "png" ? ".png" : ".svg";
      // 模型自拟的文件名优先（去扩展名 + 同文档一道净化闸），缺省回落默认名
      const named = filename?.trim().replace(/\.(png|svg)$/i, "");
      const filePath = uniquePath(dir, named ? sanitizeFileBase(named) : base, ext);
      await fsp.writeFile(filePath, payload);
      const file = {
        filename: path.basename(filePath),
        filePath,
        bytes: typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.length,
      };
      recordDeliverable(file);

      const { counts } = svgResult;
      return {
        file,
        term: g.term.label,
        mode,
        style,
        format,
        ...(resolvedWeek != null ? { week: resolvedWeek } : {}),
        counts: {
          课格: counts.cells,
          课程条目: counts.courses,
          ...(counts.splitSlots ? { 并排时段: counts.splitSlots } : {}),
          ...(counts.unscheduled ? { 未排节次: counts.unscheduled } : {}),
        },
        usage:
          format === "png"
            ? "PNG 是位图，手机/QQ 直接保存查看即可（2 倍分辨率出图，放大不糊）。"
            : "SVG 是矢量图，任意放大不糊：浏览器/微信直接打开，需要 PNG 时可用浏览器打开后截图。",
        note: !g.courses.length ? "本学期课表为空，图里只有空网格" : undefined,
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

      if (config.giteeToken) {
        const r = await publishCalendarToGitee({ token: config.giteeToken, ics, repoName });
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

      if (config.githubToken) {
        const r = await publishCalendarToGithub({ token: config.githubToken, ics, repoName });
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
