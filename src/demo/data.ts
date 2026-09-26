/**
 * 演示模式的虚构数据单一来源：独立页内嵌数据、/api/today 与 live 工具共用。
 * 全部条目为虚构示例；日期相对「现在」生成，任何时刻打开演示都成立。
 */

import type { BriefCourse, BriefDay, TodayBrief } from "../channels/web/today-brief";
import type { KnowledgeEntry } from "../core/knowledge";

export const DEMO_PERIOD_TIMES: Record<string, string> = {
  "1": "08:10-08:55",
  "2": "09:05-09:50",
  "3": "10:20-11:05",
  "4": "11:15-12:00",
  "5": "14:00-14:45",
  "6": "14:55-15:40",
  "7": "16:00-16:45",
  "8": "16:55-17:40",
  "9": "19:00-19:45",
  "10": "19:55-20:40",
};

export const DEMO_CLASS_TIMES: Record<string, string> = {
  "1-2节": "08:10-09:50",
  "3-4节": "10:20-12:00",
  "5-6节": "14:00-15:40",
  "7-8节": "16:00-17:40",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** 演示知识库：覆盖「归入课程 / 自定义分类 / 未分类」三种形态，条目全为虚构 */
export function demoKnowledge(now: Date): KnowledgeEntry[] {
  const at = (daysAgo: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 20, 30).getTime();
  return [
    {
      id: "demo-kn-1",
      title: "洛必达法则",
      content:
        "求 0/0 或 ∞/∞ 型未定式极限时，若分子分母均可导，可分别求导后再取极限：lim f(x)/g(x) = lim f'(x)/g'(x)。条件不满足（如导数比值的极限不存在）时不能用它。（虚构示例）",
      category: "示例高等数学",
      source: "对话",
      createdAt: at(6),
      updatedAt: at(2),
    },
    {
      id: "demo-kn-2",
      title: "现在完成时",
      content:
        "have/has + 过去分词：表示过去发生的动作对现在的影响，或从过去持续到现在的状态。常见信号词：already、yet、just、since、for。（虚构示例）",
      category: "示例大学英语",
      source: "对话",
      createdAt: at(5),
      updatedAt: at(5),
    },
    {
      id: "demo-kn-3",
      title: "二分查找",
      content:
        "有序数组中查找目标：每次与中点比较，排除一半区间，时间复杂度 O(log n)。注意边界：左闭右开区间用 left < right 循环。（虚构示例）",
      category: "示例程序设计",
      source: "对话",
      createdAt: at(4),
      updatedAt: at(4),
    },
    {
      id: "demo-kn-4",
      title: "番茄工作法",
      content:
        "25 分钟专注 + 5 分钟休息为一个番茄钟，每 4 个番茄钟多休一会儿；期间被打断就重新计。（虚构示例）",
      category: null,
      source: "对话",
      createdAt: at(1),
      updatedAt: at(1),
    },
    {
      id: "demo-kn-5",
      title: "TypeScript 类型收窄",
      content:
        "typeof / instanceof / in 判断后变量类型自动收窄；只需约束取值时，字面量联合（'ok' | 'error'）比 enum 更轻量。（虚构示例）",
      category: "编程技术",
      source: "对话",
      createdAt: at(3),
      updatedAt: at(3),
    },
  ].sort((a, b) => b.updatedAt - a.updatedAt); // 与真实 listKnowledge 一致：最近更新在前
}

/** 演示待办：跟真实时钟走，覆盖逾期/今天/数天后三种形态 + 已完成折叠区 */
export function demoTodos(now: Date): {
  items: TodayBrief["todos"]["items"];
  done: TodayBrief["todos"]["done"];
} {
  const names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const dueAt = (offset: number, h: number, m: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, h, m);
  const todoLabel = (d: Date) => {
    const diff = Math.round(
      (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
        new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
        86400000,
    );
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (diff === 0) return `今天 ${hm}`;
    if (diff === 1) return `明天 ${hm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${names[(d.getDay() + 6) % 7]} ${hm}`;
  };
  return {
    items: [
      {
        id: "demo-todo-1",
        title: "交示例实验报告",
        dueAt: dueAt(-1, 23, 59).toISOString(),
        dueLabel: todoLabel(dueAt(-1, 23, 59)),
        overdue: true,
        isToday: false,
        source: "对话",
      },
      {
        id: "demo-todo-2",
        title: "复习示例高等数学第 3 章",
        dueAt: dueAt(0, 22, 0).toISOString(),
        dueLabel: todoLabel(dueAt(0, 22, 0)),
        overdue: false,
        isToday: true,
        notes: "重点看极限与连续（虚构示例）",
      },
      {
        id: "demo-todo-3",
        title: "示例英语 quiz 备考",
        dueAt: dueAt(4, 14, 0).toISOString(),
        dueLabel: todoLabel(dueAt(4, 14, 0)),
        overdue: false,
        isToday: false,
      },
    ],
    // 已完成折叠区与撤销入口的样子
    done: [
      {
        id: "demo-todo-done-1",
        title: "领取示例教材",
        dueAt: dueAt(-2, 18, 0).toISOString(),
        dueLabel: todoLabel(dueAt(-2, 18, 0)),
        doneAt: Date.now() - 3 * 3600_000,
      },
    ],
  };
}

export function demoTodayBrief(): TodayBrief {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const weekday = ((now.getDay() + 6) % 7) + 1; // 周一=1…周日=7
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (weekday - 1));
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayAt = (i: number) =>
    new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
  const names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const short = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

  // 周内课程表（weekday-1 为下标）：每天都排一两门，任意日子打开演示页
  // 今日时间线都有内容；周六是调休补课，演示调休覆盖
  const weekCourses: Array<
    Array<{ title: string; periods: string; location?: string; teacher?: string }>
  > = [
    [
      { title: "示例高等数学", periods: "1-2节", location: "示例教学楼 101", teacher: "王老师" },
      { title: "示例大学英语", periods: "3-4节", location: "示例教学楼 202", teacher: "李老师" },
      { title: "示例通识选修", periods: "7-8节", location: "示例教学楼 303" },
    ],
    [{ title: "示例程序设计", periods: "3-4节", location: "示例机房", teacher: "陈老师" }],
    [
      { title: "示例高等数学", periods: "1-2节", location: "示例教学楼 101", teacher: "王老师" },
      { title: "示例大学英语", periods: "3-4节", location: "示例教学楼 202", teacher: "李老师" },
      { title: "示例程序设计", periods: "5-6节", location: "示例机房", teacher: "陈老师" },
    ],
    [{ title: "示例体育课", periods: "5-6节", location: "示例体育馆" }],
    [{ title: "示例大学英语（口语）", periods: "1-2节", location: "示例语音室" }],
    [{ title: "示例高等数学", periods: "1-2节", location: "示例教学楼 101", teacher: "王老师" }],
    [],
  ];

  const toBrief = (c: {
    title: string;
    periods: string;
    location?: string;
    teacher?: string;
  }): BriefCourse => {
    const time = DEMO_CLASS_TIMES[c.periods];
    const [sh, sm] = time.split("-")[0].split(":").map(Number);
    const [eh, em] = time.split("-")[1].split(":").map(Number);
    const status: BriefCourse["status"] =
      nowMin > eh * 60 + em ? "done" : nowMin >= sh * 60 + sm ? "current" : "upcoming";
    return {
      title: c.title,
      periods: c.periods,
      time,
      ...(c.location ? { location: c.location } : {}),
      ...(c.teacher ? { teacher: c.teacher } : {}),
      status,
    };
  };

  const todayCourses = weekCourses[weekday - 1].map(toBrief);

  // 下一节课：今天未开始的，否则往后找（跨到下周一只示例周一的课）。
  // 注意未来日期不能用「当前时刻算出的 status」过滤——晚上打开时那天
  // 的课会被误判成已结束；只有今天（look=0）才看状态
  let next: TodayBrief["next"] = null;
  for (let look = 0; look <= 7 && !next; look++) {
    const idx = (weekday - 1 + look) % 7;
    const list = look === 0 ? todayCourses : weekCourses[idx].map(toBrief);
    const date = dayAt(weekday - 1 + look);
    for (const c of list) {
      if (look === 0 && c.status !== "upcoming") continue;
      if (!c.time) continue;
      const [sh, sm] = c.time.split("-")[0].split(":").map(Number);
      const startsInMin = look * 1440 + sh * 60 + sm - nowMin;
      if (startsInMin <= 0) continue;
      next = {
        dateISO: iso(date),
        dateLabel:
          look === 0
            ? "今天"
            : look === 1
              ? "明天"
              : `${date.getMonth() + 1}月${date.getDate()}日 ${names[idx]}`,
        ...(idx === 5 ? { makeup: true } : {}),
        course: c,
        startsInMin,
      };
      break;
    }
  }

  const days: BriefDay[] = weekCourses.map((list, i) => {
    const date = dayAt(i);
    return {
      dateISO: iso(date),
      weekday: i + 1,
      label: names[i],
      dateShort: short(date),
      isToday: i === weekday - 1,
      ...(i === 5 ? { makeup: true } : {}),
      courses: list.map((c) => ({
        title: c.title,
        time: DEMO_CLASS_TIMES[c.periods],
        location: c.location,
        teacher: c.teacher,
        weeks: "1-16",
        pStart: Number(c.periods.match(/^\d+/)?.[0]),
        pEnd: Number(c.periods.match(/(\d+)节$/)?.[1]),
      })),
    };
  });

  const todos = demoTodos(now);

  return {
    now: now.toISOString(),
    dateLabel: `${now.getMonth() + 1}月${now.getDate()}日 ${names[weekday - 1]}`,
    periodTimes: DEMO_PERIOD_TIMES,
    term: {
      label: "2026-2027学年第一学期（示例）",
      weekLabel: "第 2 周",
      week: 2,
      maxWeek: 16,
      weekSource: "known",
    },
    schedule: {
      available: true,
      cachedAt: Date.now() - 2 * 3600_000,
      stale: false,
      todaySpecial: null,
      courses: todayCourses,
      ...(todayCourses.length ? {} : { note: "今天没有课（虚构示例课表）" }),
    },
    next,
    week: { mondayISO: iso(monday), days },
    exams: {
      available: true,
      cachedAt: Date.now() - 6 * 3600_000,
      upcoming: demoExams(now).slice(0, 1),
      note: "演示只展示一场虚构考试",
    },
    todos: { items: todos.items, done: todos.done },
    knowledge: { total: demoKnowledge(now).length, recent: demoKnowledge(now).slice(0, 5) },
  };
}

/** 演示成绩：与离线剧本文案同数字（GPA 3.30 / 42 学分 / 58 分未过 / 缓考） */
export function demoGrades() {
  return {
    term: "2026-2027学年第一学期（示例）",
    gpa: 3.3,
    creditsEarned: 42,
    courses: [
      { name: "示例高等数学", category: "必修", credits: 4, score: 86 },
      { name: "示例大学英语", category: "必修", credits: 3, score: 78 },
      { name: "示例程序设计", category: "必修", credits: 4, score: 92 },
      { name: "示例体育课", category: "必修", credits: 1, score: 90 },
      { name: "示例通识选修（人文）", category: "通识·人文类", credits: 2, score: 88 },
      { name: "示例通识选修（自然）", category: "通识·自然类", credits: 2, score: 81 },
      { name: "示例课程 A", category: "必修", credits: 3, score: 58, status: "未通过" },
      { name: "示例课程 B", category: "必修", credits: 2, status: "缓考（待出分）" },
    ],
    general: { 人文类: 2, 自然类: 2, 公共艺术类: 0 },
    note: "全部为虚构示例；未通过与缓考课程不计入已获学分",
  };
}

/** 演示考试：日期相对今天生成，任何时刻打开都是「即将到来」 */
export function demoExams(now: Date) {
  const padDate = (offset: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  return [
    {
      subject: "示例课程 A",
      date: padDate(5),
      time: "09:00-11:00",
      location: "示例教学楼 101",
      seatNumber: "12",
      inDays: 5,
      isToday: false,
    },
    {
      subject: "示例课程 B",
      date: padDate(7),
      time: "14:00-16:00",
      location: "示例教学楼 202",
      seatNumber: "05",
      inDays: 7,
      isToday: false,
    },
  ];
}

/** 演示通知：3 条虚构条目，不含任何真实链接 */
export function demoNews(now: Date) {
  const padDate = (daysAgo: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  return [
    {
      id: "demo-news-1",
      title: "关于本学期选修课教学班调整的通知（虚构示例）",
      date: padDate(1),
      summary: "部分选修课教学班时间与地点微调，请同学们核对课表并确认学分归属。",
      content:
        "因教室调度原因，部分选修课教学班的上课时间或地点有小幅调整，具体以教务系统课表为准。请于本周内完成核对，涉及学分归属问题的同学可咨询所在学院教务老师。（虚构示例，无真实链接）",
    },
    {
      id: "demo-news-2",
      title: "大学英语四六级考试报名通知（虚构示例）",
      date: padDate(3),
      summary: "报名即日开始，逾期不再补报；考试时间以下发准考证为准。",
      content:
        "本次报名采取线上方式，报名前请确认学籍状态正常。报名成功后请留意准考证下发通知，按时参加考试。（虚构示例，无真实链接）",
    },
    {
      id: "demo-news-3",
      title: "期末考试考场安排发布（虚构示例）",
      date: padDate(6),
      summary: "考场与座位号可在教务系统查询，请提前熟悉考场位置。",
      content:
        "期末考试考场安排已发布，考生可凭学号查询所在考场与座位号。请携带有效证件按时参加考试，遵守考场纪律。（虚构示例，无真实链接）",
    },
  ];
}
