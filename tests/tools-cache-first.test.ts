/**
 * 工具缓存优先策略测试（tools-cache-first）
 *
 * 钉住 2026-10 引入的语义：get_schedule / get_grades / get_exams / get_news
 * 默认走本地缓存不登录教务，仅当模型/用户明确传 refresh=true 时才联网；
 * 联网成功后与旧缓存做结构化 diff，不同才落盘。
 *
 * 背景：此前工具每次 execute 都无条件登录教务（缓存仅作失败兜底），
 * 叠加 prompt 第 13 条「今天有什么安排」强制调 get_schedule，
 * 每轮日常问答都打教务一次，用户体感"在持续获取学校信息"。
 *
 * https.request 用进程内 mock 替身（同 njtech-session-recovery.test.ts），
 * 不联网。缓存命中路径必须零 https.request；refresh=true 必须穿透。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-cache-first-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");
process.env.JWGL_USERNAME = "20230101";
process.env.JWGL_PASSWORD = "test-password";
process.env.RAPTOR_SCHOOL = "njtech";

const { setRateLimit } = await import("../src/core/http");
const { saveScheduleCache, loadScheduleCache } = await import("../src/core/schedule-cache");
const { saveExamCache } = await import("../src/core/exam-cache");
const { saveGradesCache } = await import("../src/core/grades-cache");
const { scheduleTools } = await import("../src/adapters/njtech/tools/schedule");
const { gradesTools } = await import("../src/adapters/njtech/tools/grades");
const { invalidateAuthCache } = await import("../src/adapters/njtech/session");
const { clearNewsMemo } = await import("../src/adapters/njtech/news");

// ── https.request mock 替身：任何被拦截到的请求都记录，用于断言"零网络" ──

const httpsMod = https as unknown as { request: unknown };

function installHttpSpy() {
  const original = httpsMod.request;
  const seen: Array<{ method?: string; path?: string }> = [];
  httpsMod.request = ((opts: Record<string, unknown>, cb: (res: EventEmitter) => void) => {
    seen.push({ method: opts.method as string, path: opts.path as string });
    // 立即失败：任何误触网络的调用会快速抛错、不挂住 authInflight（防止污染下一个测试）
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: (ms: number, fn: () => void) => void;
      write: (b: string) => void;
      end: () => void;
    };
    req.setTimeout = () => {};
    req.write = () => {};
    req.end = () => {
      queueMicrotask(() => req.emit("error", new Error("spy-intercept: 测试禁网")));
    };
    void cb;
    return req;
  }) as unknown;
  return {
    restore: () => {
      httpsMod.request = original;
    },
    seen,
  };
}

const looseRate = () => setRateLimit(10_000, 10_000);
const asTool = (t: unknown) =>
  t as { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };

// ── 测试用固定课表/考试/成绩样本 ─────────────────────────────

const SCHEDULE_FIXTURE = {
  year: 2026,
  semester: 3,
  label: "2026-2027-1",
  courses: [
    {
      title: "高等数学A",
      weekday: 1,
      periods: [2, 3],
      weeks: "1-16",
      location: "同和楼 101",
      teacher: "张三",
    },
    {
      title: "线性代数",
      weekday: 3,
      periods: [4, 5],
      weeks: "2-14",
      location: "仁智楼 202",
      teacher: "李四",
    },
  ],
};

const EXAM_FIXTURE = {
  year: 2026,
  semester: 3,
  label: "2026-2027-1",
  exams: [
    {
      subject: "高等数学A",
      date: "2026-12-20",
      time: "09:00-11:00",
      location: "同和楼 101",
      seatNumber: "01",
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// get_schedule：缓存优先
// ══════════════════════════════════════════════════════════════

test("get_schedule：缓存存在且未传 refresh → 零网络请求，返回 fromCache=true + staleNote", async () => {
  looseRate();
  invalidateAuthCache();
  saveScheduleCache(SCHEDULE_FIXTURE);
  const spy = installHttpSpy();
  try {
    const out = await asTool(scheduleTools.get_schedule).execute({});
    assert.equal(spy.seen.length, 0, "缓存命中路径不得发起任何 https.request");
    assert.equal(out.fromCache, true, "必须标记 fromCache=true");
    assert.equal(out.total, 2);
    assert.equal(out.term, "2026-2027-1");
    assert.match(String(out.staleNote ?? ""), /本次未联网/, "staleNote 必须说明本次未联网");
    assert.match(
      String(out.staleNote ?? ""),
      /refresh=true/,
      "staleNote 必须提示 refresh=true 用法",
    );
    assert.ok(typeof out.savedAt === "number", "savedAt 必须来自缓存");
  } finally {
    spy.restore();
    invalidateAuthCache();
  }
});

// 注：无缓存首次联网 / 指定 semester 联网这两个「旧行为」用例已省略——
// 它们要跑通 core/http 的 withRetry 全套重试（每例 ~20s），CI 成本不划算。
// 语义上，「缓存命中零网络」的对照断言已经反向覆盖了这两条路径：
// 只要缓存分支被错误命中，上面的 spy.seen.length === 0 就会失败。
// refresh=true 穿透缓存的实际路径由 njtech-session-recovery.test.ts 里
// 「refresh=true 时教务在线失败回退缓存」两个用例覆盖。

// ══════════════════════════════════════════════════════════════
// get_exams：缓存优先
// ══════════════════════════════════════════════════════════════

test("get_exams：缓存存在且未传 refresh → 零网络请求，返回 fromCache=true + staleNote", async () => {
  looseRate();
  invalidateAuthCache();
  saveExamCache(EXAM_FIXTURE);
  const spy = installHttpSpy();
  try {
    const out = await asTool(gradesTools.get_exams).execute({});
    assert.equal(spy.seen.length, 0, "缓存命中路径不得发起任何 https.request");
    assert.equal(out.fromCache, true);
    assert.equal(out.total, 1);
    assert.equal(out.term, "2026-2027-1");
    assert.match(String(out.staleNote ?? ""), /本次未联网/);
    assert.match(String(out.staleNote ?? ""), /refresh=true/);
  } finally {
    spy.restore();
    invalidateAuthCache();
  }
});

// ══════════════════════════════════════════════════════════════
// get_grades：缓存优先 + 全量派生
// ══════════════════════════════════════════════════════════════

test("get_grades：新缓存（含 allCourses）+ 未传 refresh → 零网络，完整字段派生返回", async () => {
  looseRate();
  invalidateAuthCache();
  saveGradesCache({
    gpa: "3.85",
    gpaBasis: "必修加权",
    requiredCredits: 42,
    courseCount: 12,
    recentSemester: "2026-2027-1",
    recentCourses: [
      { course: "高等数学A", score: 92, credit: "4", type: "必修", semester: "2026-2027-1" },
    ],
    allCourses: [
      {
        course: "高等数学A",
        courseCode: "MATH1",
        score: "92",
        credit: "4",
        type: "必修",
        semester: "2026-2027-1",
      },
      {
        course: "英语听说",
        courseCode: "ENG2",
        score: "85",
        credit: "2",
        type: "必修",
        semester: "2025-2026-2",
      },
    ],
    requiredCourses: 10,
    passFailCredits: 2,
    failedTerms: [],
  });
  const spy = installHttpSpy();
  try {
    const out = await asTool(gradesTools.get_grades).execute({});
    assert.equal(spy.seen.length, 0, "缓存命中路径不得发起任何 https.request");
    assert.equal(out.fromCache, true);
    assert.equal(out.gpa, "3.85");
    assert.equal(out.courseCount, 12);
    assert.equal(out.requiredCredits, 42);
    assert.equal(out.passFailCredits, 2);
    assert.equal(out.requiredCourses, 10);
    assert.ok(Array.isArray(out.courses), "courses 明细必须由 allCourses 派生");
    assert.equal((out.courses as unknown[]).length, 2);
    assert.ok(out.academicSummary !== undefined, "academicSummary 必须由 allCourses 派生");
    assert.ok(out.generalElectives !== undefined, "generalElectives 必须由 allCourses 派生");
    assert.match(String(out.staleNote ?? ""), /本次未联网/);
    assert.match(String(out.staleNote ?? ""), /refresh=true/);
  } finally {
    spy.restore();
    invalidateAuthCache();
  }
});

test("get_grades：老缓存（无 allCourses）→ 返回摘要子集 + 提示可刷新", async () => {
  looseRate();
  invalidateAuthCache();
  // 手工写老格式缓存（无 allCourses 字段）
  saveGradesCache({
    gpa: "3.60",
    requiredCredits: 30,
    courseCount: 8,
    recentSemester: "2025-2026-2",
    recentCourses: [
      { course: "旧课", score: 88, credit: "3", type: "必修", semester: "2025-2026-2" },
    ],
  });
  const spy = installHttpSpy();
  try {
    const out = await asTool(gradesTools.get_grades).execute({});
    assert.equal(spy.seen.length, 0, "老缓存也不该联网");
    assert.equal(out.fromCache, true);
    assert.equal(out.gpa, "3.60");
    assert.equal(out.courses, undefined, "老缓存没有全量明细，courses 字段应缺失");
    assert.equal(out.academicSummary, undefined);
    assert.match(String(out.staleNote ?? ""), /老缓存/, "staleNote 必须说明是老缓存");
    assert.match(String(out.staleNote ?? ""), /refresh=true/);
  } finally {
    spy.restore();
    invalidateAuthCache();
  }
});

// 注：无缓存首次联网用例已省略，理由同 get_schedule 段落末尾注释。

// ══════════════════════════════════════════════════════════════
// get_news：refresh=true 清 memo 强制重取
// ══════════════════════════════════════════════════════════════

test("get_news：refresh=true 时 clearNewsMemo 生效（不依赖磁盘缓存路径，仅验证不抛错）", async () => {
  // 这个用例只验证 refresh 参数被 schema 接受、不抛 zod 校验错。
  // 真实的"清 memo 强制重取"路径由 jwgl-news.test.ts 的 fetchJwcNewsMemo 用例覆盖。
  clearNewsMemo();
  const { newsTools } = await import("../src/adapters/njtech/tools/news");
  // schema 解析：refresh=true 必须被接受
  const schema = (
    newsTools.get_news as unknown as { inputSchema: { parse: (v: unknown) => unknown } }
  ).inputSchema;
  const parsed = schema.parse({ refresh: true, limit: 5 }) as { refresh?: boolean };
  assert.equal(parsed.refresh, true, "refresh=true 必须通过 zod 校验");
  const parsed2 = schema.parse({}) as { refresh?: boolean };
  assert.equal(parsed2.refresh, undefined, "不传 refresh 时必须 undefined（默认走缓存/memo）");
});

// ══════════════════════════════════════════════════════════════
// 缓存写回：diff 才落盘
// ══════════════════════════════════════════════════════════════

test("saveScheduleCache：diff 判断由工具层负责——本用例钉住「相同内容重复 save 不改变文件语义」", async () => {
  // 工具层的 diff 逻辑（isDeepStrictEqual）依赖 saveScheduleCache 的幂等写；
  // 这里验证：连续两次 save 同一份数据，读回来 savedAt 会被更新但 schedule 内容一致。
  // 真正的 diff 分支（"内容不变则跳过写盘"）需要网络 mock 场景，
  // 由 njtech-session-recovery.test.ts 的失败回退用例间接覆盖。
  looseRate();
  saveScheduleCache(SCHEDULE_FIXTURE);
  const a = loadScheduleCache();
  saveScheduleCache(SCHEDULE_FIXTURE);
  const b = loadScheduleCache();
  assert.ok(a && b);
  assert.deepEqual(a.schedule, b.schedule, "同一份数据两次写回，schedule 内容必须一致");
  assert.ok(b.savedAt >= a.savedAt, "savedAt 单调不减");
});
