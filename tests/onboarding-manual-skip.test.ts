/**
 * 默认不接入任何学校（custom 手动课表模式）时，QQ 入口的教务凭证引导
 * 直接放行：不问学号密码，指引去网页「设置 → 学校」里选校。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 隔离：凭证与数据都指到临时目录，绝不碰真机 credentials.enc / data/
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-onboard-manual-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");
delete process.env.RAPTOR_SCHOOL;

await import("../src/adapters"); // 无凭证起步 → 默认 custom（不接入任何学校）
const { ensureCredentials } = await import("../src/core/onboarding");

test("默认 custom：ensureCredentials 不引导填教务账号，直接 skipped 放行", async () => {
  const asked: string[] = [];
  const output: string[] = [];
  const outcome = await ensureCredentials(
    {
      write: (message) => output.push(message),
      ask: async (prompt) => {
        asked.push(prompt);
        return "";
      },
      askSecret: async (prompt) => {
        asked.push(prompt);
        return "";
      },
    },
    { isConfigured: () => false, login: async () => {}, save: () => {} },
  );
  assert.equal(outcome, "skipped");
  assert.equal(asked.length, 0, "手动课表模式下不应发起任何终端提问");
  assert.ok(output.some((m) => m.includes("未接入任何学校")));
  assert.ok(output.some((m) => m.includes("设置 → 学校")));
});
