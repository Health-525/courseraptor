/**
 * NJTECH 教务系统数据类型
 * 移植自 ScholarFlow lib/schools/types.ts（仅教务相关部分）
 */

export interface CourseData {
  title: string;
  weekday: number;
  periods: number[];
  weeks: string;
  location: string;
  teacher: string;
  [key: string]: unknown;
}

export interface ExamData {
  subject: string;
  date: string;
  time: string;
  location: string;
  seatNumber?: string;
  [key: string]: unknown;
}

export interface GradeResult {
  gpa: string;
  /**
   * 计入 GPA 的必修课学分和。**不是**总修学分——
   * 字段名曾是 totalCredits，LLM 消费者必然理解成「已修总学分」并转述给用户，
   * 对 agent 项目而言命名歧义等价于 bug，所以直接改名并补充说明字段。
   */
  requiredCredits: number;
  requiredCourses: number;
  /** GPA 口径说明（模型应原样转述，避免用户误读分母） */
  gpaBasis?: string;
  /** 通过型（合格/免修等）必修课学分：有学分、不计 GPA */
  passFailCredits?: number;
  /** 彻底拿不到数据的学期（重试 3 次后放弃），空数组才代表完整 */
  failedTerms?: string[];
  allCourses: GradeCourse[];
}

export interface GradeCourse {
  course: string;
  /** 课程号（去重键的一部分：重修同号取最高分，多学期同名课靠它区分） */
  courseCode?: string;
  score: string;
  credit: string;
  type: string;
  semester: string;
  /** 课程归属（通识选修六类：创新创业类/公共艺术类/人文类/社会类/自然类/AI前沿技术类） */
  category?: string;
  /** 课程类别（通识教育课/学科基础课/专业教育课等） */
  courseClass?: string;
}

export interface NewsItem {
  title: string;
  url: string;
  date: string;
  category?: string;
}
