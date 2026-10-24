/**
 * 手动成绩工具：edit_grades
 *
 * 仅「其他学校/手动课表」模式：没有教务系统可查，成绩靠用户在对话里
 * 报分逐门记录（写入 data/grades-cache.json，成绩面板即时可见）。
 * 教务已适配学校的成绩以官方查询为准（get_grades 落盘），本地一律
 * 不给改——GPA 是学校口径的派生量，手改必然失真，工具直接拒绝并说明。
 *
 * 面板顶部「GPA」展示的是记录的按学分加权平均分，gpaBasis 标注
 * 「手动记录」口径，与教务 GPA 严格区分。
 */

import { tool } from "ai";
import { z } from "zod";

import { loadGradesCache, saveGradesCache } from "../grades-cache";
import { deleteJsonCache } from "../json-cache";
import type { GradeCourse } from "../model";
import { registeredSchool } from "../school";

function manualMode(): boolean {
  const school = registeredSchool();
  return !school || Boolean(school.info.manual);
}

const numericScore = (s: string): number | null => {
  const v = Number(s.trim());
  return Number.isFinite(v) ? v : null;
};

const numericCredit = (c: string): number | null => {
  const v = Number(c.trim());
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** 面板速览行的字段口径（allCourses 存完整 GradeCourse） */
const briefOf = (c: GradeCourse) => ({
  course: c.course,
  score: c.score,
  credit: c.credit,
  type: c.type,
  semester: c.semester,
});

/** 全量记录重算派生量并落盘；记录删空则移除缓存，面板回到空态 */
function persist(courses: GradeCourse[]): void {
  if (!courses.length) {
    deleteJsonCache("grades-cache.json", "grades-cache");
    return;
  }
  const scored = courses.filter(
    (c) => numericScore(c.score) !== null && numericCredit(c.credit) !== null,
  );
  const creditSum = scored.reduce((sum, c) => sum + (numericCredit(c.credit) ?? 0), 0);
  const gpa = scored.length
    ? (
        scored.reduce(
          (sum, c) => sum + (numericScore(c.score) ?? 0) * (numericCredit(c.credit) ?? 0),
          0,
        ) / creditSum
      ).toFixed(2)
    : "—";
  const credits = courses.reduce((sum, c) => sum + (numericCredit(c.credit) ?? 0), 0);
  const semesters = [...new Set(courses.map((c) => c.semester).filter(Boolean))].sort();
  const recent = semesters.length ? semesters[semesters.length - 1] : undefined;
  saveGradesCache({
    gpa,
    gpaBasis: "手动记录 · 按学分加权平均分（非教务 GPA）",
    requiredCredits: Math.round(credits * 100) / 100,
    courseCount: courses.length,
    ...(recent ? { recentSemester: recent } : {}),
    recentCourses: (recent ? courses.filter((c) => c.semester === recent) : courses).map(briefOf),
    allCourses: courses,
  });
}

function indexError(id: string): string {
  return `条目 id 无效：${id}。id 来自上一次 list 结果，成绩有增删后请重新 list。`;
}

export const gradeEditTools = {
  edit_grades: tool({
    description:
      "手动记录成绩（仅「其他学校/手动课表」模式可用，写入本地缓存，成绩面板立即显示；" +
      "教务已适配学校的成绩以官方查询为准，本工具会直接拒绝，不要绕过）。用户报成绩" +
      "（「高数考了 92，4 学分」「记一下上学期成绩：…」）时调 add 逐门记" +
      "（course+score 必填，credit 建议带上否则不计入平均分，semester 形如 2026-2027-1 便于按学期分组）；" +
      "问「我记录了哪些成绩」用 list（先拿 id）；改分/改学分用 update；删记录用 delete。" +
      "面板顶部按学分加权平均分展示并标注「手动记录」口径——如实说明这不是教务 GPA。",
    inputSchema: z.object({
      action: z
        .enum(["list", "add", "update", "delete"])
        .describe(
          "list=列出已记录成绩（拿 id），add=批量记录，update=按 id 改，delete=按 ids 批量删除",
        ),
      items: z
        .array(
          z.object({
            course: z.string().describe("课程名（≤60 字），如「高等数学」"),
            score: z.string().describe("分数或等级（如「92」「优」），≤10 字"),
            credit: z.string().optional().describe("学分（如「4」「3.5」），不填不计入平均分"),
            type: z
              .string()
              .optional()
              .describe("课程类型（如「必修」「选修」），默认「手动记录」"),
            semester: z.string().optional().describe("学期（如 2026-2027-1），便于按学期分组"),
          }),
        )
        .optional()
        .describe("add 必填：一批成绩（至多 30 门）"),
      id: z.string().optional().describe("目标条目 id（update 必填，来自 list 结果）"),
      ids: z.array(z.string()).optional().describe("delete 必填：要删除的条目 id 列表"),
      course: z.string().optional().describe("update 时的新课程名"),
      score: z.string().optional().describe("update 时的新分数"),
      credit: z.string().optional().describe("update 时的新学分"),
      type: z.string().optional().describe("update 时的新类型"),
      semester: z.string().optional().describe("update 时的新学期"),
    }),
    execute: async ({ action, items, id, ids, course, score, credit, type, semester }) => {
      if (!manualMode()) {
        return {
          error:
            "成绩来自教务官方查询（get_grades），本地不可修改，防止 GPA 口径失真。" +
            "手动记录仅支持「其他学校/手动课表」模式；请如实告诉用户当前学校的成绩以教务为准。",
        };
      }
      // 老缓存可能只有速览行没有全量 allCourses：以其为底继续记
      const cached = loadGradesCache();
      let courses: GradeCourse[] = [];
      if (cached?.allCourses?.length) {
        courses = structuredClone(cached.allCourses);
      } else if (cached?.recentCourses?.length) {
        courses = cached.recentCourses.map((c) => ({
          course: c.course,
          score: String(c.score),
          credit: String(c.credit),
          type: c.type ?? "手动记录",
          semester: c.semester,
        }));
      }

      if (action === "list") {
        return {
          summary: courses.length ? `已记录 ${courses.length} 门成绩` : "还没有记录过成绩",
          entries: courses.map((c, i) => ({ id: String(i), ...briefOf(c) })),
          ...(cached?.recentSemester ? { recentSemester: cached.recentSemester } : {}),
          ...(courses.length ? {} : { note: "用户报成绩即可记录（如「高数考了 92，4 学分」）" }),
        };
      }

      if (action === "add") {
        if (!items?.length) return { error: "add 需要 items（至少一门成绩）" };
        if (items.length > 30) return { error: "一次最多记录 30 门成绩" };
        const added: Array<{ id: string; course: string }> = [];
        for (const item of items) {
          const name = item.course?.trim();
          if (!name) return { error: "每门成绩都需要 course（课程名）" };
          if (!item.score?.trim()) return { error: `「${name}」需要 score（分数或等级）` };
          if (item.credit?.trim() && numericCredit(item.credit) === null) {
            return { error: `「${name}」的学分无效：${item.credit}（应为正数，如「4」「3.5」）` };
          }
          courses.push({
            course: name.slice(0, 60),
            score: item.score.trim().slice(0, 10),
            credit: (item.credit?.trim() ?? "").slice(0, 10),
            type: (item.type?.trim() || "手动记录").slice(0, 20),
            semester: (item.semester?.trim() ?? "").slice(0, 20),
          });
          added.push({ id: String(courses.length - 1), course: name.slice(0, 60) });
        }
        persist(courses);
        return {
          ok: true,
          summary: `已记录 ${added.length} 门成绩（共 ${courses.length} 门，面板按学分加权平均分展示）`,
          added,
        };
      }

      if (action === "update") {
        const i = Number(id);
        if (!Number.isInteger(i) || i < 0 || i >= courses.length)
          return { error: indexError(String(id)) };
        const old = courses[i];
        if (!old) return { error: indexError(String(id)) };
        const next: GradeCourse = { ...old };
        if (course !== undefined) {
          const name = course.trim();
          if (!name) return { error: "course 不能改为空" };
          next.course = name.slice(0, 60);
        }
        if (score !== undefined) {
          const value = score.trim();
          if (!value) return { error: "score 不能改为空" };
          next.score = value.slice(0, 10);
        }
        if (credit !== undefined) {
          if (credit.trim() && numericCredit(credit) === null) {
            return { error: `学分无效：${credit}（应为正数或留空）` };
          }
          next.credit = credit.trim().slice(0, 10);
        }
        if (type !== undefined) next.type = type.trim().slice(0, 20) || "手动记录";
        if (semester !== undefined) next.semester = semester.trim().slice(0, 20);
        courses[i] = next;
        persist(courses);
        return {
          ok: true,
          summary: `已改成绩：${old.course} ${old.score} → ${next.course} ${next.score}`,
          entry: { id: String(i), ...briefOf(next) },
        };
      }

      // delete
      if (!ids?.length) return { error: "delete 需要 ids（来自 list 结果的条目 id 列表）" };
      const targets: number[] = [];
      for (const raw of ids) {
        const i = Number(raw);
        if (!Number.isInteger(i) || i < 0 || i >= courses.length) return { error: indexError(raw) };
        targets.push(i);
      }
      const dropped = [...new Set(targets)];
      const removed = dropped.map((i) => {
        const c = courses[i];
        return c ? `${c.course}（${c.score}）` : `#${i}`;
      });
      for (const i of dropped.sort((a, b) => b - a)) courses.splice(i, 1);
      persist(courses);
      return {
        ok: true,
        summary: courses.length
          ? `已删除 ${dropped.length} 门成绩，剩余 ${courses.length} 门`
          : `已删除全部 ${dropped.length} 门成绩，成绩面板回到空态`,
        removed,
        remaining: courses.length,
        note: courses.length ? undefined : "id 是删除前的下标，已随删除失效。",
      };
    },
  }),
};
