/**
 * 多用户网关的 Token 用量账本：按 天 → 用户 → 模型 聚合落盘。
 *
 * 数据来源：同学专属实例（spawner 拉起的 headless 进程）里 src/core/token-usage.ts
 * 的每调用上报——POST /internal/usage-report（app.mjs，per-instance 随机令牌鉴权）。
 * 记的是展示性统计而不是扣费账本：单条上报丢失无妨，落盘损坏按空表重建。
 *
 * 文件布局：stateDir/token-usage.json（原子替换，读写经模块内 Promise 链串行化，
 * 与 registry.mjs / local-usage.mjs 同约定）。保留最近 90 天（管理台看趋势够用，
 * 文件不随用户×模型无限膨胀）：
 *   { "days": { "2026-10-05": { "u_xxx": { "deepseek/deepseek-chat": { "in": 1, "out": 2 } } } } }
 *
 * 聚合口径：「一天」按北京时间切（受众南工大学生，服务器跑 UTC，同 local-usage）。
 */

import { mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_DAYS = 90;
/** 单条上报的输入/输出上限：正常一次调用 < 1M token，超出当脏载荷拒绝 */
const MAX_SINGLE = 10_000_000;

/**
 * 北京时间日期（YYYY-MM-DD）。用 Intl 按真实北京时区取——本机跑什么时区
 * 都不影响切日口径（now+8h 的换算只在 UTC 机器上正确，东八区机器在
 * 16 点后会把用量记到「明天」）。
 */
function beijingDate(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .replaceAll("/", "-");
}

/** 纯日期平移 N 天（字符串日期运算，避免时区换算歧义） */
function shiftDate(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.error(`[token-usage] 状态文件损坏，按空表重新统计：${path.basename(file)}`);
    }
    return fallback;
  }
}

export function createTokenUsageStore({ stateDir }) {
  if (!stateDir) throw new Error("createTokenUsageStore 需要 stateDir");
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "token-usage.json");

  let chain = Promise.resolve();
  const serialized = (task) => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };

  async function writeAtomic(content) {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, content);
    await rename(temp, file);
  }

  function validNumber(value) {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) && n >= 0 && n <= MAX_SINGLE ? n : null;
  }

  return {
    /**
     * 记一笔（一次 LLM 调用）的用量。载荷非法返回 false（端点回 400 不落盘）。
     * @returns {Promise<boolean>}
     */
    record({ userId, model, in: inTok, out: outTok }) {
      const user = String(userId ?? "");
      const name = String(model ?? "");
      if (!user || name.length > 64 || !/^[A-Za-z0-9._/-]+$/.test(name)) {
        return Promise.resolve(false);
      }
      const inV = validNumber(inTok);
      const outV = validNumber(outTok);
      if (inV === null || outV === null || (inV === 0 && outV === 0)) {
        return Promise.resolve(false);
      }
      return serialized(async () => {
        const store = await readJson(file, { days: {} });
        const days = store.days && typeof store.days === "object" ? store.days : {};
        const today = beijingDate();
        const dayEntry = days[today] ?? {};
        const userEntry = dayEntry[user] ?? {};
        const prev = userEntry[name] ?? { in: 0, out: 0 };
        userEntry[name] = { in: prev.in + inV, out: prev.out + outV };
        dayEntry[user] = userEntry;
        days[today] = dayEntry;
        // 过期清理：只留最近 MAX_DAYS 天（含今天）
        const cutoff = shiftDate(today, -(MAX_DAYS - 1));
        for (const day of Object.keys(days)) {
          if (day < cutoff) delete days[day];
        }
        await writeAtomic(JSON.stringify({ days }, null, 2));
        return true;
      });
    },

    /**
     * 管理台聚合查询：时间范围（7/30/90/all）× 用户 × 模型三向筛选。
     * - days 曲线与 total：三项筛选全部生效
     * - byUser 排行：时间 + 模型筛选（不受用户筛选限制——选了模型看「谁用它最多」）
     * - byModel 排行：时间 + 用户筛选（选了用户看「TA 用什么最多」）
     * - facets：范围内出现过的全部用户/模型（不受筛选限制，供下拉）
     */
    async query({ range = "30", user = "", model = "" } = {}) {
      const store = await readJson(file, { days: {} });
      const days = store.days && typeof store.days === "object" ? store.days : {};
      const today = beijingDate();
      const rangeDays =
        range === "7" || range === "30" || range === "90" ? Number(range) : MAX_DAYS;
      // all 与 90 同窗口（账本本身就只保留 90 天），保证 from/to 真实
      const from = shiftDate(today, -(rangeDays - 1));

      const daysOut = [];
      const byUser = new Map();
      const byModel = new Map();
      const facetUsers = new Set();
      const facetModels = new Set();

      const touch = (map, key, inV, outV) => {
        const prev = map.get(key) ?? { in: 0, out: 0 };
        map.set(key, { in: prev.in + inV, out: prev.out + outV });
      };

      for (const [day, users] of Object.entries(days)) {
        if (!users || typeof users !== "object") continue;
        const inWindow = day >= from && day <= today;
        if (!inWindow) continue;
        let dayIn = 0;
        let dayOut = 0;
        for (const [uid, models] of Object.entries(users)) {
          if (!models || typeof models !== "object") continue;
          for (const [name, e] of Object.entries(models)) {
            const inV = Number(e?.in) || 0;
            const outV = Number(e?.out) || 0;
            facetUsers.add(uid);
            facetModels.add(name);
            const userHit = !user || user === uid;
            const modelHit = !model || model === name;
            if (modelHit) touch(byUser, uid, inV, outV);
            if (userHit) touch(byModel, name, inV, outV);
            if (userHit && modelHit) {
              dayIn += inV;
              dayOut += outV;
            }
          }
        }
        daysOut.push({ date: day, in: dayIn, out: dayOut, total: dayIn + dayOut });
      }

      // 逐日补零：范围每天都有一行（图表横轴不缺刻度）
      const filled = [];
      for (let i = 0; i < rangeDays; i++) {
        const date = shiftDate(from, i);
        filled.push(daysOut.find((d) => d.date === date) ?? { date, in: 0, out: 0, total: 0 });
      }

      const totalIn = filled.reduce((s, d) => s + d.in, 0);
      const totalOut = filled.reduce((s, d) => s + d.out, 0);
      const asList = (map, keyName) =>
        [...map.entries()]
          .map(([key, v]) => ({ [keyName]: key, in: v.in, out: v.out, total: v.in + v.out }))
          .sort((a, b) => b.total - a.total);

      return {
        range: String(range),
        from,
        to: today,
        total: { in: totalIn, out: totalOut, total: totalIn + totalOut },
        days: filled,
        byUser: asList(byUser, "id"),
        byModel: asList(byModel, "model"),
        facets: {
          users: [...facetUsers].sort(),
          models: [...facetModels].sort(),
        },
      };
    },
  };
}
