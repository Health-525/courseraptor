/** 不加载 .env；演示只监听本机，不启用 QQ、自动更新或教务登录。 */
import { createDemoServer } from "./web/demo-server";

const port = Number(process.env.RAPTOR_DEMO_PORT ?? 3211);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("RAPTOR_DEMO_PORT 应为 0–65535 之间的整数。");
  process.exitCode = 1;
} else {
  const server = createDemoServer();
  server.once("error", (error) => {
    console.error(`演示启动失败：${error.message}。请关闭旧演示或设置 RAPTOR_DEMO_PORT。`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") {
      console.log(`CourseRaptor 离线演示：http://127.0.0.1:${address.port}`);
      console.log("全部为虚构数据，无需账号或 API Key，不调用 AI。Ctrl+C 退出。");
    }
  });
}
