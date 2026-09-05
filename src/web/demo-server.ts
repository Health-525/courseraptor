/** 独立演示服务：不导入 config/agent，不读取凭证、真实会话或教务数据。 */
import { readFileSync } from "node:fs";
import http from "node:http";
import { chatPage } from "./chat-page";

interface DemoMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}
interface DemoSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: DemoMessage[];
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
      } else if (url === "/api/settings") {
        json(res, { error: "演示模式无需配置，也不会保存账号或 API Key" }, 403);
      } else if (req.method === "GET" && url === "/api/sessions") {
        json(res, {
          sessions: [...sessions.values()]
            .reverse()
            .map(({ messages, ...s }) => ({ ...s, count: messages.length })),
        });
      } else if (url.startsWith("/api/sessions/")) {
        const id = url.slice("/api/sessions/".length);
        if (req.method === "GET" && sessions.has(id)) json(res, sessions.get(id));
        else if (req.method === "DELETE" && sessions.delete(id)) json(res, { ok: true });
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
        session.messages.push(
          { role: "user", text: message, ts: now },
          { role: "assistant", text: reply, ts: now },
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
          `data: ${JSON.stringify({ t: "text", v: reply })}\n\ndata: ${JSON.stringify({ t: "end", sid: id })}\n\n`,
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
