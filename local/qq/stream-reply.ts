/**
 * QQ 私聊流式回复（官方 stream_messages 能力）
 *
 * QQ 开放平台对 C2C 开放 stream_messages：同一条消息原地逐帧改写，正是
 * LLM 逐字输出的展示形态。本模块收拢「agent 流事件 → QQ 流式帧」的粘合：
 * 工具执行期在帧首显示「⏳ 正在查课表…」状态行，正文产出后逐字增长，
 * 结束发终帧（DONE）。任何一帧失败都标记 broken 并回调桥，自动退回
 * 「心跳提示 + 分段纯文本」的旧通路——用户侧永远有回复。
 */

import type { QQBot, ReplyTarget, StreamSession } from "@tencent-connect/qqbot-nodejs";

type BridgeLogger = Pick<Console, "log" | "info" | "warn" | "error" | "debug">;

/** 初帧文案：私聊收到消息当下即可见（顶替旧模式 4 秒后才来的「收到，正在查…」） */
export const STREAM_ACK_TEXT = "🦖 收到，正在查…";

/**
 * 工具名 → 流式状态行的中文动作。只收录高频教务/文档工具，未收录的
 * 退回通用文案（带工具名，宁可朴素不可误导）。
 */
const TOOL_STATUS_LABELS: Record<string, string> = {
  get_schedule: "正在查课表",
  get_grades: "正在查成绩",
  get_exams: "正在查考试安排",
  get_news: "正在查教务通知",
  read_notice: "正在读通知正文",
  search_courses: "正在查课程信息",
  search_classes: "正在查班级课表",
  compare_courses: "正在对比课程",
  list_choosed_courses: "正在查已选课程",
  check_selection_status: "正在查选课状态",
  fetch_attachment: "正在取通知附件",
  export_calendar: "正在导出日历",
  export_schedule_image: "正在绘制课表图",
  query_table: "正在读表格",
  read_local_file: "正在读文件",
  read_skill: "正在调取技能",
  query_ai_news: "正在整理 AI 资讯",
  prepare_ai_news: "正在整理 AI 资讯",
  save_ai_news_digest: "正在保存资讯摘要",
  generate_document: "正在生成文档",
  convert_document: "正在转换文档",
  web_search: "正在联网搜索",
  web_fetch: "正在读网页",
  get_weather: "正在查天气",
  get_time: "正在校准时间",
  manage_todos: "正在整理待办",
  edit_schedule: "正在改课表",
  edit_grades: "正在改成绩单",
  edit_exams: "正在改考试安排",
  manage_knowledge: "正在整理知识库",
  save_memory: "正在记笔记",
  manage_pomodoro: "正在管理番茄钟",
  manage_prompts: "正在整理提示词",
  manage_attachments: "正在整理附件",
  run_js: "正在跑计算",
  set_holidays: "正在设置假期",
  open_panel: "正在打开面板",
  open_settings: "正在打开设置",
  ppt_preview: "正在预览 PPT",
  ppt_save: "正在保存 PPT",
};

export function toolStatusLabel(name: string | undefined): string {
  if (!name) return "正在处理";
  return TOOL_STATUS_LABELS[name] ?? `正在处理（${name}）`;
}

/** 组装流式帧：工具执行期在正文前加状态行；无正文时只显示状态行 */
export function renderStreamFrame(text: string, status: string | null): string {
  if (status === null) return text;
  return text === "" ? `⏳ ${status}…` : `⏳ ${status}…\n\n${text}`;
}

/** 流式帧的推送目标（QqStreamReply 本体或测试桩） */
export interface QqStreamPushTarget {
  push(text: string): void;
}

/**
 * 流式回放句柄：包住 SDK 的 StreamSession，把节流/重试/失败语义收进来。
 * open() 失败返回 null（桥退回旧通路）；此后任何帧失败都走 onBreak，
 * 桥收到回调即可重启心跳提示，长任务不会陷入无反馈的黑箱。
 */
export class QqStreamReply {
  private broken = false;
  private constructor(
    private readonly session: StreamSession,
    private readonly log: BridgeLogger,
    private readonly onBreak: () => void,
  ) {}

  static async open(
    bot: QQBot,
    target: ReplyTarget,
    log: BridgeLogger,
    onBreak: () => void = () => {},
  ): Promise<QqStreamReply | null> {
    try {
      const session = bot.openStream({ target });
      const reply = new QqStreamReply(session, log, onBreak);
      await session.update(STREAM_ACK_TEXT);
      return reply;
    } catch (e) {
      log.warn(`[qq] 流式回复不可用，退回普通消息：${(e as Error)?.message ?? e}`);
      return null;
    }
  }

  get alive(): boolean {
    return !this.broken;
  }

  /** 追加一帧（传全量文本，SDK 内部节流，调用方尽管随手 push） */
  push(text: string): void {
    if (this.broken) return;
    void this.session.update(text).catch((e) => this.break(e));
  }

  /** 终帧 + DONE；返回 false 表示流式已死，调用方改走 sendText 分段 */
  async finish(text: string): Promise<boolean> {
    if (this.broken) return false;
    try {
      await this.session.update(text);
      await this.session.complete();
      return true;
    } catch (e) {
      this.break(e);
      return false;
    }
  }

  private break(e: unknown): void {
    if (this.broken) return;
    this.broken = true;
    this.session.cancel();
    this.log.warn(`[qq] 流式回复中断，退回普通消息：${(e as Error)?.message ?? e}`);
    this.onBreak();
  }
}

/**
 * 把网页渠道那套 SSE 形态的流事件喂给 QQ 流式帧（与 translateStream 的
 * send 回调直接对接）：text 增量累积成正文，tool start/end 切换状态行。
 * reply 传 null 时只累积不发（群聊复用同一事件循环，收尾走分段发送）。
 */
export function createStreamFeed(reply: QqStreamPushTarget | null): {
  send: (obj: Record<string, unknown>) => void;
  rawText: () => string;
} {
  let raw = "";
  let status: string | null = null;
  const push = () => {
    reply?.push(renderStreamFrame(raw, status));
  };
  return {
    send(obj) {
      if (obj.t === "text" && typeof obj.v === "string" && obj.v !== "") {
        raw += obj.v;
        push();
        return;
      }
      if (obj.t === "tool") {
        if (obj.phase === "start") {
          status = toolStatusLabel(typeof obj.name === "string" ? obj.name : undefined);
        } else if (obj.phase === "end" || obj.phase === "error") {
          status = null;
        } else {
          return;
        }
        push();
      }
    },
    rawText: () => raw,
  };
}
