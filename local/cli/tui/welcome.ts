/**
 * 启动欢迎面板：往 @ai-sdk/tui 的空状态（scripts/patch-tui.mjs 打的补丁）
 * 注入实时教务数据。补丁每次重绘都读 globalThis.__raptorWelcome，所以这里
 * 后台拉取、逐段刷新：一周内待办（本地）→ 今日课表（登录）。
 * 任何一段失败只降级那一段的文案，不影响其他段和正常对话。
 * 未选学校（教务账号与导入课表都没有）时只留栏目题头与网页地址，
 * 不显示、也不拉取任何教务信息（用户 2026-10-04 指示）。
 *
 * 本文件只管取数与状态；排版在 local/cli/tui/welcome-panel.ts（纯函数，
 * 布局说明与宽度口径见其文件头）。
 */

import { startChatWeb } from "../../../src/channels/web/chat-web";
import { config } from "../../../src/core/config";
import type { ScheduleResult } from "../../../src/core/model";
import { loadScheduleCache, saveScheduleCache } from "../../../src/core/schedule-cache";
import { school } from "../../../src/core/school";
import { listReminders } from "../../../src/core/workspace-data";
import { buildWelcomeLines, type ScheduleRow, type WelcomeState } from "./welcome-panel";

declare global {
  // eslint-disable-next-line no-var
  var __raptorWelcome: string[] | undefined;
}

const DAY_MS = 86_400_000;
/** 每栏目最多展示条数：正文区高度 = 终端行数 - 5，24 行终端下 4+4 条加
 *  装饰行正好放得下（完整列表对话里问一句就有） */
const MAX_ROWS = 4;

/** JS 的周日=0 转成教学周 weekday（周一=1 … 周日=7） */
function todayWeekday(): number {
  return ((new Date().getDay() + 6) % 7) + 1;
}

// 面板各段的当前内容，任何一段更新后整体重渲染
const panel: WelcomeState = {
  now: new Date(),
  dateLabel: "",
  week: undefined,
  webUrl: null,
  /** 未选学校：栏目只留题头，内容一律不显示，面板只补网页地址 */
  blank: false,
  schedule: { kind: "hint", text: "正在登录教务系统…" },
  todos: { kind: "hint", text: "正在获取…" },
};

/** 「已选学校」= 配了教务账号，或自定义学校已导入课表；两者都没有时不拉任何教务信息 */
export function schoolConfigured(): boolean {
  return Boolean((config.jwglUsername && config.jwglPassword) || loadScheduleCache());
}

/** TUI 正文区可用宽度，与库的 boxLine 一致（框宽 - 4 列边距） */
function contentWidth(): number {
  return Math.max(36, (process.stdout.columns ?? 80) - 4);
}

function render() {
  const now = new Date();
  panel.now = now;
  panel.dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 ${school().terms.weekdayName(todayWeekday())}`;
  globalThis.__raptorWelcome = buildWelcomeLines(panel, contentWidth());
}

/** 启动时调用一次即可，后台逐段填充，永不 reject */
export function startWelcomeBootstrap(): void {
  // 分屏/拖窗口时库靠 resize 事件全帧重绘并重读面板，这里同步重排，
  // 右对齐徽标列与条目截断宽度才能跟上新宽度
  process.stdout.on("resize", () => render());
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
      panel.todos = { kind: "hint", text: "暂无一周内到期待办" };
    } else {
      panel.todos = {
        kind: "rows",
        rows: due.slice(0, MAX_ROWS).map((r) => {
          const d = new Date(r.dueAt);
          const days = Math.round(
            (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
              new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
              DAY_MS,
          );
          return { title: r.title, days };
        }),
        more: due.length - MAX_ROWS,
      };
    }
  } catch {
    panel.todos = { kind: "hint", text: "待办读取失败（不影响使用）" };
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
    panel.schedule = {
      kind: "hint",
      text: "尚未配置教务账号；网页「设置 → 教务账号」里补填后即可查课表",
    };
    render();
    return;
  }
  try {
    const s = school();
    const cookie = await s.auth.getCookie();
    const r = await s.schedule?.fetchSmart(cookie);
    if (!r?.ok) {
      panel.schedule = { kind: "hint", text: "课表获取失败，可直接问我查详情" };
      render();
      return;
    }
    saveScheduleCache(r.data);
    renderSchedule(r.data);
  } catch {
    panel.schedule = { kind: "hint", text: "教务登录失败，直接提问可看详细报错" };
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
    // 教学周号已在首行日期里，这里不重复
    panel.schedule = { kind: "hint", text: "今天没有课" };
  } else {
    panel.schedule = {
      kind: "rows",
      rows: today.slice(0, MAX_ROWS).map<ScheduleRow>((c) => ({
        time: terms.periodTimeRange(c.periods) ?? "",
        title: c.title,
        location: c.location || "待定",
      })),
      more: today.length - MAX_ROWS,
    };
  }
  render();
}
