import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/* 装配学校适配器（open_panel 的教务通知门禁要看当前学校能力）：
   临时目录隔离凭证，RAPTOR_SCHOOL=custom 起步（没接通知的学校） */
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-panel-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");
process.env.RAPTOR_SCHOOL = "custom";
await import("../src/adapters");

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

test("教务通知门禁：未接入的学校 open_panel(news) 劝退，不谎称已推出", async () => {
  const { coreTools } = await import("../src/core/tools");
  const { selectSchool } = await import("../src/core/school");
  const execute = (
    coreTools.open_panel as unknown as {
      execute: (i: { panel: string }) => Promise<string>;
    }
  ).execute;

  // custom（装配默认）：教务通知没有端点 → 劝退，不能说「已推出」
  const denied = await execute({ panel: "news" });
  assert.match(String(denied), /尚未接入教务通知/);
  assert.doesNotMatch(String(denied), /已请网页端推出/);

  // njtech 对照：接了通知 → 正常推出文案
  assert.ok(selectSchool("njtech"));
  const allowed = await execute({ panel: "news" });
  assert.match(String(allowed), /教务通知/);
  assert.doesNotMatch(String(allowed), /尚未接入/);
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
