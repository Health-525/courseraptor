/**
 * CourseRaptor 本地 API 的响应与事件类型
 *
 * 只声明插件用到的字段（服务端返回更宽的对象，多余字段忽略）；
 * 契约与 src/channels/web/chat-web.ts、today-brief.ts 的产出对齐。
 */

/** GET /api/sessions 的列表项（不含正文） */
export interface SessionMeta {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: number;
  count: number;
}

/** GET /api/sessions/:id 的会话正文 */
export interface SessionDetail {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    ts: number;
    think?: string;
  }>;
}

/** POST /api/chat 的 SSE 事件（t 为判别字段） */
export type ChatEvent =
  | { t: "text"; v: string }
  | { t: "think"; v?: string; phase?: "end" }
  | {
      t: "tool";
      phase: "start" | "end" | "error";
      id: string;
      name: string;
      dur?: number;
      brief?: string;
      args?: string;
      out?: string;
    }
  | { t: "err"; v: string }
  | { t: "end"; dur: number; sid: string };

export interface BriefCourse {
  title: string;
  periods: string;
  time?: string;
  location?: string;
  teacher?: string;
  status: "done" | "current" | "upcoming";
}

export interface BriefExam {
  subject: string;
  date: string;
  time: string;
  location: string;
  seatNumber?: string;
  inDays: number;
  isToday: boolean;
}

export interface ReminderItem {
  id: string;
  title: string;
  dueAt: string;
  done: boolean;
  notes?: string;
}

/** GET /api/today 的今日档案（服务端字段更多，这里只取要插入笔记的） */
export interface TodayBrief {
  now: string;
  dateLabel: string;
  term: {
    label: string;
    weekLabel: string;
    week: number | null;
  };
  schedule: {
    available: boolean;
    cachedAt: number | null;
    stale: boolean;
    courses: BriefCourse[];
    note?: string;
  };
  exams: {
    available: boolean;
    upcoming: BriefExam[];
    note?: string;
  };
}

/** GET /api/settings 里插件用到的部分 */
export interface SettingsBrief {
  quickQuestions?: string[];
  school?: {
    current: string;
    manual: boolean;
  };
}

/** GET /api/localapi：本地 API 令牌与实际端口 */
export interface LocalApiInfo {
  token: string;
  port: number;
}
