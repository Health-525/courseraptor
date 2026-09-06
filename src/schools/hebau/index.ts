/**
 * 河北农业大学适配器
 *
 * 认证：CAS 统一认证（cas.hebau.edu.cn，密码 AES-CBC 前端加密，可能触发动态码二次认证）
 * 数据：正方 URP 学生端（urp.hebau.edu.cn:1009，XHR .do 接口，学期用 XNXQDM 字符串）
 * 能力：课表 / 成绩 / 考试 / 日历导出。选课、学籍、实验成绩、教务通知没有对应端点，
 *      一律走 capability 门禁如实报「暂不支持」，不借用南工大的接口猜数据。
 */

import { HEBAU_PERIOD_TIMES } from "../period-times";
import { HEBAU_TERM_SEED } from "../term-seeds";
import type { SchoolAdapter } from "../types";
import { loginHebau } from "./cas";
import { fetchHebauExams } from "./exams";
import { fetchHebauGrades } from "./grades";
import { fetchHebauSchedule } from "./schedule";

export { HEBAU_PERIOD_TIMES };

const PROMPT_FACTS = `## 本校事实（河北农业大学）

- 认证走学校统一认证（CAS），教务数据来自正方 URP 学生端；统一认证在账密之后可能再要一个动态验证码（短信/微信/企业微信/邮箱/钉钉），工具会明确说「需要二次认证」并给出投递目标——这时向用户索要验证码，拿到后调 submit_auth_code，不要重复触发登录。
- 已接入能力：课表、成绩与 GPA、考试安排、日历导出（.ics）。
- 未接入能力（学校教务系统没有提供对应接口，工具会直接返回「暂不支持」）：自主选课/抢课、学籍个人信息、已选课程教学班、可重修课程、实验成绩、教务处通知列表与通知正文读取。用户问这些时如实说明本校尚未接入，建议去教务系统官网查看，不要拿其他学校的口径作答。
- 成绩绩点是 5.0 满绩制（百分制折算 = 分数/10 - 5），与南工大 4.0 制不可混用；GPA 只算必修课，合格/免修/缓考类不参与。
- 节次时间与南工大不同（第 1 节 08:00-08:45），说上课时间以工具返回的 time 字段为准，不要按印象推。
- 校历参照：2026-2027 学年秋冬学期第 1 周自 2026-09-01（周一）起，春夏学期第 1 周自 2027-03-01（周一）起；周次计算以 get_schedule 返回的 week1Monday/weekSource 为准，weekSource=estimated 时要说明是估算值。
- 寒暑假与法定节假日安排学校没有开放接口也没有落盘记录时，回答「以学校通知/校历为准」，不要凭印象给具体日期。`;

export const hebauAdapter: SchoolAdapter = {
  id: "hebau",
  name: "河北农业大学",
  city: "保定",
  jwglBase: "http://urp.hebau.edu.cn:1009",
  newsDomains: ["hebau.edu.cn"],
  periodTimes: HEBAU_PERIOD_TIMES,
  // 河北农大春夏学期覆盖 2～7 月（含 7 月初的考试周），比南工大宽一个月
  secondSemesterMonths: [2, 7],
  capabilities: ["schedule", "grades", "exams", "calendar"],
  supportsSecondFactor: true,
  promptFacts: PROMPT_FACTS,
  termSeed: HEBAU_TERM_SEED,
  gpaBasis: "5.0 满绩制，仅必修课计入",

  login: (input) => loginHebau(input),
  fetchScheduleFor: (session, year, semester) => fetchHebauSchedule(session.cookie, year, semester),
  fetchExamsFor: (session, year, semester) => fetchHebauExams(session.cookie, year, semester),
  fetchGrades: (session) => fetchHebauGrades(session.cookie, session.username),
};
