/**
 * CourseRaptor 入口：终端对话 UI
 * 配置了 QQ 机器人（QQBOT_APP_ID/SECRET）时，QQ 渠道随本入口一并启动
 * 运行: raptor / npm run dev
 *
 * 默认使用 @ai-sdk/tui 全屏卡片 UI（用户指定偏好：不要顺着命令行往下滚），
 * 行内渲染器（src/tui/inline.ts）作为备选，两种 UI 可运行时互切：
 *   - 卡片模式输入 /inline → 行内（输出顺着终端缓冲区走、滚轮/选中复制可用）
 *   - 行内模式输入 /card   → 卡片
 * RAPTOR_TUI_INLINE=1 只决定初始模式。滚轮/滚动步长/斜杠命令见 src/tui/keys.ts。
 * 两种 UI 输入 / 都会唤出斜杠命令候选菜单（↑↓ 选择、Tab/Enter 补全），
 * 注册表与渲染共用 src/tui/slash-menu.ts。
 */

import { createRaptorAgent } from "./agent";
import { config } from "./config";
import { flushCapturedSession } from "./memory/shortterm";
import { ensureCredentials, runDeepSeekKeySetup } from "./onboarding";
import { SLASH_COMMANDS } from "./tui/slash-menu";
import {
  checkForUpdate,
  formatUpdateBadge,
  formatUpdateBanner,
  type UpdateInfo,
} from "./update-check";
import { runUpdateCommand } from "./updater";

// 更新检查先发出，与凭证加载/agent 构建并行跑，后面收结果
const updatePromise = checkForUpdate();

// 教务凭证缺失时引导录入（.env > credentials.enc 加密文件 > 首次引导）
await ensureCredentials();
if (config.credentialsSource === "encrypted") {
  console.log("🔐 教务凭证：已从本机加密存储解密加载");
}

const updateInfo: UpdateInfo | null = await updatePromise;
if (updateInfo) {
  // 行内模式可见；卡片模式每帧清屏，靠下面 title 里的徽标常驻
  console.log(formatUpdateBanner(updateInfo));
}

// QQ 渠道：日志写 qq-bridge.log，不干扰终端渲染
if (config.qqBotAppId && config.qqBotAppSecret) {
  const { startQQBridge } = await import("./qq/bridge");
  const { createQQFileLogger } = await import("./qq/logger");
  startQQBridge({ logger: createQQFileLogger() }).catch((e) => {
    console.error(`[qq] 桥启动失败（终端对话不受影响）：${(e as Error).message.slice(0, 120)}`);
  });
}

const agent = await createRaptorAgent();

// 网页对话窗口：浏览器打开即聊（地址显示在欢迎卡片下方），起不来不影响终端
const { setChatAgent, startChatWeb } = await import("./web/chat-web");
setChatAgent(agent);
startChatWeb().catch(() => {});

/**
 * UI 切换外层循环：全屏卡片（@ai-sdk/tui）和行内渲染器可运行时互切。
 * /key 与 /inline 同样先退出当前 UI；外层独占 stdin 执行静音本地设置后，
 * 回到原 UI，避免 API Key 出现在 TUI 帧、会话或 Agent 中。
 */
type UIMode = "card" | "inline";
let mode: UIMode = process.env.RAPTOR_TUI_INLINE === "1" ? "inline" : "card";
let running = true;
while (running) {
  if (mode === "card") {
    const { runAgentTUI } = await import("@ai-sdk/tui");
    const { createKeyProxy } = await import("./tui/keys");
    const { withSoftInterrupt } = await import("./tui/soft-interrupt");
    const { startWelcomeBootstrap } = await import("./tui/welcome");
    const keys = createKeyProxy(process.stdin, {
      commands: {
        // desc 同时是斜杠菜单（输入 / 唤出，↑↓ 选择）里的说明文案，统一取自
        // SLASH_COMMANDS——菜单里写的说明必须和回车后真正执行的是一回事
        "/inline": {
          desc: SLASH_COMMANDS["/inline"].desc,
          switchTo: "inline",
        },
        // /key 始终无参：TUI 退出后由外层独占 stdin 显示脱敏值、确认并静音读取。
        "/key": {
          desc: SLASH_COMMANDS["/key"].desc,
          switchTo: "setup-key",
          rejectsArgument: true,
          onArgumentRejected: () =>
            console.log("请直接输入无参数 /key，再按提示安全设置 API Key。"),
        },
        // /update：从更新后台拉新版覆盖安装（进度在行内模式看得更清楚）
        "/update": {
          desc: SLASH_COMMANDS["/update"].desc,
          handler: () => {
            console.log("🔄 /update：开始检查更新…");
            runUpdateCommand();
          },
        },
        // 非目标模式名（"exit"）的 switchRequest 让外层循环走正常退出
        "/exit": { desc: SLASH_COMMANDS["/exit"].desc, switchTo: "exit" },
      },
    });
    // 空屏欢迎面板：后台拉今日课表/最新通知/GPA，逐段填进 TUI 空状态
    startWelcomeBootstrap();
    try {
      await runAgentTUI({
        // TUI 每帧都会 clearScreen 重绘，启动前打印的引导横幅活不下来；title 是
        // 唯一常驻的引导位，超宽时会被 sliceVisible 自动截断，不会破坏布局。
        // 未配置 API Key 时借 title 常驻提示 /key 配置命令；有新版时徽标插在
        // 前半段，标题超宽被截断时更新提示也能保住。
        title: [
          "🦖 CourseRaptor",
          updateInfo ? formatUpdateBadge(updateInfo) : null,
          config.deepseekApiKey
            ? "NJTECH 教务 Agent（/inline 切行内模式）"
            : "输入无参数 /key 安全配置后即可对话",
        ]
          .filter(Boolean)
          .join(" · "),
        // 键位约定（对齐 Claude Code 等主流 CLI）：ESC=打断当前回复并回到输入框
        // （库默认 ESC/Ctrl+C 都会终结会话，键位代理拦 ESC 转软打断信号，包装层
        // 消费：src/tui/soft-interrupt.ts）；Ctrl+C=退出程序（透传，库自己走优雅退出）
        agent: withSoftInterrupt(agent),
        // userInput 是库未文档化的运行时参数，类型未声明所以断言一下
        userInput: keys.stream,
        // tools: "full" -- 默认 "auto-collapsed" 会在工具卡后出现文字总结时
        // 自动折叠成只剩标题的空壳，agent 几乎每轮都这样，等于工具调用永远看不见。
        // reasoning: "auto-collapsed" -- 思考过程流式可见（最新一段展开、旧段自动
        // 折叠），让用户感知到"模型在想什么"；hidden 会把思考完全藏掉，界面死板。
        tools: "full",
        reasoning: "auto-collapsed",
      } as Parameters<typeof runAgentTUI>[0]);
    } finally {
      // 嵌入模式下 QQ 桥会让进程继续存活，解除键位代理对 stdin 的转发，
      // 不然退出 TUI 后按键还在流向已退出的 UI
      keys.restore();
    }
    if (keys.switchRequest === "setup-key") {
      await runDeepSeekKeySetup();
    } else if (keys.switchRequest === "inline") {
      mode = "inline";
    } else {
      running = false; // Ctrl+C / 正常退出
    }
  } else {
    const { runInlineTUI } = await import("./tui/inline");
    const result = await runInlineTUI({
      title: [
        "🦖 CourseRaptor",
        updateInfo ? formatUpdateBadge(updateInfo) : null,
        "NJTECH 教务 Agent（/card 切卡片模式）",
      ]
        .filter(Boolean)
        .join(" · "),
      agent,
    });
    if (result === "setup-key") {
      await runDeepSeekKeySetup();
    } else if (result === "switch-card") {
      mode = "card";
    } else {
      running = false;
    }
  }
}

// 会话历史在每轮已逐轮落盘，这里兜底刷写
await flushCapturedSession();
