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
import { flushCapturedSession } from "./memory/shortterm";

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
    title: "🦖 CourseRaptor · NJTECH 教务 Agent（试试：这周课表 · 最近通知 · 我的成绩）",
    agent,
  });
} else {
  const { runAgentTUI } = await import("@ai-sdk/tui");
  const { createKeyProxy } = await import("./tui/keys");
  const keys = createKeyProxy(process.stdin);
  await runAgentTUI({
    // TUI 每帧都会 clearScreen 重绘，启动前打印的引导横幅活不下来；title 是
    // 唯一常驻的引导位，超宽时会被 sliceVisible 自动截断，不会破坏布局。
    title: "🦖 CourseRaptor · 试试：这周课表 · 最近通知 · 我的成绩 · 通识还差哪几类",
    agent,
    // 键位约定修正：ESC=打断回复，Ctrl+C=退出程序（库默认把 Ctrl+C 也当打断，
    // 与状态栏「Ctrl+C quit」的提示不符）。userInput 是库的运行时参数，类型
    // 未声明所以断言一下。
    userInput: keys.stream,
    // tools: "full" -- 默认 "auto-collapsed" 会在工具卡后出现文字总结时
    // 自动折叠成只剩标题的空壳，agent 几乎每轮都这样，等于工具调用永远看不见。
    // reasoning: "hidden" -- 不展示推理过程，对话界面只保留结论。
    tools: "full",
    reasoning: "hidden",
  } as Parameters<typeof runAgentTUI>[0]);
  // 嵌入模式下 QQ 桥会让进程继续存活，库只恢复代理流——真实终端必须手动还原，
  // 否则退出 TUI 后终端留在 raw mode（不回显、按键乱码）
  keys.restore();
}

// 会话历史在每轮已逐轮落盘，这里兜底刷写
await flushCapturedSession();
