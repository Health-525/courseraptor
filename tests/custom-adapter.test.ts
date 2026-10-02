/**
 * 自定义学校（其他学校 / 手动课表）适配器：学期规则、缓存课表工具、能力边界
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-custom-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");
delete process.env.RAPTOR_SCHOOL;

await import("../src/adapters");
const { school, selectSchool } = await import("../src/core/school");
const { saveScheduleCache, loadScheduleCache } = await import("../src/core/schedule-cache");
const { recordManualTermStart, manualTermStarts } = await import("../src/core/manual-terms");

/** 切到自定义学校再执行，结束后切回（不影响同进程后续断言） */
async function withCustom<T>(fn: () => Promise<T> | T): Promise<T> {
  assert.ok(selectSchool("custom"));
  try {
    return await fn();
  } finally {
    selectSchool("njtech");
  }
}

test("terms：学期标签 / 周次展开 / 记录开学日期后周次有据", async () => {
  await withCustom(async () => {
    const terms = school().terms;
    assert.equal(terms.label(2026, 3), "2026-2027学年第一学期");
    // 单周过滤作用于整串：1-8 与 11-16 都只留奇数周
    assert.deepEqual(terms.expandWeeks("1-8,11-16(单)"), [1, 3, 5, 7, 11, 13, 15]);
    // 未记录时是估算值（如实标 source）
    const est = terms.week1MondayOf(2026, 3);
    assert.equal(est.source, "estimated");
    assert.match(est.week1Monday, /^2026-09-0[1-7]$/);
    // 记录 2026-2027-1 开学周一（2026-09-07 恰为周一）后变 recorded
    recordManualTermStart(2026, 3, "2026-09-07");
    assert.equal(manualTermStarts()["2026-2027-1"], "2026-09-07");
    const rec = terms.week1MondayOf(2026, 3);
    assert.equal(rec.source, "recorded");
    assert.equal(rec.week1Monday, "2026-09-07");
    // 9 月第 2 周的周三是第 2 周（第 1 周周一 = 2026-09-07）
    const week = terms.weekOf(2026, 3, new Date("2026-09-16T12:00:00"));
    assert.equal(week?.week, 2);
    // 开学前不在教学周
    assert.equal(terms.weekOf(2026, 3, new Date("2026-08-30T12:00:00")), null);
    // 作息兜底表：节次可渲染时间段
    assert.equal(terms.periodTime(1), "08:00-08:45");
    assert.equal(terms.periodTimeRange([1, 2]), "08:00-09:40");
  });
});

test("get_schedule：无缓存时抛「请先配置」口径（网页端据此自动弹设置）", async () => {
  await withCustom(async () => {
    const tool = school().tools.get_schedule as unknown as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await assert.rejects(
      () => tool.execute({}),
      (e: Error) => /尚未导入课表|请先配置/.test(e.message),
    );
  });
});

test("get_schedule：读导入缓存，byWeek 按周预分组", async () => {
  await withCustom(async () => {
    saveScheduleCache({
      year: 2026,
      semester: 3,
      label: "2026-2027学年第一学期",
      courses: [
        {
          title: "高等数学",
          weekday: 1,
          periods: [3, 4],
          weeks: "1-16",
          location: "教一101",
          teacher: "张老师",
        },
        {
          title: "大学英语",
          weekday: 3,
          periods: [5, 6],
          weeks: "1-8",
          location: "文楼202",
          teacher: "李老师",
        },
      ],
    });
    const tool = school().tools.get_schedule as unknown as {
      execute: (input: unknown) => Promise<Record<string, unknown>>;
    };
    const r = await tool.execute({});
    assert.equal(r.source, "manual");
    assert.equal(r.total, 2);
    const byWeek = r.byWeek as Array<{ week: number; count: number; lines: string[] }>;
    assert.ok(byWeek.some((g) => g.week === 1 && g.lines.some((l) => l.includes("高等数学"))));
    assert.ok(!byWeek.some((g) => g.week === 9 && g.lines.some((l) => l.includes("大学英语"))));
    // 指定别的学期：本地只有一份缓存，如实报错
    const other = (await tool.execute({ semester: "2025-2026-2" })) as { error?: string };
    assert.match(other.error ?? "", /只有「2026-2027学年第一学期」/);
    // 缓存确实是同一份（导入链路写入的就是它）
    assert.equal(loadScheduleCache()?.schedule.courses.length, 2);
  });
});

test("能力边界：无教务登录、无通知面；fetchSmart 即读缓存", async () => {
  await withCustom(async () => {
    const adapter = school();
    assert.equal(adapter.notices, undefined);
    await assert.rejects(
      () => adapter.auth.login("x", "y"),
      (e: Error) => /没有接入教务系统/.test(e.message),
    );
    const r = await adapter.schedule!.fetchSmart("");
    assert.ok(r.ok);
    assert.equal(r.data.courses.length, 2);
    const exams = await adapter.schedule!.fetchExamsSmart("");
    assert.ok(!exams.ok);
    // 提示词段如实交代能力边界
    const sections = adapter.promptSections({ enableGrab: false });
    assert.match(sections.tools + sections.background, /手动导入/);
    assert.match(sections.background, /不可用/);
  });
});
