/**
 * 多用户网关的实例管理器：按需拉起 / 回收每个同学专属的 CourseRaptor 实例。
 *
 * 一个用户 = 一个 Node 子进程（src/headless/entry.ts），靠环境变量完全隔离：
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

export function createSpawner({
  projectRoot,
  usersDir,
  deepseekKey = "",
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

  function spawnInstance(userId, restartCount) {
    const dataDir = path.join(userDataDir(userId), "data");
    const credFile = path.join(userDataDir(userId), "credentials.enc");
    mkdirSync(dataDir, { recursive: true });
    const port = pickPort();
    const env = {
      ...process.env,
      RAPTOR_WEB_PORT: String(port),
      RAPTOR_DATA_DIR: dataDir,
      RAPTOR_CREDENTIALS_FILE: credFile,
      RAPTOR_NO_UPDATE_CHECK: "1",
      RAPTOR_NO_TODO_REMINDERS: "1",
    };
    // 混合 Key 模式：默认注入站点统一 Key；同学在网页设置里保存自己的 Key 后，
    // 凭证文件里的 override 优先级更高（src/core/config.ts 的解析顺序），无需此处感知
    if (deepseekKey) env.DEEPSEEK_API_KEY = deepseekKey;

    const child = spawn(nodeExec, ["--import", tsxUrl, "src/headless/entry.ts"], {
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
      instance.rawStdout += chunk;
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
        spawnInstance(userId, effectiveRestarts + 1);
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
      let instance = instances.get(userId);
      if (instance) {
        instance.lastRequestAt = Date.now();
        return instance.port;
      }
      if (instances.size >= maxConcurrent) {
        const err = new Error("当前在线的同学较多，请稍后再试");
        err.code = "ECONCURRENCY";
        throw err;
      }
      instance = spawnInstance(userId, 0);
      const port = await instance.ready;
      return port;
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
