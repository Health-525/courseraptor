/**
 * 演示模式 live agent：真实模型 + 虚构数据工具。
 *
 * 隔离约束（与 server.ts 相同）：不 import core/config、core/agent、core/tools、
 * credentials——不读 .env 之外的任何用户数据，不写真实 data/ 目录；工具全部
 * 操作本模块内存。模型 Key 由 AI SDK 每次请求实时读 DEEPSEEK_API_KEY 环境变量。
 */
import { createDeepSeek } from "@ai-sdk/deepseek";
import type { ModelMessage } from "ai";
import { ToolLoopAgent, tool } from "ai";
import { z } from "zod";
// 流事件翻译骨架与正式版共用（此前逐字抄了一份 30 行克隆）：只做「事件类型 →
// SSE 载荷」的公共部分，不碰凭证、会话落盘与用户数据，不违反本模块的隔离约束。
import { translateStream } from "../../src/channels/web/web-stream-translate";
import { type DemoCard, demoCardFromTool } from "./cards";
import {
  DEMO_PERIOD_TIMES,
  demoExams,
  demoGrades,
  demoKnowledge,
  demoNews,
  demoSchedule,
  demoTodayBrief,
  demoTodos,
} from "./data";

/* ── 系统提示词：声明演示环境，引导真实分析 ── */

const DEMO_PROMPT = `你是「迅猛龙」课程助手的演示版，正在离线演示环境中接待一位体验产品的大学生。

环境约定：
- 你调用的所有工具返回的都是虚构示例数据（课表、成绩、考试、待办、通知一律是编造的示例），不代表任何真实学生或学校。
- 不要声称读取了真实教务系统；不要编造文件、下载链接或网址（演示模式没有生成文件的能力）。
- 工具数据里的「示例课程」「示例教学楼」等就是这位演示学生的全部事实，基于它们做真实、有用的分析。

工作方式：
- 凡涉及时间判断（今天几号周几、第几周、距截止还剩几天）必须先调 get_time，禁止凭训练数据猜「今天」。
- 查课表用 get_schedule，成绩/通识学分用 get_grades，考试用 get_exams，教务通知用 get_news；待办与知识库的增删改查用 manage_todos / manage_knowledge。\n- 调课、换教室/教师、加课退课用 edit_schedule：先 list 拿时段 id，再 update / add / delete；用户想撤销全部修改用 revert，改完可调 get_schedule 复述新课表。
- 主动做结合分析：比如把课表空档、考试倒计时和待办截止时间放在一起给建议——这正是产品的核心价值。

表达：
- 用简体中文，Markdown 排版（表格、列表、加粗按需使用），先给结论再给细节。
- 页面已声明「虚构数据」，不必每句重复；提到具体数据时可自然带过「示例」。`;

/* ── 内存状态：待办与知识库（种子为虚构数据，进程内有效，不落盘）── */

interface DemoTodoItem {
  id: string;
  title: string;
  dueAt: string;
  notes?: string;
  done: boolean;
  doneAt?: number;
  source: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function labelDue(dueAt: string, now: Date): string {
  const d = new Date(dueAt);
  const diff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86400000,
  );
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  if (diff === -1) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/* ── 演示课表槽位定位：id 形如「3-1」＝周三第 2 个时段（weekday-下标）── */

const WD_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** "1-2节" -> [1,2]；解析不了给空数组 */
function parsePeriodStr(s: string): number[] {
  const m = /(\d+)\s*[-~]\s*(\d+)/.exec(s) ?? /(\d+)/.exec(s);
  if (!m) return [];
  const a = parseInt(m[1] ?? m[3] ?? "", 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
  const out: number[] = [];
  for (let p = Math.min(a, b); p <= Math.max(a, b); p++) out.push(p);
  return out;
}

/** 节次数组 -> "1-2节" 式展示串 */
function periodStrOf(periods: number[]): string {
  const min = Math.min(...periods);
  const max = Math.max(...periods);
  return min === max ? `${min}节` : `${min}-${max}节`;
}

function slotLabel(weekday: number, periods: string): string {
  return `${WD_NAMES[weekday - 1] ?? `周${weekday}`} ${periods}`;
}

/** 解析槽位 id；课表有增删移动后旧 id 会失效，返回 null 由调用方提示重新 list */
function findSlot(raw: string): { weekday: number; index: number } | null {
  const m = /^([1-7])-(\d+)$/.exec(raw);
  if (!m) return null;
  const weekday = Number(m[1] ?? 0);
  const index = Number(m[2] ?? -1);
  if (!Number.isInteger(weekday) || weekday < 1 || !Number.isInteger(index) || index < 0)
    return null;
  const day = demoSchedule.courses[weekday - 1];
  if (!day || index >= day.length) return null;
  return { weekday, index };
}

/** 演示课表是否相对初始种子有过修改（内存对比，无周次概念） */
function demoScheduleModified(): boolean {
  return JSON.stringify(demoSchedule.courses) !== JSON.stringify(demoSchedule.seed);
}

/** 演示课表里出现过的课程名：知识 add 时的归类参照 */
function demoCourseNames(): string[] {
  const names = new Set<string>();
  const { week } = demoTodayBrief();
  if (week) for (const day of week.days) for (const c of day.courses) names.add(c.title);
  return [...names];
}

/**
 * live 模式工具集：与正式工具同名、入参同形（见 core/tools 与学校适配器），
 * 但 execute 只读写本函数闭包内的内存状态。独立导出便于单测。
 */
export function demoLiveTools() {
  const seeded = demoTodos(new Date());
  const todos: DemoTodoItem[] = [
    ...seeded.items.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt,
      ...(t.notes ? { notes: t.notes } : {}),
      done: false,
      source: t.source ?? "对话",
    })),
    ...seeded.done.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt,
      done: true,
      ...(t.doneAt ? { doneAt: t.doneAt } : {}),
      source: "对话",
    })),
  ];
  const knowledge = demoKnowledge(new Date());
  let todoSeq = 0;
  let knSeq = 0;

  const todoView = (t: DemoTodoItem, now: Date) => {
    const due = new Date(t.dueAt);
    const isToday =
      due.getFullYear() === now.getFullYear() &&
      due.getMonth() === now.getMonth() &&
      due.getDate() === now.getDate();
    return {
      id: t.id,
      title: t.title,
      dueAt: t.dueAt,
      dueLabel: labelDue(t.dueAt, now),
      overdue: !t.done && due.getTime() < now.getTime(),
      isToday,
      ...(t.notes ? { notes: t.notes } : {}),
      ...(t.done ? { done: true, doneAt: t.doneAt } : {}),
    };
  };

  return {
    /** 时间查询：真实时钟 + 虚构学期（固定第 2 周，与演示页一致） */
    get_time: tool({
      description:
        "查当前日期、星期与时刻，以及本学期教学周（演示学期固定为第 2 周）。你没有内置时钟，凡涉及时间的判断（今天几号、还剩几天、是否逾期）都必须先调本工具。",
      inputSchema: z.object({}),
      execute: async () => {
        const now = new Date();
        const weekday = ((now.getDay() + 6) % 7) + 1;
        const names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
        return {
          date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
          weekday,
          weekdayLabel: names[weekday - 1],
          time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
          term: "2026-2027学年第一学期（示例）",
          week: 2,
          weekLabel: "第 2 周",
          maxWeek: 16,
        };
      },
    }),
    /** 课表查询：虚构周课表（含周六调休补课） */
    get_schedule: tool({
      description:
        "查演示学生的本学期课表：今日课程、下一节课、周视图（含节次时间、地点、教师）与调休标记。",
      inputSchema: z.object({}),
      execute: async () => {
        const brief = demoTodayBrief();
        const weekTotal = (brief.week?.days ?? []).reduce((n, d) => n + d.courses.length, 0);
        return {
          summary: `今天 ${brief.schedule.courses.length} 节课 · 本周 ${weekTotal} 门次（虚构示例）`,
          term: brief.term,
          today: brief.schedule.courses,
          next: brief.next,
          ...(brief.week ? { week: brief.week } : {}),
          periodTimes: DEMO_PERIOD_TIMES,
          note: "虚构示例课表",
        };
      },
    }),
    /** 课表修改：内存态（与正式 edit_schedule 同形；改 demoSchedule，页面刷新即可见） */
    edit_schedule: tool({
      description:
        "修改演示学生的课表（演示：仅保存在内存，重启即失）。调课、换教室/教师、加课退课时调用：先 list 拿各时段条目 id（一门课一周多时段就是多条，别拿错），update 按 id 改（weekday/periods/location/teacher/title 传哪个改哪个），add 新增（title/weekday/periods 必填），delete 按 ids 批量删，revert 撤销全部修改还原初始课表。目标时段与已有课冲突会报错并列出冲突课，用户明确确认「就调到那」再传 allowConflict 重试。改完可直接调 get_schedule 复述新课表。",
      inputSchema: z.object({
        action: z
          .enum(["list", "update", "add", "delete", "revert"])
          .describe(
            "list=列出课表时段（拿 id），update=按 id 调课/改信息，add=新增一门课，delete=按 ids 批量删除，revert=还原初始课表",
          ),
        id: z.string().optional().describe("目标时段 id（update 必填，来自 list 结果，形如 3-1）"),
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
          .array(z.number().int().min(1).max(10))
          .min(1)
          .optional()
          .describe("节次数组如 [3,4]（add 必填，update 调课目标节次）"),
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
        location,
        teacher,
        allowConflict,
      }) => {
        const modified = demoScheduleModified();
        const entryOf = (weekday: number, index: number) => {
          const slot = demoSchedule.courses[weekday - 1]?.[index];
          return {
            id: `${weekday}-${index}`,
            title: slot?.title ?? "",
            weekday,
            weekdayLabel: WD_NAMES[weekday - 1] ?? "",
            periods: slot?.periods ?? "",
            ...(slot?.location ? { location: slot.location } : {}),
            ...(slot?.teacher ? { teacher: slot.teacher } : {}),
          };
        };
        if (action === "list") {
          const entries: ReturnType<typeof entryOf>[] = [];
          demoSchedule.courses.forEach((day, i) => {
            day.forEach((_, j) => {
              entries.push(entryOf(i + 1, j));
            });
          });
          return {
            summary: `${entries.length} 个课表时段${modified ? "（含修改，revert 可还原初始课表）" : ""}`,
            entries,
            note: modified ? "部分时段经过调课；revert 可整体还原" : undefined,
          };
        }
        if (action === "revert") {
          if (!modified) return { error: "课表没有本地修改，无需还原" };
          demoSchedule.courses = structuredClone(demoSchedule.seed);
          const total = demoSchedule.courses.reduce((n, d) => n + d.length, 0);
          return { ok: true, summary: `已还原初始课表（${total} 个时段）` };
        }
        if (action === "delete") {
          if (!ids?.length) return { error: "delete 需要 ids（来自 list 结果的时段 id 列表）" };
          // 先全部校验再倒序删除：同天内先删大下标，避免删除改变后续下标
          const targets: Array<{ weekday: number; index: number }> = [];
          for (const raw of new Set(ids)) {
            const r = findSlot(raw);
            if (!r)
              return { error: `条目 id 无效：${raw}。课表增删移动后旧 id 失效，请重新 list。` };
            targets.push(r);
          }
          targets.sort((a, b) => b.weekday - a.weekday || b.index - a.index);
          for (const r of targets) {
            demoSchedule.courses[r.weekday - 1]?.splice(r.index, 1);
          }
          const total = demoSchedule.courses.reduce((n, d) => n + d.length, 0);
          return {
            ok: true,
            summary: `已删除 ${new Set(ids).size} 个时段，剩余 ${total} 个`,
            note: "id 是删除前的定位，现在已失效；再改先重新 list。",
          };
        }
        if (action === "add") {
          const name = title?.trim();
          if (!name) return { error: "add 需要 title（课程名）" };
          if (!weekday) return { error: "add 需要 weekday（1=周一…7=周日）" };
          if (!periods?.length) return { error: "add 需要 periods（节次数组，如 [3,4]）" };
          const slot = {
            title: name.slice(0, 60),
            periods: periodStrOf(periods),
            ...(location?.trim() ? { location: location.trim() } : {}),
            ...(teacher?.trim() ? { teacher: teacher.trim() } : {}),
          };
          const conflicts =
            demoSchedule.courses[weekday - 1]
              ?.filter((s) => parsePeriodStr(s.periods).some((p) => periods.includes(p)))
              .map((s) => `「${s.title}」${slotLabel(weekday, s.periods)}`) ?? [];
          if (conflicts.length && !allowConflict) {
            return {
              error: `目标时段与已有课冲突：${conflicts.join("、")}。换时段，或用户明确确认后传 allowConflict 重试。`,
              conflicts,
            };
          }
          (demoSchedule.courses[weekday - 1] ?? []).push(slot);
          const index = (demoSchedule.courses[weekday - 1]?.length ?? 1) - 1;
          return {
            ok: true,
            summary: `已加课：${slot.title} ${slotLabel(weekday, slot.periods)}`,
            course: entryOf(weekday, index),
            ...(conflicts.length
              ? { warning: `与已有课冲突（用户已确认）：${conflicts.join("、")}` }
              : {}),
          };
        }
        // update：按 id 调课 / 改信息
        const at = id ? findSlot(id) : null;
        if (!at)
          return {
            error: `条目 id 无效：${id ?? "(未传)"}。id 来自 list 结果，课表有增删移动后请重新 list。`,
          };
        const day = demoSchedule.courses[at.weekday - 1];
        const old = day?.[at.index];
        if (!old) return { error: `条目 id 无效：${id}。请重新 list。` };
        const next = {
          title: title !== undefined ? title.trim().slice(0, 60) : old.title,
          periods: periods?.length ? periodStrOf(periods) : old.periods,
          ...(location !== undefined
            ? location.trim()
              ? { location: location.trim() }
              : {}
            : old.location
              ? { location: old.location }
              : {}),
          ...(teacher !== undefined
            ? teacher.trim()
              ? { teacher: teacher.trim() }
              : {}
            : old.teacher
              ? { teacher: old.teacher }
              : {}),
        };
        if (!next.title) return { error: "title 不能改为空" };
        const targetDay = weekday ?? at.weekday;
        const moved = targetDay !== at.weekday;
        // 冲突检测：目标天上的其他槽位——未移动时排除自身，移动时原槽位不在目标天、全算他人
        const others = (demoSchedule.courses[targetDay - 1] ?? []).filter(
          (_, j) => moved || j !== at.index,
        );
        const nextPeriods = parsePeriodStr(next.periods);
        const conflicts = others
          .filter((s) => parsePeriodStr(s.periods).some((p) => nextPeriods.includes(p)))
          .map((s) => `「${s.title}」${slotLabel(targetDay, s.periods)}`);
        if (conflicts.length && !allowConflict) {
          return {
            error: `调课后与已有课冲突：${conflicts.join("、")}。换时段，或用户明确确认后传 allowConflict 重试。`,
            conflicts,
          };
        }
        if (moved) {
          day?.splice(at.index, 1);
          (demoSchedule.courses[targetDay - 1] ?? []).push(next);
          const newIndex = (demoSchedule.courses[targetDay - 1]?.length ?? 1) - 1;
          return {
            ok: true,
            summary: `已调课：「${old.title}」 ${slotLabel(at.weekday, old.periods)} → ${slotLabel(targetDay, next.periods)}`,
            course: entryOf(targetDay, newIndex),
            note: "移动后的新 id 在返回里，后续修改用它。",
          };
        }
        if (day) day[at.index] = next;
        return {
          ok: true,
          summary: `已更新：「${next.title}」${slotLabel(targetDay, next.periods)}`,
          course: entryOf(targetDay, at.index),
        };
      },
    }),
    /** 成绩查询：虚构成绩单与通识分类汇总 */
    get_grades: tool({
      description:
        "查演示学生的成绩：必修 GPA、已获学分、逐门成绩（含未通过与缓考）和通识分类学分汇总。",
      inputSchema: z.object({}),
      execute: async () => demoGrades(),
    }),
    /** 考试查询：虚构考试安排 */
    get_exams: tool({
      description: "查演示学生的近期考试安排：科目、日期时间、考场与座位号、倒计时天数。",
      inputSchema: z.object({}),
      execute: async () => {
        const exams = demoExams(new Date());
        return {
          summary: `${exams.length} 场考试，最近一场 ${exams[0]?.inDays ?? "?"} 天后（虚构示例）`,
          exams,
          note: "虚构示例考试安排",
        };
      },
    }),
    /** 通知查询：虚构教务通知 */
    get_news: tool({
      description: "查演示数据里的教务处通知列表（标题、日期、摘要与正文）。没有真实链接。",
      inputSchema: z.object({}),
      execute: async () => {
        const news = demoNews(new Date());
        return { summary: `${news.length} 条通知（虚构示例）`, count: news.length, news };
      },
    }),
    /** 待办维护：内存态，形状与正式 manage_todos 一致 */
    manage_todos: tool({
      description:
        "待办维护（演示：仅保存在内存，重启即失）。用户说出待办（「记一下周五交实验报告」）时主动调 add；问「我有哪些待办」用 list；办完了用 update 置 done；不要了用 delete。截止时间必须是绝对时间——相对日期（明天/下周五）先调 get_time 换算再传入。",
      inputSchema: z.object({
        action: z
          .enum(["add", "list", "update", "delete"])
          .describe(
            "add=批量记录待办，list=列出待办，update=按 id 修改（完成/改时间/改标题），delete=按 id 删除",
          ),
        items: z
          .array(
            z.object({
              title: z.string().describe("待办内容（≤100 字），如「交高数作业」"),
              dueAt: z
                .string()
                .describe(
                  "截止时间（绝对时间，如 2026-09-16T23:59:00；相对日期须先用 get_time 换算）",
                ),
              notes: z.string().optional().describe("补充说明"),
            }),
          )
          .optional()
          .describe("add 必填：一批待办条目"),
        includeDone: z.boolean().optional().describe("list 时是否包含已完成，默认只列未完成"),
        id: z.string().optional().describe("目标待办 id（update/delete 必填，来自 list 结果）"),
        title: z.string().optional().describe("update 时的标题"),
        dueAt: z.string().optional().describe("update 时的新截止时间"),
        notes: z.string().optional().describe("update 时的新备注"),
        done: z.boolean().optional().describe("update 时的完成状态"),
      }),
      execute: async ({ action, items, includeDone, id, title, dueAt, notes, done }) => {
        if (action === "add") {
          if (!items?.length) return { error: "add 需要 items（至少一条待办）" };
          const created = [];
          for (const item of items) {
            const ts = Date.parse(item.dueAt);
            if (!item.title.trim()) return { error: "每条待办都需要 title" };
            if (Number.isNaN(ts))
              return { error: `「${item.title}」的截止时间无效：${item.dueAt}` };
            const entry: DemoTodoItem = {
              id: `demo-todo-new-${++todoSeq}`,
              title: item.title.trim().slice(0, 100),
              dueAt: new Date(ts).toISOString(),
              ...(item.notes ? { notes: item.notes } : {}),
              done: false,
              source: "对话",
            };
            todos.push(entry);
            created.push({ id: entry.id, title: entry.title, dueAt: entry.dueAt });
          }
          const open = todos.filter((t) => !t.done).length;
          return {
            ok: true,
            summary: `已记录 ${created.length} 条待办（共 ${open} 条未完成）`,
            added: created,
          };
        }
        if (action === "list") {
          const now = new Date();
          const list = (includeDone ? todos : todos.filter((t) => !t.done)).map((t) =>
            todoView(t, now),
          );
          return {
            summary: `${list.length} 条${includeDone ? "" : "未完成"}待办（虚构示例）`,
            todos: list,
          };
        }
        if (action === "update") {
          const target = todos.find((t) => t.id === id);
          if (!target) return { error: `待办不存在：${id}` };
          if (title !== undefined) target.title = title.trim().slice(0, 100) || target.title;
          if (dueAt !== undefined) {
            const ts = Date.parse(dueAt);
            if (Number.isNaN(ts)) return { error: `新的截止时间无效：${dueAt}` };
            target.dueAt = new Date(ts).toISOString();
          }
          if (notes !== undefined) target.notes = notes || undefined;
          if (done !== undefined) {
            target.done = done;
            target.doneAt = done ? Date.now() : undefined;
          }
          return { ok: true, summary: "已更新", todo: todoView(target, new Date()) };
        }
        const index = todos.findIndex((t) => t.id === id);
        const removed = todos.find((t) => t.id === id);
        if (!removed) return { error: `待办不存在：${id}` };
        todos.splice(index, 1);
        return { ok: true, summary: `已删除「${removed.title}」` };
      },
    }),
    /** 知识库维护：内存态，形状与正式 manage_knowledge 一致 */
    manage_knowledge: tool({
      description:
        "知识库维护（演示：仅保存在内存，重启即失）。用户说出值得长期保留的知识（概念、公式、方法，「记住这个」）时主动调 add：能看出归属就传 subject——优先用课表课程名（如「示例高等数学」），对不上课表的简短主题会成为自定义分类，无归属才省略落「未分类」；问「我记过哪些知识」用 list；改用 update；删用 delete。",
      inputSchema: z.object({
        action: z
          .enum(["add", "list", "update", "delete"])
          .describe(
            "add=批量记录知识，list=列出知识（可筛），update=按 id 修改，delete=按 id 删除",
          ),
        items: z
          .array(
            z.object({
              title: z.string().describe("知识标题，如「洛必达法则」"),
              content: z.string().describe("知识内容：概念/公式/方法/结论本身"),
              subject: z.string().optional().describe("归属提示：课表课程名或简短自定义主题"),
            }),
          )
          .optional()
          .describe("add 必填：一批知识条目"),
        category: z.string().optional().describe("list 时按分类筛选；传空字符串表示只看未分类"),
        keyword: z.string().optional().describe("list 时按关键词检索标题与内容"),
        id: z.string().optional().describe("目标条目 id（update/delete 必填，来自 list 结果）"),
        title: z.string().optional().describe("update 时的新标题"),
        content: z.string().optional().describe("update 时的新内容"),
        subject: z.string().optional().describe("update 时重新归属"),
      }),
      execute: async ({ action, items, category, keyword, id, title, content, subject }) => {
        if (action === "add") {
          if (!items?.length) return { error: "add 需要 items（至少一条知识）" };
          const courses = demoCourseNames();
          const saved: Array<{ id: string; title: string; category: string | null }> = [];
          for (const item of items) {
            if (!item.title.trim() || !item.content.trim())
              return { error: `「${item.title || "未命名"}」需要标题与内容` };
            const subject = item.subject?.trim();
            const matched = subject
              ? courses.find((c) => c.includes(subject) || subject.includes(c))
              : undefined;
            const entry = {
              id: `demo-kn-new-${++knSeq}`,
              title: item.title.trim().slice(0, 80),
              content: item.content.trim().slice(0, 2000),
              category: subject ? (matched ?? subject.slice(0, 30)) : null,
              source: "对话",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            knowledge.unshift(entry);
            saved.push({ id: entry.id, title: entry.title, category: entry.category });
          }
          return { ok: true, summary: `已记录 ${saved.length} 条知识（演示内存）`, saved };
        }
        if (action === "list") {
          let list = [...knowledge].sort((a, b) => b.updatedAt - a.updatedAt);
          if (category !== undefined)
            list = list.filter((e) => (category ? e.category === category : e.category === null));
          if (keyword?.trim()) {
            const kw = keyword.trim().toLowerCase();
            list = list.filter(
              (e) => e.title.toLowerCase().includes(kw) || e.content.toLowerCase().includes(kw),
            );
          }
          return {
            summary: `${list.length} 条知识（虚构示例）`,
            entries: list.map((e) => ({
              id: e.id,
              title: e.title,
              category: e.category,
              updatedAt: e.updatedAt,
            })),
          };
        }
        if (action === "update") {
          const target = knowledge.find((e) => e.id === id);
          if (!target) return { error: `知识条目不存在：${id}` };
          if (title !== undefined) target.title = title.trim().slice(0, 80) || target.title;
          if (content !== undefined) target.content = content.trim().slice(0, 2000);
          if (subject !== undefined) {
            const courses = demoCourseNames();
            const matched = courses.find((c) => c.includes(subject) || subject.includes(c));
            target.category = subject ? (matched ?? subject.trim().slice(0, 30)) : null;
          }
          target.updatedAt = Date.now();
          return {
            ok: true,
            summary: "已更新",
            entry: { id: target.id, title: target.title, category: target.category },
          };
        }
        const index = knowledge.findIndex((e) => e.id === id);
        const removed = knowledge.find((e) => e.id === id);
        if (!removed) return { error: `知识条目不存在：${id}` };
        knowledge.splice(index, 1);
        return { ok: true, summary: `已删除「${removed.title}」` };
      },
    }),
  };
}

/** live 模式 agent：真实 DeepSeek 模型 + 上述虚构数据工具。Key 缺失时报错由调用方处理。 */
export function createDemoAgent(options: { model: string; baseUrl?: string }) {
  const deepseek = createDeepSeek({
    // 与 core/agent.ts 相同：不传 apiKey，AI SDK 每次请求实时读 DEEPSEEK_API_KEY
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  });
  return new ToolLoopAgent({
    model: deepseek(options.model),
    instructions: DEMO_PROMPT,
    tools: demoLiveTools(),
  });
}

/* ── SSE 翻译：fullStream → 演示页事件流（与正式 chat-web 的 runTurn 同形，精简版）── */

/** 结构化最小接口：ToolLoopAgent 天然满足，测试可用桩替换 */
export interface DemoStreamAgent {
  stream(options: {
    messages: ModelMessage[];
    abortSignal?: AbortSignal;
  }): PromiseLike<{ fullStream: AsyncIterable<unknown> }>;
}

/** 跑一轮 live 对话：把 agent 事件流翻译成 SSE 事件发给 send，返回累积正文与失败信息 */
export async function runDemoLiveTurn(options: {
  agent: DemoStreamAgent;
  history: ModelMessage[];
  message: string;
  send: (obj: Record<string, unknown>) => void;
  signal: AbortSignal;
}): Promise<{ text: string; think: string; failure: string | null; cards: DemoCard[] }> {
  const { agent, history, message, send, signal } = options;
  const messages: ModelMessage[] = [...history, { role: "user", content: message }];
  const cards: DemoCard[] = [];

  // 事件翻译骨架与正式版共用（此前逐字抄了一份）；演示差异只有「工具结果
  // 之后再发一张结构化结果卡」，通过 afterToolResult 钩子挂上
  const { text, think, failure } = await translateStream(agent, {
    messages,
    signal,
    send,
    afterToolResult: (output, toolName) => {
      // 读态查询的结果同时以结构化卡片呈现（同 kind 去重，一轮至多一张）
      const card = demoCardFromTool(toolName, output);
      if (card && !cards.some((c) => c.kind === card.kind)) {
        cards.push(card);
        send({ t: "card", card });
      }
    },
  });

  return { text, think, failure, cards };
}
