/**
 * 独立演示服务：不导入 config/agent，不读取凭证、真实会话或教务数据。
 * 虚构数据统一来自 ./data；传入 liveAgent（entry --live 时构建的真实模型
 * agent）后 /api/chat 走真实模型分析，否则维持离线固定剧本。
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import type { ModelMessage } from "ai";
import { chatPage } from "../channels/web/chat-page";
import { knowledgePage } from "../channels/web/knowledge-page";
import { DEFAULT_QUESTIONS } from "../channels/web/quick-questions";
import { schedulePage } from "../channels/web/schedule-page";
import { todayPage } from "../channels/web/today-page";
import { todosPage } from "../channels/web/todos-page";
import { type DemoStreamAgent, runDemoLiveTurn } from "./agent";
import { demoKnowledge, demoTodayBrief } from "./data";

interface DemoMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

interface DemoSession {
  id: string;
  title: string;
  pinned?: boolean;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: DemoMessage[];
}

const LIVE_DISCLAIMER = "> 演示模式：以下回答由 AI 实时生成，数据均为虚构示例。\n\n";

/* ── 模拟 Agent 过程：思考一段 + 若干工具调用（名称与正式工具一致，参数与结果均为示例）── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DemoToolCall {
  name: string;
  brief: string;
  out: string;
}

interface DemoScript {
  think: string;
  tools: DemoToolCall[];
}

/** 按问题类型给出与正式 Agent 同形的剧本；未知问题不带工具，只回固定文案 */
function demoScript(message: string): DemoScript | null {
  if (/今天.*(安排|怎么样)|今日日程|今天有什么/.test(message))
    return {
      think: "用户问今天的安排。先取当前日期和教学周，再查今日课表和待办，最后综合成一份简报。",
      tools: [
        {
          name: "get_time",
          brief: "2026-09-23 周三 · 第 2 周（示例）",
          out: '{ "date": "2026-09-23", "weekday": 3, "week": 2 }',
        },
        {
          name: "get_schedule",
          brief: "今天 3 节课（示例）",
          out: '{ "courses": [ "示例高等数学", "示例大学英语", "示例程序设计" ] }',
        },
        {
          name: "manage_todos",
          brief: "3 条未完成，其中 1 条已逾期（示例）",
          out: '{ "open": 3, "overdue": 1 }',
        },
      ],
    };
  if (/日历|导出|ics/i.test(message))
    return {
      think: "导出日历前需要课表与考试数据，先查课表。",
      tools: [
        { name: "get_schedule", brief: "本学期课表已缓存（示例）", out: '{ "cached": true }' },
      ],
    };
  if (/通识|学分/.test(message))
    return {
      think: "通识修读情况要从成绩里按类别汇总。",
      tools: [
        {
          name: "get_grades",
          brief: "已按通识类别汇总（示例）",
          out: '{ "人文类": 2, "自然类": 2 }',
        },
      ],
    };
  if (/成绩|GPA|绩点|挂科|学业/i.test(message))
    return {
      think: "查全量成绩，再计算必修 GPA、已获学分与未通过清单。",
      tools: [
        {
          name: "get_grades",
          brief: "GPA 3.30 · 已获 42 学分（示例）",
          out: '{ "gpa": 3.3, "credits": 42 }',
        },
      ],
    };
  if (/通知|公告/.test(message))
    return {
      think: "拉取教务处通知列表，按年级标注相关度。",
      tools: [{ name: "get_news", brief: "3 条通知（示例）", out: '{ "count": 3 }' }],
    };
  if (/考试/.test(message))
    return {
      think: "读考试安排缓存，筛选近期场次。",
      tools: [{ name: "get_exams", brief: "2 场考试（示例）", out: '{ "count": 2 }' }],
    };
  if (/待办/.test(message))
    return {
      think: "读本地待办清单，按截止时间排序。",
      tools: [{ name: "manage_todos", brief: "3 条未完成（示例）", out: '{ "open": 3 }' }],
    };
  if (/知识|记住|笔记/.test(message))
    return {
      think: "在本地知识库里检索相关条目。",
      tools: [{ name: "manage_knowledge", brief: "命中 5 条（示例）", out: '{ "hits": 5 }' }],
    };
  if (/课表|上课|这周|今天|明天/.test(message))
    return {
      think: "查本学期课表，结合教学周与调休安排按星期整理。",
      tools: [
        {
          name: "get_schedule",
          brief: "本周 10 门次课，周六调休补课（示例）",
          out: '{ "week": 2, "days": 6 }',
        },
      ],
    };
  return null;
}

/** 固定剧本明确标注示例；思考与工具调用为同形模拟（见 demoScript），不伪造通知链接或已生成文件。 */
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
  if (/待办/.test(message))
    return (
      prefix +
      "### 待办功能示例\n\n正式模式直接说出你的安排即可，例如：**我这周要交高数作业，周五交实验报告**。我会先调时间工具把「明天/下周五」换算成具体日期，再把待办存到本地。\n\n待办会显示在独立的待办页（/todos）和对话页「设置 → 截止日期待办」里，可勾选完成或删除。演示模式的 /todos 页展示的是虚构待办。"
    );
  if (/知识|记住|笔记/.test(message))
    return (
      prefix +
      "### 知识库功能示例\n\n正式模式里可以把我当笔记本：**「记住：洛必达法则用来求 0/0 型极限」**。我会判断这是值得沉淀的知识并存入本地知识库；能对应上课表里的课程会自动归类（如归入「高等数学」），对不上课程的会按 subject 建自定义分类（如「编程技术」），完全无归属才留在「未分类」。\n\n知识集中在独立的知识库页（/knowledge），可按分类筛选、搜索、删除。演示模式展示的是虚构知识。"
    );
  if (/今天.*(安排|怎么样)|今日日程|今天有什么/.test(message))
    return (
      prefix +
      "### 今日简报示例（日程 + 待办结合分析）\n\n**今天（示例）3 节课：**\n- 08:10 示例高等数学 @示例教学楼 101\n- 10:20 示例大学英语 @示例教学楼 202\n- 14:00 示例程序设计 @示例机房，15:40 下课\n\n**结合你的待办：**\n- ⏰ 复习示例高等数学第 3 章今晚 22:00 截止——14:00 那节下课后到晚饭前是整块时间，建议先做\n- ⚠️ 交示例实验报告已逾期（昨天 23:59），尽快补上\n- 📌 示例英语 quiz 还有 4 天，周末集中准备即可\n\n今天课到 15:40 就结束，晚上没有安排；要的话我现在给你开一个 90 分钟番茄钟。\n\n正式模式下我会先查时间、课表和你的真实待办再给这份分析。"
    );
  if (/课表|上课|这周|今天|明天/.test(message))
    return (
      prefix +
      "### 一周课表示例\n\n| 星期 | 节次 | 课程 | 地点 |\n|---|---|---|---|\n| 周一 | 1–2 | 示例高等数学 | 示例教学楼 101 |\n| 周一 | 3–4 | 示例大学英语 | 示例教学楼 202 |\n| 周二 | 3–4 | 示例程序设计 | 示例机房 |\n| 周三 | 1–2 / 3–4 / 5–6 | 示例高等数学 / 示例大学英语 / 示例程序设计 | 见今日简报 |\n| 周四 | 5–6 | 示例体育课 | 示例体育馆 |\n| 周五 | 1–2 | 示例大学英语（口语） | 示例语音室 |\n| 周六 | 1–2 | 示例高等数学（调休补课） | 示例教学楼 101 |\n\n正式模式会根据教学周、单双周及已记录的调休安排查询你的课表。也可以问：**导出课表到手机日历**。"
    );
  return (
    prefix +
    "这个演示使用固定示例回答，不调用 AI。试试输入“这周课表”“我的成绩和 GPA”“通识学分还缺哪些”“最近的考试安排”“我有哪些待办”“教务处最近有什么通知”或“导出课表到手机日历”。正式对话请运行 `npm start` 并配置自己的账号。"
  );
}

export function createDemoServer(options?: { liveAgent?: DemoStreamAgent | null }): http.Server {
  const liveAgent = options?.liveAgent ?? null;
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
      } else if (req.method === "GET" && (url === "/schedule" || url === "/schedule/")) {
        // 独立课表页的演示版：数据内嵌虚构课表，不发任何请求
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(schedulePage({ demo: true, demoData: demoTodayBrief() }));
      } else if (req.method === "GET" && (url === "/todos" || url === "/todos/")) {
        // 独立待办页的演示版：数据内嵌虚构待办，不发任何请求
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(todosPage({ demo: true, demoData: demoTodayBrief() }));
      } else if (req.method === "GET" && (url === "/knowledge" || url === "/knowledge/")) {
        // 独立知识库页的演示版：数据内嵌虚构知识，不发任何请求
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(knowledgePage({ demo: true, demoData: demoKnowledge(new Date()) }));
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
          qq: { configured: false, passcodeSet: false, source: "unset", sourceLabel: "演示模式" },
          model: liveAgent ? "DeepSeek 实时生成（虚构数据演示）" : "离线固定回答",
          models: [],
          quickQuestions: DEFAULT_QUESTIONS,
        });
      } else if (req.method === "GET" && url.startsWith("/api/models")) {
        json(res, {
          ok: false,
          current: liveAgent ? "DeepSeek 实时生成（虚构数据演示）" : "离线固定回答",
          source: "fallback",
          options: [],
          message: liveAgent ? "演示模式固定使用启动时指定的模型" : "演示模式不联网，无可选型号",
        });
      } else if (req.method === "GET" && url === "/api/reminders") {
        json(res, { reminders: [] });
      } else if (req.method === "GET" && url === "/api/today") {
        // 功能大厅的今日日程/课表/考试/待办/知识面板都吃这份简报（与 /today 页同源）
        json(res, demoTodayBrief());
      } else if (req.method === "GET" && url === "/api/data") {
        const sessionValues = [...sessions.values()];
        const demoEntries = demoKnowledge(new Date());
        json(res, {
          sessions: {
            count: sessionValues.length,
            messages: sessionValues.reduce((count, session) => count + session.messages.length, 0),
          },
          attachments: { count: 0, bytes: 0 },
          uploads: { count: 0, bytes: 0 },
          generated: { count: 0, bytes: 0 },
          reminders: { total: 0, open: 0 },
          knowledge: {
            total: demoEntries.length,
            categorized: demoEntries.filter((e) => e.category).length,
            courses: new Set(demoEntries.filter((e) => e.category).map((e) => e.category)).size,
          },
        });
      } else if (
        ["/api/settings", "/api/diagnostics", "/api/reminders", "/api/data/clear"].includes(url)
      ) {
        json(res, { error: "演示模式只展示界面，不保存个人配置或数据" }, 403);
      } else if (req.method === "GET" && url === "/api/sessions") {
        json(res, {
          sessions: [...sessions.values()]
            .sort(
              (a, b) =>
                Number(!!a.archived) - Number(!!b.archived) ||
                Number(!!b.pinned) - Number(!!a.pinned) ||
                b.updatedAt - a.updatedAt,
            )
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
          if (typeof body.archived === "boolean") session.archived = body.archived;
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
          chunks.push(Buffer.from(chunk));
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

        if (liveAgent) {
          // live 模式：真实模型分析（工具数据仍是虚构示例）。先发虚构数据声明
          // 保持口径可见，再流式输出模型回答；整轮完成后写回内存会话
          const t0 = Date.now();
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
          });
          const send = (payload: Record<string, unknown>) => {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          };
          const abort = new AbortController();
          let closed = false;
          res.on("close", () => {
            closed = true;
            abort.abort();
          });
          send({ t: "text", v: LIVE_DISCLAIMER });
          const history: ModelMessage[] = session.messages
            .slice(-40)
            .map((m) =>
              m.role === "user"
                ? { role: "user" as const, content: m.text }
                : { role: "assistant" as const, content: m.text },
            );
          const { text, failure } = await runDemoLiveTurn({
            agent: liveAgent,
            history,
            message,
            send,
            signal: abort.signal,
          });
          if (failure)
            send({
              t: "err",
              v: `模型调用失败：${failure}。请检查网络与 DEEPSEEK_API_KEY，或去掉 --live 用离线剧本演示。`,
            });
          send({ t: "end", dur: Date.now() - t0, sid: id });
          res.end();
          // 中断或纯报错的半截轮次不进历史（与正式模式一致）
          if (!closed && text.trim()) {
            session.messages.push(
              { role: "user", text: message, ts: now },
              { role: "assistant", text: LIVE_DISCLAIMER + text, ts: Date.now() },
            );
            session.messages = session.messages.slice(-40);
            session.updatedAt = Date.now();
            sessions.set(id, session);
            if (sessions.size > 30) sessions.delete(sessions.keys().next().value!);
          }
          return;
        }

        const reply = demoReply(message);
        session.messages.push(
          { role: "user", text: message, ts: now },
          { role: "assistant", text: reply, ts: now },
        );
        session.messages = session.messages.slice(-40);
        session.updatedAt = now;
        sessions.set(id, session);
        if (sessions.size > 30) sessions.delete(sessions.keys().next().value!);

        // 与正式 /api/chat 同形的 SSE 事件流：思考一段 → 工具卡（示例数据）→ 正文分段
        const script = demoScript(message);
        const t0 = Date.now();
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        const send = (payload: Record<string, unknown>) => {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        if (script) {
          await sleep(300);
          send({ t: "think", v: script.think });
          await sleep(450);
          send({ t: "think", phase: "end" });
          await sleep(200);
          for (const tool of script.tools) {
            const toolId = `demo-${tool.name}-${Math.random().toString(36).slice(2, 8)}`;
            send({ t: "tool", phase: "start", id: toolId, name: tool.name, args: "{}" });
            await sleep(420);
            send({
              t: "tool",
              phase: "end",
              id: toolId,
              name: tool.name,
              dur: 380 + Math.floor(Math.random() * 120),
              brief: tool.brief,
              out: tool.out,
            });
            await sleep(160);
          }
        }
        // 正文按行流出，营造打字机节奏；前端逐段渲染 markdown
        const lines = reply.split("\n");
        for (const line of lines) {
          send({ t: "text", v: `${line}\n` });
          await sleep(70);
        }
        send({ t: "end", dur: Date.now() - t0, sid: id });
        res.end();
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
