import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { buildSkillPackage } = await import("../scripts/package-skill.mjs");

/**
 * 独立技能包（npm run package:skill）的产物契约：
 * - 目录结构齐全（SKILL.md / README / .env.example / 单文件 bundle / assets）
 * - bundle 不依赖仓库源码（无残留相对导入），在干净环境、任意 cwd 下可运行
 * - 未配置数据 → 明确报错而非空数据；zip 可识别（本地头签名 + 条目名）
 */

function childEnv() {
  const env = { ...process.env };
  for (const key of ["RAPTOR_DATA_DIR", "RAPTOR_CREDENTIALS_FILE"]) {
    delete env[key];
  }
  return env;
}

test("技能打包：export-schedule 独立包结构 + 自包含可运行", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-skill-exp-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  // includeBinaries:false 跳过 resvg 原生模块暂装（不打网络请求）
  const built = await buildSkillPackage({
    outDir,
    skill: "export-schedule",
    includeBinaries: false,
  });
  const script = path.join(built.skillDir, "scripts", "export.mjs");

  for (const rel of [
    "SKILL.md",
    "README.md",
    ".env.example",
    "scripts/export.mjs",
    "assets/courseraptor-logo.png",
  ]) {
    assert.ok(fs.existsSync(path.join(built.skillDir, rel)), `产物应包含 ${rel}`);
  }

  const bundle = fs.readFileSync(script, "utf8");
  assert.ok(!/(?:from|import\()\s*["']\.\.?\//.test(bundle), "bundle 不应残留相对导入（要自包含）");
  // PNG 原生模块必须 external（.node 二进制没法进单文件 JS，随包另发）
  assert.ok(!bundle.includes('from"@resvg/resvg-js"'), "resvg 应为 external 惰性加载");

  const run = (args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      cwd: built.skillDir,
      env: childEnv(),
    });

  // --help → 用法清单（证明 bundle 在干净环境独立可跑）
  const help = run(["--help"]);
  assert.equal(help.status, 0, `help 应成功：${help.stderr}`);
  assert.match(help.stdout, /--mode/);
  assert.match(help.stdout, /--cache/);
  assert.match(help.stdout, /--open/);
  assert.match(help.stdout, /--serve/);

  // 无缓存 → 非零退出 + 引导配置（不编造课表）
  const noCache = run([]);
  assert.notEqual(noCache.status, 0);
  assert.match(noCache.stderr, /还没有课表缓存/);
  assert.match(noCache.stderr, /--cache/);

  // --cache 指向缓存 → 导出成功。本包不带 resvg 二进制（includeBinaries:false），
  // PNG 应自动降级为 SVG 而不是崩溃——断言放行两种后缀，钉住「不崩」契约
  const cacheFile = path.join(outDir, "schedule-cache.json");
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      savedAt: Date.now(),
      schedule: {
        year: 2026,
        semester: 3,
        label: "2026-2027学年第一学期",
        courses: [
          {
            title: "打包测试课",
            weekday: 1,
            periods: [1, 2],
            weeks: "1-16",
            location: "A101",
            teacher: "",
          },
        ],
      },
      schoolId: "custom",
    }),
  );
  // 默认不弹浏览器（对话内嵌交付），跑测试不会在宿主机开窗口
  const exported = run([
    "--cache",
    cacheFile,
    "--week",
    "1",
    "--out",
    path.join(outDir, "exports"),
  ]);
  assert.equal(exported.status, 0, `带缓存导出应成功：${exported.stderr}`);
  assert.match(exported.stdout, /已导出/);
  const produced = fs
    .readdirSync(path.join(outDir, "exports"))
    .filter((f) => /^schedule-week1-2026-1\.(png|svg)$/.test(f));
  assert.equal(produced.length, 1, "应产出 schedule-week1-2026-1.png 或降级 .svg");

  // --serve：本地 http 预览（对话内嵌显示的底座）——拉起后轮询 fetch，
  // 应返回预览地址、图片字节与非 image/* Content-Type 不符即失败
  const port = 20000 + Math.floor(Math.random() * 20000);
  const serveProc = spawn(
    process.execPath,
    [
      script,
      "--cache",
      cacheFile,
      "--week",
      "1",
      "--out",
      path.join(outDir, "serve"),
      "--serve",
      "--port",
      String(port),
      "--idle-min",
      "0",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => serveProc.kill());
  let serveOut = "";
  serveProc.stdout.on("data", (d) => {
    serveOut += d;
  });
  serveProc.stderr.on("data", (d) => {
    serveOut += d;
  });

  let fetchErr = "未开始";
  let served = false;
  // 轮询预算 20s：coverage 档的 ubuntu CI 冷启动（node + 1.4MB bundle + 出图）
  // 实测可超 6s，旧窗口 40×150ms 会在服务刚起时耗尽（#218 CI 偶发红）
  for (let i = 0; i < 80 && !served; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/${produced[0]}`);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        served = buf.length > 0 && (res.headers.get("content-type") ?? "").startsWith("image/");
      } else {
        fetchErr = `HTTP ${res.status}`;
      }
    } catch (e) {
      fetchErr = (e as Error).message;
    }
  }
  assert.ok(served, `预览服务应可访问（${fetchErr}）stdout：${serveOut}`);
  assert.match(serveOut, /预览地址 http:\/\/127\.0\.0\.1:\d+\//, `stdout：${serveOut}`);

  // zip：本地头签名 + 条目前缀
  const zip = fs.readFileSync(built.zipPath);
  assert.equal(zip.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
  const asLatin1 = zip.toString("latin1");
  assert.ok(asLatin1.includes("export-schedule/SKILL.md"), "zip 应含 SKILL.md");
  assert.ok(asLatin1.includes("export-schedule/scripts/export.mjs"), "zip 应含 bundle");
});

test("技能打包：meta-learning 纯提示词技能（无 bundle，整拷即用）", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-skill-ml-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const built = await buildSkillPackage({ outDir, skill: "meta-learning" });

  assert.equal(built.promptOnly, true);
  assert.equal(built.bundleBytes, 0);

  for (const rel of [
    "SKILL.md",
    "README.md",
    "references/deep-understanding.md",
    "references/exam-strategies.md",
    "references/knowledge-structure-assessment.md",
    "references/learning-frameworks.md",
    "references/note-taking-systems.md",
    "references/practice-design.md",
  ]) {
    assert.ok(fs.existsSync(path.join(built.skillDir, rel)), `产物应包含 ${rel}`);
  }
  // 纯提示词技能：不带脚本与配置模板
  assert.ok(!fs.existsSync(path.join(built.skillDir, "scripts")));
  assert.ok(!fs.existsSync(path.join(built.skillDir, ".env.example")));

  assert.match(fs.readFileSync(path.join(built.skillDir, "SKILL.md"), "utf8"), /学习/);

  // zip：本地头签名 + 条目前缀 + 条目数恰为 8（SKILL/README + 六篇 references）
  const zip = fs.readFileSync(built.zipPath);
  assert.equal(zip.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
  const asLatin1 = zip.toString("latin1");
  assert.ok(asLatin1.includes("meta-learning/SKILL.md"), "zip 应含 SKILL.md");
  assert.ok(
    asLatin1.includes("meta-learning/references/exam-strategies.md"),
    "zip 应含 references",
  );
  assert.equal(built.files.length, 8, "zip 条目数应为 8（无多余文件混入）");
});
