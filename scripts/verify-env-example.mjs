#!/usr/bin/env node
// 校验 .env.example 与代码的一致性：文档里出现的每个变量名，
// 必须仍被代码（src/local/scripts/bin）读取，否则报错退出。
//
// 背景：配置文档与实现最容易漂移——变量改名或删除后 .env.example 留下
// 「幽灵配置」，用户照着配了却不生效。CI 门禁：要么修文档，要么恢复读取。
// 只查「文档 → 代码」方向；RAPTOR_DATA_DIR 之类的内部钩子不强制写进文档。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const EXAMPLE = join(ROOT, ".env.example");
const SCAN_DIRS = ["src", "local", "scripts", "bin"];
const EXTS = new Set([".ts", ".mjs", ".cjs"]);

function extractDocumentedVars(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    // 同时覆盖未注释的必填项与注释掉的示例项：注释项同样是「文档承诺」
    const m = line.match(/^\s*#\s*([A-Z][A-Z_0-9]+)\s*=/) ?? line.match(/^([A-Z][A-Z_0-9]+)\s*=/);
    if (m) names.add(m[1]);
  }
  return names;
}

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (EXTS.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

const documented = extractDocumentedVars(readFileSync(EXAMPLE, "utf8"));
const sources = SCAN_DIRS.flatMap((d) => collectFiles(join(ROOT, d))).map((f) =>
  readFileSync(f, "utf8"),
);
const code = sources.join("\n");

// 两种读取形式：直引 process.env.X，或经 config.ts 的 env("X") 封装
function isRead(name) {
  return code.includes(`process.env.${name}`) || code.includes(`env("${name}")`);
}

const ghosts = [...documented].filter((name) => !isRead(name));
if (ghosts.length > 0) {
  console.error(`.env.example 里仍有 ${ghosts.length} 个变量在代码中已无人读取：`);
  for (const name of ghosts) console.error(`  - ${name}`);
  console.error("要么从 .env.example 删除该变量，要么恢复代码读取。");
  process.exit(1);
}
console.log(`verify-env-example: ${documented.size} 个文档变量全部可在代码中读取到 ✓`);
