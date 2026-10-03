/**
 * 河北农大适配器的离线单测：只测纯逻辑与配置隔离，绝不打真实教务系统。
 *
 * 三件必须钉住的事：
 * 1. 行归一（URP 字段名大小写混杂、周次带「周」字、节次给区间）；
 * 2. 5.0 绩点口径：通过型/缓考不参与计算（返回 null），不是 0 分；
 * 3. 多校隔离：候选学期探测在南工大月份区间上与 core 实现逐月等价、
 *    河农大春夏学期覆盖到 7 月；校历与缓存按学校分开，切校后不串数据。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";

// 隔离：数据目录指到临时目录，绝不碰真机 data/
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-hebau-"));

before(() => {
  // config 在 import 时已定型，这里只兜底清掉可能存在的学校强制
  delete process.env.RAPTOR_SCHOOL;
});

// ── 学期编码与行归一 ─────────────────────────────────────────

test("xnxqdm: 内部学期码（3/12）换算成 URP 的 XNXQDM 字符串", async () => {
  const { xnxqdm } = await import("../src/adapters/hebau/urp");
  assert.equal(xnxqdm(2026, 3), "2026-2027-1");
  assert.equal(xnxqdm(2025, 12), "2025-2026-2");
});

test("课表行归一：小写字段、区间节次、带「周」字的周次都能收正", async () => {
  const { toCourseRow } = await import("../src/adapters/hebau/schedule");
  const row = {
    kcmc: "高等数学A",
    xqj: "3",
    skjc: "1",
    jsjc: "2",
    skzc: "1-16周",
    jasmc: "3教101",
    skjs: "王老师",
  };
  const c = toCourseRow(row);
  assert.ok(c);
  assert.equal(c?.title, "高等数学A");
  assert.equal(c?.weekday, 3);
  assert.deepEqual(c?.periods, [1, 2]);
  assert.equal(c?.weeks, "1-16");
  assert.equal(c?.location, "3教101");
  assert.equal(c?.teacher, "王老师");
});

test("课表行归一：课程名为空的统计行丢弃，单节课不被补成两节", async () => {
  const { toCourseRow } = await import("../src/adapters/hebau/schedule");
  assert.equal(toCourseRow({ xqj: "1", skjc: "3" }), null);
  const single = toCourseRow({ KCMC: "体育", XQJ: "2", SKJC: "5" });
  assert.deepEqual(single?.periods, [5]);
});

test("normalizeWeekSpec: 去「周」与空白，保留单双周标记", async () => {
  const { normalizeWeekSpec } = await import("../src/adapters/hebau/schedule");
  assert.equal(normalizeWeekSpec("2-6,8-12周"), "2-6,8-12");
  assert.equal(normalizeWeekSpec("1-20 周"), "1-20");
  assert.equal(normalizeWeekSpec("3-16周(双)"), "3-16(双)");
});

test("parsePeriodRange: 只给开始节时按 1 节算，不再默认连堂 2 节", async () => {
  const { parsePeriodRange } = await import("../src/adapters/hebau/schedule");
  assert.deepEqual(parsePeriodRange({ SKJC: "7" }), [7]);
  assert.deepEqual(parsePeriodRange({ SKJC: "7", SKCD: "3" }), [7, 8, 9]);
  assert.deepEqual(parsePeriodRange({}), []);
});

test("extractUrpRows: 考试接口把行拆成 arranged/notArranged 也要合并取到", async () => {
  const { extractUrpRows } = await import("../src/adapters/hebau/urp");
  const payload = {
    datas: {
      queryMyExamArrangeMent: {
        arranged: [{ KCMC: "A", KSRQ: "2026-06-15" }],
        notArranged: [{ KCMC: "B" }],
      },
    },
  };
  const rows = extractUrpRows(payload, "queryMyExamArrangeMent");
  assert.equal(rows?.length, 2);
  // 结构完全对不上时必须是 null（= 报错），不能是空数组（=「你没有考试」）
  assert.equal(extractUrpRows({ foo: 1 }, "x"), null);
});

test("考试行归一：日期与时间同串时拆开，未排期的行保留", async () => {
  const { parseExamDate, toExamRow } = await import("../src/adapters/hebau/exams");
  const merged = toExamRow({ KCMC: "数据结构", KSSJ: "2026-06-20 08:00-10:00", ZWH: "12" });
  assert.equal(merged?.date, "2026-06-20");
  assert.equal(merged?.time, "08:00-10:00");
  assert.equal(merged?.seatNumber, "12");
  const unscheduled = toExamRow({ KCMC: "形势政策", KSJC: "待定" });
  assert.ok(unscheduled);
  assert.equal(unscheduled?.date, "");
  assert.equal(toExamRow({ XQBH: "备注行" }), null);
  assert.equal(parseExamDate({ SJKSRQ: "2026/06/15 上午" }), "2026-06-15");
});

test("考试去重：同键留信息更全的那条", async () => {
  const { dedupeExams } = await import("../src/adapters/hebau/exams");
  const deduped = dedupeExams([
    { subject: "A", date: "2026-06-20", time: "08:00", location: "" },
    { subject: "A", date: "2026-06-20", time: "08:00", location: "3教101", seatNumber: "5" },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].location, "3教101");
});

// ── 成绩口径 ──────────────────────────────────────────────────

test("河北农大 5.0 绩点：百分制折算与等级制映射", async () => {
  const { hebauGradeToGP } = await import("../src/adapters/hebau/grades");
  assert.equal(hebauGradeToGP("100"), 5);
  assert.equal(hebauGradeToGP("85"), 3.5);
  assert.equal(hebauGradeToGP("60"), 1);
  assert.equal(hebauGradeToGP("59"), 0);
  assert.equal(hebauGradeToGP("优秀"), 4.5);
  assert.equal(hebauGradeToGP("及格"), 1.5);
});

test("通过型与未考标记返回 null（不参与 GPA），与 0 分是两回事", async () => {
  const { hebauGradeToGP, isHebauPassFail } = await import("../src/adapters/hebau/grades");
  for (const score of ["合格", "通过", "免修", "免考", "缓考", "缺考", ""]) {
    assert.equal(hebauGradeToGP(score), null, score);
  }
  assert.equal(hebauGradeToGP("不及格"), 0);
  assert.equal(isHebauPassFail("合格"), true);
  assert.equal(isHebauPassFail("中等"), false);
});

test("必修判定认 URP 的性质代码 001，也认中文", async () => {
  const { isHebauRequired } = await import("../src/adapters/hebau/grades");
  assert.equal(isHebauRequired("001"), true);
  assert.equal(isHebauRequired("必修"), true);
  assert.equal(isHebauRequired("专业选修"), false);
});

test("重修去重按「课程号+性质」，多学期同名课不被合并吞学分", async () => {
  const { dedupeGrades } = await import("../src/adapters/hebau/grades");
  const courses = [
    {
      course: "大学英语1",
      courseCode: "A01",
      score: "72",
      credit: "2",
      type: "必修",
      semester: "2024-2025-1",
    },
    {
      course: "大学英语2",
      courseCode: "A02",
      score: "80",
      credit: "2",
      type: "必修",
      semester: "2024-2025-2",
    },
    {
      course: "高等数学",
      courseCode: "B01",
      score: "55",
      credit: "4",
      type: "必修",
      semester: "2024-2025-1",
    },
    {
      course: "高等数学",
      courseCode: "B01",
      score: "78",
      credit: "4",
      type: "必修",
      semester: "2025-2026-1",
    },
  ];
  const deduped = dedupeGrades(courses);
  assert.equal(deduped.length, 3);
  assert.ok(deduped.find((g) => g.courseCode === "B01")?.score === "78");
});

// ── 学期探测与节次表 ─────────────────────────────────────────

test("候选学期探测：在南工大月份区间上与 core 实现逐月等价", async () => {
  const { candidateTermsIn } = await import("../src/adapters/hebau/academics");
  const { candidateTerms } = await import("../src/core/academic-utils");
  for (let month = 1; month <= 12; month++) {
    const now = new Date(2026, month - 1, 10);
    assert.deepEqual(
      candidateTermsIn([2, 6], now),
      candidateTerms(now),
      `${month} 月的候选学期与 core 实现不一致`,
    );
  }
});

test("候选学期探测：河北农大春夏学期覆盖到 7 月，7 月不提前探秋学期", async () => {
  const { candidateTermsIn } = await import("../src/adapters/hebau/academics");
  const july = new Date(2026, 6, 10);
  assert.deepEqual(candidateTermsIn([2, 7], july), [
    { year: 2025, semester: 12 },
    { year: 2025, semester: 3 },
  ]);
  assert.deepEqual(candidateTermsIn([2, 7], new Date(2026, 7, 10))[0], { year: 2026, semester: 3 });
});

test("两校节次表不同，且各自的表都完整到第 10 节", async () => {
  const { HEBAU_PERIOD_TIMES } = await import("../src/adapters/hebau/academics");
  const { NJTECH_PERIOD_TIMES } = await import("../src/adapters/njtech/academics");
  assert.equal(NJTECH_PERIOD_TIMES["1"], "08:10-08:55");
  assert.equal(HEBAU_PERIOD_TIMES["1"], "08:00-08:45");
  for (const table of [NJTECH_PERIOD_TIMES, HEBAU_PERIOD_TIMES]) {
    for (let p = 1; p <= 10; p++) assert.ok(table[String(p)], `缺第 ${p} 节`);
  }
});

// ── 校历按学校分开 ───────────────────────────────────────────

test("河北农大校历：开学日期独立存独立取，不与南工大共用一份真值", async () => {
  const hebau = await import("../src/adapters/hebau/term-dates");
  const njtech = await import("../src/adapters/njtech/term-dates");
  // 2026 秋：9 月 1 日（周二）开课，教学周自包含该日的周一 08-31 起
  const fall = hebau.resolveWeek1Monday(2026, 3);
  assert.equal(fall.week1Monday, "2026-08-31");
  assert.match(fall.evidence ?? "", /09-01/);
  // 2027 春夏：周一 2027-03-01
  assert.equal(hebau.resolveWeek1Monday(2026, 12).week1Monday, "2027-03-01");
  // 两校真值各自独立成文件，写入互不影响
  const dir = process.env.RAPTOR_DATA_DIR ?? "";
  assert.ok(fs.existsSync(path.join(dir, "term-dates-hebau.json")), "河农大应落到自己的校历文件");
  assert.equal(hebau.termKey(2026, 3), "2026-1", "学期 key 与 njtech 同格式（各自文件内自洽）");
  hebau.recordWeek1Monday(2027, 3, "2027-08-30", "recorded", "测试记录");
  assert.equal(hebau.resolveWeek1Monday(2027, 3).week1Monday, "2027-08-30");
  // njtech 侧不受污染
  assert.notEqual(njtech.resolveWeek1Monday(2027, 3).week1Monday, "2027-08-30");
});

// ── 适配器装配 ───────────────────────────────────────────────

test("hebauSchool：info/capabilities/terms/tools/promptSections 都按端口装配", async () => {
  const { hebauSchool } = await import("../src/adapters/hebau");
  assert.equal(hebauSchool.info.id, "hebau");
  assert.equal(hebauSchool.info.name, "河北农业大学");
  assert.equal(hebauSchool.info.city, "保定");
  assert.equal(hebauSchool.info.manual, undefined);
  assert.deepEqual([...hebauSchool.capabilities].sort(), [
    "calendarExport",
    "exams",
    "grades",
    "schedule",
  ]);
  // 没接入的能力绝不能出现在清单里（选课/学籍/实验成绩/通知都没有端点）
  for (const cap of [
    "student",
    "enrolledCourses",
    "retakeCourses",
    "labGrades",
    "courseSelection",
    "notices",
  ]) {
    assert.equal(
      (hebauSchool.capabilities as readonly string[]).includes(cap),
      false,
      `${cap} 不该被声明为已支持`,
    );
  }
  // 学期口径：秋冬/春夏展示名 + 本校节次表
  assert.equal(hebauSchool.terms.label(2026, 3), "2026-2027学年秋冬学期");
  assert.equal(hebauSchool.terms.label(2026, 12), "2026-2027学年春夏学期");
  assert.equal(hebauSchool.terms.periodTime(1), "08:00-08:45");
  assert.equal(hebauSchool.terms.periodTimeRange([7, 8]), "16:20-18:00");
  // 工具：有 query/auth-code 族，没有 news/选课族
  const toolNames = Object.keys(hebauSchool.tools);
  for (const wanted of [
    "get_schedule",
    "get_grades",
    "get_exams",
    "export_calendar",
    "submit_auth_code",
  ])
    assert.ok(toolNames.includes(wanted), `缺工具 ${wanted}`);
  for (const absent of [
    "get_news",
    "read_notice",
    "get_student_info",
    "grab_course",
    "get_lab_grades",
  ])
    assert.ok(!toolNames.includes(absent), `不该有工具 ${absent}`);
  // 提示词段：二次认证指引 + 5.0 口径 + 未接入能力如实说明
  const sections = hebauSchool.promptSections({ enableGrab: true });
  assert.match(sections.tools, /submit_auth_code/);
  assert.match(sections.background, /5\.0 满绩/);
  assert.match(sections.background, /未接入能力/);
  // 二次认证端口
  assert.equal(typeof hebauSchool.auth.submitSecondFactor, "function");
});

test('selectSchool("hebau") 运行期切换成功，school() 随之生效', async () => {
  const { registerSchoolOption, school, selectSchool } = await import("../src/core/school");
  const { hebauSchool } = await import("../src/adapters/hebau");
  const { njtechSchool } = await import("../src/adapters/njtech");
  registerSchoolOption(njtechSchool);
  registerSchoolOption(hebauSchool);
  assert.equal(selectSchool("hebau"), true);
  assert.equal(school().info.id, "hebau");
  assert.equal(school().terms.periodTime(1), "08:00-08:45");
  selectSchool("njtech");
  assert.equal(school().info.id, "njtech");
});

// ── 抓取链路（传输层注入假响应）──────────────────────────────

test("河北农大课表请求：XNXQDM 正确编码，空数据不当失败", async () => {
  const { setTransportForTest } = await import("../src/adapters/hebau/http");
  const { fetchHebauSchedule } = await import("../src/adapters/hebau/schedule");
  const seen: string[] = [];
  setTransportForTest(async (url, opts) => {
    seen.push(`${url}|${opts.body ?? ""}`);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        datas: {
          cxxszhxqkb: {
            rows: [
              {
                KCMC: "作物育种学",
                XQJ: "2",
                SKJC: "3",
                JSJC: "4",
                SKZC: "1-12周",
                JASMC: "A305",
                SKJS: "李老师",
              },
            ],
          },
        },
      }),
    };
  });
  try {
    const r = await fetchHebauSchedule("GS_SESSIONID=x", 2026, 3);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data[0]?.title, "作物育种学");
    assert.deepEqual(r.data[0]?.periods, [3, 4]);
    assert.match(seen[0] ?? "", /XNXQDM=2026-2027-1/);
  } finally {
    setTransportForTest(null);
  }
});

test("教务系统返回 HTML 登录页时报「会话已失效」，不报「没课」；Smart 层抛 SESSION_EXPIRED", async () => {
  const { setTransportForTest } = await import("../src/adapters/hebau/http");
  const { fetchHebauSchedule } = await import("../src/adapters/hebau/schedule");
  const { fetchScheduleSmart } = await import("../src/adapters/hebau/academics");
  const { isSessionExpiredError } = await import("../src/core/errors");
  setTransportForTest(async () => ({
    status: 200,
    headers: {},
    body: "<!DOCTYPE html><html><body>统一认证</body></html>",
  }));
  try {
    const r = await fetchHebauSchedule("c", 2026, 3);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /页面而非数据/);
    assert.match(r.error, /会话已失效/);
    // Smart 层把「会话失效」翻译成可被 withAuthRetry 识别的 RaptorError
    await assert.rejects(
      () => fetchScheduleSmart("c", 2026, 3),
      (e: unknown) => isSessionExpiredError(e),
    );
  } finally {
    setTransportForTest(null);
  }
});

test("密码加密：输出为纯密文 base64，盐长非法时不提交登录", async () => {
  const { encryptPassword } = await import("../src/adapters/hebau/cas");
  const cipher = encryptPassword("mypassword", "0123456789abcdef");
  const bytes = Buffer.from(cipher, "base64");
  assert.equal(bytes.length % 16, 0, "AES-CBC 密文必须是整块");
  assert.ok(bytes.length >= 80, "64 位随机前缀 + 明文至少两个块");
  // 每次的随机前缀与 IV 都不同，所以同一密码两次结果必然不同
  assert.notEqual(cipher, encryptPassword("mypassword", "0123456789abcdef"));
  assert.throws(() => encryptPassword("x", "tooshort"), /加密参数异常/);
});

test("成绩全链路：分学期抓取→重修去重→5.0 GPA 聚合（假传输层）", async () => {
  const { setTransportForTest } = await import("../src/adapters/hebau/http");
  const { fetchHebauGrades } = await import("../src/adapters/hebau/grades");
  // 按学号推入学年份：2023010101 → 从 2023-1 学期问到今年；只有两个学期给数据
  const rowsFor: Record<string, Record<string, unknown>[]> = {
    "2025-2026-1": [
      { KCMC: "高等数学B", KCH: "B01", ZCJ: "85", XF: "4", KCXZDM: "001", XNXQDM: "2025-2026-1" },
      { KCMC: "军事技能", KCH: "J01", ZCJ: "合格", XF: "2", KCXZDM: "001", XNXQDM: "2025-2026-1" },
      { KCMC: "大学英语", KCH: "E01", ZCJ: "90", XF: "2", KCXZDM: "002", XNXQDM: "2025-2026-1" },
      { KCMC: "", XF: "99" }, // 合计行：必须被丢弃
    ],
    "2025-2026-2": [
      { KCMC: "数据结构", KCH: "C01", ZCJ: "92", XF: "3", KCXZDM: "001", XNXQDM: "2025-2026-2" },
    ],
    // 重修旧成绩：同课程号+性质，去重应保留 85 那条
    "2024-2025-1": [
      { KCMC: "高等数学B", KCH: "B01", ZCJ: "55", XF: "4", KCXZDM: "001", XNXQDM: "2024-2025-1" },
    ],
  };
  setTransportForTest(async (_url, opts) => {
    const semester =
      decodeURIComponent(opts.body ?? "").match(
        /XNXQDM\\?"?,?\s*\\?"?value\\?"?:\s*\\?"(\d{4}-\d{4}-\d)\\?"/,
      )?.[1] ?? "";
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datas: { xscjcx: { rows: rowsFor[semester] ?? [] } } }),
    };
  });
  try {
    const r = await fetchHebauGrades("GS_SESSIONID=x", "2023010101");
    // GPA = (3.5×4 + 4.2×3) / 7 = 3.8：军训「合格」移出分子分母、选修不计
    assert.equal(r.gpa, "3.80");
    assert.equal(r.requiredCredits, 7);
    assert.equal(r.requiredCourses, 3);
    assert.equal(r.passFailCredits, 2);
    assert.deepEqual(r.failedTerms, []);
    // 重修去重：高等数学B 只留 85 那条，英语（选修）仍在全部课程清单里
    assert.equal(r.allCourses.length, 4);
    assert.equal(r.allCourses.find((c) => c.courseCode === "B01")?.score, "85");
    assert.ok(r.allCourses.some((c) => c.course === "大学英语"));
    assert.match(r.gpaBasis ?? "", /5\.0 满绩/);
  } finally {
    setTransportForTest(null);
  }
});

// ── 缓存按学校隔离 ───────────────────────────────────────────

test("成绩/考试缓存记学校：切到别校后读不到，切回来还在", async () => {
  const { registerSchoolOption, selectSchool } = await import("../src/core/school");
  const { hebauSchool } = await import("../src/adapters/hebau");
  const { njtechSchool } = await import("../src/adapters/njtech");
  const { loadGradesCache, saveGradesCache } = await import("../src/core/grades-cache");
  const { loadExamCache, saveExamCache } = await import("../src/core/exam-cache");
  registerSchoolOption(njtechSchool);
  registerSchoolOption(hebauSchool);
  selectSchool("hebau");
  saveGradesCache({
    gpa: "3.42",
    requiredCredits: 60,
    courseCount: 20,
    recentCourses: [],
  });
  saveExamCache({ year: 2026, semester: 3, label: "2026-2027学年秋冬学期", exams: [] });
  assert.ok(loadGradesCache(), "写入校应能读回");
  assert.ok(loadExamCache(), "写入校应能读回");
  // 切到南工大：河农大的缓存不得冒充南工大数据
  selectSchool("njtech");
  assert.equal(loadGradesCache(), null);
  assert.equal(loadExamCache(), null);
  // 切回来：数据还在（不是被删了）
  selectSchool("hebau");
  assert.equal(loadGradesCache()?.gpa, "3.42");
  assert.ok(loadExamCache());
});
