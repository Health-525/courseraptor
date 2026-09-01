/**
 * 学籍与课程信息工具：get_student_info / get_enrolled_courses / get_retake_courses
 */

import { tool } from "ai";
import { z } from "zod";
import { fetchEnrolledClasses, fetchProfile, fetchRetakeCourses } from "../jwgl/portal";
import { getCookie } from "./session";

export const studentTools = {
  /** 学籍个人信息 */
  get_student_info: tool({
    description:
      "查询学籍个人信息：姓名、学号、性别、学院、专业、班级、年级、学制、入学/毕业日期等（从教务系统个人信息页解析）。需要确认用户身份信息、或查询班级/专业信息时调用。",
    inputSchema: z.object({}),
    execute: async () => {
      const cookie = await getCookie();
      const profile = await fetchProfile(cookie);
      // 敏感字段打码（只留前4后4），避免完整证件/卡号进入模型上下文
      const SENSITIVE = /证件号码|银行卡|考生号/;
      const masked: Record<string, string> = {};
      let maskedCount = 0;
      for (const [k, v] of Object.entries(profile)) {
        if (SENSITIVE.test(k) && v.length > 8) {
          masked[k] = `${v.slice(0, 4)}****${v.slice(-4)}`;
          maskedCount++;
        } else {
          masked[k] = v;
        }
      }
      const keys = Object.keys(masked);
      return {
        total: keys.length,
        info: masked,
        maskedNote: maskedCount > 0 ? `${maskedCount} 个敏感字段已打码` : undefined,
        note: keys.length === 0 ? "个人信息页解析失败（页面结构可能变化）" : undefined,
      };
    },
  }),

  /** 已选课程教学班 */
  get_enrolled_courses: tool({
    description:
      "查询本学期已选的课程教学班列表：课程名、教学班、教师、上课时间、地点、学分、课程性质（必修/选修）。注意：与课表（get_schedule）互补，这里按教学班维度、含选课属性。",
    inputSchema: z.object({}),
    execute: async () => {
      const cookie = await getCookie();
      const classes = await fetchEnrolledClasses(cookie);
      return {
        total: classes.length,
        courses: classes,
        note: classes.length === 0 ? "暂无已选课程（学期初未选课属正常）" : undefined,
      };
    },
  }),

  /** 可重修课程 */
  get_retake_courses: tool({
    description:
      "查询可重修的课程列表（历年开课记录，含课程号/开课学院/学分）。用户问「××能不能重修」「重修有哪些课」或计划重修时调用；可用 keyword 过滤课程名。",
    inputSchema: z.object({
      keyword: z.string().optional().describe("课程名关键词过滤（可选）"),
    }),
    execute: async ({ keyword }) => {
      const cookie = await getCookie();
      const all = await fetchRetakeCourses(cookie);
      const filtered = keyword ? all.filter((c) => c.courseName.includes(keyword)) : all;
      return {
        total: filtered.length,
        totalAll: all.length,
        courses: filtered.slice(0, 40).map((c) => ({
          ...c,
          semester: c.semester || undefined,
        })),
        note:
          filtered.length > 40
            ? `仅显示前 40 条（共 ${filtered.length} 条，可加 keyword 过滤）`
            : undefined,
      };
    },
  }),
};
