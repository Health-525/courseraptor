# CourseRaptor 桌面版实施方案（Electron 薄壳）

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax. 一个 Task 一次提交：改完 → 跑该 Task 的「验收命令」→ 全绿再进下一个。**动手前先完整读第 0–3 节**，尤其第 1 节的红线。
>
> 本文件是自包含的：所有涉及的文件路径、函数签名、环境变量都已从当前代码核实，无需再去摸索仓库。文末「附录 A：现有代码索引」列出可直接跳读的关键符号。

**实现进度（2026-10-15）:** Task 1–7 均已落地并通过校验（`npm run typecheck` / `lint` / `verify:imports` 全绿；`desktop` 已 `npm run build` 通过；受影响单测全绿）。应用图标复用仓库项目 logo（`docs/courseraptor-logo.png`）。**唯一遗留**：桌面 GUI 与 `desktop:dist` 出安装包的人工验收（需在 Windows 桌面环境点一遍）。

**Goal:** 给现成的本地 Web UI + Node 后端套一层 Electron 薄壳，产出「双击即进对话、任务栏/开始菜单图标、托盘常驻、原生通知、应用内自动更新」的真桌面应用，**全程不开终端**。

**Architecture:** Electron 主进程只当壳（单实例锁 / BrowserWindow / 托盘 / 原生通知 / electron-updater / watchdog），后端仍跑现成的 Node 24 服务：子进程 spawn `local/host/headless.ts`，主进程从它的 stdout 读 IPC 行握手拿 URL，再把窗口 `loadURL` 指过去。核心引导逻辑从 `local/cli/index.ts` 抽成共享 `bootstrapHost()`，TUI 与桌面入口复用同一份。

**Tech Stack:** Electron + electron-builder + esbuild；后端复用现有 TypeScript / Node 内置 http / tsx；通知复用现有「端口注入」模式。

---

## 0. 背景：为什么这么做

现状（已核实）：

- 产品形态已是「本地 Node http 服务 + 零框架网页前端」，绑 `127.0.0.1:3210`（`RAPTOR_WEB_PORT` 可改）。入口 `local/cli/index.ts` 起 TUI 时顺带 `startChatWeb()` 拉起网页。
- 已有内置 Node 运行时的**便携 zip / 单文件 exe**（`scripts/package-portable.mjs`、`scripts/package-exe.mjs`、`scripts/exe-launcher.cs`）。
- 数据落在 `<PROJECT_ROOT>/data`（`src/core/paths.ts` 的 `dataDir()`，`RAPTOR_DATA_DIR` 可覆盖）。
- 通知：`src/core/todo-reminders.ts` 的 `windowsToast()` 用 PowerShell 弹系统 toast；QQ 推送走端口注入（`src/core/notify.ts` 的 `registerQQPushSender`）。
- 更新：`src/core/update-check.ts` 的 `checkForUpdate()` + `src/core/updater.ts` 的 `applyUpdate()`；**注意** `applyUpdate` 依赖的更新后台已下线（`DEFAULT_UPDATE_SERVER` 占位符恒空，`requireSecureUpdateServerUrl()` 会抛错），所以桌面自动更新改走 GitHub Release。

结论：**UI、后端、服务、分发管道全都现成**，缺的只是把它们装进一个真应用窗口。

## 1. 红线与不变式（改动前必读）

来自 `AGENTS.md` + `README.md`，逐条遵守：

1. **本地版行为零改动**：模型装配、凭证（AES-256-GCM 绑本机指纹）、`data/` 存储、CSRF/Host/Origin 三道门、端口注入分层全部原样复用。桌面版只是给网页套窗口。
2. **分层依赖单向 `local → channels → core`**：`core` 不 import 具体实现，跨层走端口。由 `npm run verify:imports` 在 CI 钉死。**`desktop/` 是仓库另一个独立 npm 工程（对齐 `obsidian/`），允许 import 主仓的 `local/host/*`，但主仓源码不得 import `desktop/`。**
3. **数据目录可重定向**：桌面版通过 `RAPTOR_DATA_DIR` 把数据放到用户目录（`app.getPath("userData")/data`），保证应用升级不丢数据。详见 §3.2。
4. **不碰 MCP 工具**（本机调用会卡死），一律命令行。
5. **不新增网络暴露**：网页仍只绑 `127.0.0.1`，桌面窗口从本机 URL 加载，不引入任何对外监听。

## 2. 进程模型与数据流

```
┌──────────────────────────── Electron 主进程（壳，desktop/src/main.ts）────────────────────────────┐
│  单实例锁 · BrowserWindow · 系统托盘 · 原生通知 · electron-updater · watchdog                    │
│                                                                                                  │
│   ① spawn 子进程 ──► [后端 Node host]      ② readline 读 stdout 的 @raptor-ipc 行              │
│   ④ new Notification() ◄── ③ 后端发 {type:"notify"} 行                                          │
│   ⑤ ready 行里的 url ──► win.loadURL(url)                                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                                        │ spawn
        ┌───────────────────────────────▼───────────────────────────────────────────────┐
        │  内置 Node 24 运行时（复用 portable 那套：runtime/node.exe）                     │
        │  ── local/host/headless.ts ──                                                   │
        │  bootstrapHost() → 适配器 → agent → startChatWeb() → todo 提醒调度               │
        │  registerDesktopNotifier(发 notify 行)                                          │
        │  打印 ready(URL) / notify / log 三类 IPC 行，进程常驻                            │
        └─────────────────────────────────────────────────────────────────────────────────┘
```

**为什么子进程而非主进程内跑（已定）：** 后端固定跑打包内置的 Node 24，绕开 Electron 自带 Node 版本差异，行为与现在 `raptor` 完全一致；Electron 与后端可互相看护重启。后端 URL 由 `startChatWeb()` 返回（形如 `http://localhost:3210`）。

## 3. 关键设计决策（实现者必须理解，否则容易改错）

### 3.1 IPC 走子进程 stdout 行协议
后端不 import 任何 Electron；它把消息写成单行 JSON 到 stdout，主进程按前缀解析。这让「后端行为零改动」成立——不注册时行为与现状完全一致。

### 3.2 数据目录重定向到 userData（**重要**）
electron-builder 升级会替换安装目录里的资源。若数据留在安装目录内，升级会**丢数据**。因此主进程在 spawn 前设置：

```
RAPTOR_DATA_DIR = path.join(app.getPath("userData"), "data")
```

Windows 上即 `%APPDATA%\CourseRaptor\data`。这与便携版（数据在 `app/data`）**不共享**——这是有意的取舍：桌面版以「升级永不丢数据」为第一优先。若日后要共享，可由用户在 `.env` 显式设 `RAPTOR_DATA_DIR` 覆盖。

### 3.3 通知走端口，未注册回退现状
`src/core/notify.ts` 增补「桌面通知端口」。桌面后端注册它（发 notify 行）；非桌面环境（TUI / QQ / 测试）端口为空，`todo-reminders.ts` 回退现有 `windowsToast()`，**行为一行不变**。

### 3.4 自动更新走 GitHub Release
现有更新后台已下线，`applyUpdate` 对桌面不可用。桌面用 `electron-updater` + GitHub provider（`Health-525/courseraptor`）。TUI 的 `/update` 命令保留给源码用户。升级整体替换（Chromium + app + runtime），一次到位。

### 3.5 关闭窗口 ≠ 退出
关闭窗口隐藏到托盘，后端继续跑（待办提醒 + QQ 桥后台续命，这正是现在「TUI 退出后进程靠 QQ 桥存活」的自然延伸）。**退出**（托盘菜单 / 系统关机）才真正 kill 后端。

## 4. 完整文件清单

**新增（`desktop/` 独立 npm 工程，对齐 `obsidian/`）：**

| 文件 | 作用 |
|---|---|
| `desktop/package.json` | 工程定义；`"main": "dist/main.cjs"`；devDeps：`electron` `electron-builder` `esbuild` `typescript` `@types/node` `builtin-modules`（用最新稳定版，`npm i -D` 自动取，不要手写死版本号） |
| `desktop/tsconfig.json` | 参考 `obsidian/tsconfig.json`；`module: ESNext`、`moduleResolution: Bundler`、`strict` |
| `desktop/esbuild.config.mjs` | 打 `main.ts` → `dist/main.cjs`、`preload.ts` → `dist/preload.cjs`；`platform: node`、`format: cjs`、`external: ["electron", ...builtinModules]`（照抄 `obsidian/esbuild.config.mjs` 的写法） |
| `desktop/src/main.ts` | 主进程：单实例锁、建窗、装配、生命周期 |
| `desktop/src/backend.ts` | 后端子进程管理器：spawn、stdout 行解析、ready 握手、watchdog |
| `desktop/src/ipc-protocol.ts` | IPC 行协议（类型 + `parseIpcLine`）；**纯数据、不 import electron**，便于主仓测试复用 |
| `desktop/src/tray.ts` | 系统托盘 |
| `desktop/src/preload.ts` | 暴露极小 API（版本号、打开数据目录、窗口控制），`contextIsolation: true`、`nodeIntegration: false` |
| `desktop/electron-builder.yml` | 打包配置：`extraResources` 塞入 portable 的 `app/` + `runtime/` |
| `desktop/build/icon.png` | 应用图标（≥256×256；复用/放大 `docs/courseraptor-logo.png`） |
| `desktop/README.md` | 桌面版构建与发布说明 |

**主仓新增：**

| 文件 | 作用 |
|---|---|
| `local/host/boot.ts` | **共享引导** `bootstrapHost()`：把 `local/cli/index.ts` 中「TUI 之前」的启动序列抽出，TUI 与 headless 两处复用（避免 jscpd 重复告警） |
| `local/host/headless.ts` | 桌面版后端入口：调 `bootstrapHost()` 后常驻、打印 IPC 行、注册桌面通知端口、优雅退出 |
| `scripts/package-desktop.mjs` | 复用 `buildPortable()` 产出 `app/`+`runtime/` → 交 electron-builder 出安装包 |
| `tests/desktop-ipc.test.ts` | IPC 协议解析 + 通知端口回退链测试 |

**改动：**

| 文件 | 改动 |
|---|---|
| `local/cli/index.ts` | 改为调 `bootstrapHost()`；TUI 部分**逐行序列、提示语、日志分毫不动** |
| `src/core/notify.ts` | 增补 `registerDesktopNotifier` / `sendDesktopNotification`（对齐现有 `registerQQPushSender`） |
| `src/core/todo-reminders.ts` | `defaultNotify` 先试桌面端口，未注册回退 `windowsToast()` |
| `scripts/package-portable.mjs` | `buildPortable()` 返回值**追加** `portableDir`（`keep: true` 时有效），供 `package-desktop.mjs` 复用；不改变现有字段，纯增量 |
| `package.json` | 增脚本 `desktop:dev` / `desktop:build` / `desktop:backend` / `desktop:dist` |
| `.gitignore` | 加 `desktop/dist/`、`desktop/release/`、`desktop/node_modules/` |

## 5. IPC 行协议规格（`desktop/src/ipc-protocol.ts` 定死）

后端向 stdout 写，**一行一条**，前缀固定 `@raptor-ipc `，其后是单行 JSON。非此前缀的行按普通日志处理（主进程转发 console）。

```
@raptor-ipc {"type":"ready","url":"http://localhost:3210"}
@raptor-ipc {"type":"notify","title":"CourseRaptor 待办提醒","body":"「交作业」今天 20:00 到期"}
@raptor-ipc {"type":"log","level":"info","text":"..."}
```

- `ready`：服务起好发**一次**，主进程据此 `loadURL`。
- `notify`：桌面通知端口的消息转原生通知。
- `log`：普通日志（桌面无终端），主进程按级别落 console / 文件。

参考实现：

```ts
// desktop/src/ipc-protocol.ts  —— 纯数据，不 import electron
export type IpcMessage =
  | { type: "ready"; url: string }
  | { type: "notify"; title: string; body: string }
  | { type: "log"; level?: "info" | "warn" | "error"; text: string };

const PREFIX = "@raptor-ipc ";

export function parseIpcLine(line: string): IpcMessage | null {
  if (!line.startsWith(PREFIX)) return null;
  try {
    const obj = JSON.parse(line.slice(PREFIX.length)) as unknown;
    if (obj && typeof obj === "object" && typeof (obj as { type?: unknown }).type === "string") {
      return obj as IpcMessage;
    }
  } catch {
    /* 非法行按日志处理 */
  }
  return null;
}

export function encodeIpc(msg: IpcMessage): string {
  return PREFIX + JSON.stringify(msg);
}
```

---

## Task 1：抽取共享引导 `bootstrapHost()`

**目标：** 把 `local/cli/index.ts` 里「TUI 循环之前」的启动序列抽成 `local/host/boot.ts` 的 `bootstrapHost()`，`index.ts` 改调它。这是全项目唯一会碰现存启动路径的改动，务必逐字对齐。

**当前 `local/cli/index.ts` 的启动序列（改造前，已核实，顺序不能变）：**

1. `import "../../src/adapters"`（副作用导入，必须最先）
2. `const updatePromise = checkForUpdate();`
3. `void pingUsage();`
4. `const updateInfo = await updatePromise;` → 若有则 `console.log(formatUpdateBanner(updateInfo))`
5. 若 `config.deepseekApiKey`：`await ensureModelAvailable({ current, providerId, baseUrl, apiKey })`，`migrated` 则改 `config.model`、`saveCredentialsStore({ model, modelOverride: true, providerModels })` 并打印 `🔄 ${drift.message}`
6. `installDefaultTitleMaker()`（`../../src/core/session-titles`）
7. 若 `config.qqBotAppId && config.qqBotAppSecret`：`startQQBridge({ logger: createQQFileLogger() })`（失败仅 `console.error("[qq] 桥启动失败…")`）
8. `const agent = await createRaptorAgent();`
9. `setChatAgent(await createRaptorAgent(undefined, { carryOver: false }))`；`setChatAgentRefresher(async () => setChatAgent(await createRaptorAgent(undefined, { carryOver: false })))`；`setQQBridgeLauncher(() => import("../qq/bridge").then(({ ensureQQBridgeOnline }) => ensureQQBridgeOnline()))`；`startChatWeb()`
10. `startTodoReminderScheduler()`（`../../src/core/todo-reminders`）

**步骤：**

- [ ] 新建 `local/host/boot.ts`：

```ts
import "../../src/adapters"; // 副作用导入，必须最先
import { createRaptorAgent } from "../../src/core/agent";
import { config } from "../../src/core/config";
import { loadCredentialsStore, saveCredentialsStore } from "../../src/core/credentials";
import { ensureModelAvailable } from "../../src/core/models";
import { pingUsage } from "../../src/core/usage-ping";
import { checkForUpdate, formatUpdateBanner, type UpdateInfo } from "../../src/core/update-check";

export interface BootResult {
  agent: Awaited<ReturnType<typeof createRaptorAgent>>;
  updateInfo: UpdateInfo | null;
  webUrl: string | null;
}

/**
 * 共享启动引导：TUI（local/cli/index.ts）与桌面后端（local/host/headless.ts）共用。
 * 逐字复刻原 index.ts 的启动序列与日志，保证本地版行为零改动。
 */
export async function bootstrapHost(): Promise<BootResult> {
  const updatePromise = checkForUpdate();
  void pingUsage();

  const updateInfo = await updatePromise;
  if (updateInfo) console.log(formatUpdateBanner(updateInfo));

  if (config.deepseekApiKey) {
    const drift = await ensureModelAvailable({
      current: config.model,
      providerId: config.providerId,
      baseUrl: config.providerBaseUrl,
      apiKey: config.deepseekApiKey,
    });
    if (drift.migrated) {
      config.model = drift.model;
      const providerModels = {
        ...(loadCredentialsStore()?.providerModels ?? {}),
        [config.providerId]: drift.model,
      };
      saveCredentialsStore({ model: drift.model, modelOverride: true, providerModels });
      console.log(`🔄 ${drift.message}\n`);
    }
  }

  await import("../../src/core/session-titles").then(({ installDefaultTitleMaker }) =>
    installDefaultTitleMaker(),
  );

  if (config.qqBotAppId && config.qqBotAppSecret) {
    const { startQQBridge } = await import("../qq/bridge");
    const { createQQFileLogger } = await import("../qq/logger");
    startQQBridge({ logger: createQQFileLogger() }).catch((e) => {
      console.error(`[qq] 桥启动失败（终端对话不受影响）：${(e as Error).message.slice(0, 120)}`);
    });
  }

  const agent = await createRaptorAgent();

  const { setChatAgent, setChatAgentRefresher, setQQBridgeLauncher, startChatWeb } = await import(
    "../../src/channels/web/chat-web"
  );
  setChatAgent(await createRaptorAgent(undefined, { carryOver: false }));
  setChatAgentRefresher(async () => {
    setChatAgent(await createRaptorAgent(undefined, { carryOver: false }));
  });
  setQQBridgeLauncher(() =>
    import("../qq/bridge").then(({ ensureQQBridgeOnline }) => ensureQQBridgeOnline()),
  );
  const webUrl = await startChatWeb().catch(() => null);

  void import("../../src/core/todo-reminders").then(({ startTodoReminderScheduler }) =>
    startTodoReminderScheduler(),
  );

  return { agent, updateInfo, webUrl };
}
```

- [ ] 改 `local/cli/index.ts`：删掉已搬走的那段，改为：

```ts
import { bootstrapHost } from "../host/boot";
// …保留 school / schoolConfigured / runDeepSeekKeySetup / SLASH_COMMANDS 等 TUI 相关 import…

const { agent, updateInfo, webUrl } = await bootstrapHost();

if (webUrl && !schoolConfigured()) console.log(`💬 网页对话：${webUrl}`);

// ↓↓↓ 以下 TUI 外层循环（card / inline 互切、/key、/inline、soft-interrupt、welcome）
//      原样保留，一字不改 ↓↓↓
```

> 注意：原 `updateInfo` 的 banner 打印已移进 `bootstrapHost()`（与原来语义一致）。`formatUpdateBadge(updateInfo)` 仍用在 TUI 标题里，留在 `index.ts`。
> 时序微差：原来 `startChatWeb()` 不 await（TUI 先起），现在 boot 会 await 到网页 listen 完成再返回（本机监听，毫秒级）。可接受，但要在 PR 描述里点明。

- [ ] **验收命令：**
  - `npm run typecheck && npm test`（重点看 `tests/qq-startup.test.ts`、`tests/chat-web*.test.ts`）
  - `npm run verify:imports`（确认 `core` 没新增对 `local/` 的依赖）
  - `npm run lint`
  - 手动：`npm run dev` 起 TUI，确认网页地址打印、馆队对话、`/key`、`/inline` 与改动前一致
- [ ] 提交：`refactor: 抽取 bootstrapHost 共享引导（TUI/桌面复用）`

**验收标准：** 启动行为逐字不变；`npm test` 全绿；`verify:imports` 过。

## Task 2：桌面通知端口 + 回退链

**目标：** `core` 增加桌面通知端口；`todo-reminders` 先试端口、未注册回退 `windowsToast()`。

**步骤：**

- [ ] 改 `src/core/notify.ts`，文件顶部注释同步补充「桌面通知」语义，追加：

```ts
/** 桌面通知端口：桌面宿主（Electron 后端）注册后接管 toast；未注册时调用方回退本机实现 */
export type DesktopNotifier = (title: string, body: string) => void;

let desktopNotifier: DesktopNotifier | null = null;

/** 宿主启动后注册；传 null 注销 */
export function registerDesktopNotifier(fn: DesktopNotifier | null): void {
  desktopNotifier = fn;
}

/** 发一条桌面通知；未注册返回 false，调用方自行回退 */
export function sendDesktopNotification(title: string, body: string): boolean {
  if (!desktopNotifier) return false;
  desktopNotifier(title, body);
  return true;
}
```

- [ ] 改 `src/core/todo-reminders.ts`：`import { sendDesktopNotification } from "./notify";`，把 `defaultNotify` 的桌面分支改为：

```ts
async function defaultNotify(items: Reminder[], now: Date): Promise<void> {
  for (const r of items) {
    const title = "CourseRaptor 待办提醒";
    const body = `「${r.title}」${dueText(r, now)}`;
    if (!sendDesktopNotification(title, body)) windowsToast(title, body);
  }
  const lines = items.map((r) => `• ${r.title} — ${dueText(r, now)}`).join("\n");
  await sendQQPush(`⏰ 待办提醒（未来 7 天内到期）\n${lines}`).catch(() => {});
}
```

- [ ] 新建 `tests/desktop-ipc.test.ts`（node:test）：
  - 用 `parseIpcLine`（从 `../desktop/src/ipc-protocol` 导入）测：合法 ready/notify/log 行解析、非前缀行返回 null、非法 JSON 返回 null。
  - 测通知回退链：注册一个假的 `DesktopNotifier` 后 `runReminderCheck({ notify })` 走端口；`registerDesktopNotifier(null)` 后语义回退（可断言端口未被调用）。参照 `tests/todo-reminders.test.ts` 的注入方式。
- [ ] **验收命令：** `npm run typecheck && npm test`
- [ ] 提交：`feat(core): 桌面通知端口 + windowsToast 回退`

**验收标准：** 未注册端口时行为与现在完全一致；注册后由宿主接管。

## Task 3：headless 后端入口 + IPC 输出

**步骤：**

- [ ] 新建 `local/host/headless.ts`：

```ts
/**
 * 桌面版后端入口：与 TUI 同一个内核（bootstrapHost），但不进 TUI 循环。
 * 打印 @raptor-ipc 行与 Electron 主进程通信；进程常驻（待办提醒 / QQ 桥续命）。
 */
import { flushCapturedSession } from "../../src/core/memory/shortterm";
import { registerDesktopNotifier } from "../../src/core/notify";
import { bootstrapHost } from "./boot";

function emit(msg: unknown): void {
  process.stdout.write(`@raptor-ipc ${JSON.stringify(msg)}\n`);
}

registerDesktopNotifier((title, body) => emit({ type: "notify", title, body }));

const { webUrl } = await bootstrapHost();

if (webUrl) emit({ type: "ready", url: webUrl });
else emit({ type: "log", level: "error", text: "网页服务启动失败" });

const shutdown = async () => {
  try {
    await flushCapturedSession();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] `package.json` 加脚本：`"desktop:backend": "tsx local/host/headless.ts"`
- [ ] **验收命令：**
  - `npm run desktop:backend`（应打印 `@raptor-ipc {"type":"ready","url":"http://localhost:3210"}` 后常驻；浏览器打开该 URL 能对话；Ctrl+C 优雅退出）
  - `npm run typecheck`
- [ ] 提交：`feat(host): 桌面版 headless 后端入口 + IPC`

**验收标准：** 手跑 headless 能起服务、打印 ready 行、浏览器可对话。

## Task 4：Electron 工程骨架 + 后端子进程管理

> 从这里开始动 `desktop/`（独立 npm 工程）。先在 `desktop/` 里 `npm init` 并 `npm i -D electron electron-builder esbuild typescript @types/node builtin-modules`。

**步骤：**

- [ ] 建 `desktop/package.json`、`desktop/tsconfig.json`、`desktop/esbuild.config.mjs`（三份都参考 `obsidian/` 的同名文件）。`esbuild.config.mjs` 用两个 entry：`main.ts`→`dist/main.cjs`、`preload.ts`→`dist/preload.cjs`，`external: ["electron", ...builtinModules.flatMap(m => [\`node:\${m}\`, m])]`。
- [ ] `desktop/src/ipc-protocol.ts`：照 §5 实现。
- [ ] `desktop/src/backend.ts`（关键：dev/prod 两种 spawn + ready 握手）：

```ts
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseIpcLine, type IpcMessage } from "./ipc-protocol";

export interface BackendHandle {
  child: ChildProcess;
}

export interface StartBackendOptions {
  /** 含 local/host/headless.ts 的目录：dev=仓库根；prod=resources/app */
  appPath: string;
  /** dev 传系统 node 路径；prod 传 resources/runtime/node(.exe) */
  nodeBin: string;
  env: NodeJS.ProcessEnv;
  onMessage: (m: IpcMessage) => void;
  onExit: (code: number | null) => void;
}

export function startBackend(opts: StartBackendOptions): BackendHandle {
  // 复用 bin/raptor.cjs 的稳健写法：从 appPath 解析 tsx 的绝对路径再 --import
  const req = createRequire(path.join(opts.appPath, "package.json"));
  const tsxEntry = pathToFileURL(req.resolve("tsx")).href;

  const child = spawn(
    opts.nodeBin,
    ["--import", tsxEntry, path.join(opts.appPath, "local", "host", "headless.ts")],
    { cwd: opts.appPath, env: opts.env, stdio: ["ignore", "pipe", "pipe"] },
  );

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const msg = parseIpcLine(line);
    if (msg) opts.onMessage(msg);
    else console.log(line);
  });
  child.stderr!.on("data", (d) => process.stderr.write(d));
  child.on("exit", (code) => opts.onExit(code));

  return { child };
}
```

- [ ] `desktop/src/preload.ts`：`contextBridge.exposeInMainWorld("raptor", { version, openDataDir, hideWindow })`（用 `ipcRenderer.invoke`）。保持 `contextIsolation: true`、`nodeIntegration: false`。
- [ ] `desktop/src/main.ts`：

```ts
import { app, BrowserWindow, Notification, ipcMain, shell } from "electron";
import path from "node:path";
import { startBackend } from "./backend";

const isDev = !app.isPackaged;
let win: BrowserWindow | null = null;
let backend: ReturnType<typeof startBackend> | null = null;
let restarting = false;
let restarts = 0;

// 数据目录重定向到用户目录：升级不丢数据（见方案 §3.2）
const dataDir = path.join(app.getPath("userData"), "data");
process.env.RAPTOR_DATA_DIR = dataDir;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(() => boot());
}

function appPath() {
  return isDev ? path.resolve(__dirname, "..", "..") : path.join(process.resourcesPath, "app");
}
function nodeBin() {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  return isDev ? process.execPath.replace(/electron(\.exe)?$/i, exe) /* dev 兜底用系统 node */ : path.join(process.resourcesPath, "runtime", exe);
}

function boot() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.on("close", (e) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault();
      win?.hide();
    }
  });

  backend = startBackend({
    appPath: appPath(),
    nodeBin: nodeBin(),
    env: { ...process.env, RAPTOR_DATA_DIR: dataDir },
    onMessage: (m) => {
      if (m.type === "ready") win?.loadURL(m.url);
      else if (m.type === "notify") new Notification({ title: m.title, body: m.body }).show();
      else if (m.type === "log") console[m.level ?? "log"](m.text);
    },
    onExit: () => {
      if (restarting) return;
      restarts += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(restarts, 5));
      setTimeout(() => {
        if (win && !win.isDestroyed()) backend = startBackend({ /* 同上 */ } as never); // Task 5 抽成 startOnce() 复用
      }, delay);
    },
  });
}

ipcMain.handle("raptor:open-data-dir", () => shell.openPath(dataDir));
```

> 实现时把 `startBackend({...})` 的重复调用抽成一个 `startOnce()` 闭包（Task 5 会用到 watchdog，本就该抽）。上面为示意。

- [ ] `desktop/package.json` 脚本：`"dev": "node esbuild.config.mjs && electron ."`、`"build": "tsc --noEmit && node esbuild.config.mjs production"`。
- [ ] **验收命令：** `npm --prefix desktop run dev` → 开窗、加载后端 URL、能对话。
- [ ] 提交：`feat(desktop): Electron 壳骨架 + 后端子进程 + ready 握手`

**验收标准：** dev 模式开窗进对话；关窗不崩后端（关闭即退可接受，Task 5 完善）。

## Task 5：桌面化能力（托盘 / 通知 / 单实例 / watchdog）

**步骤：**

- [ ] `desktop/src/tray.ts`：托盘图标 + 菜单（显示/隐藏主窗口、打开数据目录、检查更新、退出）。退出走 `app.isQuitting = true; backend?.child.kill(); app.quit()`。
- [ ] `main.ts`：接入托盘；`win.on("close")` 隐藏到托盘；`before-quit` 置 `isQuitting` 并 kill 后端（Windows 上用 `treeKill` 或 `taskkill /pid <pid> /T /F` 杀进程树，避免 QQ 桥残留）。
- [ ] 通知：已在 Task 4 的 `onMessage` 处理 `notify`；补 `Notification` 的 icon 与 click→聚焦窗口。
- [ ] 单实例锁：Task 4 已含 `requestSingleInstanceLock` + `second-instance`。
- [ ] watchdog：Task 4 的 `onExit` 抽成 `startOnce()`，指数退避重启（上限 ~30s），连续失败 N 次后弹一次 `dialog.showErrorBox` 并停止重启（防刷屏），提供托盘「重启后端」手动项。
- [ ] **验收命令：** 关窗后托盘仍在、提醒照常弹；`taskkill` 掉后端进程能自愈；重复启动只开一个实例。
- [ ] 提交：`feat(desktop): 托盘/原生通知/单实例/watchdog`

**验收标准：** 见上。

## Task 6：打包与自动更新

**步骤：**

- [ ] `scripts/package-portable.mjs`：`buildPortable` 返回值追加 `portableDir`（`keep: true` 时有效）。**纯增量**，不动现有字段与行为。
- [ ] 新建 `scripts/package-desktop.mjs`：调 `buildPortable({ keep: true })` → 把 `portableDir` 里的 `app/` 与 `runtime/` 复制到 `desktop/build-resources/` → `npm --prefix desktop run build` → `electron-builder`（cwd=desktop）。结束后清理临时的 `build-resources/`。用与 `package-portable.mjs` 相同的「写临时 .ps1 用 -File 跑」的方式调 PowerShell（避免 cmd 转义把路径吃掉）。
- [ ] `desktop/electron-builder.yml`：

```yaml
appId: com.courseraptor.desktop
productName: CourseRaptor
directories:
  output: release
files:
  - dist/**/*
  - package.json
extraResources:
  - from: build-resources/app
    to: app
  - from: build-resources/runtime
    to: runtime
win:
  target:
    - nsis
    - portable
  icon: build/icon.png
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

- [ ] 自动更新：`electron-updater` 配 `github` provider（`owner: Health-525`、`repo: courseraptor`）；`ready` 后 `checkForUpdatesAndNotify()`，或自绘「发现新版本」对话框 → `quitAndInstall()`。
- [ ] 发布：仍走 `gh release upload`（沿用现有流程），产物命名 `courseraptor-vX.Y.Z-desktop-win-x64.exe`，与便携包并存。
- [ ] **验收命令：** 干净 Windows 上双击安装包能起；发新 Release 后旧版能收到更新提示。
- [ ] 提交：`build(desktop): 打包脚本 + 自动更新（GitHub Release）`

**验收标准：** 见上。

## Task 7：打磨 + 文档 + CI（可选）

- [ ] 应用图标（任务栏/开始菜单/托盘/安装向导）；`desktop/build/icon.png`（≥256）。
- [ ] 首启引导：未配 Key 时引导到网页「设置 → AI 模型」（沿用网页现有引导，不新做）。
- [ ] `desktop/README.md` + 更新 `README.md`「快速开始」增加「桌面版」一种安装方式。
- [ ] CI（`.github/workflows/ci.yml`）：加一个 job 只跑 `npm --prefix desktop run build`（不下载 electron 的纯 typecheck/esbuild 可行；electron 相关跑不了就跳过或标记）。
- [ ] 提交：`docs(desktop): 说明与 CI`

---

## 6. 环境变量与路径对照

| 变量 / 路径 | 含义 | 桌面版取值 |
|---|---|---|
| `RAPTOR_WEB_PORT` | 网页监听端口，默认 3210，被占自动换 | 不设（用默认） |
| `RAPTOR_DATA_DIR` | 数据目录 | `app.getPath("userData")/data`（见 §3.2） |
| `RAPTOR_NO_TODO_REMINDERS` | 关提醒，`=1` | 不设 |
| `RAPTOR_NO_UPDATE_CHECK` | 关版本检查，`=1` | 不设 |
| `<resources>/app` | 后端源码 + 生产依赖（含 tsx） | `extraResources` 注入 |
| `<resources>/runtime/node(.exe)` | 内置 Node 24 运行时 | `extraResources` 注入 |
| `%APPDATA%\CourseRaptor\data` | 桌面版数据 | 由主进程设置 `RAPTOR_DATA_DIR` 指向 |

## 7. 测试清单

| 测试文件 | 覆盖 |
|---|---|
| `tests/desktop-ipc.test.ts` | `parseIpcLine` 各种输入；通知端口注册/回退语义 |
| `tests/qq-startup.test.ts`（已存在） | Task 1 后必须仍绿——证明 index.ts 重构无回归 |
| `tests/chat-web*.test.ts`（已存在） | Task 1 后必须仍绿 |
| `tests/todo-reminders.test.ts`（已存在） | Task 2 后必须仍绿——通知回退不改默认行为 |

`desktop/` 自身测试从简：主进程逻辑（握手/重启）建议用 Electron 的 `@electron/test` 或手动验收，先不强制单测。

## 8. 风险与回滚

- **唯一回归风险点是 Task 1**（碰现存启动路径）。回滚方式：Task 1 单独一个 commit，出问题 `git revert`。
- **体积**：Electron 自带 Chromium（~80–120MB）叠在现有内置 Node 运行时上，安装包约 250MB 级。已经在 §3.2 用 userData 规避了数据丢失；体积是接受的取舍。
- **进程树清理**：Windows 上 `child.kill()` 不杀孙进程，退出时后端用 `taskkill /T`。QQ 桥在 Node 进程内，随后端一起退。
- **签名**：现在就不签名，桌面版同样不签，SmartScreen 提示继续存在，文档沿用现有话术。

## 9. 待确认项

1. **自动更新源**：本方案默认「桌面独立走 electron-updater + GitHub Release」（§3.4）。若日后恢复自建更新后台，再评估接入。
2. **体积取舍**：是否让 Electron 的 Node 兼任后端以省掉单独 runtime——本方案先保守用固定 Node 24，后续再评估。

---

## 附录 A：现有代码索引（实现时直接跳读）

| 符号 | 位置 | 用途 |
|---|---|---|
| `checkForUpdate` / `UpdateInfo` / `formatUpdateBanner` / `formatUpdateBadge` | `src/core/update-check.ts` | 版本检查 |
| `applyUpdate` / `runUpdateCommand` | `src/core/updater.ts` | 源码版一键更新（依赖已下线的后台） |
| `createRaptorAgent` | `src/core/agent.ts` | 组装 agent（`carryOver` 语义见其注释） |
| `startChatWeb` / `getWebUrl` / `setChatAgent` / `setChatAgentRefresher` / `setQQBridgeLauncher` | `src/channels/web/chat-web.ts` + `src/channels/web/web-agent-gate.ts` | 网页服务与 agent 注入 |
| `config` | `src/core/config.ts` | 全局配置（含 `RAPTOR_WEB_PORT` 之外的 env 读取、凭证解析） |
| `dataDir` / `PROJECT_ROOT` | `src/core/paths.ts` | 数据目录与根目录解析 |
| `windowsToast` / `defaultNotify` / `startTodoReminderScheduler` / `runReminderCheck` | `src/core/todo-reminders.ts` | 通知与提醒 |
| `registerQQPushSender` / `sendQQPush` | `src/core/notify.ts` | 端口注入先例（桌面通知端口照它写） |
| `buildPortable` / `PORTABLE_TOP_DIR` | `scripts/package-portable.mjs` | 便携包构建（桌面复用） |
| `bin/raptor.cjs` | `bin/raptor.cjs` | tsx 解析的稳健写法（backend.ts 抄它） |
| `start.bat` 生成逻辑 | `scripts/package-portable.mjs` | 便携启动器（headless 版去掉 TUI 部分） |

（附录到此，实现时以代码为准。）
