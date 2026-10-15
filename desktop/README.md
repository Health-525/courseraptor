# CourseRaptor 桌面版（desktop/）

Electron 薄壳：复用仓库现成的 Web UI 与 Node 后端，套一层「双击即进对话、托盘常驻、
原生通知、应用内自动更新」的桌面窗口，全程不开终端。

方案与任务拆解见 [`docs/superpowers/plans/2026-10-15-desktop-version.md`](../docs/superpowers/plans/2026-10-15-desktop-version.md)。

## 结构

```
desktop/
├── src/
│   ├── main.ts          # 主进程：单实例锁 / 窗口 / 托盘 / 通知 / 自动更新 / watchdog
│   ├── backend.ts       # 后端子进程管理：spawn + stdout IPC 解析 + 进程树清理
│   ├── ipc-protocol.ts  # stdout 行协议（纯数据，主仓测试也复用）
│   ├── preload.ts       # 隔离渲染世界的极小桥接 API
│   └── tray.ts          # 系统托盘
├── esbuild.config.mjs   # 打主进程/preload → dist/（CJS）
├── electron-builder.yml # 打包配置（extraResources 注入后端 app/ 与内置 Node runtime/）
└── build/icon.png       # 应用图标（可选；缺失时用默认/透明兜底）
```

进程模型与 IPC 协议见方案文档 §2 / §5。要点：

- 主进程 spawn `local/host/headless.ts`（同一个内核，不进 TUI），从它的 stdout 读
  `@raptor-ipc {...}` 行，拿 `ready` 行的 URL 再 `loadURL`。
- 数据目录重定向到 `app.getPath("userData")/data`（Windows 即 `%APPDATA%\CourseRaptor\data`），
  **升级不丢数据**。
- 关窗＝隐藏到托盘；退出走托盘菜单 / 关机。
- 待办提醒等 core 侧通知经 `src/core/notify.ts` 的桌面通知端口转成原生 `Notification`。

## 开发

前提：主仓已 `npm install`（桌面后端要跑主仓代码 + tsx）。

```bash
# 装桌面工程依赖（含 Electron）
npm --prefix desktop install

# 开发：起后端 + 开窗口（会打开一个 Electron 窗口）
npm run desktop:dev

# 只跑桌面后端（不带窗口，便于调试；会打印 ready 行）
npm run desktop:backend
```

`desktop:dev` 里主进程用**系统 node** 跑后端（依赖 PATH，仓库里有 tsx）；打包版用
`extraResources/runtime` 里的内置 Node 24。

## 打包

```bash
# 主仓根目录执行：先构建便携后端，再交给 electron-builder
npm run desktop:dist          # 产物在 desktop/release/
npm run desktop:dist -- --keep  # 保留 desktop/build-resources/ 便于排查
# IDE/杀软咬住仓库目录导致 EBUSY 时，把输出改到扫描之外的目录：
npm run desktop:dist -- --out "$env:TEMP\raptor-desktop-out"
```

产物为 NSIS 安装包 + portable exe，命名沿用 `courseraptor-vX.Y.Z-desktop-win-x64.*`，
与现有便携包并存，一起走 `gh release upload`。自动更新走 `electron-updater` + GitHub
Release（`electron-builder.yml` 的 `publish` 段）。

### 应用图标

直接复用仓库里的项目 logo `docs/courseraptor-logo.png`（与 README 同一张）——`electron-builder.yml`
的 `win.icon` 与 `extraResources` 都指向它，不复制第二份避免漂移。dev 模式下窗口/托盘图标
也从该文件读取（缺失时托盘走透明兜底，不影响运行）。

## 安全边界（不变式）

- 网页仍只监听 `127.0.0.1`，窗口从本机 URL 加载，不新增任何对外暴露。
- `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`，页面只经 preload
  拿到 `openDataDir` / `appVersion` 两个方法。
- 主仓源码不 import `desktop/`；`desktop/` 只单向依赖主仓的 `local/host/*`。
