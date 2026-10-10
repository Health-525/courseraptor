/**
 * 课表图片导出 CLI（CourseRaptor 技能 export-schedule 的入口）
 *
 * 设计原则：
 * - 只读封装 src/core 的已验证渲染器（schedule-svg / schedule-png），
 *   与网页「本周图片/整学期图片」按钮、AI 工具 export_schedule_image 同一套代码。
 * - 零登录零网络：只读本地课表缓存（data/schedule-cache.json）。
 * - 导出后默认不弹窗；--open 可选用默认浏览器打开预览（file:// 本地直读，
 *   打不开也不影响导出结果与退出码）。
 * - --serve 导出后挂本地 http 预览服务（只绑 127.0.0.1，空闲自动退出）：
 *   聊天客户端普遍不渲染 file:// 本地图，本地 http 地址才能内嵌进对话框。
 * - 仓库内直跑：npx tsx skills/export-schedule/scripts/export.ts [参数]；
 *   独立技能包（npm run package:skill -- export-schedule）里是同逻辑的
 *   单文件 bundle（scripts/export.mjs），用法参数完全一致。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import "../../../src/adapters"; // 学校适配器装配（school() / terms 周期依赖它）
import { loadScheduleCache } from "../../../src/core/schedule-cache";
import { readJsonCache } from "../../../src/core/json-cache";
import { registeredSchool, school, selectSchool } from "../../../src/core/school";
import { renderTermScheduleSVG, renderWeekScheduleSVG } from "../../../src/core/schedule-svg";
import { scheduleSvgToPng } from "../../../src/core/schedule-png";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── 参数 ────────────────────────────────────────────────────────────

interface CliArgs {
  mode: "week" | "term";
  week: number | null;
  style: "classic" | "color";
  format: "png" | "svg";
  out: string | null;
  cache: string | null;
  open: boolean;
  serve: boolean;
  port: number | null;
  idleMin: number | null;
}

function usage(): string {
  return [
    "课表图片导出：从本地课表缓存渲染 PNG/SVG（零登录零网络）",
    "",
    "用法: node export.mjs [--mode week|term] [--week N] [--style classic|color]",
    "                     [--format png|svg] [--out <目录|文件名>] [--cache <schedule-cache.json>]",
    "                     [--open | --serve [--port N] [--idle-min M]]",
    "",
    "  --mode    week=第 N 周课表（默认）；term=整学期汇总",
    "  --week    周次（week 模式；缺省取当前教学周）",
    "  --style   classic=红头档案（默认）；color=彩色课格",
    "  --format  png=2 倍宽位图（默认）；svg=矢量",
    "  --out     输出位置（目录或文件名；缺省当前目录）",
    "  --cache   直接指定 schedule-cache.json（缺省读技能 data/ 下的缓存）",
    "  --open    导出后用默认浏览器打开预览（默认只导出，不弹窗）",
    "  --serve   导出后挂本地预览服务（127.0.0.1），供聊天对话框内嵌显示",
    "  --port    预览端口（默认 8917；被占用时自动向后找可用端口）",
    "  --idle-min 预览服务空闲自动退出的分钟数（默认 30；0=不自动退出）",
  ].join("\n");
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: "week",
    week: null,
    style: "classic",
    format: "png",
    out: null,
    cache: null,
    open: false,
    serve: false,
    port: null,
    idleMin: null,
  };
  const die = (msg: string): never => {
    process.stderr.write(`${msg}\n\n${usage()}\n`);
    process.exit(1);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      return v === undefined ? die(`${a} 缺少参数值`) : v;
    };
    if (a === "--mode") {
      const v = next();
      if (v !== "week" && v !== "term") die(`--mode 只能是 week 或 term，收到：${v}`);
      args.mode = v;
    } else if (a === "--week") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1) die("--week 需要是正整数周次");
      args.week = n;
    } else if (a === "--style") {
      const v = next();
      if (v !== "classic" && v !== "color") die(`--style 只能是 classic 或 color，收到：${v}`);
      args.style = v;
    } else if (a === "--format") {
      const v = next();
      if (v !== "png" && v !== "svg") die(`--format 只能是 png 或 svg，收到：${v}`);
      args.format = v;
    } else if (a === "--out") {
      args.out = next();
    } else if (a === "--cache") {
      args.cache = next();
    } else if (a === "--open") {
      args.open = true;
    } else if (a === "--serve") {
      args.serve = true;
    } else if (a === "--port") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1 || n > 65535) die("--port 需要是 1-65535 的端口号");
      args.port = n;
    } else if (a === "--idle-min") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 0) die("--idle-min 需要是非负整数分钟数");
      args.idleMin = n;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      die(`未知参数：${a}`);
    }
  }
  return args;
}

// ── logo：独立包在技能 assets/，仓库源码运行回落 docs/（同一张图，不复制第二份） ──

function logoDataUri(): string | undefined {
  for (const p of [
    path.resolve(SCRIPT_DIR, "..", "assets", "courseraptor-logo.png"),
    path.resolve(SCRIPT_DIR, "..", "..", "..", "docs", "courseraptor-logo.png"),
  ]) {
    try {
      return `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
    } catch {
      // 缺文件继续找下一处；都没有则渲染器退回无 logo 画法
    }
  }
  return undefined;
}

// ── 导出后预览：默认浏览器打开（file:// 本地直读，零网络） ────────────
// Windows 上 ShellExecute（start/rundll32）对 file: 协议按扩展名走关联程序，
// PNG 会开到「照片」而不是浏览器；所以从注册表解析默认浏览器 exe 直接拉起。
// 打不开（无浏览器/无桌面/被拦截）只静默放弃，绝不让预览问题影响导出结果与退出码。
function regSz(key: string, value: string): string | null {
  try {
    const r = spawnSync("reg", ["query", key, ...(value ? ["/v", value] : ["/ve"])], {
      encoding: "utf8",
    });
    if (r.status !== 0) return null;
    return /REG_SZ\s+(.*\S)\s*$/m.exec(r.stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

function windowsDefaultBrowserExe(): string | null {
  // 默认浏览器 ProgId（https 关联）→ 打开命令 → 第一个带 .exe 的带引号路径
  const progId = regSz(
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
    "ProgId",
  );
  const command = progId ? regSz(`HKCR\\${progId}\\shell\\open\\command`, "") : null;
  const exe = command ? (/"([^"]+\.exe)"/i.exec(command)?.[1] ?? null) : null;
  if (exe && fs.existsSync(exe)) return exe;
  // 解析失败时兜底常见安装位置：Chrome → Edge（Win10/11 必有 Edge）
  return (
    [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find((p) => fs.existsSync(p)) ?? null
  );
}

function openImageInBrowser(file: string): void {
  const url = pathToFileURL(file).href;
  let child: ReturnType<typeof spawn>;
  if (process.platform === "win32") {
    const exe = windowsDefaultBrowserExe();
    if (!exe) return;
    child = spawn(exe, [url], { detached: true, stdio: "ignore" });
  } else if (process.platform === "darwin") {
    child = spawn("open", [url], { detached: true, stdio: "ignore" });
  } else {
    child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  }
  child.on("error", () => {});
  child.unref();
}

// ── 本地预览服务（--serve）：把导出目录挂到 http://127.0.0.1 ──────────
// 聊天客户端普遍不渲染 file:// 本地图、上传回链也可能被拦，本地 http 地址
// 各端都能内嵌。只绑回环地址不对外；空闲 idleMin 分钟无请求自动退出，避免
// 残留后台进程。目录内任意文件可取（agent 可能连续导出多张）。
function servePreview(dir: string, entryFile: string, firstPort: number, idleMin: number): void {
  const root = path.resolve(dir);
  let idleTimer: NodeJS.Timeout | null = null;
  const server = http.createServer((req, res) => {
    touchIdle();
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const rel = decodeURIComponent(
      new URL(req.url ?? "/", "http://127.0.0.1").pathname,
    ).replace(/^\/+/, "");
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let data: Buffer;
    try {
      data = fs.readFileSync(abs);
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    const type = abs.endsWith(".png")
      ? "image/png"
      : abs.endsWith(".svg")
        ? "image/svg+xml"
        : "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": data.length,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });

  function touchIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleMin > 0) {
      idleTimer = setTimeout(() => {
        server.close();
        process.exit(0);
      }, idleMin * 60_000);
    }
  }

  let retry = 0;
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE" && retry < 20) {
      retry++;
      server.listen(firstPort + retry, "127.0.0.1");
      return;
    }
    process.stderr.write(`预览服务启动失败：${e.message}\n`);
    process.exit(1);
  });
  server.listen(firstPort, "127.0.0.1", () => {
    touchIdle();
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : firstPort;
    process.stdout.write(
      [
        `预览服务 http://127.0.0.1:${port}/（只绑本机回环）`,
        `预览地址 http://127.0.0.1:${port}/${encodeURIComponent(entryFile)}`,
        idleMin > 0
          ? `空闲 ${idleMin} 分钟自动退出（Ctrl+C 立即退出）`
          : "不会自动退出（Ctrl+C 结束）",
      ].join("\n") + "\n",
    );
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

// --cache 直接指定缓存文件：重定向数据目录后走公共读缓存逻辑（含形状与分校校验）
if (args.cache) {
  const abs = path.resolve(args.cache);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`--cache 指定的文件不存在：${abs}\n`);
    process.exit(1);
  }
  process.env.RAPTOR_DATA_DIR = path.dirname(abs);
}

// 缓存记录了来源学校（schoolId）：本技能默认「不接入任何学校」（custom）起步，
// 若缓存来自真实学校（如 njtech），先显式切过去再读——否则 loadScheduleCache
// 的分校校验会把别校缓存判为 null，周次推算也会用错校历。RAPTOR_SCHOOL
// 显式指定时尊重之，不做自动切换
if (!process.env.RAPTOR_SCHOOL) {
  const raw = readJsonCache("schedule-cache.json", (p): p is { schoolId?: unknown } => true);
  const cacheSchoolId = typeof raw?.schoolId === "string" ? raw.schoolId : null;
  if (cacheSchoolId && cacheSchoolId !== registeredSchool()?.info.id) {
    selectSchool(cacheSchoolId); // 未知 id 返回 false，保持现状（后面自然报「还没有课表缓存」）
  }
}

const cached = loadScheduleCache();
if (!cached) {
  process.stderr.write(
    [
      "还没有课表缓存。三种来源任选其一：",
      "  1. 从本机 CourseRaptor 的 data/ 目录拷 schedule-cache.json 到本技能 data/ 下；",
      "  2. 用 --cache <路径> 直接指向那份 schedule-cache.json；",
      "  3. 还没查过课表：先在 CourseRaptor 对话里查询一次课表让缓存落盘，再执行 1 或 2。",
    ].join("\n"),
  );
  process.exit(1);
}

const schedule = cached.schedule;
const semPart = `${schedule.year}-${schedule.semester === 3 ? 1 : 2}`;
const logo = logoDataUri();
const styleSuffix = args.style === "color" ? "-color" : "";

let svg: string;
let svgWidth: number;
let filename: string;
let describe: string;

if (args.mode === "week") {
  const terms = school().terms;
  const current = terms.weekOf(schedule.year, schedule.semester);
  const maxWeek = Math.max(
    1,
    ...schedule.courses.flatMap((course) => terms.expandWeeks(course.weeks)),
  );
  let week: number;
  if (args.week !== null) {
    if (args.week > maxWeek) {
      process.stderr.write(`周次越界：${args.week}（有效范围 1-${maxWeek}）\n`);
      process.exit(1);
    }
    week = args.week;
  } else {
    if (current?.week == null) {
      process.stderr.write(`当前不在教学周内，请用 --week 指定周次（1-${maxWeek}）\n`);
      process.exit(1);
    }
    week = current.week;
  }
  const week1Monday = terms.week1MondayOf(schedule.year, schedule.semester).week1Monday;
  const r = renderWeekScheduleSVG({
    courses: schedule.courses,
    week,
    week1Monday,
    termLabel: schedule.label,
    style: args.style,
    ...(logo ? { logoDataUri: logo } : {}),
  });
  svg = r.svg;
  svgWidth = r.width;
  filename = `schedule-week${week}-${semPart}${styleSuffix}`;
  describe = `第 ${week} 周`;
} else {
  const r = renderTermScheduleSVG({
    courses: schedule.courses,
    termLabel: schedule.label,
    style: args.style,
    ...(logo ? { logoDataUri: logo } : {}),
  });
  svg = r.svg;
  svgWidth = r.width;
  filename = `schedule-term-${semPart}${styleSuffix}`;
  describe = "整学期汇总";
}

// 输出位置：--out 以 .png/.svg 结尾按文件名，否则当目录；缺省当前目录
let outFile: string;
if (args.out) {
  outFile = /\.(png|svg)$/i.test(args.out)
    ? path.resolve(args.out)
    : path.resolve(args.out, `${filename}.${args.format}`);
} else {
  outFile = path.resolve(`${filename}.${args.format}`);
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });

if (args.format === "svg") {
  fs.writeFileSync(outFile, svg, "utf8");
} else {
  try {
    // 2 倍宽出图：手机放大看笔画不发虚（与网页端点同款）
    fs.writeFileSync(outFile, scheduleSvgToPng(svg, svgWidth * 2));
  } catch (e) {
    const msg = `${(e as Error)?.message ?? e}`;
    if (!msg.includes("Cannot find module") || !msg.includes("@resvg")) throw e;
    // 独立包未带本平台原生二进制（mac/Linux）：降级出 SVG，别让同学空手而归
    const fallback = outFile.replace(/\.png$/i, ".svg");
    fs.writeFileSync(fallback, svg, "utf8");
    process.stderr.write(
      [
        `本平台缺 @resvg/resvg-js 原生模块，无法出 PNG，已降级输出 SVG：${fallback}`,
        "想要 PNG：在技能目录执行 npm install @resvg/resvg-js 后重试（会自动装对应平台的二进制）。",
      ].join("\n"),
    );
    outFile = fallback;
  }
}

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
process.stdout.write(
  `已导出 ${outFile}（${schedule.label} · ${describe} · ${args.style} · ${path.extname(outFile).slice(1).toUpperCase()} · ${kb} KB）\n`,
);

if (args.serve) {
  servePreview(path.dirname(outFile), path.basename(outFile), args.port ?? 8917, args.idleMin ?? 30);
} else if (args.open) {
  openImageInBrowser(outFile);
}
