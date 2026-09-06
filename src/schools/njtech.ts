/**
 * 南京工业大学适配器
 *
 * 这一层是「包装」而不是「重写」：src/jwgl/* 那套抓取模块本来就是南工大专用的
 * （jwgl.njtech.edu.cn + RSA 登录 + xnm/xqm 学期编码），搬进来只会平白制造两套真相。
 * 所以本文件只做三件事：声明本校能力清单与节次表、把三个抓取原语按 SchoolAdapter
 * 契约接上、把原来写死在系统提示词里的南工大专属事实挪到学校这边。
 */

import { fetchExamsFor, fetchScheduleFor, NJTECH_PERIOD_TIMES } from "../jwgl/academics";
import { BASE, loginJwgl } from "../jwgl/auth";
import { fetchAllGrades } from "../jwgl/grades";
import { NJTECH_TERM_SEED } from "./term-seeds";
import type { SchoolAdapter } from "./types";

const PROMPT_FACTS = `## 背景知识（重要）

- 教务系统是正方新版，选课模块为「自主选课 zzxkyzb」。
- 教务线路偶发抖动：登录失败会自动重试（最多 5 次），若工具报「登录失败」让用户稍后再试即可。
- 学校侧停用的模块（任何客户端都查不到）：空闲教室、班级课表、学业情况、实验课表、培养方案、站内通知。用户问这些时如实说明教务系统未开放该模块。

## 校历（2026-2027 学年，2026-08-30 按官方校历核对）

- 秋冬学期：注册 2026-08-29～08-30；第 1 周 2026-08-31（周一）～9-06，共 20 个教学周；本科新生报到 9-05～09-06（军训 9-14～09-30）
- 元旦 2027-01-01；寒假 2027-01-09～02-26（春节 2027-02-06）
- 春夏学期：注册 2027-02-27～02-28；第 1 周 2027-03-01（周一）；暑假 2027-07-10～08-27
- 周次计算的运行时真值是 data/term-dates.json（get_schedule 返回的 week1Monday/weekNote），此处仅为背景参照，两者不一致时以工具返回为准
- 具体哪天放假、哪天调休补课教务处临近才发通知，处理流程见行为准则第 12 条；校历原图存于 outputs/njtech-calendar-2026-2027.jpg`;

export const njtechAdapter: SchoolAdapter = {
  id: "njtech",
  name: "南京工业大学",
  city: "南京",
  jwglBase: BASE,
  newsDomains: ["njtech.edu.cn"],
  periodTimes: NJTECH_PERIOD_TIMES,
  // 南工大春夏学期覆盖 2～6 月
  secondSemesterMonths: [2, 6],
  capabilities: [
    "schedule",
    "grades",
    "exams",
    "generalElectives",
    "news",
    "notice",
    "student",
    "enrolledCourses",
    "retakeCourses",
    "labGrades",
    "courseSelection",
    "calendar",
  ],
  supportsSecondFactor: false,
  promptFacts: PROMPT_FACTS,
  termSeed: NJTECH_TERM_SEED,
  gpaBasis: "4.0 制，仅必修课计入",

  login: async ({ username, password }) => {
    const session = await loginJwgl(username, password);
    return { cookie: session.cookie, username: session.username };
  },
  fetchScheduleFor: (session, year, semester) => fetchScheduleFor(session.cookie, year, semester),
  fetchExamsFor: (session, year, semester) => fetchExamsFor(session.cookie, year, semester),
  fetchGrades: (session) => fetchAllGrades(session.cookie, session.username),
};
