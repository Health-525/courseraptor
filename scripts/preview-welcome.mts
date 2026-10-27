/**
 * 预览脚本：用真实本地数据（课表缓存 + 待办）跑 welcome-panel 的正式渲染
 * 函数，套上 @ai-sdk/tui 同款外框打印，所见即 TUI 所得；并对每行做
 * 「可见宽度不超框」与「徽标列对齐」断言。美化迭代用，不进发布链路。
 * 用法：node --import tsx scripts/preview-welcome.mts
 */
import "../src/adapters";
import { buildWelcomeLines, textWidth, type WelcomeState } from "../local/cli/tui/welcome-panel";
import { loadScheduleCache } from "../src/core/schedule-cache";
import { school } from "../src/core/school";
import { listReminders } from "../src/core/workspace-data";

const DAY_MS = 86_400_000;
const todayWeekday = () => ((new Date().getDay() + 6) % 7) + 1;

// —— 用真实数据组装欢迎面板状态（与 welcome.ts 的取数路径一致）——
const now = new Date();
const terms = school().terms;
const cached = loadScheduleCache();
const week = cached ? terms.weekOf(cached.schedule.year, cached.schedule.semester) : null;

const schedule: WelcomeState["schedule"] = (() => {
  if (!cached) return { kind: "hint", text: "尚未配置教务账号" };
  const today = cached.schedule.courses
    .filter(
      (c) =>
        c.weekday === todayWeekday() && (!week || terms.expandWeeks(c.weeks).includes(week.week)),
    )
    .sort((a, b) => (a.periods[0] ?? 0) - (b.periods[0] ?? 0));
  if (!today.length) return { kind: "hint", text: "今天没有课" };
  return {
    kind: "rows",
    rows: today.slice(0, 4).map((c) => ({
      time: terms.periodTimeRange(c.periods) ?? "",
      title: c.title,
      location: c.location || "待定",
    })),
    more: Math.max(0, today.length - 4),
  };
})();

const todos: WelcomeState["todos"] = (() => {
  const due = listReminders().filter((r) => {
    if (r.done) return false;
    const t = Date.parse(r.dueAt);
    return Number.isFinite(t) && t <= now.getTime() + 7 * DAY_MS;
  });
  if (!due.length) return { kind: "hint", text: "暂无一周内到期待办" };
  return {
    kind: "rows",
    rows: due.slice(0, 4).map((r) => {
      const d = new Date(r.dueAt);
      return {
        title: r.title,
        days: Math.round(
          (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
            new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
            DAY_MS,
        ),
      };
    }),
    more: Math.max(0, due.length - 4),
  };
})();

const state: WelcomeState = {
  now,
  dateLabel: `${now.getMonth() + 1}月${now.getDate()}日 ${terms.weekdayName(todayWeekday())}`,
  week: week?.week,
  webUrl: "http://127.0.0.1:8787",
  blank: false,
  schedule,
  todos,
};

// —— 套上 @ai-sdk/tui 的外框（复刻 boxLine：剥 ANSI 按可见宽度补齐）——
// biome-ignore lint/suspicious/noControlCharactersInRegex: 复刻边框补齐前必须剥掉 ANSI 颜色序列
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");
const box = (line: string, width: number) =>
  `│ ${line}${" ".repeat(Math.max(0, width - textWidth(strip(line))))} │`;

function show(title: string, s: WelcomeState, columns: number) {
  const width = columns - 4;
  const lines = buildWelcomeLines(s, width);
  console.log(`\n== ${title}（终端 ${columns} 列）==`);
  console.log(`┌${"─".repeat(width + 2)}┐`);
  for (const l of lines) {
    const w = textWidth(strip(l));
    if (w > width) console.error(`!! 超宽 ${w} > ${width}：${strip(l)}`);
    console.log(box(l, width));
  }
  console.log(`└${"─".repeat(width + 2)}┘`);
  // 徽标右对齐检查：待办条目行去掉颜色后，徽标结尾列应一致
  const badgeEnds = lines
    .filter(
      (l) =>
        /还有 \d+ 天|已逾期|今天|明天/.test(strip(l)) &&
        strip(l).startsWith("  ") &&
        !strip(l).includes("滚轮"),
    )
    .map((l) => textWidth(strip(l)));
  if (badgeEnds.length > 1 && new Set(badgeEnds).size > 1)
    console.error("!! 待办徽标未对齐：", badgeEnds);
}

show("真实数据", state, 100);
show("真实数据·窄终端", state, 80);
show("真实数据·超窄", state, 60);
show(
  "未选学校",
  { ...state, blank: true, week: undefined, webUrl: "http://192.168.1.5:8787" },
  100,
);
show(
  "加载中",
  {
    ...state,
    week: undefined,
    schedule: { kind: "hint", text: "正在登录教务系统…" },
    todos: { kind: "hint", text: "正在获取…" },
    webUrl: null,
  },
  100,
);
