/**
 * CourseRaptor Obsidian 插件入口
 *
 * CourseRaptor 的第四端入口：本机跑着 CourseRaptor 网页服务（终端 raptor
 * 或安装包），插件作为瘦客户端连上去——对话与查询都在那边完成，这里只
 * 负责界面与命令。服务地址与令牌在设置页配置（网页「设置 → Obsidian 插
 * 件」可复制），状态栏常驻连接标识。
 */

import { Plugin, WorkspaceLeaf } from "obsidian";
import { RaptorClient } from "./api";
import { insertTodayBrief, insertTodos } from "./insert";
import {
  CourseRaptorSettingTab,
  DEFAULT_SETTINGS,
  type CourseRaptorSettings,
} from "./settings";
import { VIEW_TYPE_COURSE_RAPTOR, ChatView } from "./view";

export default class CourseRaptorPlugin extends Plugin {
  /** 基类已声明 settings 字段：这里收窄为本插件类型，loadData 后立即可用 */
  declare settings: CourseRaptorSettings;
  client!: RaptorClient;

  private statusText: HTMLElement | null = null;
  private statusTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.client = new RaptorClient(() => ({
      baseUrl: this.settings.baseUrl,
      token: this.settings.token,
    }));

    this.registerView(VIEW_TYPE_COURSE_RAPTOR, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    this.addRibbonIcon("bot", "打开 CourseRaptor 对话", () => void this.activateView());
    this.addSettingTab(new CourseRaptorSettingTab(this.app, this));

    this.addCommand({
      id: "open-chat",
      name: "打开对话侧栏",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "insert-today",
      name: "插入今日日程到当前笔记",
      callback: () => void insertTodayBrief(this),
    });
    this.addCommand({
      id: "insert-todos",
      name: "插入待办清单到当前笔记",
      callback: () => void insertTodos(this),
    });

    this.statusText = this.addStatusBarItem();
    this.statusText.addClass("cr-status");
    this.statusText.addEventListener("click", () => void this.activateView());
    void this.refreshStatusBar();
    this.statusTimer = window.setInterval(() => void this.refreshStatusBar(), 60_000);
    this.registerInterval(this.statusTimer);
  }

  onunload(): void {
    /* 状态栏元素由 Obsidian 随插件卸载回收；视图 leaf 由宿主统一清理 */
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    void this.refreshStatusBar();
  }

  /** 从右侧 leaf 打开（或唤起）对话视图 */
  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_COURSE_RAPTOR)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_COURSE_RAPTOR, active: true });
    workspace.revealLeaf(leaf);
  }

  /** 状态栏连接标识：不弹窗不报错，悬停 title 说明去哪修 */
  private async refreshStatusBar(): Promise<void> {
    const el = this.statusText;
    if (!el) return;
    const result = await this.client.check().catch(() => ({ ok: false as const, message: "连接失败" }));
    if (result.ok) {
      el.setText("🦖 已连接");
      el.setAttribute("title", `CourseRaptor 已连接（127.0.0.1:${result.info.port}），点这里打开对话`);
    } else {
      el.setText("🦖 离线");
      el.setAttribute("title", `CourseRaptor 连不上：${result.message}`);
    }
  }
}
