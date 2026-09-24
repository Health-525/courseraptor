/**
 * 通知相关性评分（通用规则，与具体学校无关）
 *
 * 教务处一次发十几条，其中大半跟具体某个学生无关。过去全靠模型逐条判断，
 * 判断质量时好时坏；这里按「是否点名本年级 / 是否需本人行动」固化成规则。
 * web 通知面板与 get_news 工具共用。
 */

export type RelevanceLevel = "high" | "medium" | "low";

/** 视情况才看：只在本人有对应需求时才相关，判定要早于 MUST_DO */
const SITUATIONAL = [
  "补修",
  "重修",
  "转专业",
  "辅修",
  "免修",
  "缓考",
  "交流",
  "学籍",
  "毕业",
  "学位",
  "先修",
];
/** 全校性需要本人动手的事 */
const MUST_DO = [
  "报到",
  "注册",
  "教材",
  "开学",
  "选课",
  "考试",
  "补考",
  "停开",
  "补退选",
  "放假",
  "缴费",
];
/** 与学生日常无关的行政类 */
const IRRELEVANT = [
  "公示",
  "课题",
  "申报",
  "增设",
  "评审",
  "立项",
  "结题",
  "获奖",
  "专项",
  "教研",
  "教改",
];

export function relevanceOf(
  title: string,
  grade: string | null,
): { level: RelevanceLevel; reason?: string } {
  // 归一化：去掉括号与空白，否则「补（缓）考」这种写法匹配不到「缓考」
  const flat = title.replace(/[（）()【】[\]\s]/g, "");
  const gradeInTitle = flat.match(/(\d{4})\s*级/);
  if (grade && gradeInTitle) {
    return gradeInTitle[1] === grade
      ? { level: "high", reason: `点名 ${grade} 级` }
      : { level: "low", reason: `面向 ${gradeInTitle[1]} 级，非你所在年级` };
  }
  if (SITUATIONAL.some((w) => flat.includes(w))) {
    return { level: "medium", reason: "视个人情况" };
  }
  if (MUST_DO.some((w) => flat.includes(w))) {
    return { level: "high", reason: "需本人办理" };
  }
  if (IRRELEVANT.some((w) => flat.includes(w))) {
    return { level: "low", reason: "行政公示类" };
  }
  return { level: "low" };
}
