/** 抢人文类网课：主目标+备选，抢到一门即停（真实提交） */
import { config } from "./src/config";
import { openXkSession, searchCourses, submitCourse } from "./src/jwgl/xk";

const CANDIDATES = ["中华诗词", "科学思想史", "科学哲学", "伦理学", "西方人文经典"];
const DEADLINE = Date.now() + 300 * 1000; // 5 分钟上限

let session = await openXkSession(config.jwglUsername, config.jwglPassword);
console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 会话就绪，轮次: ${session.rounds.map((r) => r.tabName || r.kklxdm).join("、")}`);

let idx = 0;
let fullRounds = 0;
let missRounds = 0;
let attempts = 0;

while (Date.now() < DEADLINE) {
  if (idx >= CANDIDATES.length) { console.log("备选已用尽，未抢到"); break; }
  const kw = CANDIDATES[idx];
  let courses;
  try {
    courses = await searchCourses(session, kw);
  } catch (e) {
    if ((e as Error).message === "SESSION_EXPIRED") { session = await openXkSession(config.jwglUsername, config.jwglPassword); continue; }
    console.log(`[${kw}] 查询异常: ${(e as Error).message.slice(0, 60)}`);
    await new Promise((r) => setTimeout(r, 2000));
    continue;
  }
  const matched = courses.filter((c) => c.courseName.includes(kw) || kw.includes(c.courseName));
  const avail = matched.filter((c) => c.remain > 0);

  if (avail.length > 0) {
    attempts++;
    const course = avail[0];
    const res = await submitCourse(session, course);
    if (res.ok) {
      console.log(`\n🎉 抢到！${course.courseName}（代码 ${course.courseCode}，教师 ${course.teacher || "网课"}）- ${res.message}`);
      break;
    }
    if (res.message === "SESSION_EXPIRED") { session = await openXkSession(config.jwglUsername, config.jwglPassword); continue; }
    console.log(`[${kw}] 提交失败: ${res.message}`);
  } else if (matched.length > 0) {
    fullRounds++;
    console.log(`[${kw}] 出现但满员（第 ${fullRounds} 轮）`);
    if (fullRounds >= 3) { console.log(`→ 切换备选 ${CANDIDATES[idx + 1] ?? "无"}`); idx++; fullRounds = 0; missRounds = 0; }
  } else {
    missRounds++;
    if (missRounds >= 5) { console.log(`→ ${kw} 未出现，切换备选 ${CANDIDATES[idx + 1] ?? "无"}`); idx++; missRounds = 0; fullRounds = 0; }
  }
  await new Promise((r) => setTimeout(r, 2500));
}
console.log(`\n结束。共提交 ${attempts} 次。`);
