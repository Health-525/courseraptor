/**
 * 领域模型：core 定义的规范数据形状
 *
 * 适配器（adapters/njtech）负责把学校系统抓到的原始数据映射成这里的
 * 形状；core 与 channels 只消费本文件，不接触任何学校私有结构。
 * 历史上这些类型与 NJTECH 抓取逻辑同住 src/jwgl/types.ts，
 * 多校适配（roadmap P3）时抽到 core 作为跨学校的公共契约。
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
  /** 课程归属（如通识选修分类；具体类目是学校规则，见适配器） */
  category?: string;
  /** 课程类别（通识教育课/学科基础课/专业教育课等） */
  courseClass?: string;
}

export interface NewsItem {
  title: string;
  url: string;
  date: string;
  category?: string;
  /**
   * 官网设置了浏览权限的文章（webplus 未静态化，列表里只给 article.jsp
   * 动态链接）：匿名打开原文会被 302 到 auth.htm「您无权访问此页面」
   */
  restricted?: boolean;
}

/** 通知正文（含附件清单） */
export interface SchoolArticle {
  title: string;
  text: string;
  attachments: Array<{ name: string; url: string }>;
}

// ── 学期 ──────────────────────────────────────────────────────

/** 学期候选（不带展示名）：探测与解析的返回形状 */
export interface TermCandidate {
  year: number;
  semester: number;
}

/** 学期引用。semester 取学校侧编码（正方系 3=秋、12=春），展示交给 terms.label */
export interface TermRef extends TermCandidate {
  label: string;
}

/** 学期开学日期来源：recorded > known > estimated，只有前两者能当真值用 */
export type TermDateSource = "recorded" | "known" | "estimated";

export interface TermStartDate {
  /** 第 1 周的周一，YYYY-MM-DD */
  week1Monday: string;
  source: TermDateSource;
  /** 依据：通知文号/标题片段；estimated 时写估算规则 */
  evidence?: string;
  recordedAt?: string;
}

// ── 课表 / 考试结果 ────────────────────────────────────────────

/** 按周预分组的课表：week -> 该周实际要上的课（预格式化好的行） */
export interface WeekGroup {
  week: number;
  count: number;
  /** 预格式化为可直接引用的文本行，避免模型再拼字段 */
  lines: string[];
}

export type ScheduleResult = {
  year: number;
  semester: number;
  label: string;
  courses: CourseData[];
};

export type ExamResult = {
  year: number;
  semester: number;
  label: string;
  exams: ExamData[];
};

/** 上课时间字符串拆分后的单个时段（星期 + 节次 + 周次） */
export interface SkwjSegment {
  weekday: number;
  /** 节次数组，如 [5, 6] */
  periods: number[];
  /** 周次表达式原文，如 "2-17" 或 "2-6,8-12" */
  weeks: string;
  /** 展开后的周号列表 */
  expandedWeeks: number[];
}
