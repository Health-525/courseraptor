/**
 * Token 用量记账：每次 LLM 调用的 usage 按天 / 按模型聚合落盘。
 *
 * - 数据源：agent.ts 的模型中间件在每次 doGenerate / doStream 完成时上报
 *   （输入 / 输出 token 数），本地版与托管版同一条链路
 * - 落盘：data/token-usage.json（原子替换），保留近 371 天（GitHub 式
 *   热力图一年窗口的余量），过期日期在写入时顺带清理
 * - 切日按北京时间（受众是南工大学生，与网关 local-usage 同口径）
 * - 写盘节流：记录先进内存 pending，2 秒防抖合并一次；网页端读取
 *   （tokenUsageSnapshot）前强制冲刷，保证看到的数据不缺角
 * - 托管版上报：RAPTOR_HOSTED=1 且注入了 RAPTOR_USAGE_REPORT_URL /
 *   RAPTOR_USAGE_REPORT_TOKEN（spawner 拉起实例时给）时，每次调用
 *   fire-and-forget POST 网关内部端点——网关按用户 / 模型聚合全站账本，
 *   管理台「Token 用量」页的数据源。失败静默丢弃：统计不是账本，
 *   绝不能拖慢或打断对话
 *
 * 本模块严禁 import AI SDK（llm.ts 的闭包约束同样适用）。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { dataDir } from "./paths";

/** 保留天数：热力图一年（52 周 + 当前周）再加一周余量 */
const MAX_DAYS = 371;
/** 写盘防抖：一次对话的多次工具循环调用合并成一次落盘 */
const FLUSH_DELAY_MS = 2_000;
/** 网关上报超时：fire-and-forget，超了就丢 */
const REPORT_TIMEOUT_MS = 4_000;

export interface TokenUsageEntry {
  in: number;
  out: number;
}

/** 落盘形状：日期 → 模型（providerId/modelId）→ 输入/输出 token */
export interface TokenUsageFile {
  days: Record<string, Record<string, TokenUsageEntry>>;
}

/**
 * 北京时间日期（YYYY-MM-DD）。用 Intl 按真实北京时区取——本机跑什么时区
 * 都不影响切日口径（now+8h 的换算只在 UTC 机器上正确，北京时间 16 点后
 * 在东八区本机会把用量记到「明天」）。
 */
function beijingDate(now: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts.replaceAll("/", "-");
}

function fileOf(): string {
  return path.join(dataDir(), "token-usage.json");
}

async function loadFile(): Promise<TokenUsageFile> {
  try {
    const parsed = JSON.parse(await fsp.readFile(fileOf(), "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.days !== "object") {
      return { days: {} };
    }
    return parsed as TokenUsageFile;
  } catch {
    // 文件不存在（首次记录）或损坏：统计丢了可重建，按空表起步
    return { days: {} };
  }
}

/** pending：date → model → 累计值（防抖窗口内的多次调用先在内存合并） */
const pending = new Map<string, Map<string, TokenUsageEntry>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** 读-改-写串行化（同 registry / credentials 的约定） */
let chain: Promise<unknown> = Promise.resolve();
const serialized = (task: () => Promise<void>): Promise<void> => {
  const next = chain.then(task, task);
  chain = next.catch(() => {});
  return next;
};

async function flushLocked(): Promise<void> {
  if (!pending.size) return;
  const batch = new Map(pending);
  pending.clear();
  try {
    const file = await loadFile();
    const days = file.days && typeof file.days === "object" ? file.days : {};
    for (const [date, models] of batch) {
      const dayEntry = days[date] ?? {};
      for (const [model, entry] of models) {
        const prev = dayEntry[model] ?? { in: 0, out: 0 };
        dayEntry[model] = { in: prev.in + entry.in, out: prev.out + entry.out };
      }
      days[date] = dayEntry;
    }
    // 过期清理：只留最近 MAX_DAYS 天（含今天）
    const cutoff = beijingDate(Date.now() - (MAX_DAYS - 1) * 86_400_000);
    for (const day of Object.keys(days)) {
      if (day < cutoff) delete days[day];
    }
    await writeFileAtomic(fileOf(), JSON.stringify({ days }));
  } catch (e) {
    // 写盘失败（如 Windows 上目标文件被别的进程短暂锁定）：把这批放回
    // pending，下一次记录或快照读取时自动重试——统计性数据也要尽力不丢
    for (const [date, models] of batch) {
      const current = pending.get(date) ?? new Map<string, TokenUsageEntry>();
      for (const [model, entry] of models) {
        const prev = current.get(model) ?? { in: 0, out: 0 };
        current.set(model, { in: prev.in + entry.in, out: prev.out + entry.out });
      }
      pending.set(date, current);
    }
    throw e;
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void serialized(flushLocked);
  }, FLUSH_DELAY_MS);
  // 不挂事件循环：对话进程该退就退，尾巴数据最多丢 2 秒内的聚合
  flushTimer.unref?.();
}

/** 托管版：把单次调用的用量报给网关（每次一条，网关按增量累计） */
function reportIfHosted(model: string, inTok: number, outTok: number): void {
  if (process.env.RAPTOR_HOSTED !== "1") return;
  const url = process.env.RAPTOR_USAGE_REPORT_URL || "";
  const token = process.env.RAPTOR_USAGE_REPORT_TOKEN || "";
  if (!url || !token) return;
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-report-token": token },
    body: JSON.stringify({ model, in: inTok, out: outTok }),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  }).catch(() => {
    /* 统计性上报：网关重启瞬间丢一条无妨，绝不重试不打日志 */
  });
}

/**
 * 记一次 LLM 调用的 token 用量。model 建议传 `providerId/modelId`
 * 组合键（不同厂商可能有同名型号）；非法输入（空模型 / 非正数）静默忽略。
 */
export function recordTokenUsage(usage: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  const model = String(usage.model ?? "");
  const inTok = Math.max(0, Math.trunc(Number(usage.inputTokens) || 0));
  const outTok = Math.max(0, Math.trunc(Number(usage.outputTokens) || 0));
  if (!model || (!inTok && !outTok)) return;

  const date = beijingDate(Date.now());
  const models = pending.get(date) ?? new Map<string, TokenUsageEntry>();
  const prev = models.get(model) ?? { in: 0, out: 0 };
  models.set(model, { in: prev.in + inTok, out: prev.out + outTok });
  pending.set(date, models);

  reportIfHosted(model, inTok, outTok);
  scheduleFlush();
}

/** 网页端 /api/usage 的响应形状 */
export interface TokenUsageSnapshot {
  /** 每天合计（北京时间日期 → 输入/输出/总量） */
  days: Record<string, { in: number; out: number; total: number }>;
  /** 模型维度聚合（保留窗口内全部数据） */
  models: Array<{ model: string; in: number; out: number; total: number }>;
  /** 摘要：今日 / 近 7 天 / 近 30 天 / 全窗口 */
  totals: { today: number; week: number; month: number; year: number };
}

/**
 * 读取用量快照：先冲刷 pending 保证不缺角，再按天 / 模型聚合。
 */
export async function tokenUsageSnapshot(): Promise<TokenUsageSnapshot> {
  await serialized(flushLocked);
  const file = await loadFile();
  const days: TokenUsageSnapshot["days"] = {};
  const models = new Map<string, TokenUsageEntry>();
  for (const [date, entries] of Object.entries(file.days)) {
    if (!entries || typeof entries !== "object") continue;
    let dayIn = 0;
    let dayOut = 0;
    for (const [model, entry] of Object.entries(entries)) {
      const e = entry ?? { in: 0, out: 0 };
      dayIn += e.in;
      dayOut += e.out;
      const prev = models.get(model) ?? { in: 0, out: 0 };
      models.set(model, { in: prev.in + e.in, out: prev.out + e.out });
    }
    days[date] = { in: dayIn, out: dayOut, total: dayIn + dayOut };
  }
  const sumRange = (fromDate: string): number => {
    let sum = 0;
    for (const [date, d] of Object.entries(days)) {
      if (date >= fromDate) sum += d.total;
    }
    return sum;
  };
  const today = beijingDate(Date.now());
  const shift = (daysBack: number) => beijingDate(Date.now() - daysBack * 86_400_000);
  return {
    days,
    models: [...models.entries()]
      .map(([model, e]) => ({ model, in: e.in, out: e.out, total: e.in + e.out }))
      .sort((a, b) => b.total - a.total),
    totals: {
      today: days[today]?.total ?? 0,
      week: sumRange(shift(6)),
      month: sumRange(shift(29)),
      year: sumRange(shift(MAX_DAYS - 1)),
    },
  };
}

/** 测试专用：清空内存 pending 与定时器（跨场景隔离用） */
export function resetTokenUsageForTest(): void {
  pending.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
