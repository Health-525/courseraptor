/**
 * 网页「常用」快捷问题：默认清单 + 保存时的归一化。
 *
 * 用户可在设置面板自行增删（存于 credentialsStore.webQuickQuestions），
 * 这里是正式服务与演示服务共用的唯一事实源；空列表视为恢复默认。
 */

/** 单条问题长度上限（字符） */
export const QUICK_QUESTION_MAX_CHARS = 60;
/** 列表条数上限：chips 要在一两行内展示完，放不下的一律拒绝 */
export const QUICK_QUESTION_MAX_COUNT = 12;

/** 未自定义时的默认快捷问题（与历史硬编码清单保持一致） */
export const DEFAULT_QUESTIONS: string[] = [
  "今天有什么安排",
  "这周课表",
  "教务处最近有什么通知",
  "我的成绩和 GPA",
  "最近的考试安排",
  "通识学分还缺哪些",
  "导出课表到手机日历",
];

/** 把任意输入归一化成可落盘的快捷问题清单：字符串、去空、截长、去重、限量 */
export function normalizeQuickQuestions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim().slice(0, QUICK_QUESTION_MAX_CHARS))
    .filter(Boolean);
  return [...new Set(cleaned)].slice(0, QUICK_QUESTION_MAX_COUNT);
}

/** 生效清单：没存过或被清空时回退默认，保证页面上永远有快捷问题可点 */
export function effectiveQuickQuestions(stored: string[] | undefined): string[] {
  return stored?.length ? stored : DEFAULT_QUESTIONS;
}
