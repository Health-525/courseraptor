import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { buildSkillPackage } = await import("../scripts/package-skill.mjs");

/**
 * njtech-jwgl 独立技能包（npm run package:skill）的产物契约：
 * - 目录结构齐全（SKILL.md / README / .env.example / references / 单文件 bundle）
 * - bundle 不依赖仓库源码（无残留相对导入），在干净环境、任意 cwd 下可运行
 * - 未配置凭证 → 明确报错而非空数据；.env 配置真实生效（限速预检干净退出）
 * - zip 可识别（本地头签名 + 条目名）
 */

function childEnv() {
  const env = { ...process.env };
  for (const key of [
    "JWGL_USERNAME",
    "JWGL_PASSWORD",
    "RAPTOR_DATA_DIR",
    "RAPTOR_CREDENTIALS_FILE",
  ]) {
    delete env[key];
  }
  return env;
}

test("技能打包：独立目录 + 单文件 bundle + zip，自包含可运行", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-skill-pkg-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const built = await buildSkillPackage({ outDir });
  const script = path.join(built.skillDir, "scripts", "query.mjs");

  for (const rel of [
    "SKILL.md",
    "README.md",
    ".env.example",
    "references/protocol.md",
    "references/capabilities.md",
    "scripts/query.mjs",
  ]) {
    assert.ok(fs.existsSync(path.join(built.skillDir, rel)), `产物应包含 ${rel}`);
  }

  const bundle = fs.readFileSync(script, "utf8");
  assert.ok(!/(?:from|import\()\s*["']\.\.?\//.test(bundle), "bundle 不应残留相对导入（要自包含）");
  assert.match(fs.readFileSync(path.join(built.skillDir, "SKILL.md"), "utf8"), /njtech-jwgl/);

  const run = (args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      cwd: built.skillDir,
      env: childEnv(),
    });

  // 无参数 → 命令清单（证明 bundle 在干净环境独立可跑）
  const help = run([]);
  assert.equal(help.status, 0, `help 应成功：${help.stderr}`);
  assert.match(help.stdout, /schedule/);
  assert.match(help.stdout, /grades/);

  // 未配置凭证 → 非零退出 + 明确报错（「拿不到」≠「没有」的入口语义）
  const noCreds = run(["student-info"]);
  assert.notEqual(noCreds.status, 0);
  assert.match(noCreds.stderr, /尚未配置教务账号/);

  // .env 读取生效：非法限速值在模块初始化前干净退出（而不是压缩堆栈）
  const envFile = path.join(built.skillDir, ".env");
  fs.writeFileSync(envFile, "RAPTOR_MAX_RPS=999\n");
  try {
    const bad = run(["grades"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /RAPTOR_MAX_RPS/);
    assert.ok(!bad.stderr.includes("    at "), "报错不应带堆栈");
  } finally {
    fs.rmSync(envFile, { force: true });
  }

  // zip：本地头签名 + 条目前缀
  const zip = fs.readFileSync(built.zipPath);
  assert.equal(zip.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
  const asLatin1 = zip.toString("latin1");
  assert.ok(asLatin1.includes("njtech-jwgl/SKILL.md"), "zip 应含 SKILL.md");
  assert.ok(asLatin1.includes("njtech-jwgl/scripts/query.mjs"), "zip 应含 bundle");
  assert.equal(built.files.length, 6, "zip 条目数应为 6（无多余文件混入）");
});
