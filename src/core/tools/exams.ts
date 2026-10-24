/**
 * 考试修改：edit_exams
 *
 * 教务通知考试变动（改考场/改时间/推迟）、老师口头通知、或手动课表
 * 模式下用户要补录考试时，直写本地考试缓存（data/exam-cache.json）。
 * 缓存是 get_exams 与今日简报/考试面板的共同数据源，改完立即生效；
 * 首次修改前把最后官方查到的安排快照为 base，revert 可整体还原；
 * 在线刷新走 saveExamCache 覆盖式写入——官方安排永远赢过本地手改
 * （与 edit_schedule 同一套语义）。
 */

import { tool } from "ai";
import { z } from "zod";

import { candidateTerms, termLabel } from "../academic-utils";
import { type CachedExams, loadExamCache, saveExamEntry } from "../exam-cache";
import type { ExamData, ExamResult } from "../model";
import { loadScheduleCache } from "../schedule-cache";
import { registeredSchool } from "../school";

/** 手动课表模式（其他学校/未装配学校）：没有教务来源，考试全靠对话补录 */
function manualMode(): boolean {
  const school = registeredSchool();
  return !school || Boolean(school.info.manual);
}

/** 条目给模型看的视图：id 是数组下标（增删后会变，每次改前重新 list） */
const viewOf = (e: ExamData, id: string) => ({
  id,
  subject: e.subject,
  date: e.date,
  ...(e.time ? { time: e.time } : {}),
  ...(e.location ? { location: e.location } : {}),
  ...(e.seatNumber ? { seatNumber: e.seatNumber } : {}),
});

/** 考试日期收整：接受 2026-6-28 / 2026-06-28，校验为真实日历日，归一成 YYYY-MM-DD */
function normalizeExamDate(raw: string): string | null {
  const m = raw.trim().match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function indexError(id: string): string {
  return `条目 id 无效：${id}。id 来自上一次 list 结果，考试有增删后请重新 list。`;
}

/** 手动模式下从零建缓存：学期跟课表缓存走（今日简报按学期匹配考试），
 *  没有课表缓存再按日历估算当前学期 */
function freshExamResult(): ExamResult {
  const schedule = loadScheduleCache()?.schedule;
  if (schedule) {
    return { year: schedule.year, semester: schedule.semester, label: schedule.label, exams: [] };
  }
  const term = candidateTerms()[0];
  if (term) {
    return {
      year: term.year,
      semester: term.semester,
      label: termLabel(term.year, term.semester),
      exams: [],
    };
  }
  return { year: 2026, semester: 3, label: termLabel(2026, 3), exams: [] };
}

const examLabel = (e: ExamData) =>
  [e.subject, e.date, e.time, e.location, e.seatNumber ? `座位 ${e.seatNumber}` : ""]
    .filter(Boolean)
    .join(" · ");

export const examEditTools = {
  edit_exams: tool({
    description:
      "修改本地考试安排（改时间/改考场/补录考试/删条目，持久保存，考试面板与今日简报立即生效；" +
      "最后官方查到的安排留有快照，revert 可整体还原）。教务通知考试变动、老师说「考试改到 X 考场/推迟到 X 日」、" +
      "用户说「记一下 X 月 X 日考 XX」时调用。先 list 拿条目 id，update 按 id 改" +
      "（subject/date/time/location/seatNumber 传哪个改哪个），add 批量补录（subject+date 必填），" +
      "delete 按 ids 批量删，revert 整体还原最后官方查到的安排。「其他学校/手动课表」模式没有教务来源，" +
      "考试安排全靠对话补录；教务已适配学校若还没有考试缓存，先让用户问一次考试安排（get_exams）落盘再改，" +
      "不要凭印象编。改前先核对用户说的考试确实在缓存里、id 没拿错。",
    inputSchema: z.object({
      action: z
        .enum(["list", "add", "update", "delete", "revert"])
        .describe(
          "list=列出考试安排（拿 id），add=批量补录考试，update=按 id 改信息，delete=按 ids 批量删除，revert=还原最后官方查到的安排",
        ),
      items: z
        .array(
          z.object({
            subject: z.string().describe("考试科目（≤60 字），如「高等数学」"),
            date: z.string().describe("考试日期（2026-06-28）"),
            time: z.string().optional().describe("考试时间（如「14:00-16:00」），可省略"),
            location: z.string().optional().describe("考场（如「教 A-101」），可省略"),
            seatNumber: z.string().optional().describe("座位号，可省略"),
          }),
        )
        .optional()
        .describe("add 必填：一批考试（至多 20 场）"),
      id: z.string().optional().describe("目标条目 id（update 必填，来自 list 结果）"),
      ids: z.array(z.string()).optional().describe("delete 必填：要删除的条目 id 列表"),
      subject: z.string().optional().describe("update 时的科目名"),
      date: z.string().optional().describe("update 时的新日期（2026-06-28）"),
      time: z.string().optional().describe("update 时的新时间（传空串清除）"),
      location: z.string().optional().describe("update 时的新考场（传空串清除）"),
      seatNumber: z.string().optional().describe("update 时的新座位号（传空串清除）"),
    }),
    execute: async ({ action, items, id, ids, subject, date, time, location, seatNumber }) => {
      const cached = loadExamCache();
      if (!cached && !manualMode()) {
        return {
          error:
            "还没有考试缓存：先让用户问一次考试安排（get_exams）落盘，再修改；不要凭印象编考试。",
        };
      }
      const current: CachedExams = cached ?? { savedAt: Date.now(), exams: freshExamResult() };
      // base：首次修改前快照现有安排（手动模式补录前可能是空表）；本次未动 base 语义
      const base: ExamResult = cached?.base
        ? structuredClone(cached.base)
        : structuredClone(current.exams);
      const exams: ExamResult = structuredClone(current.exams);
      const list = exams.exams;

      if (action === "list") {
        const entries = list.map((e, i) => viewOf(e, String(i)));
        return {
          summary: `${entries.length} 场考试（${exams.label}）`,
          term: exams.label,
          entries,
          ...(cached?.base
            ? { note: "部分条目经过本地修改；最后官方查到的安排可用 revert 整体还原" }
            : entries.length === 0
              ? { note: "考试安排还是空的，add 可补录" }
              : {}),
        };
      }

      if (action === "revert") {
        if (!cached?.base) return { error: "考试安排没有本地修改，无需还原" };
        const restored = structuredClone(cached.base);
        saveExamEntry({ savedAt: Date.now(), exams: restored });
        return {
          ok: true,
          summary: `已还原为最后官方查到的考试安排（${restored.exams.length} 场）`,
          count: restored.exams.length,
        };
      }

      if (action === "delete") {
        if (!ids?.length) return { error: "delete 需要 ids（来自 list 结果的条目 id 列表）" };
        const targets: number[] = [];
        for (const raw of ids) {
          const i = Number(raw);
          if (!Number.isInteger(i) || i < 0 || i >= list.length) return { error: indexError(raw) };
          targets.push(i);
        }
        const unique = [...new Set(targets)].sort((a, b) => b - a);
        const removed = unique.map((i) => {
          const target = list[i];
          return target ? examLabel(target) : `#${i}`;
        });
        for (const i of unique) list.splice(i, 1);
        saveExamEntry({ savedAt: Date.now(), exams, base });
        return {
          ok: true,
          summary: `已删除 ${new Set(targets).size} 场考试，剩余 ${list.length} 场`,
          removed,
          remaining: list.length,
          note: "id 是删除前的下标，现在已失效；再改先重新 list。",
        };
      }

      if (action === "add") {
        if (!items?.length) return { error: "add 需要 items（至少一场考试）" };
        if (items.length > 20) return { error: "一次最多补录 20 场考试" };
        const added: Array<{ id: string; subject: string; date: string }> = [];
        for (const item of items) {
          const name = item.subject?.trim();
          if (!name) return { error: "每场考试都需要 subject（科目名）" };
          const iso = normalizeExamDate(item.date ?? "");
          if (!iso) {
            return { error: `「${name}」的日期无效：${item.date}（应为 2026-06-28 这类写法）` };
          }
          const entry: ExamData = {
            subject: name.slice(0, 60),
            date: iso,
            time: (item.time?.trim() ?? "").slice(0, 40),
            location: (item.location?.trim() ?? "").slice(0, 60),
            ...(item.seatNumber?.trim() ? { seatNumber: item.seatNumber.trim().slice(0, 20) } : {}),
          };
          list.push(entry);
          added.push({ id: String(list.length - 1), subject: entry.subject, date: entry.date });
        }
        saveExamEntry({ savedAt: Date.now(), exams, base });
        return {
          ok: true,
          summary: `已补录 ${added.length} 场考试（${exams.label}，共 ${list.length} 场）`,
          added,
        };
      }

      // update：按 id 改科目/日期/时间/考场/座位
      const i = Number(id);
      if (!Number.isInteger(i) || i < 0 || i >= list.length)
        return { error: indexError(String(id)) };
      const old = list[i];
      if (!old) return { error: indexError(String(id)) };
      const next: ExamData = { ...old };
      if (subject !== undefined) {
        const name = subject.trim();
        if (!name) return { error: "subject 不能改为空" };
        next.subject = name.slice(0, 60);
      }
      if (date !== undefined) {
        const iso = normalizeExamDate(date);
        if (!iso) return { error: `日期无效：${date}（应为 2026-06-28 这类写法）` };
        next.date = iso;
      }
      if (time !== undefined) next.time = time.trim().slice(0, 40);
      if (location !== undefined) next.location = location.trim().slice(0, 60);
      if (seatNumber !== undefined) {
        const seat = seatNumber.trim().slice(0, 20);
        if (seat) next.seatNumber = seat;
        else delete next.seatNumber;
      }
      list[i] = next;
      saveExamEntry({ savedAt: Date.now(), exams, base });
      const changed =
        examLabel(old) === examLabel(next)
          ? examLabel(next)
          : `${examLabel(old)} → ${examLabel(next)}`;
      return {
        ok: true,
        summary: `已改考试安排：${changed}`,
        exam: viewOf(next, String(i)),
      };
    },
  }),
};
