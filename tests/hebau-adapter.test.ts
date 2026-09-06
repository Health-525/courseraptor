/**
 * 河北农大适配器的离线单测：只测纯逻辑与配置隔离，绝不打真实教务系统。
 *
 * 三件必须钉住的事：
 * 1. 行归一（URP 字段名大小写混杂、周次带「周」字、节次给区间）；
 * 2. 5.0 绩点口径：通过型/缓考不参与计算（返回 null），不是 0 分；
 * 3. 多校隔离：候选学期探测在与南工大旧实现上逐月等价；换校后能力门禁生效；
 *    凭证属于另一所学校时不得被采用（那是凭证外泄路径）。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "../src/config";
import { candidateXnxqList } from "../src/jwgl/academics";
import { resolveWeek1Monday } from "../src/jwgl/term-dates";
import type { GradeCourse } from "../src/jwgl/types";
import { encryptPassword } from "../src/schools/hebau/cas";
import { dedupeExams, parseExamDate, toExamRow } from "../src/schools/hebau/exams";
import {
  dedupeGrades,
  hebauGradeToGP,
  isHebauPassFail,
  isHebauRequired,
} from "../src/schools/hebau/grades";
import { normalizeWeekSpec, parsePeriodRange, toCourseRow } from "../src/schools/hebau/schedule";
import { extractUrpRows, xnxqdm } from "../src/schools/hebau/urp";
import { normalizeSchoolId } from "../src/schools/ids";
import { HEBAU_PERIOD_TIMES, NJTECH_PERIOD_TIMES } from "../src/schools/period-times";
import { candidateTerms } from "../src/schools/probe";
import { activeSchool, resetSchoolCache } from "../src/schools/registry";
import {
  CAPABILITY_LABELS,
  supportsCapability,
  unsupportedCapabilityMessage,
} from "../src/schools/types";

/** 恢复 config.school，免得一个改过学校的用例污染后面的文件 */
const originalSchool = config.school;
after(() => {
  config.school = originalSchool;
  resetSchoolCache();
});

function withSchool<T>(id: string, run: () => T): T {
  config.school = id;
  resetSchoolCache();
  try {
    return run();
  } finally {
    config.school = originalSchool;
    resetSchoolCache();
  }
}

// ── 学期编码与行归一 ─────────────────────────────────────────

test("xnxqdm: 内部学期码（3/12）换算成 URP 的 XNXQDM 字符串", () => {
  assert.equal(xnxqdm(2026, 3), "2026-2027-1");
  assert.equal(xnxqdm(2025, 12), "2025-2026-2");
});

test("课表行归一：小写字段、区间节次、带「周」字的周次都能收正", () => {
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

test("课表行归一：课程名为空的统计行丢弃，单节课不被补成两节", () => {
  assert.equal(toCourseRow({ xqj: "1", skjc: "3" }), null);
  const single = toCourseRow({ KCMC: "体育", XQJ: "2", SKJC: "5" });
  assert.deepEqual(single?.periods, [5]);
});

test("normalizeWeekSpec: 去「周」与空白，保留单双周标记", () => {
  assert.equal(normalizeWeekSpec("2-6,8-12周"), "2-6,8-12");
  assert.equal(normalizeWeekSpec("1-20 周"), "1-20");
  assert.equal(normalizeWeekSpec("3-16周(双)"), "3-16(双)");
});

test("parsePeriodRange: 只给开始节时按 1 节算，不再默认连堂 2 节", () => {
  assert.deepEqual(parsePeriodRange({ SKJC: "7" }), [7]);
  assert.deepEqual(parsePeriodRange({ SKJC: "7", SKCD: "3" }), [7, 8, 9]);
  assert.deepEqual(parsePeriodRange({}), []);
});

test("extractUrpRows: 考试接口把行拆成 arranged/notArranged 也要合并取到", () => {
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

test("考试行归一：日期与时间同串时拆开，未排期的行保留", () => {
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

test("考试去重：同键留信息更全的那条", () => {
  const deduped = dedupeExams([
    { subject: "A", date: "2026-06-20", time: "08:00", location: "" },
    { subject: "A", date: "2026-06-20", time: "08:00", location: "3教101", seatNumber: "5" },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].location, "3教101");
});

// ── 成绩口径 ──────────────────────────────────────────────────

test("河北农大 5.0 绩点：百分制折算与等级制映射", () => {
  assert.equal(hebauGradeToGP("100"), 5);
  assert.equal(hebauGradeToGP("85"), 3.5);
  assert.equal(hebauGradeToGP("60"), 1);
  assert.equal(hebauGradeToGP("59"), 0);
  assert.equal(hebauGradeToGP("优秀"), 4.5);
  assert.equal(hebauGradeToGP("及格"), 1.5);
});

test("通过型与未考标记返回 null（不参与 GPA），与 0 分是两回事", () => {
  for (const score of ["合格", "通过", "免修", "免考", "缓考", "缺考", ""]) {
    assert.equal(hebauGradeToGP(score), null, score);
  }
  assert.equal(hebauGradeToGP("不及格"), 0);
  assert.equal(isHebauPassFail("合格"), true);
  assert.equal(isHebauPassFail("中等"), false);
});

test("必修判定认 URP 的性质代码 001，也认中文", () => {
  assert.equal(isHebauRequired("001"), true);
  assert.equal(isHebauRequired("必修"), true);
  assert.equal(isHebauRequired("专业选修"), false);
});

test("重修去重按「课程号+性质」，多学期同名课不被合并吞学分", () => {
  const courses: GradeCourse[] = [
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

// ── 学校隔离与门禁 ───────────────────────────────────────────

test("候选学期探测：在南工大月份区间上与旧实现逐月等价", () => {
  for (let month = 1; month <= 12; month++) {
    const now = new Date(2026, month - 1, 10);
    assert.deepEqual(
      candidateTerms([2, 6], now),
      candidateXnxqList(now),
      `${month} 月的候选学期与 NJTECH 原实现不一致`,
    );
  }
});

test("候选学期探测：河北农大春夏学期覆盖到 7 月，7 月不提前探秋学期", () => {
  const july = new Date(2026, 6, 10);
  assert.deepEqual(candidateTerms([2, 7], july), [
    { year: 2025, semester: 12 },
    { year: 2025, semester: 3 },
  ]);
  assert.deepEqual(candidateTerms([2, 7], new Date(2026, 7, 10))[0], { year: 2026, semester: 3 });
});

test("两校节次表不同，且各自的表都完整到第 10 节", () => {
  assert.equal(NJTECH_PERIOD_TIMES["1"], "08:10-08:55");
  assert.equal(HEBAU_PERIOD_TIMES["1"], "08:00-08:45");
  for (const table of [NJTECH_PERIOD_TIMES, HEBAU_PERIOD_TIMES]) {
    for (let p = 1; p <= 10; p++) assert.ok(table[String(p)], `缺第 ${p} 节`);
  }
});

test("RAPTOR_SCHOOL 未知值硬失败，不回退默认学校", () => {
  assert.equal(normalizeSchoolId(undefined), "njtech");
  assert.equal(normalizeSchoolId("  HEBau "), "hebau");
  assert.throws(() => normalizeSchoolId("tsinghua"), /不是已知学校/);
});

test("河北农大：能力清单只含已接入项，门禁话术说清是「学校没接口」", () => {
  withSchool("hebau", () => {
    const school = activeSchool();
    assert.equal(school.name, "河北农业大学");
    assert.equal(school.city, "保定");
    assert.equal(school.supportsSecondFactor, true);
    assert.equal(supportsCapability(school, "schedule"), true);
    for (const cap of [
      "courseSelection",
      "student",
      "labGrades",
      "news",
      "generalElectives",
      "retakeCourses",
      "enrolledCourses",
    ] as const) {
      assert.equal(supportsCapability(school, cap), false, `${cap} 不该被声明为已支持`);
    }
    const msg = unsupportedCapabilityMessage(school, "courseSelection");
    assert.match(msg, /河北农业大学/);
    assert.match(msg, /没有提供对应接口/);
    assert.match(school.promptFacts, /submit_auth_code/);
  });
});

test("南工大：全部能力在册，提示词带上本校教务形态与校历", () => {
  const school = activeSchool();
  assert.equal(school.name, "南京工业大学");
  assert.equal(school.supportsSecondFactor, false);
  for (const cap of Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[]) {
    assert.equal(supportsCapability(school, cap as never), true, `NJTECH 缺能力 ${cap}`);
  }
  assert.match(school.promptFacts, /自主选课/);
  assert.match(school.promptFacts, /第 1 周 2026-08-31/);
});

test("校历按学校分开取：同一学期两所学校开学日不同，绝不共用一份真值", () => {
  const njtech = resolveWeek1Monday(2026, 3, "njtech");
  assert.equal(njtech.week1Monday, "2026-08-31");
  assert.match(njtech.evidence ?? "", /南工教〔2026〕91号/);
  const hebau = resolveWeek1Monday(2026, 3, "hebau");
  assert.equal(hebau.week1Monday, "2026-09-01");
  assert.notEqual(hebau.week1Monday, njtech.week1Monday);
});

test("河北农大课表请求：XNXQDM 正确编码，空数据不当失败", async () => {
  // 走真实解析链路，但把传输层换成假响应（见 hebau-cas-mfa.test.ts 的同款做法）
  const { setTransportForTest } = await import("../src/schools/hebau/http");
  const { fetchHebauSchedule } = await import("../src/schools/hebau/schedule");
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

test("教务系统返回 HTML 登录页时报「会话失效」，不报「没课」", async () => {
  const { setTransportForTest } = await import("../src/schools/hebau/http");
  const { fetchHebauSchedule } = await import("../src/schools/hebau/schedule");
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
  } finally {
    setTransportForTest(null);
  }
});

test("密码加密：输出为纯密文 base64，盐长非法时不提交登录", () => {
  const cipher = encryptPassword("mypassword", "0123456789abcdef");
  const bytes = Buffer.from(cipher, "base64");
  assert.equal(bytes.length % 16, 0, "AES-CBC 密文必须是整块");
  assert.ok(bytes.length >= 80, "64 位随机前缀 + 明文至少两个块");
  // 每次的随机前缀与 IV 都不同，所以同一密码两次结果必然不同
  assert.notEqual(cipher, encryptPassword("mypassword", "0123456789abcdef"));
  assert.throws(() => encryptPassword("x", "tooshort"), /加密参数异常/);
});
