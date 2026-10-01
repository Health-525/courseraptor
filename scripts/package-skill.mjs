/**
 * 打包 njtech-jwgl 独立技能包：npm run package:skill
 *
 * 产物（默认在 dist/ 下）：
 * - dist/skill/njtech-jwgl/    可直接整目录拷进 ~/.workbuddy/skills/ 的技能
 * - dist/njtech-jwgl-skill-vX.Y.Z.zip   供下载分发（解压即上述目录）
 *
 * 做法：esbuild 把 skills/njtech-jwgl/scripts/query.ts 连同它引用的
 * src/adapters/njtech + src/core 依赖闭包打成单文件 ESM（scripts/query.mjs）。
 * 闭包内唯一的 npm 依赖 zod 会被内联；jszip/pdf-parse/mammoth/tesseract.js
 * 是源码里函数内的惰性 require（仅附件/PDF/OCR 路径用到，技能查询用不到），
 * 标记 external——独立包不带 node_modules，真用到会在运行时报缺依赖（可接受降级）。
 *
 * banner 注入独立包运行时引导：数据目录/凭证文件重定向到技能自身 data/、
 * 支持技能根目录 .env、给惰性 require 提供 createRequire（相对 bundle 解析）。
 * esbuild 从 tsx 的依赖上下文解析（仓库未直接依赖 esbuild，tsx 自带）。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

// 惰性依赖：源码里函数体内 require(...)，独立包不携带，标记 external
const EXTERNAL_LAZY_DEPS = ["jszip", "pdf-parse", "mammoth", "tesseract.js"];

function banner(skillVarDocs) {
  // 注意：banner 不参与 esbuild 的重命名/去重，绑定一律用 __skill 前缀避免与
  // bundle 顶部保留的 node 内置导入（fs/path 等）撞名；const require 供源码里
  // 函数体内的惰性 require(...)（jszip 等）落到本文件解析。
  return `// njtech-jwgl 独立技能包运行时引导（package-skill.mjs 注入，勿手改）
// - 数据/凭证/会话默认落在本技能目录 data/ 下（RAPTOR_DATA_DIR 等可覆盖）
// - 支持本技能根目录 .env（与 SKILL.md 同级）
// - 为惰性依赖（${EXTERNAL_LAZY_DEPS.join("/")}）提供 require；独立包未携带，
//   仅附件/PDF/OCR 深度路径会用到，届时会报缺失并给出指引
import { createRequire as __skillCreateRequire } from "node:module";
import * as __skillFs from "node:fs";
import * as __skillPath from "node:path";
import { fileURLToPath as __skillF2P } from "node:url";
const require = __skillCreateRequire(import.meta.url);
const __skillRoot = __skillPath.resolve(
  __skillPath.dirname(__skillF2P(import.meta.url)),
  "..",
);
if (!process.env.RAPTOR_DATA_DIR) {
  process.env.RAPTOR_DATA_DIR = __skillPath.join(__skillRoot, "data");
}
if (!process.env.RAPTOR_CREDENTIALS_FILE) {
  process.env.RAPTOR_CREDENTIALS_FILE = __skillPath.join(__skillRoot, "data", "credentials.enc");
}
${skillVarDocs}
try {
  const __envFile = __skillPath.join(__skillRoot, ".env");
  if (__skillFs.existsSync(__envFile)) {
    for (const __line of __skillFs.readFileSync(__envFile, "utf8").split(/\\r?\\n/)) {
      const __m = /^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)\\s*$/.exec(__line);
      if (__m && !__m[1].startsWith("#") && process.env[__m[1]] === undefined) {
        process.env[__m[1]] = __m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
} catch {}
// 限速预检（在 .env 读取之后）：坏值在模块初始化（zod 校验）前就干净退出，
// 避免用户看到压缩堆栈
if (process.env.RAPTOR_MAX_RPS !== undefined) {
  const __rps = Number(process.env.RAPTOR_MAX_RPS);
  if (!Number.isInteger(__rps) || __rps < 1 || __rps > 3) {
    process.stderr.write("❌ .env 里 RAPTOR_MAX_RPS 必须是 1-3 的整数（限速只许下调）\\n");
    process.exit(1);
  }
}
`;
}

// ── 零依赖 zip（仅存储，不压缩）：本地文件头 + 中央目录 + EOCD ──────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

/** 打包 zip：entries = [{ name(正斜杠相对名), data }]，返回 Buffer */
export function zipEntries(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const { time, day } = dosDateTime(entry.mtime ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // method 0 = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: -rw-r--r--
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walkFiles(full, base));
    else out.push({ full, rel: path.relative(base, full).split(path.sep).join("/") });
  }
  return out;
}

// ── esbuild：从 tsx 的依赖上下文解析（仓库不直接依赖 esbuild） ─────────────

function loadEsbuild() {
  const require = createRequire(import.meta.url);
  const tsxDir = path.dirname(require.resolve("tsx/package.json"));
  const esbuildMain = createRequire(tsxDir).resolve("esbuild");
  return createRequire(esbuildMain)(esbuildMain);
}

/** 供测试与脚本共用：组装独立技能包。返回产物路径与文件清单。 */
export async function buildSkillPackage({ projectRoot = REPO_ROOT, outDir } = {}) {
  const root = path.resolve(projectRoot);
  const skillSrc = path.join(root, "skills", "njtech-jwgl");
  const dest = path.resolve(outDir ?? path.join(root, "dist"));
  const skillDir = path.join(dest, "skill", "njtech-jwgl");

  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const skillVarDocs = `// 技能版本：v${version}（来自 CourseRaptor 主项目）`;

  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });

  // 1) 单文件 bundle
  const esbuild = loadEsbuild();
  await esbuild.build({
    entryPoints: [path.join(skillSrc, "scripts", "query.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node18"],
    charset: "utf8",
    minify: true,
    banner: { js: banner(skillVarDocs) },
    external: EXTERNAL_LAZY_DEPS,
    outfile: path.join(skillDir, "scripts", "query.mjs"),
  });

  // 2) 静态文件
  fs.copyFileSync(path.join(skillSrc, "package", "SKILL.md"), path.join(skillDir, "SKILL.md"));
  fs.copyFileSync(path.join(skillSrc, "package", "README.md"), path.join(skillDir, "README.md"));
  fs.copyFileSync(
    path.join(skillSrc, "package", ".env.example"),
    path.join(skillDir, ".env.example"),
  );
  for (const file of fs.readdirSync(path.join(skillSrc, "references"))) {
    fs.copyFileSync(
      path.join(skillSrc, "references", file),
      path.join(skillDir, "references", file),
    );
  }

  // 3) zip（条目带 njtech-jwgl/ 前缀，解压即得技能目录）
  const entries = walkFiles(skillDir).map(({ full, rel }) => ({
    name: `njtech-jwgl/${rel}`,
    data: fs.readFileSync(full),
    mtime: fs.statSync(full).mtime,
  }));
  const zipPath = path.join(dest, `njtech-jwgl-skill-v${version}.zip`);
  fs.writeFileSync(zipPath, zipEntries(entries));

  const bundle = fs.readFileSync(path.join(skillDir, "scripts", "query.mjs"), "utf8");
  const leak = /(?:from|import\()\s*["']\.\.?\/(?!node:)/.exec(bundle);
  if (leak) throw new Error(`bundle 里出现未解析的相对导入：${leak[0]}`);

  return {
    version,
    skillDir,
    zipPath,
    files: entries.map((e) => e.name),
    bundleBytes: fs.statSync(path.join(skillDir, "scripts", "query.mjs")).size,
  };
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSkillPackage()
    .then((r) => {
      console.log(`✅ njtech-jwgl 独立技能包 v${r.version}`);
      console.log(`   技能目录：${r.skillDir}（拷进 ~/.workbuddy/skills/ 即用）`);
      console.log(`   下载包：  ${r.zipPath}`);
      console.log(`   文件数：  ${r.files.length}，bundle ${(r.bundleBytes / 1024).toFixed(0)} KB`);
      console.log("   自检：");
      const help = spawnSync(process.execPath, [path.join(r.skillDir, "scripts", "query.mjs")], {
        encoding: "utf8",
        cwd: r.skillDir,
      });
      if (help.status !== 0 || !String(help.stdout).includes("schedule")) {
        throw new Error(`自检失败：exit=${help.status}\n${help.stderr}`);
      }
      console.log("   node scripts/query.mjs → 命令清单正常 ✓");
    })
    .catch((error) => {
      console.error(`❌ 打包失败：${error.message}`);
      process.exit(1);
    });
}
