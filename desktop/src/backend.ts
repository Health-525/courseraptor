import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { type IpcMessage, parseIpcLine } from "./ipc-protocol";

export interface BackendOptions {
  /** 含 local/host/headless.ts 的目录：dev=仓库根；prod=<resources>/app */
  appPath: string;
  /** dev=系统 node；prod=<resources>/runtime/node(.exe) */
  nodeBin: string;
  env: NodeJS.ProcessEnv;
  onMessage: (m: IpcMessage) => void;
  onExit: (info: { code: number | null; expected: boolean }) => void;
}

export interface BackendHandle {
  child: ChildProcess;
  /** 期望的关闭（退出应用时）：kill 后端的整棵进程树，不让 onExit 触发 watchdog */
  stop: () => void;
}

/**
 * 拉起后端 Node host（local/host/headless.ts）。tsx 的解析复用 bin/raptor.cjs
 * 的稳健写法：从 appPath 解析出 tsx 入口的绝对路径再 --import，避免依赖 cwd。
 *
 * 生产依赖注意：tsx 必须落在根 package.json 的 dependencies 里（它正是如此），
 * 否则便携包/桌面包的 npm ci --omit=dev 会把它裁掉，后端起不来。
 */
export function startBackend(opts: BackendOptions): BackendHandle {
  const req = createRequire(path.join(opts.appPath, "package.json"));
  const tsxEntry = pathToFileURL(req.resolve("tsx")).href;
  const entry = path.join(opts.appPath, "local", "host", "headless.ts");

  const child = spawn(opts.nodeBin, ["--import", tsxEntry, entry], {
    cwd: opts.appPath,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let expected = false;

  const rl = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
  rl.on("line", (line) => {
    const msg = parseIpcLine(line);
    if (msg) opts.onMessage(msg);
    else console.log(`[backend] ${line}`);
  });
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  child.on("exit", (code) => opts.onExit({ code, expected }));

  return {
    child,
    stop: () => {
      expected = true;
      killTree(child);
    },
  };
}

/** Windows 上 child.kill() 不杀孙进程，用 taskkill /T 杀整棵进程树（QQ 桥随之退） */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
  } else {
    child.kill("SIGTERM");
  }
}
