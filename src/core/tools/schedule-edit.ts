/**
 * 课表修改：edit_schedule
 *
 * 调课/换教室换老师/加课/退课直写本地课表缓存（data/schedule-cache.json）。
 * 缓存是 get_schedule 与今日页的共同数据源，改完全端立即生效。首次修改前
 * 把原始导入课表快照为 base，revert 可整体还原；在线刷新/重新导入走
 * saveScheduleCache 覆盖式写入、隐含清掉 base——官方课表永远赢过本地手改。
 */

import { tool } from "ai";
import { z } from "zod";

import { expandWeeks, segmentsOverlap, WEEKDAY_NAMES } from "../academic-utils";
import type { CourseData, ScheduleResult, SkwjSegment } from "../model";
import { loadScheduleCache, saveScheduleEntry } from "../schedule-cache";

const MAX_PERIOD = 12;

const periodLabel = (periods: number[]) =>
  periods.length ? `${Math.min(...periods)}-${Math.max(...periods)}节` : "";

const courseLabel = (c: CourseData) =>
  [
    c.title,
    WEEKDAY_NAMES[c.weekday] ?? `周${c.weekday}`,
    periodLabel(c.periods),
    `第${c.weeks}周`,
    c.location,
    c.teacher,
  ]
    .filter(Boolean)
    .join(" · ");

const segmentOf = (c: CourseData): SkwjSegment => ({
  weekday: c.weekday,
  periods: c.periods,
  weeks: c.weeks,
  expandedWeeks: expandWeeks(c.weeks),
});

/** 目标时段与其余课程的重叠冲突，返回冲突课程描述列表 */
function conflictsOf(
  courses: CourseData[],
  targetCourse: CourseData,
  excludeIndex: number,
): string[] {
  const targetSeg = segmentOf(targetCourse);
  const out: string[] = [];
  courses.forEach((c, i) => {
    if (i === excludeIndex) return;
    if (segmentsOverlap(targetSeg, segmentOf(c))) {
      out.push(
        `「${c.title}」${WEEKDAY_NAMES[c.weekday] ?? ""} ${periodLabel(c.periods)}（第${c.weeks}周）`,
      );
    }
  });
  return out;
}

/** list 给模型看的条目视图：id 是数组下标（改动后会变，每次改前重新 list） */
const viewOf = (c: CourseData, id: string) => ({
  id,
  title: c.title,
  weekday: c.weekday,
  weekdayLabel: WEEKDAY_NAMES[c.weekday] ?? `周${c.weekday}`,
  periods: c.periods,
  periodsLabel: periodLabel(c.periods),
  weeks: c.weeks,
  ...(c.location ? { location: c.location } : {}),
  ...(c.teacher ? { teacher: c.teacher } : {}),
});

/** 节次入参收整：去重升序；越界节次视为非法 */
function sanitizePeriods(input: number[]): number[] | null {
  const valid = input.every((p) => Number.isInteger(p) && p >= 1 && p <= MAX_PERIOD);
  if (!valid) return null;
  return [...new Set(input)].sort((a, b) => a - b);
}

function indexError(id: string): string {
  return `条目 id 无效：${id}。id 来自上一次 list 结果，课表有增删后请重新 list。`;
}

export const scheduleEditTools = {
  edit_schedule: tool({
    description:
      "修改本地课表缓存（调课/换教室换老师/加课/退课，持久保存，对 get_schedule 与今日页立即生效；最初导入的课表留有快照，revert 可整体还原）。教务通知调课、用户说「把 X 挪到周几第几节」「X 换教室/换老师」「加了/退了课」时调用。先 list 拿各时段条目 id（一门课一周多个时段就是多条），update 按 id 改（weekday/periods/weeks/location/teacher/title 传哪个改哪个），add 新增（title/weekday/periods 必填，weeks 默认 1-16），delete 按 ids 批量删，revert 撤销全部本地修改。改前先核对用户说的课确实在课表里、id 没拿错；目标时段与已有课冲突会报错并列出冲突课，用户明确确认「就调到那」再传 allowConflict 重试。",
    inputSchema: z.object({
      action: z
        .enum(["list", "update", "add", "delete", "revert"])
        .describe(
          "list=列出课表时段（拿 id），update=按 id 调课/改信息，add=新增一门课，delete=按 ids 批量删除，revert=还原最初导入的课表",
        ),
      id: z.string().optional().describe("目标时段 id（update 必填，来自 list 结果）"),
      ids: z.array(z.string()).optional().describe("delete 必填：要删除的时段 id 列表"),
      title: z.string().optional().describe("课程名（add 必填；update 改名）"),
      weekday: z
        .number()
        .int()
        .min(1)
        .max(7)
        .optional()
        .describe("星期几（1=周一…7=周日；add 必填，update 调课目标日）"),
      periods: z
        .array(z.number().int().min(1).max(12))
        .min(1)
        .optional()
        .describe("节次数组如 [1,2]（add 必填；update 调课目标节次）"),
      weeks: z
        .string()
        .optional()
        .describe('周次表达式如 "1-16"、"2-6,8-12(单)"；update/add 可选，add 默认 1-16'),
      location: z.string().optional().describe("上课地点（update 可传空串清空，add 省略为无）"),
      teacher: z.string().optional().describe("教师（update 可传空串清空，add 省略为无）"),
      allowConflict: z
        .boolean()
        .optional()
        .describe("目标时段与已有课冲突时是否仍写入（默认否，须用户明确确认）"),
    }),
    execute: async ({
      action,
      id,
      ids,
      title,
      weekday,
      periods,
      weeks,
      location,
      teacher,
      allowConflict,
    }) => {
      const cached = loadScheduleCache();
      if (!cached) {
        return {
          error:
            "还没有课表缓存：请先在 设置 → 学校 → 导入课表，或先调 get_schedule 查一次课表落盘。修改前先 list 看清现状，不要凭印象改。",
        };
      }
      // base：首次编辑时快照原始课表（revert 用）；本次未动 base 语义
      const base: ScheduleResult = cached.base
        ? structuredClone(cached.base)
        : structuredClone(cached.schedule);
      const schedule: ScheduleResult = structuredClone(cached.schedule);
      const courses = schedule.courses;

      if (action === "list") {
        const entries = courses.map((c, i) => viewOf(c, String(i)));
        return {
          summary: `${courses.length} 个课表时段${cached.base ? "（含本地修改，revert 可还原最初导入版）" : ""}`,
          term: schedule.label,
          entries,
          ...(cached.base
            ? { note: "部分时段经过本地调课；最初导入的课表可用 revert 整体还原" }
            : {}),
        };
      }

      if (action === "revert") {
        if (!cached.base) return { error: "课表没有本地修改，无需还原" };
        const restored = structuredClone(cached.base);
        saveScheduleEntry({ savedAt: Date.now(), schedule: restored });
        return {
          ok: true,
          summary: `已还原为最初导入的课表（${restored.courses.length} 个时段）`,
          count: restored.courses.length,
        };
      }

      if (action === "delete") {
        if (!ids?.length) return { error: "delete 需要 ids（来自 list 结果的时段 id 列表）" };
        const targets: number[] = [];
        for (const raw of ids) {
          const i = Number(raw);
          if (!Number.isInteger(i) || i < 0 || i >= courses.length)
            return { error: indexError(raw) };
          targets.push(i);
        }
        for (const i of [...new Set(targets)].sort((a, b) => b - a)) courses.splice(i, 1);
        saveScheduleEntry({ savedAt: Date.now(), schedule, base });
        return {
          ok: true,
          summary: `已删除 ${new Set(targets).size} 个时段，剩余 ${courses.length} 个`,
          remaining: courses.length,
          note: "id 是删除前的下标，现在已失效；再改先重新 list。",
        };
      }

      if (action === "add") {
        const name = title?.trim();
        if (!name) return { error: "add 需要 title（课程名）" };
        if (!weekday) return { error: "add 需要 weekday（1=周一…7=周日）" };
        if (!periods?.length) return { error: "add 需要 periods（节次数组，如 [1,2]）" };
        const cleanPeriods = sanitizePeriods(periods);
        if (!cleanPeriods) return { error: `节次非法（须为 1-${MAX_PERIOD} 的整数）` };
        const weekSpec = weeks?.trim() || "1-16";
        if (!expandWeeks(weekSpec).length)
          return { error: `周次表达式无法解析：${weekSpec}（如 "1-16"、"2-6,8-12(单)"）` };
        const entry: CourseData = {
          title: name.slice(0, 60),
          weekday,
          periods: cleanPeriods,
          weeks: weekSpec,
          location: location?.trim() ?? "",
          teacher: teacher?.trim() ?? "",
        };
        const conflicts = conflictsOf(courses, entry, -1);
        if (conflicts.length && !allowConflict) {
          return {
            error: `目标时段与已有课冲突：${conflicts.join("、")}。换时段，或用户明确确认后传 allowConflict 重试。`,
            conflicts,
          };
        }
        courses.push(entry);
        saveScheduleEntry({ savedAt: Date.now(), schedule, base });
        return {
          ok: true,
          summary: `已加课：${courseLabel(entry)}`,
          course: viewOf(entry, String(courses.length - 1)),
          ...(conflicts.length
            ? { warning: `与已有课冲突（用户已确认）：${conflicts.join("、")}` }
            : {}),
        };
      }

      // update：按 id 调课 / 改信息
      const i = Number(id);
      if (!Number.isInteger(i) || i < 0 || i >= courses.length)
        return { error: indexError(String(id)) };
      const old = courses[i];
      if (!old) return { error: indexError(String(id)) };
      const next: CourseData = { ...old };
      if (title !== undefined) {
        const name = title.trim();
        if (!name) return { error: "title 不能改为空" };
        next.title = name.slice(0, 60);
      }
      if (weekday !== undefined) next.weekday = weekday;
      if (periods !== undefined) {
        const cleanPeriods = sanitizePeriods(periods);
        if (!cleanPeriods) return { error: `节次非法（须为 1-${MAX_PERIOD} 的整数）` };
        next.periods = cleanPeriods;
      }
      if (weeks !== undefined) {
        const weekSpec = weeks.trim();
        if (!expandWeeks(weekSpec).length)
          return { error: `周次表达式无法解析：${weekSpec}（如 "1-16"、"2-6,8-12(单)"）` };
        next.weeks = weekSpec;
      }
      if (location !== undefined) next.location = location.trim();
      if (teacher !== undefined) next.teacher = teacher.trim();

      const conflicts = conflictsOf(courses, next, i);
      if (conflicts.length && !allowConflict) {
        return {
          error: `调课后与已有课冲突：${conflicts.join("、")}。换时段，或用户明确确认后传 allowConflict 重试。`,
          conflicts,
        };
      }
      courses[i] = next;
      saveScheduleEntry({ savedAt: Date.now(), schedule, base });
      const changed =
        courseLabel(old) === courseLabel(next)
          ? courseLabel(next)
          : `${courseLabel(old)} → ${courseLabel(next)}`;
      return {
        ok: true,
        summary: `已调课：${changed}`,
        course: viewOf(next, String(i)),
        ...(conflicts.length
          ? { warning: `与已有课冲突（用户已确认）：${conflicts.join("、")}` }
          : {}),
      };
    },
  }),
};
