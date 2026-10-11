/**
 * CourseRaptor 本地 API 客户端
 *
 * 插件是第四端入口的瘦客户端：所有能力都来自本机正在运行的 CourseRaptor
 * 网页服务（127.0.0.1，默认 3210），这里只做 HTTP/SSE 的拼装与解析。
 *
 * 鉴权：写请求带 x-raptor-token（网页「设置 → Obsidian 插件」里复制），
 * 与页面 CSRF token 二选一过服务端写门；GET 无需令牌。
 * 流式：POST /api/chat 返回 SSE，Obsidian 渲染进程的 fetch 支持流读，
 * 依赖服务端对 app://obsidian.md 的 CORS 放行。
 */

import { requestUrl, type RequestUrlParam } from "obsidian";
import type {
  ChatEvent,
  LocalApiInfo,
  ReminderItem,
  SessionDetail,
  SessionMeta,
  SettingsBrief,
  TodayBrief,
} from "./types";

export interface RaptorClientConfig {
  baseUrl: string;
  token: string;
}

export class RaptorError extends Error {}

export class RaptorClient {
  /** 自动模式下从服务取回的令牌（本进程内缓存；服务端持久化，重启不变） */
  private autoToken: string | null = null;

  constructor(private getConfig: () => RaptorClientConfig) {}

  /** 拼当前服务根地址（去掉末尾斜杠）：设置页「打开网页」也用它 */
  base(): string {
    const { baseUrl } = this.getConfig();
    return baseUrl.replace(/\/+$/, "");
  }

  /**
   * 写请求用的令牌：手动配置优先（留作覆盖与排障），否则自动向服务
   * 取回——令牌防御的是「浏览器里的网页」（读不到本机响应），插件是
   * 本机进程、本就在信任边界内，自动取回安全性不打折，省掉手粘一步。
   */
  private async writeToken(): Promise<string> {
    const configured = this.getConfig().token;
    if (configured) return configured;
    if (!this.autoToken) {
      const info = await this.getJson<LocalApiInfo>("/api/localapi");
      if (!info?.token) throw new RaptorError("服务未返回本地 API 令牌");
      this.autoToken = info.token;
    }
    return this.autoToken;
  }

  /** 渲染进程 fetch：可流式读 SSE，但跨源需要服务端 CORS 配合 */
  private async request(
    path: string,
    init: { method?: string; body?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["x-raptor-token"] = await this.writeToken();
    }
    try {
      return await fetch(`${this.base()}${path}`, { ...init, headers });
    } catch (e) {
      if (init.signal?.aborted) throw e;
      throw new RaptorError(
        `连不上 CourseRaptor（${this.base()}）：请确认它正在运行（终端敲 raptor，或双击安装包）`,
      );
    }
  }

  /** requestUrl 走主进程网络栈、无 CORS 限制：给不需要流式的 GET 兜底 */
  private async getText(path: string): Promise<string> {
    const params: RequestUrlParam = {
      url: `${this.base()}${path}`,
      method: "GET",
      throw: false,
    };
    const res = await requestUrl(params);
    return res.text;
  }

  private async getJson<T>(path: string): Promise<T> {
    try {
      const raw = await this.getText(path);
      return JSON.parse(raw) as T;
    } catch (e) {
      if (e instanceof RaptorError) throw e;
      throw new RaptorError(
        `连不上 CourseRaptor（${this.base()}）：请确认它正在运行（终端敲 raptor，或双击安装包）`,
      );
    }
  }

  /**
   * 连接检测：服务可达 + 令牌一致。令牌留空即自动获取并缓存——所以
   * 「未填令牌」不再算错误，默认装好即连。
   */
  async check(): Promise<{ ok: true; info: LocalApiInfo } | { ok: false; message: string }> {
    let info: LocalApiInfo;
    try {
      info = await this.getJson<LocalApiInfo>("/api/localapi");
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    const configured = this.getConfig().token;
    if (configured && configured !== info.token) {
      return {
        ok: false,
        message: "令牌不匹配：清空插件设置里的令牌即可恢复自动获取",
      };
    }
    this.autoToken = info.token;
    return { ok: true, info };
  }

  sessions(): Promise<SessionMeta[]> {
    return this.getJson<{ sessions: SessionMeta[] }>("/api/sessions").then((d) => d.sessions ?? []);
  }

  session(id: string): Promise<SessionDetail | null> {
    return this.getJson<SessionDetail | { error: string }>(`/api/sessions/${encodeURIComponent(id)}`).then(
      (d) => ("messages" in d ? d : null),
    );
  }

  today(): Promise<TodayBrief> {
    return this.getJson<TodayBrief>("/api/today");
  }

  reminders(): Promise<ReminderItem[]> {
    return this.getJson<{ reminders: ReminderItem[] }>("/api/reminders").then(
      (d) => d.reminders ?? [],
    );
  }

  settings(): Promise<SettingsBrief> {
    return this.getJson<SettingsBrief>("/api/settings");
  }

  /**
   * 发起一轮对话并逐事件回调。返回后流已结束；用 AbortSignal 中断
   * （对齐网页端「关页面即打断本轮」的语义，服务端会中止这轮生成）。
   */
  async sendChat(
    message: string,
    sessionId: string,
    onEvent: (event: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const init = {
      method: "POST",
      body: JSON.stringify({ message, sessionId }),
      signal,
    };
    let res = await this.request("/api/chat", init);
    if (res.status === 403 && !this.getConfig().token) {
      // 自动令牌失效（服务端重置过数据等）：重取一次再试，仅自动模式
      this.autoToken = null;
      res = await this.request("/api/chat", init);
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        /* 非 JSON 错误体：用状态码 */
      }
      throw new RaptorError(detail);
    }
    if (!res.body) throw new RaptorError("服务返回了空响应流");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const dispatch = (frame: string): void => {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as ChatEvent);
        } catch {
          /* 单帧坏数据跳过，不断流 */
        }
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        dispatch(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf("\n\n");
      }
    }
    dispatch(buffer);
  }
}

/** 客户端先生成会话 id：第一条消息发出时服务端才建档，不留空壳会话 */
export function newSessionId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `s${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}
