/**
 * 本地版（下载安装包/TUI）匿名使用统计的存储与聚合。
 *
 * 数据来源：网关公开端点 POST /api/local-usage（见 gateway/app.mjs）。
 * 客户端只上报「随机设备号 + 版本 + 平台 + 渠道」四样（src/core/usage-ping.ts），
 * 服务器侧不存在设备号到人的映射，管理台只能看到聚合计数与匿名设备列表。
 *
 * 落盘：stateDir/local-usage.json（原子替换，读写经模块内 Promise 链串行化，
 * 与 registry.mjs 的约定一致）。文件损坏按空表起步——统计丢了可重建，不值得
 * 像账号文件那样 strict 拒读。
 */

import { mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** 设备记录条数上限：防恶意刷上报把文件撑爆；超出按 lastSeen 最旧的淘汰 */
const MAX_CLIENTS = 20_000;
/** 管理台「最近设备」列表返回条数 */
const RECENT_LIMIT = 100;
/** 受众是南工大学生，「今日」按北京时间（UTC+8）切日，服务器本身跑 UTC */
const TZ_OFFSET_MS = 8 * 3600_000;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const PLATFORM_RE = /^[a-z0-9]{1,16}$/;
const CHANNELS = new Set(["tui"]);

/** 北京时间今日 00:00 对应的真实时间戳 */
function todayStartMs(now = Date.now()) {
  return Math.floor((now + TZ_OFFSET_MS) / 86_400_000) * 86_400_000 - TZ_OFFSET_MS;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.error(`[local-usage] 状态文件损坏，按空表重新统计：${path.basename(file)}`);
    }
    return fallback;
  }
}

export function createLocalUsageStore({ stateDir }) {
  if (!stateDir) throw new Error("createLocalUsageStore 需要 stateDir");
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "local-usage.json");

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

  return {
    /**
     * 记一次设备上报。输入形状非法直接返回 false（端点回 400，不落盘）。
     * @returns {Promise<boolean>} 是否记录成功
     */
    record({ id, version, channel, platform }) {
      const clean = {
        id: String(id ?? ""),
        version: String(version ?? ""),
        channel: String(channel ?? ""),
        platform: String(platform ?? ""),
      };
      if (!ID_RE.test(clean.id)) return Promise.resolve(false);
      if (!VERSION_RE.test(clean.version)) return Promise.resolve(false);
      if (!CHANNELS.has(clean.channel)) return Promise.resolve(false);
      if (!PLATFORM_RE.test(clean.platform)) return Promise.resolve(false);

      return serialized(async () => {
        const store = await readJson(file, { clients: {} });
        const clients = store.clients && typeof store.clients === "object" ? store.clients : {};
        const now = Date.now();
        const prev = clients[clean.id];
        clients[clean.id] = {
          firstSeen: prev?.firstSeen ?? now,
          lastSeen: now,
          pings: (prev?.pings ?? 0) + 1,
          version: clean.version,
          channel: clean.channel,
          platform: clean.platform,
        };
        const ids = Object.keys(clients);
        if (ids.length > MAX_CLIENTS) {
          // 只在真发生淘汰时打一条日志（文件被刷爆本身就是要看见的信号）
          const drop = ids
            .sort((a, b) => clients[a].lastSeen - clients[b].lastSeen)
            .slice(0, ids.length - MAX_CLIENTS);
          for (const victim of drop) delete clients[victim];
          console.warn(`[local-usage] 设备记录超 ${MAX_CLIENTS}，已淘汰最旧 ${drop.length} 条`);
        }
        await writeAtomic(JSON.stringify({ clients }, null, 2));
        return true;
      });
    },

    /** 聚合统计（管理台展示用），纯读不落盘 */
    async stats() {
      const store = await readJson(file, { clients: {} });
      const clients = store.clients && typeof store.clients === "object" ? store.clients : {};
      const list = Object.entries(clients).map(([id, c]) => ({
        id,
        firstSeen: c?.firstSeen ?? 0,
        lastSeen: c?.lastSeen ?? 0,
        pings: c?.pings ?? 1,
        version: c?.version ?? "?",
        platform: c?.platform ?? "?",
        channel: c?.channel ?? "?",
      }));
      const now = Date.now();
      const dayMs = 86_400_000;
      const tally = (key) => {
        const counts = new Map();
        for (const item of list) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1);
        return [...counts.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
      };
      const iso = (ms) => new Date(ms).toISOString();
      return {
        total: list.length,
        activeToday: list.filter((c) => c.lastSeen >= todayStartMs(now)).length,
        active7d: list.filter((c) => c.lastSeen >= now - 7 * dayMs).length,
        active30d: list.filter((c) => c.lastSeen >= now - 30 * dayMs).length,
        versions: tally("version"),
        platforms: tally("platform"),
        lastPingAt: iso(list.reduce((max, c) => Math.max(max, c.lastSeen), 0)),
        recent: list
          .sort((a, b) => b.lastSeen - a.lastSeen)
          .slice(0, RECENT_LIMIT)
          .map((c) => ({
            id: c.id.slice(0, 8),
            version: c.version,
            platform: c.platform,
            channel: c.channel,
            firstSeen: iso(c.firstSeen),
            lastSeen: iso(c.lastSeen),
            pings: c.pings,
          })),
      };
    },
  };
}
