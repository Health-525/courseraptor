/**
 * 启动欢迎面板：往 @ai-sdk/tui 的空状态（scripts/patch-tui.mjs 打的补丁）
 * 注入实时教务数据。补丁每次重绘都读 globalThis.__raptorWelcome，所以这里
 * 分阶段拉、逐段刷新：最新通知（无需登录）→ 今日课表（登录）。
 * 任何一段失败只降级那一段的文案，不影响其他段和正常对话。
 */

import { getCookie } from "../tools/session";
import { fetchJwcNews } from "../jwgl/news";
import {
  expandWeeks,
  fetchScheduleSmart,
  periodTimeRange,
  WEEKDAY_NAMES,
  type ScheduleResult,
} from "../jwgl/academics";
import { currentWeekOf } from "../jwgl/term-dates";
import { loadScheduleCache, saveScheduleCache } from "../schedule-cache";
import { startChatWeb } from "../web/chat-web";

declare global {
  // eslint-disable-next-line no-var
  var __raptorWelcome: string[] | undefined;
}

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const header = (s: string) => `${CYAN}【${s}】${RESET}`;
const dim = (s: string) => `${DIM}${s}${RESET}`;

/** JS 的周日=0 转成教学周 weekday（周一=1 … 周日=7） */
function todayWeekday(): number {
  return ((new Date().getDay() + 6) % 7) + 1;
}

// 面板各段的当前内容，任何一段更新后整体重渲染
const panel = {
  week: undefined as number | undefined,
  webUrl: null as string | null,
  scheduleLines: [dim("  正在登录教务系统…")],
  newsLines: [dim("  正在获取…")],
};

function render() {
  const lines: string[] = [];
  const now = new Date();
  const date = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAY_NAMES[todayWeekday()]}`;
  lines.push(
    `欢迎使用 CourseRaptor 🦖 · ${date}${panel.week ? ` · 第${panel.week}周` : ""}`,
    "",
    header("今日课表"),
    ...panel.scheduleLines,
    "",
    header("最新通知"),
    ...panel.newsLines,
    ...(panel.webUrl
      ? ["", `💬 网页对话：${panel.webUrl} ${dim("（浏览器打开即聊）")}`]
      : []),
  );
  lines.push("", dim("快捷键：滚轮/↑↓ 滚动 · ESC 打断回复 · 输入 / 唤出命令菜单 · Ctrl+C 退出"));
  globalThis.__raptorWelcome = lines;
}

/** 启动时调用一次即可，后台逐段填充，永不 reject */
export function startWelcomeBootstrap(): void {
  void bootstrap().catch(() => {});
}

async function bootstrap() {
  render();
  void refreshNews(); // 通知不依赖教务登录，并行先刷
  void refreshWebUrl(); // 网页版地址随本地服务起好后补进面板
  await refreshSchedule();
}

/** 网页服务在 index.ts 已并行启动，这里只等它的地址；起不来就不显示这一行 */
async function refreshWebUrl() {
  panel.webUrl = await startChatWeb();
  render();
}

async function refreshNews() {
  try {
    const news = await fetchJwcNews([], 3);
    panel.newsLines = news.length
      ? news.map((n) => `• ${n.title} ${dim(String(n.date).slice(5))}`)
      : [dim("  暂无通知")];
  } catch {
    panel.newsLines = [dim("  通知获取失败（不影响使用）")];
  }
  render();
}

async function refreshSchedule() {
  // 课表一学期基本不变：有本地缓存就直接渲染，不登录不请求教务系统。
  // 缓存由 get_schedule 工具在用户问课表时刷新，学期切换后问一次即同步。
  const cached = loadScheduleCache();
  if (cached) {
    renderSchedule(cached.schedule);
    return;
  }
  try {
    const cookie = await getCookie();
    const r = await fetchScheduleSmart(cookie);
    if (!r.ok) {
      panel.scheduleLines = [dim("  课表获取失败，可直接问我查详情")];
      render();
      return;
    }
    saveScheduleCache(r.data);
    renderSchedule(r.data);
  } catch {
    panel.scheduleLines = [dim("  教务登录失败，直接提问可看详细报错")];
  }
  render();
}

function renderSchedule(data: ScheduleResult) {
  const week = currentWeekOf(data.year, data.semester);
  panel.week = week?.week;
  const today = data.courses
    .filter(
      (c) =>
        c.weekday === todayWeekday() &&
        (!week || expandWeeks(c.weeks).includes(week.week)),
    )
    .sort((a, b) => (a.periods[0] ?? 0) - (b.periods[0] ?? 0));
  if (today.length === 0) {
    panel.scheduleLines = [
      dim(week ? `  今天没有课（第${week.week}周）` : "  今天没有课"),
    ];
  } else {
    panel.scheduleLines = today.slice(0, 5).map((c) => {
      const time = periodTimeRange(c.periods);
      return `• ${time ? `${time} ` : ""}${c.title} @${c.location || "待定"}`;
    });
    if (today.length > 5) {
      panel.scheduleLines.push(dim(`  …还有 ${today.length - 5} 门，问我看全部`));
    }
  }
  render();
}
