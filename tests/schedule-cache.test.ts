/**
 * 课表本地缓存测试
 *
 * 缓存的用途：TUI 启动面板免登录直读课表，不再每次都请求教务系统。
 * 这组测试钉住：读写往返一致、坏文件按无缓存处理（并留 .corrupt 备份）、
 * 结构不对的 JSON 不当作有效缓存。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-schedule-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { loadScheduleCache, saveScheduleCache } = await import(
  "../src/schedule-cache"
);

const sampleSchedule = {
  year: 2026,
  semester: 3,
  label: "2026-2027-1",
  courses: [
    {
      title: "高等数学",
      weekday: 1,
      periods: [1, 2],
      weeks: "1-16",
      location: "教A-101",
      teacher: "张三",
    },
  ],
};

test("保存后能原样读回", () => {
  saveScheduleCache(sampleSchedule);
  const loaded = loadScheduleCache();
  assert.ok(loaded);
  assert.equal(loaded.schedule.label, "2026-2027-1");
  assert.deepEqual(loaded.schedule.courses, sampleSchedule.courses);
  assert.ok(loaded.savedAt > 0);
});

test("缓存文件不存在时返回 null（不抛错）", () => {
  fs.rmSync(path.join(tmpData, "schedule-cache.json"), { force: true });
  assert.equal(loadScheduleCache(), null);
});

test("坏 JSON 返回 null 且留下 .corrupt 备份", () => {
  const file = path.join(tmpData, "schedule-cache.json");
  fs.writeFileSync(file, "{半截", "utf8");
  assert.equal(loadScheduleCache(), null);
  const leftovers = fs.readdirSync(tmpData).filter((f) => f.includes(".corrupt-"));
  assert.equal(leftovers.length, 1);
});

test("结构不对（缺 courses）的 JSON 不当有效缓存", () => {
  const file = path.join(tmpData, "schedule-cache.json");
  fs.writeFileSync(file, JSON.stringify({ savedAt: 1, schedule: { year: 2026 } }), "utf8");
  assert.equal(loadScheduleCache(), null);
});
