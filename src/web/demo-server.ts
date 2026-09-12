/** 独立演示服务：不导入 config/agent，不读取凭证、真实会话或教务数据。 */
import { readFileSync } from "node:fs";
import http from "node:http";
import type { StoredArtifact } from "../chat-sessions";
import { chatPage } from "./chat-page";
import type { BriefCourse, BriefDay, TodayBrief } from "./today-brief";
import { todayPage } from "./today-page";

interface DemoMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
  artifacts?: StoredArtifact[];
}

function demoCard(message: string): StoredArtifact | null {
  const base = {
    badge: "虚构示例",
    updatedAt: Date.now(),
    source: "离线演示",
    change: { status: "first" as const, text: "正式查询后会保存为变化对比基准" },
  };
  if (/成绩|GPA|绩点|学业/i.test(message))
    return {
      ...base,
      kind: "grades",
      title: "成绩与学业概览",
      metrics: [
        { label: "GPA", value: "3.30" },
        { label: "已获学分", value: "42" },
        { label: "未通过", value: "1 门" },
      ],
    };
  if (/考试/.test(message))
    return {
      ...base,
      kind: "exams",
      title: "考试安排",
      rows: [
        { label: "示例课程 A", value: "12月28日 · 09:00", meta: "示例教学楼 101" },
        { label: "示例课程 B", value: "12月30日 · 14:00", meta: "示例教学楼 202" },
      ],
    };
  if (/通知|公告/.test(message))
    return {
      ...base,
      kind: "news",
      title: "教务通知",
      badge: "1 条需要关注 · 虚构示例",
      rows: [{ label: "示例：选修课调整通知", value: "9月6日", meta: "需要关注" }],
    };
  return null;
}
interface DemoSession {
  id: string;
  title: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: DemoMessage[];
}

/* ── 「今日档案」演示数据：跟真实时钟走，但课程/考场全是虚构 ── */

const DEMO_PERIOD_TIMES: Record<string, string> = {
  "1": "08:10-08:55",
  "2": "09:05-09:50",
  "3": "10:20-11:05",
  "4": "11:15-12:00",
  "5": "14:00-14:45",
  "6": "14:55-15:40",
  "7": "16:00-16:45",
  "8": "16:55-17:40",
  "9": "19:00-19:45",
  "10": "19:55-20:40",
};

const DEMO_CLASS_TIMES: Record<string, string> = {
  "1-2节": "08:10-09:50",
  "3-4节": "10:20-12:00",
  "5-6节": "14:00-15:40",
  "7-8节": "16:00-17:40",
};

const pad = (n: number) => String(n).padStart(2, "0");

function demoTodayBrief(): TodayBrief {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const weekday = ((now.getDay() + 6) % 7) + 1; // 周一=1…周日=7
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (weekday - 1));
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayAt = (i: number) =>
    new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
  const names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const short = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

  // 周内课程表（weekday-1 为下标）：每天都排一两门，任意日子打开演示页
  // 今日时间线都有内容；周六是调休补课，演示调休覆盖
  const weekCourses: Array<
    Array<{ title: string; periods: string; location?: string; teacher?: string }>
  > = [
    [
      { title: "示例高等数学", periods: "1-2节", location: "示例教学楼 101", teacher: "王老师" },
      { title: "示例大学英语", periods: "3-4节", location: "示例教学楼 202", teacher: "李老师" },
    ],
    [{ title: "示例程序设计", periods: "3-4节", location: "示例机房", teacher: "陈老师" }],
    [{ title: "示例通识选修", periods: "7-8节", location: "示例教学楼 303" }],
    [{ title: "示例体育课", periods: "5-6节", location: "示例体育馆" }],
    [{ title: "示例大学英语（口语）", periods: "1-2节", location: "示例语音室" }],
    [{ title: "示例高等数学", periods: "1-2节", location: "示例教学楼 101", teacher: "王老师" }],
    [],
  ];

  const toBrief = (c: {
    title: string;
    periods: string;
    location?: string;
    teacher?: string;
  }): BriefCourse => {
    const time = DEMO_CLASS_TIMES[c.periods];
    const [sh, sm] = time.split("-")[0].split(":").map(Number);
    const [eh, em] = time.split("-")[1].split(":").map(Number);
    const status: BriefCourse["status"] =
      nowMin > eh * 60 + em ? "done" : nowMin >= sh * 60 + sm ? "current" : "upcoming";
    return {
      title: c.title,
      periods: c.periods,
      time,
      ...(c.location ? { location: c.location } : {}),
      ...(c.teacher ? { teacher: c.teacher } : {}),
      status,
    };
  };

  const todayCourses = weekCourses[weekday - 1].map(toBrief);

  // 下一节课：今天未开始的，否则往后找（跨到下周一只示例周一的课）。
  // 注意未来日期不能用「当前时刻算出的 status」过滤——晚上打开时那天
  // 的课会被误判成已结束；只有今天（look=0）才看状态
  let next: TodayBrief["next"] = null;
  for (let look = 0; look <= 7 && !next; look++) {
    const idx = (weekday - 1 + look) % 7;
    const list = look === 0 ? todayCourses : weekCourses[idx].map(toBrief);
    const date = dayAt(weekday - 1 + look);
    for (const c of list) {
      if (look === 0 && c.status !== "upcoming") continue;
      if (!c.time) continue;
      const [sh, sm] = c.time.split("-")[0].split(":").map(Number);
      const startsInMin = look * 1440 + sh * 60 + sm - nowMin;
      if (startsInMin <= 0) continue;
      next = {
        dateISO: iso(date),
        dateLabel:
          look === 0
            ? "今天"
            : look === 1
              ? "明天"
              : `${date.getMonth() + 1}月${date.getDate()}日 ${names[idx]}`,
        ...(idx === 5 ? { makeup: true } : {}),
        course: c,
        startsInMin,
      };
      break;
    }
  }

  const days: BriefDay[] = weekCourses.map((list, i) => {
    const date = dayAt(i);
    return {
      dateISO: iso(date),
      weekday: i + 1,
      label: names[i],
      dateShort: short(date),
      isToday: i === weekday - 1,
      ...(i === 5 ? { makeup: true } : {}),
      courses: list.map((c) => ({
        title: c.title,
        time: DEMO_CLASS_TIMES[c.periods],
        location: c.location,
        teacher: c.teacher,
        weeks: "1-16",
        pStart: Number(c.periods.match(/^\d+/)?.[0]),
        pEnd: Number(c.periods.match(/(\d+)节$/)?.[1]),
      })),
    };
  });

  const examDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 5);

  return {
    now: now.toISOString(),
    dateLabel: `${now.getMonth() + 1}月${now.getDate()}日 ${names[weekday - 1]}`,
    periodTimes: DEMO_PERIOD_TIMES,
    term: {
      label: "2026-2027学年第一学期（示例）",
      weekLabel: "第 2 周",
      week: 2,
      maxWeek: 16,
      weekSource: "known",
    },
    schedule: {
      available: true,
      cachedAt: Date.now() - 2 * 3600_000,
      stale: false,
      todaySpecial: null,
      courses: todayCourses,
      ...(todayCourses.length ? {} : { note: "今天没有课（虚构示例课表）" }),
    },
    next,
    week: { mondayISO: iso(monday), days },
    exams: {
      available: true,
      cachedAt: Date.now() - 6 * 3600_000,
      upcoming: [
        {
          subject: "示例课程 A",
          date: iso(examDate),
          time: "09:00-11:00",
          location: "示例教学楼 101",
          seatNumber: "12",
          inDays: 5,
          isToday: false,
        },
      ],
      note: "演示只展示一场虚构考试",
    },
  };
}

/** 固定剧本明确标注示例；不伪造工具调用、通知链接或已生成文件。 */
export function demoReply(message: string): string {
  const prefix = "> 离线演示：以下内容均为虚构示例，不代表你的个人数据或学校通知。\n\n";
  if (/日历|导出|ics/i.test(message))
    return (
      prefix +
      "正式模式下，可以说：**把本学期课表和考试导出为 .ics 文件**。生成后在对话中下载，再导入手机日历。\n\n导入是一次性快照，课表变更后需要重新导出。订阅需另行配置发布渠道，且当前订阅源公开可见。演示模式没有生成文件或发布链接。"
    );
  if (/通识|学分/.test(message))
    return (
      prefix +
      "### 通识修读检查示例\n\n| 类别 | 已通过学分 |\n|---|---:|\n| 人文类 | 2 |\n| 自然类 | 2 |\n| 公共艺术类 | 0 |\n\n公共艺术类尚未覆盖；未通过和待出分课程不会计入已获学分。**是否需要补修、最低学分是多少，要对照你所在年级和专业的培养方案。**"
    );
  if (/成绩|GPA|绩点|挂科|学业/i.test(message))
    return (
      prefix +
      "### 学业概览示例\n\n- 必修课 GPA：3.30（示例值，正式模式按查询成绩计算）\n- 已获学分：42\n- 未通过：示例课程 A，58 分\n- 待确认：示例课程 B，缓考\n\n待确认课程不会算成已通过。可以继续问：**通识学分还缺哪些？**\n\n以上汇总不代替教务系统成绩单或毕业审核。"
    );
  if (/通知|公告/.test(message))
    return (
      prefix +
      "### 通知阅读示例\n\n**示例：选修课调整通知（虚构）**\n\n- 适用对象：参加本轮选课的学生\n- 需要做什么：核对教学班、时间与学分归属\n- 截止时间：正式模式会读取原文后再填写\n\n正式使用时可以继续问“读第一条通知，整理需要我做的事”，并回到返回的原文链接核对。这里没有实时公告或真实截止日期。"
    );
  if (/考试/.test(message))
    return (
      prefix +
      "### 考试安排示例\n\n| 科目 | 日期 | 时间 | 考场 |\n|---|---|---|---|\n| 示例课程 A | 2026-12-28 | 09:00–11:00 | 示例教学楼 101 |\n| 示例课程 B | 2026-12-30 | 14:00–16:00 | 示例教学楼 202 |\n\n正式模式可以把考试导出到手机日历。考试安排变更时请核对教务系统。"
    );
  if (/课表|上课|这周|今天|明天/.test(message))
    return (
      prefix +
      "### 一周课表示例\n\n| 星期 | 节次 | 课程 | 地点 |\n|---|---|---|---|\n| 周一 | 1–2 | 示例高等数学 | 示例教学楼 101 |\n| 周三 | 3–4 | 示例大学英语 | 示例教学楼 202 |\n| 周五 | 7–8 | 示例程序设计 | 示例机房 |\n\n正式模式会根据教学周、单双周及已记录的调休安排查询你的课表。也可以问：**导出课表到手机日历**。"
    );
  return (
    prefix +
    "这个演示使用固定示例回答，不调用 AI。试试输入“这周课表”“我的成绩和 GPA”“通识学分还缺哪些”“最近的考试安排”“教务处最近有什么通知”或“导出课表到手机日历”。正式对话请运行 `npm start` 并配置自己的账号。"
  );
}

export function createDemoServer(): http.Server {
  const sessions = new Map<string, DemoSession>();
  const json = (res: http.ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  };
  return http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    try {
      if (req.method === "GET" && url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(chatPage({ demo: true }));
      } else if (req.method === "GET" && (url === "/today" || url === "/today/")) {
        // 独立日程页的演示版：数据内嵌虚构课表，不发任何请求
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(todayPage({ demo: true, demoData: demoTodayBrief() }));
      } else if (
        req.method === "GET" &&
        ["/logo.png", "/favicon.ico", "/vendor/marked.min.js"].includes(url)
      ) {
        const script = url.endsWith(".js");
        const asset = new URL(
          script
            ? "../../node_modules/marked/lib/marked.umd.js"
            : "../../docs/courseraptor-logo.png",
          import.meta.url,
        );
        const bytes = readFileSync(asset);
        res.writeHead(200, {
          "content-type": script ? "text/javascript; charset=utf-8" : "image/png",
        });
        res.end(bytes);
      } else if (req.method === "GET" && url === "/api/settings") {
        json(res, {
          jwgl: { configured: false, username: "", sourceLabel: "演示模式" },
          deepseek: { configured: false, masked: "", sourceLabel: "演示模式" },
          model: "离线固定回答",
          models: [],
        });
      } else if (req.method === "GET" && url.startsWith("/api/models")) {
        json(res, {
          ok: false,
          current: "离线固定回答",
          source: "fallback",
          options: [],
          message: "演示模式不联网，无可选型号",
        });
      } else if (req.method === "GET" && url === "/api/reminders") {
        json(res, { reminders: [] });
      } else if (req.method === "GET" && url === "/api/data") {
        const sessionValues = [...sessions.values()];
        json(res, {
          sessions: {
            count: sessionValues.length,
            messages: sessionValues.reduce((count, session) => count + session.messages.length, 0),
          },
          attachments: { count: 0, bytes: 0 },
          uploads: { count: 0, bytes: 0 },
          generated: { count: 0, bytes: 0 },
          reminders: { total: 0, open: 0 },
          snapshots: 0,
        });
      } else if (
        ["/api/settings", "/api/diagnostics", "/api/reminders", "/api/data/clear"].includes(url)
      ) {
        json(res, { error: "演示模式只展示界面，不保存个人配置或数据" }, 403);
      } else if (req.method === "GET" && url === "/api/sessions") {
        json(res, {
          sessions: [...sessions.values()]
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
            .map(({ messages, ...s }) => ({ ...s, count: messages.length })),
        });
      } else if (url.startsWith("/api/sessions/")) {
        const id = url.slice("/api/sessions/".length);
        if (req.method === "GET" && sessions.has(id)) json(res, sessions.get(id));
        else if (req.method === "PATCH" && sessions.has(id)) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          const session = sessions.get(id)!;
          if (typeof body.title === "string" && body.title.trim())
            session.title = body.title.trim().slice(0, 60);
          if (typeof body.pinned === "boolean") session.pinned = body.pinned;
          json(res, { ok: true, session });
        } else if (req.method === "DELETE" && sessions.delete(id)) json(res, { ok: true });
        else json(res, { error: "会话不存在" }, 404);
      } else if (req.method === "POST" && url === "/api/chat") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16_384) {
            json(res, { error: "演示问题过长，请使用简短提问" }, 413);
            return;
          }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        > | null;
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) {
          json(res, { error: "消息为空" }, 400);
          return;
        }
        const id =
          typeof body?.sessionId === "string" && /^[\w-]{1,64}$/.test(body.sessionId)
            ? body.sessionId
            : "default";
        const now = Date.now();
        const session = sessions.get(id) ?? {
          id,
          title: message.slice(0, 30),
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        const reply = demoReply(message);
        const card = demoCard(message);
        session.messages.push(
          { role: "user", text: message, ts: now },
          { role: "assistant", text: reply, ts: now, ...(card ? { artifacts: [card] } : {}) },
        );
        session.messages = session.messages.slice(-40);
        session.updatedAt = now;
        sessions.set(id, session);
        if (sessions.size > 30) sessions.delete(sessions.keys().next().value!);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        res.end(
          `data: ${JSON.stringify({ t: "text", v: reply })}\n\n${card ? `data: ${JSON.stringify({ t: "card", card })}\n\n` : ""}data: ${JSON.stringify({ t: "end", sid: id })}\n\n`,
        );
      } else json(res, { error: "演示模式不支持此操作" }, 404);
    } catch (error) {
      json(
        res,
        { error: error instanceof SyntaxError ? "请求体需要是 JSON" : "演示请求失败，请重试" },
        error instanceof SyntaxError ? 400 : 500,
      );
    }
  });
}
