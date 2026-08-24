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
  totalCredits: number;
  requiredCourses: number;
  allCourses: GradeCourse[];
}

export interface GradeCourse {
  course: string;
  score: string;
  credit: string;
  type: string;
  semester: string;
}

export interface NewsItem {
  title: string;
  url: string;
  date: string;
  category?: string;
}
