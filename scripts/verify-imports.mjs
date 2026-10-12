#!/usr/bin/env node
/**
 * 分层边界门禁：架构分层用可执行脚本钉死，防止再长回去
 * （deepseek-harness 思路：每条约定配一个 verify 脚本）。
 *
 * 层级（内 → 外，依赖只许指向更内层）：
 *   core      (src/core)      agent 内核：禁止 import channels 与 local
 *   channels  (src/channels)  渠道适配：禁止 import local（宿主注入替代）
 *   adapters  (src/adapters)  学校适配器：只许依赖 core
 *   assets    (web/assets)    浏览器前端脚本：无任何模块系统，禁止 import
 *   local     (local)         宿主/入口层：自由（装配 core+channels+qq）
 *   skills    (skills)        打包分发层：自由（esbuild 闭包自包含）
 *
 * 违例即退出码 1。新层级关系先改这里再写代码。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** [层名, 目录, 禁止的仓库前缀] */
const RULES = [
  ["core", "src/core", ["src/channels/", "local/"]],
  ["channels", "src/channels", ["local/"]],
  ["adapters", "src/adapters", ["src/channels/", "local/"]],
];

const ASSETS_DIR = path.join(ROOT, "src", "channels", "web", "assets");
const EXTS = new Set([".ts", ".js", ".mjs", ".cjs"]);

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (EXTS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

/** 提取一个源文件里的全部模块 specifier（静态 import / 动态 import / export from） */
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function specifiersOf(code) {
  const specs = [];
  for (const m of code.matchAll(IMPORT_RE)) specs.push(m[1] ?? m[2]);
  return specs;
}

/** 相对 specifier → 仓库相对路径（POSIX 分隔）；非相对/裸包名返回 null */
function resolveSpec(spec, fromFile) {
  if (!spec.startsWith(".")) return null;
  const abs = path.resolve(path.dirname(fromFile), spec);
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  for (const ext of [".ts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"]) {
    if (statSyncSafe(path.join(ROOT, `${rel}${ext}`))) return `${rel}${ext}`;
    if (statSyncSafe(path.join(ROOT, rel, "index.ts"))) return `${rel}/index.ts`;
  }
  return rel;
}

function statSyncSafe(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

const violations = [];

for (const [layer, dir, forbidden] of RULES) {
  for (const file of collectFiles(path.join(ROOT, dir))) {
    const relFile = path.relative(ROOT, file).split(path.sep).join("/");
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      const target = resolveSpec(spec, file);
      if (!target) continue;
      // 相对路径逃出仓库根（../.. 越界）：一定是写错层级数，直接拦
      if (target.startsWith("../")) {
        violations.push(`${relFile}  →  ${spec}   [相对路径逃出仓库根]`);
        continue;
      }
      for (const prefix of forbidden) {
        if (target === prefix.replace(/\/$/, "") || target.startsWith(prefix)) {
          violations.push(`${relFile}  →  ${target}   [${layer} 层不得依赖 ${prefix}]`);
        }
      }
    }
  }
}

// 浏览器前端脚本无模块系统：任何 import 都是不对（打包内联/静态伺服都不走 bundler）
if (statSyncSafe(ASSETS_DIR)) {
  for (const file of collectFiles(ASSETS_DIR)) {
    const relFile = path.relative(ROOT, file).split(path.sep).join("/");
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      violations.push(`${relFile}  →  ${spec}   [浏览器前端脚本不得 import 任何模块]`);
    }
  }
}

if (violations.length > 0) {
  console.error(`分层边界被破坏（${violations.length} 处）：`);
  for (const v of violations) console.error(`  ${v}`);
  console.error("\n依赖只许指向更内层：local → channels/adapters → core。");
  console.error("跨层需求用端口注入（参考 src/core/notify.ts、setQQBridgeLauncher）。");
  process.exit(1);
}
console.log("verify-imports: 分层边界全部干净 ✓");
