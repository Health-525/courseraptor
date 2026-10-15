/**
 * export_schedule_image：缺缓存报错；有缓存能落盘 PNG。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

await import("../src/adapters");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-sched-img-"));
process.env.RAPTOR_DATA_DIR = tmp;

const { coreTools } = await import("../src/core/tools");
const { saveScheduleCache } = await import("../src/core/schedule-cache");

const tool = coreTools.export_schedule_image as unknown as {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

test("缺课表缓存时明确报错，不编造", async () => {
  assert.ok(tool, "export_schedule_image 应注册");
  const r = await tool.execute({ mode: "week" });
  assert.match(String(r.error ?? ""), /还没有课表缓存/);
});

test("有缓存时可导出 PNG 到 generated", async () => {
  saveScheduleCache({
    year: 2026,
    semester: 1,
    label: "2026-2027-1",
    courses: [
      {
        title: "高等数学",
        weekday: 1,
        periods: [1, 2],
        weeks: "1-16",
        location: "教1-101",
        teacher: "张老师",
      },
    ],
  });

  const r = await tool.execute({
    mode: "week",
    week: 1,
    format: "png",
    style: "classic",
    filename: "测试周课表",
  });
  assert.ok(!r.error, String(r.error));
  assert.equal(r.format, "png");
  assert.match(String(r.filename), /测试周课表/);
  assert.ok(typeof r.path === "string" && fs.existsSync(String(r.path)));
  assert.ok((r.bytes as number) > 1000);
});
