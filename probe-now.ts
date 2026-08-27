/** 只读瞬时探测：12:00 通识轮是否上线 + 目标课程余量（不做任何提交） */
import { config } from "./src/config";
import { openXkSession, searchCourses } from "./src/jwgl/xk";

const session = await openXkSession(config.jwglUsername, config.jwglPassword);
console.log("iskxk =", session.isXkOpen);
console.log("轮次:", session.rounds.map((r) => `${r.tabName || r.kklxdm}(${r.kklxdm})`).join("、") || "（空）");

const targets = ["创造性思维", "中华诗词", "Triz", "创新创业基础", "科学思想史"];
for (const kw of targets) {
  const courses = await searchCourses(session, kw);
  if (courses.length) {
    for (const c of courses.slice(0, 3)) {
      console.log(`「${kw}」→ ${c.courseName} | 代码${c.courseCode} | 余量${c.remain}/${c.capacity} | 轮次${c.raw._roundTab || c.kklxdm}`);
    }
  } else {
    console.log(`「${kw}」→ 0 条`);
  }
}
