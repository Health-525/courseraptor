/**
 * 「今日档案」数据组装测试
 *
 * 钉住路线图 P1 的验收口径：单双周、调休、跨午夜、无缓存降级、
 * 考试窗口与学期匹配、缓存新旧标注。全部用注入时钟，不依赖真实时间。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-today-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const { buildTodayBrief } = await import("../src/web/today-brief");
const { saveScheduleCache } = await import("../src/schedule-cache");
const { saveExamCache } = await import("../src/exam-cache");
const { recordWeek1Monday } = await import("../src/jwgl/term-dates");
const { recordSpecialDays, removeSpecialDays } = await import("../src/jwgl/term-holidays");

// 校准 2026 秋学期：第 1 周从 2026-08-31（周一）开始
recordWeek1Monday(2026, 3, "2026-08-31", "known", "测试校历");

const courses = [
  {
    title: "高等数学",
    weekday: 2,
    periods: [1, 2],
    weeks: "1-16",
    location: "教A-101",
    teacher: "张三",
  },
  {
    title: "大学英语",
    weekday: 2,
    periods: [5, 6],
    weeks: "1-16(单)",
    location: "教B-202",
    teacher: "李四",
  },
  {
    title: "程序设计",
    weekday: 3,
    periods: [7, 8],
    weeks: "1-16",
    location: "机房",
    teacher: "王五",
  },
];

const term = { year: 2026, semester: 3, label: "2026-2027学年第一学期" };

/** 直接写缓存文件（saveScheduleCache 的 savedAt 恒为当前时刻，测旧缓存得手写） */
function writeScheduleCache(savedAt: number): void {
  fs.writeFileSync(
    path.join(tmpData, "schedule-cache.json"),
    JSON.stringify({ savedAt, schedule: { ...term, courses } }),
    "utf8",
  );
}

test("无缓存：如实降级，不装作有数据", () => {
  const b = buildTodayBrief(new Date("2026-09-01T10:00:00"));
  assert.equal(b.schedule.available, false);
  assert.equal(b.next, null);
  assert.equal(b.week, null);
  assert.match(b.schedule.note ?? "", /还没有课表数据/);
  assert.equal(b.exams.available, false);
});

test("普通教学日：今日课程按周次过滤、状态与下一节课正确", () => {
  saveScheduleCache({ ...term, courses });
  // 2026-09-01 周二，第 1 周（单周，大学英语在单周上）
  const b = buildTodayBrief(new Date("2026-09-01T10:00:00"));
  assert.equal(b.term.weekLabel, "第 1 周");
  assert.equal(b.term.weekSource, "known");
  assert.deepEqual(
    b.schedule.courses.map((c) => c.title),
    ["高等数学", "大学英语"],
  );
  assert.equal(b.schedule.courses[0].status, "done"); // 08:10-09:50 已结束
  assert.equal(b.schedule.courses[1].status, "upcoming"); // 14:00 未开始
  assert.equal(b.next?.course.title, "大学英语");
  assert.equal(b.next?.dateLabel, "今天");
  assert.equal(b.next?.startsInMin, 240); // 14:00 - 10:00
});

test("单双周：双周不含「(单)」课，下一节课跨天到明天", () => {
  // 2026-09-08 周二，第 2 周（双周，大学英语不上）
  const b = buildTodayBrief(new Date("2026-09-08T10:00:00"));
  assert.deepEqual(
    b.schedule.courses.map((c) => c.title),
    ["高等数学"],
  );
  assert.equal(b.next?.course.title, "程序设计"); // 周三 16:00-17:40
  assert.equal(b.next?.dateLabel, "明天");
  assert.equal(b.next?.startsInMin, 1440 + 16 * 60 - 10 * 60);
});

test("调休补课日：按被换周几的课表上课", () => {
  // 2026-09-05 周六（第 1 周）调休，按周二课表补课
  recordSpecialDays([{ date: "2026-09-05", type: "makeup", follows: 2 }], "测试通知");
  const b = buildTodayBrief(new Date("2026-09-05T09:00:00"));
  assert.equal(b.schedule.todaySpecial?.type, "makeup");
  assert.deepEqual(
    b.schedule.courses.map((c) => c.title),
    ["高等数学", "大学英语"],
  );
  assert.equal(b.schedule.courses[0].status, "current"); // 08:10-09:50 正在上
  assert.match(b.schedule.note ?? "", /调休补课日/);
  // 本周概览的周六带补课标记与补出的课
  const sat = b.week?.days.find((d) => d.weekday === 6);
  assert.ok(sat?.makeup);
  assert.equal(sat?.courses.length, 2);
  removeSpecialDays(["2026-09-05"]);
});

test("放假日：今日课表作废，下一节课跳到明天", () => {
  recordSpecialDays([{ date: "2026-09-01", type: "holiday", name: "测试节" }]);
  const b = buildTodayBrief(new Date("2026-09-01T10:00:00"));
  assert.equal(b.schedule.todaySpecial?.type, "holiday");
  assert.equal(b.schedule.courses.length, 0);
  assert.match(b.schedule.note ?? "", /今天放假.*测试节/);
  assert.equal(b.next?.dateLabel, "明天");
  assert.equal(b.next?.course.title, "程序设计");
  const tue = b.week?.days.find((d) => d.weekday === 2);
  assert.equal(tue?.holiday, "测试节");
  removeSpecialDays(["2026-09-01"]);
});

test("深夜与跨午夜：午夜前后两次计算给出一致的下一节课", () => {
  // 周一 23:30：今天无课，下一节是明天 08:10 的高等数学
  const late = buildTodayBrief(new Date("2026-08-31T23:30:00"));
  assert.equal(late.next?.dateLabel, "明天");
  assert.equal(late.next?.course.title, "高等数学");
  assert.equal(late.next?.startsInMin, 1440 + 8 * 60 + 10 - (23 * 60 + 30));
  // 跨过午夜：日期翻到 9-1，今天的课就是昨晚算到的那门
  const am = buildTodayBrief(new Date("2026-09-01T00:10:00"));
  assert.match(am.dateLabel, /9月1日 周二/);
  assert.deepEqual(
    am.schedule.courses.map((c) => c.title),
    ["高等数学", "大学英语"],
  );
  assert.equal(am.next?.course.title, "高等数学");
  assert.equal(am.next?.dateLabel, "今天");
});

test("本周概览：周一锚点、今日标记与按日课程", () => {
  const b = buildTodayBrief(new Date("2026-09-03T12:00:00")); // 周四，第 1 周
  assert.equal(b.week?.mondayISO, "2026-08-31");
  assert.equal(b.week?.days.length, 7);
  assert.equal(b.week?.days[3].isToday, true);
  assert.equal(b.week?.days[3].dateISO, "2026-09-03");
  assert.equal(b.week?.days[1].courses.length, 2); // 周二两门（第 1 周含单周课）
  assert.equal(b.week?.days[1].courses[0].pStart, 1);
  assert.equal(b.week?.days[1].courses[0].pEnd, 2);
  assert.equal(b.week?.days[1].courses[0].teacher, "张三");
  assert.equal(b.week?.days[1].courses[0].weeks, "1-16");
  assert.equal(b.periodTimes["1"], "08:10-08:55");
  assert.equal(b.week?.days[5].courses.length, 0); // 周六无课
});

test("考试缓存：14 天窗口、当天标记、过期与太远都剔除", () => {
  saveExamCache({
    ...term,
    exams: [
      {
        subject: "过去的考试",
        date: "2026-08-30",
        time: "09:00",
        location: "旧考场",
        seatNumber: "1",
      },
      {
        subject: "今天的考试",
        date: "2026-09-01",
        time: "14:00-16:00",
        location: "考场A",
        seatNumber: "5",
      },
      {
        subject: "三天后的考试",
        date: "2026-09-04",
        time: "09:00",
        location: "考场B",
        seatNumber: "6",
      },
      {
        subject: "太远的考试",
        date: "2026-10-01",
        time: "09:00",
        location: "考场C",
        seatNumber: "7",
      },
    ],
  });
  const b = buildTodayBrief(new Date("2026-09-01T08:00:00"));
  assert.equal(b.exams.available, true);
  assert.deepEqual(
    b.exams.upcoming.map((e) => e.subject),
    ["今天的考试", "三天后的考试"],
  );
  assert.equal(b.exams.upcoming[0].isToday, true);
  assert.equal(b.exams.upcoming[1].inDays, 3);
  assert.equal(b.exams.upcoming[1].isToday, false);
});

test("考试缓存学期与课表不一致：不当本学期临近考试展示", () => {
  saveExamCache({
    year: 2026,
    semester: 12,
    label: "2025-2026学年第二学期",
    exams: [{ subject: "旧学期考试", date: "2026-09-02", time: "09:00", location: "X" }],
  });
  const b = buildTodayBrief(new Date("2026-09-01T08:00:00"));
  assert.equal(b.exams.available, false);
  assert.match(b.exams.note ?? "", /旧学期/);
});

test("缓存超过 14 天标记为较旧，提示刷新", () => {
  writeScheduleCache(Date.now() - 15 * 86400000);
  const b = buildTodayBrief(new Date("2026-09-01T10:00:00"));
  assert.equal(b.schedule.stale, true);
  saveScheduleCache({ ...term, courses });
  assert.equal(buildTodayBrief(new Date("2026-09-01T10:00:00")).schedule.stale, false);
});

test("开学日期无记录的学期：周次如实标注估算", () => {
  saveScheduleCache({ year: 2027, semester: 3, label: "2027-2028学年第一学期", courses });
  // 2027-09-06 是 9 月第一个周一（估算规则），09-08 为第 1 周周三
  const b = buildTodayBrief(new Date("2027-09-08T10:00:00"));
  assert.equal(b.term.weekSource, "estimated");
  assert.match(b.term.weekNote ?? "", /估算/);
});

test("假期/未开学：周概览歇档，下一节课为空", () => {
  saveScheduleCache({ ...term, courses });
  // 2026-06-15 在 2026 秋学期开学（08-31）之前
  const b = buildTodayBrief(new Date("2026-06-15T10:00:00"));
  assert.equal(b.term.weekLabel, "假期 · 未在教学周内");
  assert.equal(b.week, null);
  assert.equal(b.next, null);
  assert.match(b.schedule.note ?? "", /不在教学周内/);
});
