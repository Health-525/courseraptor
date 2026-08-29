/**
 * CourseRaptor 入口：终端对话 UI
 * 配置了 QQ 机器人（QQBOT_APP_ID/SECRET）时，QQ 渠道随本入口一并启动
 * 运行: raptor / npm run dev
 *
 * 默认使用 @ai-sdk/tui 全屏卡片 UI（用户指定偏好：不要顺着命令行往下滚）。
 * RAPTOR_TUI_INLINE=1 时改用行内渲染器（src/tui/inline.ts）：
 * 输出顺着终端缓冲区往下走、滚轮/选中复制可用，供需要时选用。
 */

import { config } from "./config";
import { createRaptorAgent } from "./agent";
import { ensureCredentials } from "./onboarding";
import { flushCapturedSession } from "./memory/shortterm";

// 教务凭证缺失时引导录入（.env > credentials.enc 加密文件 > 首次引导）
await ensureCredentials();
if (config.credentialsSource === "encrypted") {
  console.log("🔐 教务凭证：已从本机加密存储解密加载");
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

if (process.env.RAPTOR_TUI_INLINE === "1") {
  const { runInlineTUI } = await import("./tui/inline");
  await runInlineTUI({
    title: "🦖 CourseRaptor · NJTECH 教务 Agent",
    agent,
  });
} else {
  const { runAgentTUI } = await import("@ai-sdk/tui");
  const { createKeyProxy } = await import("./tui/keys");
  const { withSoftInterrupt } = await import("./tui/soft-interrupt");
  const { startWelcomeBootstrap } = await import("./tui/welcome");
  const keys = createKeyProxy(process.stdin);
  // 空屏欢迎面板：后台拉今日课表/最新通知/GPA，逐段填进 TUI 空状态
  startWelcomeBootstrap();
  await runAgentTUI({
    // TUI 每帧都会 clearScreen 重绘，启动前打印的引导横幅活不下来；title 是
    // 唯一常驻的引导位，超宽时会被 sliceVisible 自动截断，不会破坏布局。
    title: "🦖 CourseRaptor · NJTECH 教务 Agent",
    // 键位约定（对齐 Claude Code 等主流 CLI）：ESC=打断当前回复并回到输入框
    // （库默认 ESC/Ctrl+C 都会终结会话，键位代理拦 ESC 转软打断信号，包装层
    // 消费：src/tui/soft-interrupt.ts）；Ctrl+C=退出程序（透传，库自己走优雅退出）
    agent: withSoftInterrupt(agent),
    // userInput 是库未文档化的运行时参数，类型未声明所以断言一下
    userInput: keys.stream,
    // tools: "full" -- 默认 "auto-collapsed" 会在工具卡后出现文字总结时
    // 自动折叠成只剩标题的空壳，agent 几乎每轮都这样，等于工具调用永远看不见。
    // reasoning: "hidden" -- 不展示推理过程，对话界面只保留结论。
    tools: "full",
    reasoning: "hidden",
  } as Parameters<typeof runAgentTUI>[0]);
  // 嵌入模式下 QQ 桥会让进程继续存活，解除键位代理对 stdin 的转发，
  // 不然退出 TUI 后按键还在流向已退出的 UI
  keys.restore();
}

// 会话历史在每轮已逐轮落盘，这里兜底刷写
await flushCapturedSession();
