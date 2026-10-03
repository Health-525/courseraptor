/**
 * 多用户网关的实例管理器：按需拉起 / 回收每个同学专属的 CourseRaptor 实例。
 *
 * 一个用户 = 一个 Node 子进程（gateway/headless/entry.ts），靠环境变量完全隔离：
 * - RAPTOR_DATA_DIR / RAPTOR_CREDENTIALS_FILE → 各自独立的数据与加密凭证
 * - RAPTOR_WEB_PORT → 独立回环端口，网关按 Cookie 路由到对应端口
 * 就绪信号是子进程 stdout 的「[headless] ready port=<n>」行（RAPTOR_WEB_PORT
 * 被占时 chat-web 会退到随机端口，以实际报告为准）。
 */

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PORT_MIN = 33100;
const PORT_MAX = 34000;
const READY_RE = /\[headless\] ready port=(\d+)/;
const SPAWN_TIMEOUT_MS = 30_000;
/** 意外退出自动重启一次；连续失败则标记故障，等人工排查 */
const MAX_RESTARTS = 1;
const UPTIME_RESET_MS = 10 * 60_000;

/**
 * 子实例环境变量白名单：实例是跑在同学会话里的 AI Agent，任何工具代码都能
 * 读进程 env——绝不能把 GATEWAY_SECRET / GATEWAY_ADMIN_PASSWORD /
 * GATEWAY_UPDATE_TOKEN 这类网关凭据透传进去（拿了就能登录 /admin、踢任意
 * 同学下线）。只带运行时与系统必需项，网关自身的配置一概不给。
 */
const ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "SYSTEMDRIVE",
  "SystemDrive",
  "TEMP",
  "TMP",
  "TMPDIR",
  "COMSPEC",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "USERNAME",
  "COMPUTERNAME",
  "LANG",
  "LC_ALL",
  "TZ",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "NODE_ENV",
];

/**
 * 构造子实例环境变量（白名单 + 注入项）。独立导出以便单测断言
 * 「网关凭据绝不进子实例」。
 */
export function buildInstanceEnv(
  sourceEnv,
  {
    port,
    dataDir,
    credFile,
    siteKey = "",
    fallbackKey = "",
    forceSite = false,
    providerId = "",
    providerSiteKey = "",
    siteModel = "",
  },
) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  env.RAPTOR_WEB_PORT = String(port);
  env.RAPTOR_DATA_DIR = dataDir;
  env.RAPTOR_CREDENTIALS_FILE = credFile;
  env.RAPTOR_NO_UPDATE_CHECK = "1";
  env.RAPTOR_NO_TODO_REMINDERS = "1";
  // 文件读取边界：同学的 agent 只能读自己数据目录内的文件（openLocalFile
  // 据此拦截），网关账本 / 站点 Key / 他人数据目录 / /proc 都不可达
  env.RAPTOR_LOCAL_FILE_ROOT = dataDir;
  // 多厂商：同学的供应商选择（users.json，/api/provider 切换）注入实例；
  // RAPTOR_HOSTED 让实例侧禁收 providerId/customBaseUrl（走网关，防 SSRF）
  if (providerId) env.RAPTOR_PROVIDER_ID = providerId;
  env.RAPTOR_HOSTED = "1";
  // 混合 Key 模式：站点按厂商配 Key（site.json providerKeys）。当前供应商
  // 的站点 Key 注入 RAPTOR_PROVIDER_KEY（实例内三层解析的 env 层）；同学
  // 保存自己的 Key 后凭证 override 优先级更高（src/core/config.ts），无需
  // 此处感知。DEEPSEEK_API_KEY 是 deepseek 的历史注入通道（官方 SDK 读它），
  // 仅 deepseek 会话注入，其他厂商的站点 Key 不经它泄露。
  const isDeepseek = !providerId || providerId === "deepseek";
  if (providerSiteKey) env.RAPTOR_PROVIDER_KEY = providerSiteKey;
  const deepseekEffective = providerSiteKey || siteKey || fallbackKey;
  if (isDeepseek && deepseekEffective) env.DEEPSEEK_API_KEY = deepseekEffective;
  if (forceSite) env.RAPTOR_DISABLE_DS_OVERRIDE = "1";
  // 站点默认型号（site.json，管理台「站点默认模型」）：实例内优先级在同学
  // 自选之后（config.ts），只兜底从没选过型号的同学，不动任何人的选择。
  if (siteModel) env.RAPTOR_SITE_MODEL = siteModel;
  return env;
}

export function createSpawner({
  projectRoot,
  usersDir,
  deepseekKey = "",
  /** 每次拉起实例时动态取站点 Key（管理台改 Key 后新实例即生效）；返回空串则回退 deepseekKey */
  getDeepseekKey = null,
  /** 每次拉起时问一次：该同学是否钉在站点免费额度模式（注入禁用自己Key的旗标） */
  getForceSiteKey = null,
  /** 每次拉起时问一次：该同学当前选的模型供应商（users.json，/api/provider 切换） */
  getProviderId = null,
  /** 每次拉起时问一次：指定供应商的站点 Key（site.json providerKeys，含 env 兜底） */
  getProviderSiteKey = null,
  /** 每次拉起时问一次：站点默认模型 {provider, model}（site.json，管理台配置；可缺省） */
  getSiteDefault = null,
  maxConcurrent = 4,
  idleMinutes = 30,
  reapIntervalMs = 60_000,
  nodeExec = process.execPath,
} = {}) {
  if (!projectRoot) throw new Error("createSpawner 需要 projectRoot");
  if (!usersDir) throw new Error("createSpawner 需要 usersDir");
  mkdirSync(usersDir, { recursive: true });

  // tsx 从部署目录解析（同 bin/raptor.cjs 的做法），Windows / Linux 通用
  const requireFromProject = createRequire(path.join(projectRoot, "package.json"));
  const tsxUrl = pathToFileURL(requireFromProject.resolve("tsx")).href;

  /** @type {Map<string, Instance>} */
  const instances = new Map();
  /** 拉起中的互斥：并发 acquire 同一用户共享同一次拉起（TOCTOU 会产生孤儿双实例） */
  const pendingSpawn = new Map();

  function pickPort() {
    for (let i = 0; i < 50; i++) {
      const port = randomInt(PORT_MIN, PORT_MAX);
      if (![...instances.values()].some((it) => it.port === port)) return port;
    }
    throw new Error("端口段耗尽");
  }

  function userDataDir(userId) {
    return path.join(usersDir, userId);
  }

  function stopInstance(userId, instance) {
    instances.delete(userId);
    instance.stopping = true;
    try {
      instance.child.kill();
    } catch {
      // 已退出
    }
  }

  async function forceSiteKey(userId) {
    if (!getForceSiteKey) return false;
    try {
      return Boolean(await getForceSiteKey(userId));
    } catch {
      return false;
    }
  }

  /**
   * 该同学当前选的供应商：同学自选（users.json，/api/provider 切换）优先；
   * 没选过时用站点默认供应商（site.json，管理台「站点默认模型」），再落
   * 回 deepseek——绝不让查询失败拦住拉起。
   */
  async function currentProviderId(userId) {
    let own = "";
    if (getProviderId) {
      try {
        own = (await getProviderId(userId)) || "";
      } catch {
        own = "";
      }
    }
    if (own) return own;
    if (getSiteDefault) {
      try {
        const site = await getSiteDefault();
        if (site && site.provider) return String(site.provider);
      } catch {
        // 查询失败按未配置处理
      }
    }
    return "deepseek";
  }

  /** 站点默认型号（site.json）；查询失败按未配置，绝不让它拦住拉起 */
  async function currentSiteModel() {
    if (!getSiteDefault) return "";
    try {
      const site = await getSiteDefault();
      return site && site.model ? String(site.model) : "";
    } catch {
      return "";
    }
  }

  /** 指定供应商的站点 Key：site.json（经回调，含 env 兜底逻辑）；旧部署只配 deepseek */
  async function providerSiteKeyFor(providerId) {
    if (getProviderSiteKey) {
      try {
        return (await getProviderSiteKey(providerId)) || "";
      } catch {
        return "";
      }
    }
    if (providerId !== "deepseek") return "";
    const key = await currentSiteKey();
    return key || deepseekKey;
  }

  /** 站点 Key 当前值：站点设置（可运行时改）优先，回退构造参数 */
  async function currentSiteKey() {
    if (!getDeepseekKey) return "";
    try {
      return (await getDeepseekKey()) || "";
    } catch {
      return "";
    }
  }

  function spawnInstance(
    userId,
    restartCount,
    siteKey = "",
    forceSite = false,
    providerId = "",
    providerSiteKey = "",
    siteModel = "",
  ) {
    const dataDir = path.join(userDataDir(userId), "data");
    const credFile = path.join(userDataDir(userId), "credentials.enc");
    mkdirSync(dataDir, { recursive: true });
    const port = pickPort();
    const env = buildInstanceEnv(process.env, {
      port,
      dataDir,
      credFile,
      siteKey,
      fallbackKey: deepseekKey,
      forceSite,
      providerId,
      providerSiteKey,
      siteModel,
    });

    const child = spawn(nodeExec, ["--import", tsxUrl, "gateway/headless/entry.ts"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const instance = {
      userId,
      port: null,
      child,
      startedAt: Date.now(),
      lastRequestAt: Date.now(),
      restarts: restartCount,
      stopping: false,
      recentLogs: [],
      rawStdout: "",
    };
    instances.set(userId, instance);

    const note = (line) => {
      const text = String(line).trimEnd();
      if (!text) return;
      instance.recentLogs.push(text);
      if (instance.recentLogs.length > 30) instance.recentLogs.shift();
      console.log(`[user:${userId}] ${text}`);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      // rawStdout 只为就绪探测服务：ready 之后不再累积（活跃实例跑数小时
      // 会积累可观内存），日志呈现走 recentLogs（封顶 30 条）
      if (instance.port == null) instance.rawStdout += chunk;
      note(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => note(chunk));

    child.on("exit", (code, signal) => {
      if (instance.stopping) return;
      note(`进程退出 code=${code} signal=${signal}`);
      instances.delete(userId);
      // 实例存活超过 10 分钟后崩溃视为新故障，重启计数从头算；
      // 连续快速崩溃只自动重启一次，避免故障循环
      const effectiveRestarts =
        Date.now() - instance.startedAt > UPTIME_RESET_MS ? 0 : instance.restarts;
      if (effectiveRestarts < MAX_RESTARTS) {
        void Promise.all([
          currentSiteKey(),
          forceSiteKey(userId),
          currentProviderId(userId).then((id) => Promise.all([id, providerSiteKeyFor(id)])),
          currentSiteModel(),
        ])
          .then(([key, force, [providerId, providerSiteKey], siteModel]) =>
            spawnInstance(
              userId,
              effectiveRestarts + 1,
              key,
              force,
              providerId,
              providerSiteKey,
              siteModel,
            ),
          )
          .catch((e) => {
            // 自动重启失败（如端口段耗尽）：可见地记录，不留未处理 rejection
            note(`自动重启失败：${e instanceof Error ? e.message : String(e)}`);
          });
      }
    });

    // 就绪探测：等待 ready 行，超时杀掉并按失败处理
    instance.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("实例启动超时"));
        try {
          child.kill();
        } catch {}
      }, SPAWN_TIMEOUT_MS);
      const check = () => {
        const match = READY_RE.exec(instance.rawStdout);
        if (match) {
          clearTimeout(timer);
          instance.port = Number(match[1]);
          resolve(instance.port);
        }
      };
      child.stdout.on("data", check);
      child.on("exit", () => {
        clearTimeout(timer);
        if (instance.port == null) reject(new Error("实例启动过程中退出"));
      });
    });

    return instance;
  }

  const spawner = {
    /** 拿到用户实例的端口；没起就拉起。满并发上限抛 QuotaError。 */
    async acquire(userId) {
      const instance = instances.get(userId);
      if (instance) {
        instance.lastRequestAt = Date.now();
        // 冷启动窗口（最长 30s）port 还是 null：必须等 ready 再返回——
        // 否则 http.request({port:null}) 会打到 127.0.0.1:80，页面并行
        // 加载的多个请求几乎必踩
        return instance.port ?? (await instance.ready);
      }
      // 同用户并发 acquire 共享同一次拉起：此前检查-拉起之间有异步间隙，
      // 两个请求各拉一个，前一个被 instances.set 覆盖成孤儿进程（永不回收）
      const pending = pendingSpawn.get(userId);
      if (pending) return pending;
      // 容量把「拉起中」也计入：不同用户并发通过检查会实际超出 maxConcurrent
      if (instances.size + pendingSpawn.size >= maxConcurrent) {
        const err = new Error("当前在线的同学较多，请稍后再试");
        err.code = "ECONCURRENCY";
        throw err;
      }
      const task = (async () => {
        try {
          const [siteKey, forceSite, [providerId, providerSiteKey], siteModel] = await Promise.all([
            currentSiteKey(),
            forceSiteKey(userId),
            currentProviderId(userId).then((id) => Promise.all([id, providerSiteKeyFor(id)])),
            currentSiteModel(),
          ]);
          const it = spawnInstance(
            userId,
            0,
            siteKey,
            forceSite,
            providerId,
            providerSiteKey,
            siteModel,
          );
          const port = await it.ready;
          it.lastRequestAt = Date.now();
          return port;
        } finally {
          pendingSpawn.delete(userId);
        }
      })();
      pendingSpawn.set(userId, task);
      return task;
    },

    noteActivity(userId) {
      const instance = instances.get(userId);
      if (instance) instance.lastRequestAt = Date.now();
    },

    kick(userId) {
      const instance = instances.get(userId);
      if (instance) stopInstance(userId, instance);
    },

    async stopAll() {
      for (const [userId, instance] of instances) stopInstance(userId, instance);
    },

    runningCount() {
      return instances.size;
    },

    /** 管理后台展示在线标记用：该用户的实例当前是否在跑 */
    isRunning(userId) {
      return instances.has(userId);
    },

    /** 管理后台展示用：在线实例的端口 / 启动时间 / 最近活跃 / 自动重启次数 */
    listRunning() {
      return [...instances.values()].map((it) => ({
        userId: it.userId,
        port: it.port,
        startedAt: it.startedAt,
        lastRequestAt: it.lastRequestAt,
        restarts: it.restarts,
      }));
    },

    /** 空闲回收 + 供 /health 展示 */
    startReaper() {
      const timer = setInterval(() => {
        const deadline = Date.now() - idleMinutes * 60_000;
        for (const [userId, instance] of instances) {
          if (instance.lastRequestAt < deadline) {
            console.log(`[spawner] ${userId} 空闲超过 ${idleMinutes} 分钟，回收`);
            stopInstance(userId, instance);
          }
        }
      }, reapIntervalMs);
      return () => clearInterval(timer);
    },
  };

  return spawner;
}
