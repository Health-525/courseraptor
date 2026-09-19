import assert from "node:assert/strict";
import test from "node:test";

/** open_settings 只是「请前端弹出设置面板」的信号：可执行、不碰凭证、返回引导文案 */
test("工具层接线：open_settings 可直接 execute，返回面板引导文案", async () => {
  const { raptorTools } = await import("../src/tools");
  assert.ok(raptorTools.open_settings, "open_settings 应注册进工具集");

  const execute = (
    raptorTools.open_settings as unknown as {
      execute: (i: unknown) => Promise<string>;
    }
  ).execute;
  const result = await execute({});
  assert.match(String(result), /设置面板/);
  assert.doesNotMatch(
    String(result),
    /(sk-|password|密码[:：]\s*\S+)/,
    "不应包含任何凭证形态的内容",
  );
});
