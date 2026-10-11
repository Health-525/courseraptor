/**
 * 命令实现：把 CourseRaptor 的今日日程与待办插进当前笔记
 *
 * 纯本地缓存数据（/api/today、/api/reminders），不调模型不登录教务，
 * 与网页「今日」「待办」面板同源。插入位置统一是当前笔记的光标处。
 */

import { MarkdownView, Notice, type Editor } from "obsidian";
import type CourseRaptorPlugin from "./main";
import type { TodayBrief } from "./types";

function activeEditor(plugin: CourseRaptorPlugin): Editor | null {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  return view?.editor ?? null;
}

function dueLabel(dueAt: string): string {
  // ISO 或 "YYYY-MM-DD HH:mm"：统一截成「YYYY-MM-DD HH:mm」展示
  return dueAt ? dueAt.replace("T", " ").slice(0, 16) : "";
}

/** 今日日程 → Markdown（课程表 + 临近考试），插到当前笔记光标处 */
export async function insertTodayBrief(plugin: CourseRaptorPlugin): Promise<void> {
  const editor = activeEditor(plugin);
  if (!editor) {
    new Notice("请先打开一篇笔记再插入");
    return;
  }
  let brief: TodayBrief;
  try {
    brief = await plugin.client.today();
  } catch (e) {
    new Notice(e instanceof Error ? e.message : String(e));
    return;
  }

  const lines: string[] = [];
  lines.push(`> [!info] 🦖 今日日程 · ${brief.dateLabel}${brief.term.weekLabel ? ` · ${brief.term.weekLabel}` : ""}`);

  if (!brief.schedule.available) {
    lines.push(
      "> 暂无课表缓存：先在 CourseRaptor 里导入或查询一次课表（网页或对话里说「这周课表」即可）。",
    );
  } else if (!brief.schedule.courses.length) {
    lines.push("今天没有课，安心安排自己的事吧。");
  } else {
    lines.push("| 时间 | 课程 | 地点 | 教师 |");
    lines.push("| --- | --- | --- | --- |");
    for (const c of brief.schedule.courses) {
      const time = [c.time, c.periods].filter(Boolean).join(" ");
      lines.push(
        `| ${time || "—"} | ${c.title} | ${c.location || "—"} | ${c.teacher || "—"} |`,
      );
    }
  }
  if (brief.schedule.note) lines.push(`> ${brief.schedule.note}`);

  if (brief.exams.available && brief.exams.upcoming.length) {
    lines.push("", "**临近考试**");
    for (const exam of brief.exams.upcoming) {
      const seat = exam.seatNumber ? `（座位 ${exam.seatNumber}）` : "";
      const rel = exam.isToday ? "今天" : `还有 ${exam.inDays} 天`;
      lines.push(`- **${exam.date} ${exam.time} ${exam.subject}** @ ${exam.location}${seat} · ${rel}`);
    }
  }

  editor.replaceSelection(`${lines.join("\n")}\n`);
  new Notice("已插入今日日程");
}

/** 未完成待办 → Markdown 任务列表，插到当前笔记光标处 */
export async function insertTodos(plugin: CourseRaptorPlugin): Promise<void> {
  const editor = activeEditor(plugin);
  if (!editor) {
    new Notice("请先打开一篇笔记再插入");
    return;
  }
  let items: Awaited<ReturnType<typeof plugin.client.reminders>>;
  try {
    items = await plugin.client.reminders();
  } catch (e) {
    new Notice(e instanceof Error ? e.message : String(e));
    return;
  }
  const open = items.filter((r) => !r.done);
  if (!open.length) {
    new Notice("没有未完成的待办");
    return;
  }
  const lines = ["## 🦖 待办", ""];
  for (const r of open) {
    const due = dueLabel(r.dueAt);
    lines.push(`- [ ] ${r.title}${due ? `（${due}）` : ""}`);
  }
  editor.replaceSelection(`${lines.join("\n")}\n`);
  new Notice(`已插入 ${open.length} 条待办`);
}
