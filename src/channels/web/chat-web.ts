/**
 * 网页对话窗口 — 浏览器里直接和 Agent 聊
 *
 * 终端 TUI 之外的第二对话入口：随主程序自动启动，地址显示在欢迎卡片
 * 下方，浏览器打开即聊。单页零依赖（Node 内置 http + 原生前端），
 * 只绑 127.0.0.1 不暴露局域网，端口默认 3210（RAPTOR_WEB_PORT 可改）。
 *
 * 界面是「红头档案」编辑部风：暖纸底 + 墨色字 + 单一朱砂红，楷体报头、
 * 等宽小字数据行、圆形印章徽章。设计令牌在 chat-page.ts 的 CSS :root。
 *
 * 协议：POST /api/chat 用 SSE 流式回传（text=文本增量 / think=思考过程增量
 * 与段末标记 / tool=工具卡片 / err=错误 / end=结束并携带 sid），与行内 TUI
 * 消费的是同一个 agent.fullStream。
 * 多会话历史由 chat-sessions.ts 落盘（data/chat-sessions.json），重启不丢；
 * 每轮把该会话最后 40 条转成 ModelMessage 传给 agent，多轮上下文完整。
 *
 * 本机防线（防「恶意网页借用户浏览器之手」的 CSRF/DNS rebinding）：
 * 1) Host 必须是本机地址——挡域名解析到 127.0.0.1 冒充同源；
 * 2) 带 Origin 的请求必须是本服务自己——挡跨站 fetch（text/plain 等
 *    「简单请求」不经预检直达，浏览器只拦读不拦发）；
 * 3) 写请求必须带 CSRF token——token 只嵌在本服务渲染的页面 meta 里，
 *    外站跨域读不到，伪造不出合法写请求（jsonBody 另拒非 JSON 类型）。
 *
 * 按职责域拆分：本文件保留启动/生命周期与 handle() 路由器本体；防线与
 * 响应基建在 web-http.ts，静态资产在 web-static.ts，成品文件在 web-files.ts，
 * agent 注入在 web-agent-gate.ts，通知视图在 web-news.ts，SSE 对话流在
 * chat-stream.ts，工具事件加工件在 web-tool-events.ts，设置域在 web-settings.ts。
 */

import http from "node:http";
import { clearAttachments } from "../../core/attachment-store";
import { openLocalFile } from "../../core/attachments";
import { loadLogoDataUri } from "../../core/brand";
import {
  deleteSession,
  getSession,
  listSessions,
  readSessions,
  resetAll,
  updateSession,
} from "../../core/chat-sessions";
import { config } from "../../core/config";
import { loadGradesCache } from "../../core/grades-cache";
import {
  addKnowledge,
  clearKnowledge,
  deleteKnowledge,
  listKnowledge,
  updateKnowledge,
} from "../../core/knowledge";
import { localApiToken } from "../../core/local-api";
import { recordManualTermStart } from "../../core/manual-terms";
import { listModelOptions } from "../../core/models";
import { activePomodoro, cancelPomodoro, listPomodoros, toView } from "../../core/pomodoro";
import { getProviderDef, providerBaseUrl, resolveProviderId } from "../../core/providers";
import { loadScheduleCache, saveScheduleCache } from "../../core/schedule-cache";
import {
  hasScheduleParser,
  type ImportQA,
  installDefaultScheduleParser,
  parseScheduleImport,
  sanitizeCourses,
} from "../../core/schedule-import";
import { scheduleSvgToPng } from "../../core/schedule-png";
import { renderScheduleImage } from "../../core/schedule-svg";
import { school } from "../../core/school";
import { tokenUsageSnapshot } from "../../core/token-usage";
import {
  addReminder,
  clearReminders,
  clearUploads,
  deleteReminder,
  deleteUpload,
  getUploads,
  listReminders,
  MAX_UPLOAD_BYTES,
  reminderIcs,
  saveUpload,
  updateReminder,
} from "../../core/workspace-data";
import { appJsAsset } from "./app-asset";
import { chatPage } from "./chat-page";
import {
  decodeSessionSegment,
  handleChat,
  importTextOf,
  jsonBody,
  SESSION_ID_RE,
  SESSIONS_PREFIX,
} from "./chat-stream";
import { knowledgePage } from "./knowledge-page";
import { schedulePage } from "./schedule-page";
import { buildTodayBrief } from "./today-brief";
import { todayPage } from "./today-page";
import { todosPage } from "./todos-page";
import { enqueueAgentRefresh } from "./web-agent-gate";
import { fileNotFound, serveGeneratedFile } from "./web-files";
import {
  applyObsidianCors,
  getListenPort,
  json,
  requestForbidden,
  setListenPort,
  withCsrf,
} from "./web-http";
import { scoredNewsSnapshot } from "./web-news";
import {
  applySettings,
  clearGenerated,
  dataPayload,
  providerKeyPreview,
  runDiagnostic,
  settingsPayload,
} from "./web-settings";
import { LOGO_PNG, loadStaticOnce, MARKED_UMD, WEB_MANIFEST } from "./web-static";

// ── 会话自动命名：协调器在 src/session-titles.ts（QQ 桥也走同一套）。
// setTitleMaker 原地转出口：index.ts 与测试的旧装配入口不变。
export { setTitleMaker } from "../../core/session-titles";

// agent 注入口的装配面也留在本文件：实现拆到 web-agent-gate.ts，入口不变。
export { type ChatStreamableAgent, setChatAgent, setChatAgentRefresher } from "./web-agent-gate";

let runningUrl: string | null = null;
let starting: Promise<string | null> | null = null;

/** 已在跑就直接返回地址（TUI 卡片/行内模式来回切也不会重复起服务） */
export function getWebUrl(): string | null {
  return runningUrl;
}

/** 启动网页服务；失败返回 null 不抛错（网页挂了不影响终端对话） */
export function startChatWeb(): Promise<string | null> {
  // index.ts 与欢迎面板可能并发调用：必须共享同一个进行中的 Promise，
  // 否则两边各自 listen，首选端口冲突后会同时退到随机端口起两个服务
  if (runningUrl) return Promise.resolve(runningUrl);
  starting ??= doStart();
  return starting;
}

async function doStart(): Promise<string | null> {
  const preferred = Number(process.env.RAPTOR_WEB_PORT) || 3210;
  for (const port of [preferred, 0]) {
    // 第二轮 port=0：让系统挑一个空闲端口，首选端口被占也能起
    const url = await listen(port).catch(() => null);
    if (url) {
      runningUrl = url;
      return url;
    }
  }
  return null;
}

// ── QQ 凭证保存后的桥热启动 ─────────────────────────────────

/** 返回追加到保存结果里的说明文案；测试可注入替身避免真实连 QQ */
export type QQBridgeLauncher = () => Promise<string>;

let qqBridgeLauncher: QQBridgeLauncher | null = null;

/** 测试注入用：替换默认的桥热启动实现 */
export function setQQBridgeLauncher(fn: QQBridgeLauncher | null): void {
  qqBridgeLauncher = fn;
}

/** 桥的启动实现是宿主（local/cli）的职责——web 不 import local/（分层红线）。
 * 宿主未注入（测试/裸起 web）时如实返回空串，保存结果里不追加桥文案 */
async function maybeStartQQBridge(): Promise<string> {
  return qqBridgeLauncher ? qqBridgeLauncher() : "";
}

function listen(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Obsidian 插件的 CORS 与预检最先处理：预检不该被三道门里的任何
      // 一道拦下（预检不带令牌），真实请求过这道后照常走三道门
      if (applyObsidianCors(req, res)) return;
      if (requestForbidden(req, res)) return;
      // 处理器的意外异常在这里兜底回 500：放任成未处理 rejection 会把
      // 整个进程带崩（Node 24 默认 unhandledRejection = 退出），
      // 一个畸形请求不该杀掉对话服务和终端 UI
      handle(req, res).catch((e) => {
        try {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "服务器内部错误" }));
          } else if (!res.writableEnded) {
            res.end();
          }
        } catch {
          /* socket 已断开：无从响应 */
        }
        console.error(
          `[chat-web] 请求处理异常 ${req.method} ${req.url}：${e instanceof Error ? e.message : String(e)}`,
        );
      });
    });
    // unref：不让网页服务拖住进程退出——终端 UI 退出时主程序该走就走
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        setListenPort(addr.port);
        resolve(`http://localhost:${addr.port}`);
      } else {
        reject(new Error("server address unavailable"));
      }
    });
  });
}

/**
 * 页面模板缓存：正式服务渲染的三个页面都是纯模板（动态数据全走 /api/*，
 * CSRF 由 withCsrf 每次后注入），首次拼接后缓存字符串。chatPage() 单次
 * 拼接即 16 万字节级，每请求重来一遍纯属浪费。要往页面注入动态真值时，
 * 改这里换成「以真值为键」的缓存。
 */
let chatPageHtml: string | null = null;
let todayPageHtml: string | null = null;
let knowledgePageHtml: string | null = null;
let schedulePageHtml: string | null = null;
let todosPageHtml: string | null = null;

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "";
  if (req.method === "GET") {
    if (url.startsWith("/files/")) {
      await serveGeneratedFile(url.slice("/files/".length), res);
      return;
    }
    // 前端应用脚本：assets/chat-app.js 独立伺服（不再内联进页面模板）。
    // no-cache 而非长缓存：开发期改前端必须立刻生效，localhost 全量拉取无感
    if (url === "/app.js") {
      const buf = appJsAsset();
      if (buf) {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-cache",
        });
        res.end(buf);
      } else {
        res.writeHead(404);
        res.end('console.error("前端脚本缺失：src/channels/web/assets/chat-app.js 不可读");');
      }
      return;
    }
    if (url === "/vendor/marked.min.js") {
      const buf = loadStaticOnce(MARKED_UMD);
      if (buf) {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=86400",
        });
        res.end(buf);
      } else {
        res.writeHead(404);
        res.end("// marked 不可用，页面会退回纯文本渲染");
      }
      return;
    }
    if (url === "/logo.png" || url === "/favicon.ico") {
      const buf = loadStaticOnce(LOGO_PNG);
      if (buf) {
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
        });
        res.end(buf);
      } else {
        // 图没了也只是没图标，不能连累页面
        res.writeHead(404);
        res.end();
      }
      return;
    }
    // PWA 清单（iOS 添加到主屏幕 / Android 安装到桌面）；图标复用 logo
    if (url === "/manifest.webmanifest") {
      res.writeHead(200, {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "public, max-age=86400",
      });
      res.end(WEB_MANIFEST);
      return;
    }
    if (url === "/today" || url === "/today/") {
      // 独立日程页：今日头条/今日速览/临近考试，纯本地缓存渲染
      todayPageHtml ??= todayPage();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(withCsrf(todayPageHtml));
      return;
    }
    if (url === "/schedule" || url === "/schedule/") {
      // 独立课表页：教学周导航 + 周课表网格，纯本地缓存渲染
      schedulePageHtml ??= schedulePage();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(withCsrf(schedulePageHtml));
      return;
    }
    if (url === "/todos" || url === "/todos/") {
      // 独立待办页：分组清单与勾选/删除，纯本地存储渲染
      todosPageHtml ??= todosPage();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(withCsrf(todosPageHtml));
      return;
    }
    if (url === "/knowledge" || url === "/knowledge/") {
      // 独立知识库页：对话中沉淀的知识条目，纯本地存储渲染
      knowledgePageHtml ??= knowledgePage();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(withCsrf(knowledgePageHtml));
      return;
    }
    if (url === "/api/knowledge") {
      json(res, { entries: listKnowledge() });
      return;
    }
    // 功能大厅「用量统计」面板：只读 token-usage 记账（快照前先冲刷 pending）
    if (url === "/api/usage") {
      json(res, await tokenUsageSnapshot());
      return;
    }
    if (url === "/api/grades") {
      // 成绩面板走纯缓存（get_grades 查通一次即落盘），这里绝不登录教务
      json(res, loadGradesCache() ?? { savedAt: null });
      return;
    }
    if (url === "/api/news") {
      // 自定义学校没有教务处官网可抓：如实给「未适配」态，前端换引导文案
      if (!school().notices) {
        json(res, { items: [], unsupported: true });
        return;
      }
      // 教务处官网公开页，无需登录；TTL 缓存在适配器 fetchNewsMemo，失败如实降级
      try {
        const snapshot = await scoredNewsSnapshot();
        json(res, {
          items: snapshot.items,
          gradeBasis: snapshot.gradeBasis ?? undefined,
          fetchedAt: snapshot.fetchedAt,
          staleAt: snapshot.staleAt,
        });
      } catch (e) {
        json(res, { items: [], error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (url === "/api/today" || url.startsWith("/api/today?")) {
      // 只读本地缓存（课表/考试/假期/学期日期），不登录教务、不调模型
      const week = Number(new URL(url, "http://127.0.0.1").searchParams.get("week"));
      json(res, buildTodayBrief(undefined, Number.isInteger(week) ? week : undefined));
      return;
    }
    if (url === "/api/schedule/image" || url.startsWith("/api/schedule/image?")) {
      // 课表图片直链（/schedule 页按钮）：只读本地缓存渲染，零登录零模型，
      // 与对话工具 export_schedule_image 同一渲染器。默认 PNG 红头档案风
      // （CourseRaptor 招牌视觉），style=color 可换彩色课格。
      // 默认 inline——浏览器/手机直接看图（长按或右键另存），?download=1 才强制下载
      const params = new URL(url, "http://127.0.0.1").searchParams;
      const mode = params.get("mode") === "week" ? "week" : "term";
      const format = params.get("format") === "svg" ? "svg" : "png";
      const style = params.get("style") === "color" ? "color" : "classic";
      const weekParam = Number(params.get("week"));
      const cached = loadScheduleCache();
      if (!cached) {
        json(res, { error: "还没有课表缓存：在对话页查询一次课表后再导出" });
        return;
      }
      const schedule = cached.schedule;
      const semPart = `${schedule.year}-${schedule.semester === 3 ? 1 : 2}`;
      const logo = loadLogoDataUri() ?? undefined;
      // 越界 week 传 null：静默回落到当前教学周（网页直链的既有语义，
      // 不因参数写错就报错——错参数不该让人白等一个错误页）
      const out = renderScheduleImage({
        courses: schedule.courses,
        termLabel: schedule.label,
        year: schedule.year,
        semester: schedule.semester,
        mode,
        week: mode === "week" && Number.isInteger(weekParam) && weekParam >= 1 ? weekParam : null,
        style,
        ...(logo ? { logoDataUri: logo } : {}),
      });
      if (!out.ok) {
        json(res, {
          error:
            out.reason === "out-of-term"
              ? `当前不在教学周内，请指定周次（week=1-${out.maxWeek}）`
              : `周次越界：1-${out.maxWeek}`,
        });
        return;
      }
      const svg = out.result.svg;
      const svgWidth = out.result.width;
      const filename =
        out.week != null ? `schedule-week${out.week}-${semPart}` : `schedule-term-${semPart}`;
      if (format === "png") {
        // 2 倍宽出图：手机放大看笔画不发虚
        const png = scheduleSvgToPng(svg, svgWidth * 2);
        res.writeHead(200, {
          "content-type": "image/png",
          "content-disposition": `${params.get("download") === "1" ? "attachment" : "inline"}; filename="${filename}.png"`,
          "cache-control": "no-store",
        });
        res.end(png);
      } else {
        res.writeHead(200, {
          "content-type": "image/svg+xml; charset=utf-8",
          "content-disposition": `${params.get("download") === "1" ? "attachment" : "inline"}; filename="${filename}.svg"`,
          "cache-control": "no-store",
        });
        res.end(svg);
      }
      return;
    }
    if (url === "/api/sessions") {
      json(res, { sessions: listSessions() });
      return;
    }
    if (url === "/api/localapi") {
      // 本地 API 令牌 + 实际端口：设置页「Obsidian 插件」栏目与插件连接
      // 检测用。本机限定 + 浏览器同源策略挡外站读响应，与本机其他数据一致
      json(res, { token: localApiToken(), port: getListenPort() });
      return;
    }
    if (url === "/api/settings") {
      json(res, settingsPayload());
      return;
    }
    if (url === "/api/models" || url.startsWith("/api/models?")) {
      // 弹窗打开后异步刷新：清单以该 Key 实际可用的型号为准。
      // ?provider= 支持切换前的预览（前端选中即拉）；custom= 传自填端点。
      const query = new URL(url, "http://127.0.0.1").searchParams;
      const force = query.get("refresh") === "1";
      const previewProvider = query.get("provider");
      const previewCustom = query.get("custom") ?? undefined;
      if (previewProvider) {
        // 预览别吃缓存也别写缓存：listModelOptions 缓存按 provider 分桶，
        // 这里用一次性入参直查（结果不落 cache，避免污染已保存供应商的缓存）
        const providerId = resolveProviderId(previewProvider);
        const def = getProviderDef(providerId);
        const base = providerBaseUrl(
          providerId,
          previewCustom ?? (providerId === config.providerId ? config.customBaseUrl : ""),
        );
        const list = await listModelOptions({
          providerId,
          baseUrl: base,
          customBaseUrl: base,
          apiKey:
            providerId === config.providerId
              ? config.deepseekApiKey
              : providerKeyPreview(providerId),
          force,
          noCache: true,
        });
        json(res, {
          ok: list.source === "live",
          current: providerId === config.providerId ? config.model : "",
          source: list.source,
          provider: providerId,
          label: def.label,
          options: list.options,
          message: list.message ?? "",
        });
        return;
      }
      const list = await listModelOptions({
        providerId: config.providerId,
        baseUrl: config.providerBaseUrl,
        customBaseUrl: config.customBaseUrl,
        apiKey: config.deepseekApiKey,
        force,
      });
      json(res, {
        ok: list.source === "live",
        current: config.model,
        source: list.source,
        provider: config.providerId,
        label: config.providerLabel,
        options: list.options,
        message: list.message ?? "",
      });
      return;
    }
    if (url === "/api/reminders") {
      json(res, { reminders: listReminders() });
      return;
    }
    if (url === "/api/pomodoro") {
      // 番茄钟现状：卡片取消按钮与重开页面后的状态都走这里，不经过 agent
      const active = activePomodoro();
      json(res, {
        active: active ? toView(active) : null,
        recent: listPomodoros(10).map((p) => toView(p)),
      });
      return;
    }
    if (url.startsWith("/api/reminders/") && url.endsWith(".ics")) {
      const id = url.slice("/api/reminders/".length, -4);
      const reminder = listReminders().find((r) => r.id === id);
      if (!reminder) {
        fileNotFound(res);
        return;
      }
      const body = reminderIcs(reminder);
      res.writeHead(200, {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="courseraptor-${id}.ics"`,
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (url === "/api/data") {
      json(res, dataPayload());
      return;
    }
    if (url === "/api/data/export") {
      const body = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          sessions: readSessions().map((s) => ({
            ...s,
            messages: s.messages.map(({ attachments, ...m }) => ({
              ...m,
              ...(attachments?.length
                ? { attachments: attachments.map(({ id, name }) => ({ id, name })) }
                : {}),
            })),
          })),
          reminders: listReminders(),
          knowledge: listKnowledge(),
          summary: dataPayload(),
        },
        null,
        2,
      );
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="courseraptor-data-${new Date().toISOString().slice(0, 10)}.json"`,
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (url.startsWith(SESSIONS_PREFIX)) {
      const raw = decodeSessionSegment(url) ?? "";
      const s = SESSION_ID_RE.test(raw) ? getSession(raw) : null;
      if (!s) {
        json(res, { error: "会话不存在" }, 404);
        return;
      }
      json(res, {
        id: s.id,
        title: s.title || "新会话",
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messages: s.messages.map(({ attachments, ...message }) => ({
          ...message,
          ...(attachments?.length
            ? { attachments: attachments.map(({ id, name }) => ({ id, name })) }
            : {}),
        })),
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    chatPageHtml ??= chatPage();
    res.end(withCsrf(chatPageHtml));
    return;
  }
  if (req.method === "POST") {
    if (url === "/api/reset") {
      // 清空全部会话档案（UI 不再挂这个动作，留给测试与自救）
      resetAll();
      json(res, { ok: true });
      return;
    }
    if (url === "/api/settings") {
      let body: Record<string, unknown>;
      try {
        body = await jsonBody(req);
      } catch {
        json(res, { error: "请求体需要是 JSON" }, 400);
        return;
      }
      const r = applySettings(body ?? {});
      if (r.modelChanged || r.schoolChanged || r.providerChanged) {
        // 串行重建：并发保存时不能让两个 agent 互相覆盖（换型号/换供应商与切学校同一条路）
        const note = await enqueueAgentRefresh();
        const line =
          r.results.find((item) => item.field === "model") ??
          r.results.find((item) => item.field === "provider") ??
          r.results.find((item) => item.field === "school");
        if (line) line.message += note;
      }
      // QQ 凭证保存成功且已凑齐：顺手把桥拉起来（未在跑时），不用等重启
      const qqLine = r.results.find((item) => item.field === "qq");
      if (r.ok && qqLine?.ok && config.qqBotAppId && config.qqBotAppSecret) {
        qqLine.message += await maybeStartQQBridge();
      }
      json(res, r, r.ok ? 200 : 400);
      return;
    }
    if (url === "/api/diagnostics") {
      try {
        const body = await jsonBody(req, 16_384);
        const result = await runDiagnostic(body.target);
        json(res, { ok: result.ok, result, checkedAt: Date.now() }, result.ok ? 200 : 400);
      } catch {
        json(res, { error: "请求体需要是 JSON" }, 400);
      }
      return;
    }
    if (url === "/api/uploads") {
      try {
        const body = await jsonBody(req, Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64_000);
        const data = typeof body.data === "string" ? body.data : "";
        const name = typeof body.name === "string" ? body.name : "";
        const type = typeof body.type === "string" ? body.type : "";
        const buf = Buffer.from(data, "base64");
        if (!data || !buf.length) throw new Error("文件内容无效");
        const upload = saveUpload(name, type, buf);
        json(res, {
          upload: { id: upload.id, name: upload.name, size: upload.size, type: upload.type },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "上传失败";
        json(
          res,
          {
            error:
              message === "PAYLOAD_TOO_LARGE"
                ? "单个文件不能超过 25 MB"
                : message === "CONTENT_TYPE"
                  ? "请求体需要是 JSON"
                  : message,
          },
          400,
        );
      }
      return;
    }
    if (url === "/api/schedule/import") {
      // 手动课表导入第一步：文本或上传文件 → AI 结构化 + 追问。
      // 服务端不存会话状态，追问循环由前端带着 answers 重放。
      try {
        const body = await jsonBody(req, 2 * 1024 * 1024);
        let content = typeof body.text === "string" ? body.text : "";
        let fileName = typeof body.fileName === "string" ? body.fileName : "";
        if (!content.trim() && typeof body.uploadId === "string" && body.uploadId) {
          const [upload] = getUploads([body.uploadId]);
          if (!upload) {
            json(res, { error: "上传文件不存在或已过期，请重新选择文件" }, 400);
            return;
          }
          // 与聊天附件同一条预解析流水线：xlsx/csv 出表格行、docx/pdf/txt 出全文。
          // 课表导入要的是「全部课程行」：默认预览每 sheet 15 行装不下真实课表
          //（15-25 门课），后面的课会被静默丢掉、同学还以为导全了
          const result = await openLocalFile(upload.storedPath, { previewRows: 1000 });
          content = importTextOf(result);
          fileName = upload.name;
          if (!content.trim()) {
            json(
              res,
              {
                error: `「${upload.name}」是图片或其他暂不支持解析的格式：请改贴文字，或导出 Excel/PDF/Word/TXT 后再传`,
              },
              400,
            );
            return;
          }
        }
        if (!content.trim()) {
          json(res, { error: "请先粘贴课表文本，或选择一个课表文件" }, 400);
          return;
        }
        if (!hasScheduleParser()) {
          // 默认解析器直连模型 API：没配 Key 时给出可操作的指引（托管版 Key 已注入）
          if (!config.deepseekApiKey) {
            json(
              res,
              { error: "AI 解析需要先配置模型：到 设置 → AI 模型 保存 API Key 后再试" },
              400,
            );
            return;
          }
          await installDefaultScheduleParser();
        }
        const answers: ImportQA[] = Array.isArray(body.answers)
          ? body.answers
              .filter(
                (a): a is { question: string; answer: string } =>
                  typeof a === "object" &&
                  a !== null &&
                  typeof (a as { question?: unknown }).question === "string" &&
                  typeof (a as { answer?: unknown }).answer === "string",
              )
              .slice(0, 6)
          : [];
        const parsed = await parseScheduleImport(content, answers);
        json(res, {
          ok: true,
          fileName,
          courses: parsed.courses,
          rejected: parsed.rejected,
          conflicts: parsed.conflicts,
          questions: parsed.questions,
          ...(parsed.termHint ? { termHint: parsed.termHint } : {}),
          ...(parsed.termStartHint ? { termStartHint: parsed.termStartHint } : {}),
        });
      } catch (error) {
        json(res, { error: error instanceof Error ? error.message : "解析失败，请稍后重试" }, 500);
      }
      return;
    }
    if (url === "/api/schedule/import/commit") {
      // 第二步：确认后的课程清单落盘（覆盖旧缓存；服务端再校验一遍）
      try {
        const body = await jsonBody(req, 1024 * 1024);
        const rows = Array.isArray(body.courses) ? body.courses : [];
        const { courses, rejected } = sanitizeCourses(rows);
        if (!courses.length) {
          json(
            res,
            {
              error: `没有可导入的课程${rejected.length ? `（${rejected.length} 行无效）` : ""}`,
            },
            400,
          );
          return;
        }
        const candidates = school().terms.candidates();
        const fallbackTerm = candidates[0];
        if (!fallbackTerm) throw new Error("没有可用学期，无法确定默认学年学期");
        const year = Number.isInteger(body.year) ? Number(body.year) : fallbackTerm.year;
        const semester = Number.isInteger(body.semester)
          ? Number(body.semester)
          : fallbackTerm.semester;
        const label = school().terms.label(year, semester);
        // 开学日期（选填）：必须是周一，写进 custom 学期真值，周次从此有据
        const termStart = typeof body.termStart === "string" ? body.termStart.trim() : "";
        if (termStart) {
          const d = new Date(`${termStart}T00:00:00`);
          if (Number.isNaN(d.getTime()) || d.getDay() !== 1) {
            json(res, { error: "开学日期无效：应为「第 1 教学周的周一」日期（YYYY-MM-DD）" }, 400);
            return;
          }
          recordManualTermStart(year, semester, termStart);
        }
        saveScheduleCache({ year, semester, label, courses });
        json(res, { ok: true, term: label, year, semester, count: courses.length, rejected });
      } catch (error) {
        json(res, { error: error instanceof Error ? error.message : "导入失败" }, 400);
      }
      return;
    }
    if (url === "/api/reminders") {
      try {
        const reminder = addReminder(await jsonBody(req, 32_768));
        json(res, { reminder }, 201);
      } catch (error) {
        json(res, { error: error instanceof Error ? error.message : "创建提醒失败" }, 400);
      }
      return;
    }
    if (url === "/api/knowledge") {
      // 知识库发布框：页面直写（分类自动归课表课程，subject 可选指定）
      try {
        const body = (await jsonBody(req, 65_536)) as {
          title?: unknown;
          content?: unknown;
          subject?: unknown;
        };
        const result = addKnowledge({
          title: typeof body.title === "string" ? body.title : "",
          content: typeof body.content === "string" ? body.content : "",
          ...(typeof body.subject === "string" && body.subject.trim()
            ? { subject: body.subject }
            : {}),
          source: "网页",
        });
        json(res, { entry: result.entry, updatedExisting: result.updatedExisting }, 201);
      } catch (error) {
        json(res, { error: error instanceof Error ? error.message : "保存知识失败" }, 400);
      }
      return;
    }
    if (url === "/api/pomodoro/cancel") {
      // 倒计时卡片上的「取消」按钮直调这里：不打扰 agent 那轮对话
      try {
        const body = await jsonBody(req, 16_384);
        const target = cancelPomodoro(typeof body.id === "string" ? body.id : undefined);
        if (!target) {
          json(res, { error: "当前没有在走的番茄钟" }, 404);
          return;
        }
        json(res, { ok: true, pomodoro: toView(target) });
      } catch {
        json(res, { error: "请求体需要是 JSON" }, 400);
      }
      return;
    }
    if (url === "/api/data/clear") {
      try {
        const body = await jsonBody(req, 16_384);
        const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
        const result: Record<string, number> = {};
        if (scopes.includes("sessions")) {
          result.sessions = listSessions().length;
          resetAll();
        }
        if (scopes.includes("attachments")) result.attachments = await clearAttachments();
        if (scopes.includes("uploads")) result.uploads = clearUploads();
        if (scopes.includes("generated")) result.generated = clearGenerated();
        if (scopes.includes("reminders")) result.reminders = clearReminders();
        if (scopes.includes("knowledge")) result.knowledge = clearKnowledge();
        json(res, { ok: true, result, summary: dataPayload() });
      } catch {
        json(res, { error: "清理请求无效" }, 400);
      }
      return;
    }
    if (url === "/api/chat") {
      await handleChat(req, res);
      return;
    }
  }
  if (req.method === "PATCH" && url.startsWith(SESSIONS_PREFIX)) {
    const raw = decodeSessionSegment(url) ?? "";
    if (!SESSION_ID_RE.test(raw)) {
      json(res, { error: "会话不存在" }, 404);
      return;
    }
    try {
      const body = await jsonBody(req, 16_384);
      const updated = updateSession(raw, {
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
      });
      json(
        res,
        updated
          ? {
              ok: true,
              session: {
                id: updated.id,
                title: updated.title,
                pinned: !!updated.pinned,
                archived: !!updated.archived,
              },
            }
          : { error: "会话不存在或标题无效" },
        updated ? 200 : 404,
      );
    } catch {
      json(res, { error: "请求体需要是 JSON" }, 400);
    }
    return;
  }
  if (req.method === "PATCH" && url.startsWith("/api/reminders/")) {
    const id = url.slice("/api/reminders/".length);
    try {
      const reminder = updateReminder(id, await jsonBody(req, 32_768));
      json(res, reminder ? { reminder } : { error: "提醒不存在" }, reminder ? 200 : 404);
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : "更新提醒失败" }, 400);
    }
    return;
  }
  if (req.method === "DELETE" && url.startsWith(SESSIONS_PREFIX)) {
    const raw = decodeSessionSegment(url) ?? "";
    const ok = SESSION_ID_RE.test(raw) && deleteSession(raw);
    json(res, ok ? { ok: true } : { error: "会话不存在" }, ok ? 200 : 404);
    return;
  }
  if (req.method === "DELETE" && url.startsWith("/api/uploads/")) {
    const ok = deleteUpload(url.slice("/api/uploads/".length));
    json(res, ok ? { ok: true } : { error: "附件不存在" }, ok ? 200 : 404);
    return;
  }
  if (req.method === "DELETE" && url.startsWith("/api/reminders/")) {
    const ok = deleteReminder(url.slice("/api/reminders/".length));
    json(res, ok ? { ok: true } : { error: "提醒不存在" }, ok ? 200 : 404);
    return;
  }
  if (req.method === "PATCH" && url.startsWith("/api/knowledge/")) {
    const id = url.slice("/api/knowledge/".length);
    try {
      const body = (await jsonBody(req, 65_536)) as {
        title?: unknown;
        content?: unknown;
        subject?: unknown;
      };
      const entry = updateKnowledge(id, {
        ...(body.title !== undefined
          ? { title: typeof body.title === "string" ? body.title : "" }
          : {}),
        ...(body.content !== undefined
          ? { content: typeof body.content === "string" ? body.content : "" }
          : {}),
        ...(body.subject !== undefined
          ? { subject: typeof body.subject === "string" ? body.subject : "" }
          : {}),
      });
      json(res, entry ? { entry } : { error: "知识条目不存在" }, entry ? 200 : 404);
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : "更新知识失败" }, 400);
    }
    return;
  }
  if (req.method === "DELETE" && url.startsWith("/api/knowledge/")) {
    const ok = deleteKnowledge(url.slice("/api/knowledge/".length));
    json(res, ok ? { ok: true } : { error: "知识条目不存在" }, ok ? 200 : 404);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

// ── 前端单页 ─────────────────────────────────────────────────
// Markdown 用 marked 渲染（/vendor/marked.min.js）；渲染前先整段转义
// HTML 特殊字符，保证最终 DOM 里只有 marked 生成的标签——模型输出里
// 夹带的 <script> 之类会以纯文本形式出现，不构成注入面。
//
// ⚠ 页面 HTML 仍是 TS 模板字符串（模板里的内联 JS 同样受限）；对话主脚本
// chat-app.js 已外置为 /app.js 静态资产，不受此约束（可自由用反引号/${}）。
