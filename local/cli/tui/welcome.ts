/**
 * 启动欢迎面板：往 @ai-sdk/tui 的空状态（scripts/patch-tui.mjs 打的补丁）
 * 注入实时教务数据。补丁每次重绘都读 globalThis.__raptorWelcome，所以这里
 * 后台拉取、逐段刷新：一周内待办（本地）→ 今日课表（登录）。
 * 任何一段失败只降级那一段的文案，不影响其他段和正常对话。
 * 未选学校（教务账号与导入课表都没有）时只留栏目题头与网页地址，
 * 不显示、也不拉取任何教务信息（用户 2026-10-04 指示）。
 */

import { startChatWeb } from "../../../src/channels/web/chat-web";
import { config } from "../../../src/core/config";
import type { ScheduleResult } from "../../../src/core/model";
import { loadScheduleCache, saveScheduleCache } from "../../../src/core/schedule-cache";
import { school } from "../../../src/core/school";
import { listReminders } from "../../../src/core/workspace-data";
import { dim, header } from "./color";

declare global {
  // eslint-disable-next-line no-var
  var __raptorWelcome: string[] | undefined;
}

const DAY_MS = 86_400_000;

/** JS 的周日=0 转成教学周 weekday（周一=1 … 周日=7） */
function todayWeekday(): number {
  return ((new Date().getDay() + 6) % 7) + 1;
}

// 面板各段的当前内容，任何一段更新后整体重渲染
const panel = {
  week: undefined as number | undefined,
  webUrl: null as string | null,
  /** 未选学校：栏目只留题头，内容一律不显示，面板只补网页地址 */
  blank: false,
  scheduleLines: [dim("  正在登录教务系统…")],
  todoLines: [dim("  正在获取…")],
};

/** 「已选学校」= 配了教务账号，或自定义学校已导入课表；两者都没有时不拉任何教务信息 */
export function schoolConfigured(): boolean {
  return Boolean((config.jwglUsername && config.jwglPassword) || loadScheduleCache());
}

function render() {
  const lines: string[] = [];
  const now = new Date();
  const date = `${now.getMonth() + 1}月${now.getDate()}日 ${school().terms.weekdayName(todayWeekday())}`;
  lines.push(`欢迎使用 CourseRaptor 🦖 · ${date}${panel.week ? ` · 第${panel.week}周` : ""}`, "");
  if (panel.blank) {
    for (const t of ["今日课表", "一周内待办"]) lines.push(header(t), "");
  } else {
    lines.push(
      header("今日课表"),
      ...panel.scheduleLines,
      "",
      header("一周内待办"),
      ...panel.todoLines,
    );
  }
  if (panel.webUrl) {
    // 非空面板最后一段（待办）后没有收尾空行，这里补上；空面板各段自带尾空行
    if (!panel.blank) lines.push("");
    lines.push(`💬 网页对话：${panel.webUrl} ${dim("（浏览器打开即聊）")}`);
  }
  // Star 引导带完整 https 前缀，终端才能把 URL 识别成可点击链接
  lines.push(
    "",
    dim("快捷键：滚轮/↑↓ 滚动 · ESC 打断回复 · 输入 / 唤出命令菜单 · Ctrl+C 退出"),
    dim("⭐ 觉得好用就点个 Star：https://github.com/Health-525/courseraptor"),
  );
  globalThis.__raptorWelcome = lines;
}

/** 启动时调用一次即可，后台逐段填充，永不 reject */
export function startWelcomeBootstrap(): void {
  void bootstrap().catch(() => {});
}

async function bootstrap() {
  // 未选学校（教务账号与导入课表都没有）：栏目题头保留、里面不显示任何信息，
  // 也不再发起教务请求——只把网页地址补进面板，配置都在网页「设置」里做
  panel.blank = !schoolConfigured();
  render();
  void refreshWebUrl(); // 网页版地址随本地服务起好后补进面板
  if (panel.blank) return;
  refreshTodos(); // 待办是本地数据，同步读
  await refreshSchedule();
}

/** 一周内到期的未完成待办（含已逾期），给空屏面板一段速览 */
function refreshTodos() {
  try {
    const now = new Date();
    const due = listReminders().filter((r) => {
      if (r.done) return false;
      const t = Date.parse(r.dueAt);
      return Number.isFinite(t) && t <= now.getTime() + 7 * DAY_MS;
    });
    if (!due.length) {
      panel.todoLines = [dim("  暂无一周内到期待办")];
      return;
    }
    panel.todoLines = due.slice(0, 5).map((r) => {
      const d = new Date(r.dueAt);
      const days = Math.round(
        (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
          new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
          DAY_MS,
      );
      const when = days < 0 ? "⚠ 已逾期" : days === 0 ? "今天" : `还有 ${days} 天`;
      return `• ${r.title} ${dim(`· ${when}`)}`;
    });
    if (due.length > 5) {
      panel.todoLines.push(dim(`  …还有 ${due.length - 5} 条，问我看全部`));
    }
  } catch {
    panel.todoLines = [dim("  待办读取失败（不影响使用）")];
  }
  render();
}

/** 网页服务在 index.ts 已并行启动，这里只等它的地址；起不来就不显示这一行 */
async function refreshWebUrl() {
  panel.webUrl = await startChatWeb();
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
  // 没配教务账号（首次引导被跳过）就不去撞登录接口，直接给补填指引
  if (!config.jwglUsername || !config.jwglPassword) {
    panel.scheduleLines = [dim("  尚未配置教务账号；网页「设置 → 教务账号」里补填后即可查课表")];
    render();
    return;
  }
  try {
    const s = school();
    const cookie = await s.auth.getCookie();
    const r = await s.schedule?.fetchSmart(cookie);
    if (!r?.ok) {
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
  const terms = school().terms;
  const week = terms.weekOf(data.year, data.semester);
  panel.week = week?.week;
  const today = data.courses
    .filter(
      (c) =>
        c.weekday === todayWeekday() && (!week || terms.expandWeeks(c.weeks).includes(week.week)),
    )
    .sort((a, b) => (a.periods[0] ?? 0) - (b.periods[0] ?? 0));
  if (today.length === 0) {
    panel.scheduleLines = [dim(week ? `  今天没有课（第${week.week}周）` : "  今天没有课")];
  } else {
    panel.scheduleLines = today.slice(0, 5).map((c) => {
      const time = terms.periodTimeRange(c.periods);
      return `• ${time ? `${time} ` : ""}${c.title} @${c.location || "待定"}`;
    });
    if (today.length > 5) {
      panel.scheduleLines.push(dim(`  …还有 ${today.length - 5} 门，问我看全部`));
    }
  }
  render();
}
