/**
 * 共享启动引导：TUI（local/cli/index.ts）与桌面后端（local/host/headless.ts）共用。
 *
 * 逐字复刻原 index.ts「TUI 循环之前」的启动序列与日志，保证本地版行为零改动：
 *   适配器 → 更新检查/上报 → 模型退役检测 → 会话自动命名 maker → QQ 桥
 *   → 建 agent → 装配网页（独立实例、不注入上次会话）→ 待办提醒调度
 *
 * 调用方拿返回值自行决定后续：TUI 进外层循环；headless 打印 IPC 后常驻。
 */

import "../../src/adapters";
import { createRaptorAgent } from "../../src/core/agent";
import { config } from "../../src/core/config";
import { loadCredentialsStore, saveCredentialsStore } from "../../src/core/credentials";
import { ensureModelAvailable } from "../../src/core/models";
import { checkForUpdate, formatUpdateBanner, type UpdateInfo } from "../../src/core/update-check";
import { pingUsage } from "../../src/core/usage-ping";

export interface BootResult {
  /** 终端入口持有的 agent 实例（网页/QQ 用各自的实例） */
  agent: Awaited<ReturnType<typeof createRaptorAgent>>;
  /** 有新版时的信息，调用方自取（TUI 标题徽标等） */
  updateInfo: UpdateInfo | null;
  /** 网页服务地址（起不来为 null） */
  webUrl: string | null;
}

export async function bootstrapHost(): Promise<BootResult> {
  // 更新检查先发出，与凭证加载/agent 构建并行跑，后面收结果
  const updatePromise = checkForUpdate();

  // 匿名使用情况上报（随机设备号+版本，24h 一次，失败静默，RAPTOR_NO_TELEMETRY=1 可关）
  void pingUsage();

  const updateInfo: UpdateInfo | null = await updatePromise;
  if (updateInfo) {
    // 行内模式可见；卡片模式每帧清屏，靠 TUI 标题里的徽标常驻
    console.log(formatUpdateBanner(updateInfo));
  }

  // 模型退役检测：DeepSeek 上下架型号后，本地存着的旧 id 会让每次对话直接
  // 报错。启动时强制拉一次实时清单，已退役的自动迁到当前默认型号并落盘；
  // 断网/Key 失效时检测不动配置（ensureModelAvailable 只认 live 清单）。
  // 必须赶在 agent / QQ 桥 / 网页构建之前，三个渠道才都拿到迁移后的模型。
  if (config.deepseekApiKey) {
    const drift = await ensureModelAvailable({
      current: config.model,
      providerId: config.providerId,
      baseUrl: config.providerBaseUrl,
      apiKey: config.deepseekApiKey,
    });
    if (drift.migrated) {
      config.model = drift.model;
      const providerModels = {
        ...(loadCredentialsStore()?.providerModels ?? {}),
        [config.providerId]: drift.model,
      };
      saveCredentialsStore({ model: drift.model, modelOverride: true, providerModels });
      console.log(`🔄 ${drift.message}\n`);
    }
  }

  // 会话自动命名 maker：直调模型 API（不带工具），失败静默——标题还有首问
  // 兜底。网页与 QQ 桥落的是同一份档案，注册表也共用（src/session-titles.ts），
  // 装配赶在 QQ 桥启动之前。
  await import("../../src/core/session-titles").then(({ installDefaultTitleMaker }) =>
    installDefaultTitleMaker(),
  );

  // QQ 渠道：日志写 qq-bridge.log，不干扰终端渲染
  if (config.qqBotAppId && config.qqBotAppSecret) {
    const { startQQBridge } = await import("../qq/bridge");
    const { createQQFileLogger } = await import("../qq/logger");
    startQQBridge({ logger: createQQFileLogger() }).catch((e) => {
      console.error(`[qq] 桥启动失败（终端对话不受影响）：${(e as Error).message.slice(0, 120)}`);
    });
  }

  const agent = await createRaptorAgent();

  // 网页对话窗口：浏览器打开即聊（地址返回给调用方显示），起不来不影响终端。
  // 网页用**独立实例且不注入上次会话记录**：它每轮都带该会话自己的完整历史，
  // 而 session.json 是全局单文件，注入进来等于让别的会话的尾巴污染当前会话。
  const { setChatAgent, setChatAgentRefresher, setQQBridgeLauncher, startChatWeb } = await import(
    "../../src/channels/web/chat-web"
  );
  setChatAgent(await createRaptorAgent("web", { carryOver: false }));
  // 换模型即重建 agent 给网页用；终端 TUI 持有的是上面这个实例，重启后才用新模型
  setChatAgentRefresher(async () => {
    setChatAgent(await createRaptorAgent("web", { carryOver: false }));
  });
  // 桥热启动是宿主职责（web 不 import local/）：设置页存 QQ 凭证后懒加载拉起
  setQQBridgeLauncher(() =>
    import("../qq/bridge").then(({ ensureQQBridgeOnline }) => ensureQQBridgeOnline()),
  );
  const webUrl = await startChatWeb().catch(() => null);

  // 待办到期提醒：每小时扫描「距到期 ≤ 7 天」的未完成待办（每天最多一次，
  // 桌面通知 + QQ 推送）。QQ 桥在线时进程在 TUI 退出后仍存活，提醒也随之持续。
  void import("../../src/core/todo-reminders").then(({ startTodoReminderScheduler }) =>
    startTodoReminderScheduler(),
  );

  // 定时提醒（定点闹钟）：每 30 秒核对一次，到点桌面通知 + QQ 推送；
  // 与待办提醒同一存活语义（桌面托盘常驻即持续生效）。
  void import("../../src/core/alarms").then(({ startAlarmScheduler }) => startAlarmScheduler());

  return { agent, updateInfo, webUrl };
}
