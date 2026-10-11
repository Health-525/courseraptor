/**
 * CourseRaptor 对话侧栏（ItemView）
 *
 * 与网页端同一套本地 API：SSE 流式对话、会话切换、快捷提问。
 * 渲染策略：流式过程中正文先以纯文本实时追加（快、不闪烁），一轮结束
 * 再整体换成 MarkdownRenderer 渲染；思考过程折叠进 details 卡片，工具
 * 调用渲染成一枚枚状态 chip（开始 → 耗时与摘要）。
 */

import { ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from "obsidian";
import { newSessionId, RaptorError, type RaptorClient } from "./api";
import type { ChatEvent, SessionMeta } from "./types";
import type CourseRaptorPlugin from "./main";

export const VIEW_TYPE_COURSE_RAPTOR = "courseraptor-chat";

const ICON = "bot";

/** 打开本插件设置页：app.setting 存在于运行时但未进公开类型，收敛在这一个访问点 */
function openPluginSettings(plugin: CourseRaptorPlugin): void {
  const setting = (plugin.app as unknown as {
    setting?: { open(): void; openTabById(id: string): void };
  }).setting;
  if (!setting) return;
  setting.open();
  setting.openTabById("courseraptor");
}

/** 一轮流式回复的动态部件：事件来了逐个挂进 root */
interface TurnParts {
  root: HTMLElement;
  text: string;
  think: { wrap: HTMLDetailsElement; body: HTMLElement; text: string } | null;
  streamEl: HTMLElement | null;
  tools: Map<string, HTMLElement>;
}

export class ChatView extends ItemView {
  private plugin: CourseRaptorPlugin;
  private sessionId = newSessionId();
  private sessions: SessionMeta[] = [];

  private messagesEl!: HTMLElement;
  private quickRowEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private sessionSelect!: HTMLSelectElement;
  private newChatBtn!: HTMLButtonElement;

  private abort: AbortController | null = null;
  private busy = false;

  constructor(leaf: WorkspaceLeaf, plugin: CourseRaptorPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = false;
  }

  getViewType(): string {
    return VIEW_TYPE_COURSE_RAPTOR;
  }

  getDisplayText(): string {
    return "CourseRaptor 对话";
  }

  getIcon(): string {
    return ICON;
  }

  setState(state: unknown, _result: unknown): Promise<void> {
    const sid = (state as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sid === "string" && sid) this.sessionId = sid;
    return Promise.resolve();
  }

  getState(): Record<string, unknown> {
    return { sessionId: this.sessionId };
  }

  async onOpen(): Promise<void> {
    this.buildDom();
    await this.refreshSessions().catch(() => {});
    void this.renderCurrentSession().catch(() => {});
    void this.loadQuickQuestions().catch(() => {});
  }

  async onClose(): Promise<void> {
    this.abort?.abort();
  }

  private get client(): RaptorClient {
    return this.plugin.client;
  }

  // ── 静态结构 ──────────────────────────────────────────────

  private buildDom(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("cr-chat");

    const head = root.createDiv({ cls: "cr-head" });
    this.sessionSelect = head.createEl("select", { cls: "cr-sessions dropdown" });
    this.sessionSelect.addEventListener("change", () => {
      const value = this.sessionSelect.value;
      if (!value) return;
      this.sessionId = value;
      void this.renderCurrentSession();
    });
    this.newChatBtn = head.createEl("button", {
      cls: "cr-newchat",
      text: "新会话",
    });
    this.newChatBtn.addEventListener("click", () => this.startFresh());

    this.messagesEl = root.createDiv({ cls: "cr-messages" });

    this.quickRowEl = root.createDiv({ cls: "cr-quickrow" });

    const inputWrap = root.createDiv({ cls: "cr-input" });
    this.inputEl = inputWrap.createEl("textarea", {
      cls: "cr-inputbox",
      attr: { placeholder: "问课表、成绩、考试、教务通知…（⏎ 发送，⇧⏎ 换行）", rows: "2" },
    }) as HTMLTextAreaElement;
    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.sendBtn = inputWrap.createEl("button", {
      cls: "cr-send mod-cta",
      text: "发送",
    });
    this.sendBtn.addEventListener("click", () => {
      if (this.busy) this.stop();
      else void this.send();
    });
  }

  private autoGrow(): void {
    const el = this.inputEl;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  // ── 会话列表与历史 ────────────────────────────────────────

  private async refreshSessions(): Promise<void> {
    this.sessions = await this.client.sessions();
    const active = this.sessions.find((s) => s.id === this.sessionId);
    this.sessionSelect.empty();
    const placeholder = this.sessionSelect.createEl("option", {
      text: active ? "" : "新会话",
    });
    placeholder.value = this.sessionId;
    placeholder.hidden = !active;
    placeholder.selected = true;
    for (const s of this.sessions.filter((x) => !x.archived)) {
      const opt = this.sessionSelect.createEl("option", {
        text: `${s.title || "新会话"}（${s.count}）`,
      });
      opt.value = s.id;
    }
    if (active) this.sessionSelect.value = this.sessionId;
  }

  private startFresh(): void {
    this.sessionId = newSessionId();
    this.messagesEl.empty();
    void this.refreshSessions().catch(() => {});
    this.renderQuickRow([]);
    this.inputEl.focus();
  }

  private async renderCurrentSession(): Promise<void> {
    this.messagesEl.empty();
    this.renderQuickRow([]);
    const detail = await this.client.session(this.sessionId);
    if (!detail || !detail.messages.length) {
      await this.loadQuickQuestions();
      return;
    }
    for (const m of detail.messages) {
      if (m.role === "user") this.renderUserBubble(m.text);
      else {
        const turn = this.beginAssistantBlock();
        if (m.think) {
          this.openThink(turn);
          if (turn.think) {
            turn.think.text = m.think;
            turn.think.body.textContent = m.think;
          }
        }
        this.finishTurnMarkdown(turn, m.text);
      }
    }
    this.scrollToBottom();
  }

  /** 快捷提问：仅空会话显示（与网页一致的「首轮引导」定位） */
  private async loadQuickQuestions(): Promise<void> {
    if (this.messagesEl.childElementCount > 0) return;
    try {
      const s = await this.client.settings();
      this.renderQuickRow(s.quickQuestions ?? []);
    } catch {
      /* 服务没开：错误在发消息时再如实呈现 */
    }
  }

  private renderQuickRow(questions: string[]): void {
    this.quickRowEl.empty();
    if (!questions.length || this.messagesEl.childElementCount > 0) return;
    for (const q of questions.slice(0, 6)) {
      const chip = this.quickRowEl.createEl("button", { cls: "cr-quick", text: q });
      chip.addEventListener("click", () => {
        if (this.busy) return;
        this.inputEl.value = q;
        void this.send();
      });
    }
  }

  // ── 发送与流式渲染 ────────────────────────────────────────

  private async send(): Promise<void> {
    if (this.busy) return;
    const message = this.inputEl.value.trim();
    if (!message) return;
    if (!this.plugin.settings.token) {
      new Notice("尚未配置本地 API 令牌：请在 CourseRaptor 插件设置里粘贴（网页「设置 → Obsidian 插件」可复制）");
      openPluginSettings(this.plugin);
      return;
    }

    this.busy = true;
    this.setStreamingUi(true);
    this.renderUserBubble(message);
    this.inputEl.value = "";
    this.autoGrow();
    this.renderQuickRow([]);
    this.scrollToBottom();

    const turn = this.beginAssistantBlock();
    this.abort = new AbortController();
    try {
      await this.client.sendChat(message, this.sessionId, (event) => this.onEvent(turn, event), this.abort.signal);
    } catch (e) {
      if (!this.abort.signal.aborted) {
        this.renderError(turn, e);
      }
    } finally {
      this.finalizeTurn(turn);
      this.abort = null;
      this.busy = false;
      this.setStreamingUi(false);
      void this.refreshSessions().catch(() => {});
    }
  }

  private stop(): void {
    this.abort?.abort();
  }

  private setStreamingUi(streaming: boolean): void {
    this.sendBtn.textContent = streaming ? "停止" : "发送";
    this.sendBtn.toggleClass("cr-stopping", streaming);
    this.inputEl.disabled = streaming;
    if (!streaming) this.inputEl.focus();
  }

  private onEvent(turn: TurnParts, event: ChatEvent): void {
    switch (event.t) {
      case "text": {
        turn.text += event.v;
        this.ensureStreamEl(turn).textContent = turn.text;
        this.scrollToBottom();
        break;
      }
      case "think": {
        if (event.phase === "end") {
          if (turn.think) turn.think.wrap.open = false;
          break;
        }
        const think = turn.think ?? this.openThink(turn);
        if (think && event.v) {
          think.text += event.v;
          think.body.textContent = think.text;
          think.wrap.open = true;
          this.scrollToBottom();
        }
        break;
      }
      case "tool": {
        if (event.phase === "start") {
          const chip = turn.root.createDiv({ cls: "cr-tool cr-tool-running", text: `${event.name} …` });
          turn.tools.set(event.id, chip);
        } else {
          const chip = turn.tools.get(event.id);
          if (chip) {
            chip.removeClass("cr-tool-running");
            if (event.phase === "error") chip.addClass("cr-tool-error");
            const dur = event.dur != null ? ` · ${(event.dur / 1000).toFixed(1)}s` : "";
            chip.textContent = `${event.name}${dur}${event.brief ? ` · ${event.brief}` : ""}`;
            chip.setAttribute("title", event.out || event.brief || event.name);
          }
        }
        this.scrollToBottom();
        break;
      }
      case "err": {
        const errEl = turn.root.createDiv({ cls: "cr-errorevent", text: event.v });
        this.scrollToBottom();
        if (event.v.includes("令牌")) {
          errEl.setText(`${event.v}（插件设置里可更新）`);
        }
        break;
      }
      case "end": {
        if (event.dur > 0) {
          turn.root.createDiv({
            cls: "cr-dur",
            text: `耗时 ${(event.dur / 1000).toFixed(1)}s`,
          });
        }
        break;
      }
    }
  }

  private ensureStreamEl(turn: TurnParts): HTMLElement {
    if (!turn.streamEl) {
      turn.streamEl = turn.root.createDiv({ cls: "cr-stream" });
      turn.streamEl.createSpan({ cls: "cr-cursor" });
    }
    turn.streamEl.setText(turn.text);
    turn.streamEl.createSpan({ cls: "cr-cursor" });
    return turn.streamEl;
  }

  private openThink(turn: TurnParts): NonNullable<TurnParts["think"]> {
    const wrap = turn.root.createEl("details", { cls: "cr-think" });
    wrap.createEl("summary", { text: "思考过程" });
    const body = wrap.createDiv({ cls: "cr-think-body" });
    turn.think = { wrap, body, text: "" };
    return turn.think;
  }

  private renderUserBubble(text: string): void {
    const bubble = this.messagesEl.createDiv({ cls: "cr-msg-user" });
    bubble.textContent = text;
    this.scrollToBottom();
  }

  private beginAssistantBlock(): TurnParts {
    const root = this.messagesEl.createDiv({ cls: "cr-msg-assistant" });
    return { root, text: "", think: null, streamEl: null, tools: new Map() };
  }

  /** 流结束后把纯文本换成正式 Markdown 渲染 */
  private finishTurnMarkdown(turn: TurnParts, text: string): void {
    turn.streamEl?.remove();
    turn.streamEl = null;
    if (!text.trim()) return;
    const mdEl = turn.root.createDiv({ cls: "cr-md" });
    void MarkdownRenderer.render(this.app, text, mdEl, "", this).catch(() => {
      mdEl.setText(text);
    });
  }

  private finalizeTurn(turn: TurnParts): void {
    if (turn.think) turn.think.wrap.open = false;
    this.finishTurnMarkdown(turn, turn.text);
    this.scrollToBottom();
  }

  private renderError(turn: TurnParts, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    const el = turn.root.createDiv({ cls: "cr-errorevent" });
    el.setText(message);
    if (e instanceof RaptorError && message.includes("连不上")) {
      el.createEl("div", { cls: "cr-errhint", text: "启动后若端口变化，以网页设置「Obsidian 插件」栏目显示的地址为准。" });
    }
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
