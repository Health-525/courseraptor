import assert from "node:assert/strict";
import test from "node:test";

/** open_panel 只是「请前端弹出指定面板」的信号：可执行、白名单把关、返回引导文案 */
test("工具层接线：open_panel 可直接 execute，返回面板引导文案", async () => {
  const { coreTools } = await import("../src/core/tools");
  assert.ok(coreTools.open_panel, "open_panel 应注册进工具集");

  const execute = (
    coreTools.open_panel as unknown as {
      execute: (i: { panel: string }) => Promise<string>;
    }
  ).execute;
  const result = await execute({ panel: "schedule" });
  assert.match(String(result), /课表/, "返回文案应点名对应面板");
  assert.doesNotMatch(
    String(result),
    /(sk-|password|密码[:：]\s*\S+)/,
    "不应包含任何凭证形态的内容",
  );
});

test("面板白名单：覆盖功能大厅各面板，隐藏卡 import/account 不开放对话直达", async () => {
  const { PANEL_IDS } = await import("../src/core/tools/panel");
  assert.deepEqual([...PANEL_IDS].sort(), [
    "exams",
    "grades",
    "knowledge",
    "news",
    "pomodoro",
    "prompts",
    "schedule",
    "settings",
    "today",
    "todos",
    "usage",
  ]);
  assert.ok(!(PANEL_IDS as readonly string[]).includes("import"));
  assert.ok(!(PANEL_IDS as readonly string[]).includes("account"));
});
