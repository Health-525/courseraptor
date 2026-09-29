/**
 * CourseRaptor 无终端（headless）入口：只起网页服务，供多用户网关部署。
 * 运行: node --import tsx gateway/headless/entry.ts（由 gateway/spawner.mjs 拉起）
 *
 * 与 channels/cli 的关系：那是「终端 TUI + 网页」双入口，这里是纯网页单入口。
 * 不引 TUI、不做交互式引导（教务账号由同学在网页「设置」里填，DeepSeek Key
 * 由网关注入或同学自带）、不启动桌面提醒与 QQ 桥——多用户托管下这些仍归
 * 同学本地的完整版。启动就绪后向 stdout 打一行固定格式，网关据此拿到实际端口。
 */

import "../../src/adapters";
import { createRaptorAgent } from "../../src/core/agent";
import { config } from "../../src/core/config";
import { saveCredentialsStore } from "../../src/core/credentials";
import { ensureModelAvailable } from "../../src/core/models";
import { installDefaultTitleMaker } from "../../src/core/session-titles";

// 模型退役检测（同 cli 入口语义）：赶在 agent / 网页构建之前完成迁移。
// 无终端模式下任何启动期异常都不能让进程带病退出——网关还要靠它服务。
if (config.deepseekApiKey) {
  try {
    const drift = await ensureModelAvailable({
      current: config.model,
      baseUrl: config.deepseekBaseUrl,
      apiKey: config.deepseekApiKey,
    });
    if (drift.migrated) {
      config.model = drift.model;
      saveCredentialsStore({ model: drift.model, modelOverride: true });
      console.log(`[headless] ${drift.message}`);
    }
  } catch {
    // 断网 / Key 失效：不动配置，让网页端按当前模型继续
  }
}

try {
  await installDefaultTitleMaker();
} catch {
  // 标题兜底为首问，装不上不影响对话
}

const agent = await createRaptorAgent();

const { setChatAgent, setChatAgentRefresher, startChatWeb } = await import(
  "../../src/channels/web/chat-web"
);
setChatAgent(agent);
// 换模型即重建 agent 给网页用（同学在设置里切型号后无需重启实例）
setChatAgentRefresher(async () => {
  setChatAgent(await createRaptorAgent());
});

const url = await startChatWeb();
if (!url) {
  console.error("[headless] 网页服务启动失败（端口不可用）");
  process.exit(1);
}

// 网关约定：这行的 port=<n> 是实例实际监听端口（RAPTOR_WEB_PORT 被占时
// chat-web 会退到随机端口，以这里报告的为准）
console.log(`[headless] ready port=${new URL(url).port} url=${url}`);

// chat-web 的 http server 是 unref() 的（终端场景进程该走就走）；
// 无终端模式必须自己拽住事件循环，否则上面的日志打完进程就退了
setInterval(() => {}, 60_000);
