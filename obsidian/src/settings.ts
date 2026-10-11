/**
 * 插件设置页：服务地址 + 本地 API 令牌 + 连接检测
 *
 * 令牌从 CourseRaptor 网页「功能大厅 → 设置 → Obsidian 插件」复制而来；
 * 检测按钮一次性验证「服务可达 + 令牌匹配」，给用户明确的错误指向。
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CourseRaptorPlugin from "./main";

export interface CourseRaptorSettings {
  baseUrl: string;
  token: string;
}

export const DEFAULT_SETTINGS: CourseRaptorSettings = {
  baseUrl: "http://127.0.0.1:3210",
  token: "",
};

export class CourseRaptorSettingTab extends PluginSettingTab {
  private plugin: CourseRaptorPlugin;

  constructor(app: App, plugin: CourseRaptorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("CourseRaptor").setHeading();

    const intro = containerEl.createEl("p", {
      text: "一般无需配置：只要本机在运行 CourseRaptor（终端敲 raptor，或双击安装包），插件就会自动连接。仅当默认端口 3210 被占用、服务换了端口时，才需要把终端欢迎卡片（或浏览器地址栏）里显示的实际地址填到下面。",
      cls: "setting-item-description",
    });
    intro.style.marginBottom = "12px";

    new Setting(containerEl)
      .setName("服务地址")
      .setDesc("默认 http://127.0.0.1:3210（端口被占用时会自动换，以终端欢迎卡片显示的为准）")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:3210")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim() || DEFAULT_SETTINGS.baseUrl;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("本地 API 令牌")
      .setDesc("留空即自动获取（推荐）。手动填写仅用于覆盖自动获取的值")
      .addText((text) => {
        text
          .setPlaceholder("留空自动获取")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = "100%";
        return text;
      });

    const status = containerEl.createEl("div", { cls: "setting-item-description" });

    new Setting(containerEl)
      .setName("检测连接")
      .setDesc("验证服务可达且令牌匹配")
      .addButton((btn) =>
        btn.setButtonText("检测").onClick(async () => {
          status.setText("检测中…");
          const result = await this.plugin.client.check();
          if (result.ok) {
            status.setText(
              `✅ 已连接（127.0.0.1:${result.info.port}），可以开始对话了`,
            );
          } else {
            status.setText(`❌ ${result.message}`);
          }
        }),
      );

    new Setting(containerEl)
      .setName("打开 CourseRaptor 网页")
      .setDesc("配置模型 Key、教务账号与令牌都在网页里完成")
      .addButton((btn) =>
        btn.setButtonText("打开").onClick(() => {
          if (!this.plugin.settings.baseUrl) {
            new Notice("请先填写服务地址");
            return;
          }
          window.open(this.plugin.client.base(), "_blank");
        }),
      );
  }
}
