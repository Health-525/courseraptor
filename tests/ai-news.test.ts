/** 可选 Python 功能的真实子进程测试，不调用模型或公开网络。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ZodObject } from "zod";

import { shouldPackagePath } from "../scripts/package-policy.mjs";
import { newsWorkflowStop, runAiNews } from "../src/core/ai-news";
import { SKILL_LIBRARY } from "../src/core/skill-library";
import { aiNewsTools } from "../src/core/tools/ai-news";

const root = path.resolve(import.meta.dirname, "..");
const interpreter = ["python", "python3"].find((candidate) => {
  const result = spawnSync(
    candidate,
    ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"],
    { windowsHide: true },
  );
  return result.status === 0;
});

test("新闻分页可完成超过 20 轮的日报，仍有硬上限，其他对话预算不变", () => {
  const steps = Array.from({ length: 20 }, () => ({ toolCalls: [{ toolName: "get_time" }] }));
  assert.equal(newsWorkflowStop({ steps }), true);
  steps[0] = { toolCalls: [{ toolName: "prepare_ai_news" }] };
  assert.equal(newsWorkflowStop({ steps }), false);
  while (steps.length < 99) steps.push({ toolCalls: [{ toolName: "save_ai_news_digest" }] });
  assert.equal(newsWorkflowStop({ steps }), false);
  steps.push({ toolCalls: [{ toolName: "save_ai_news_digest" }] });
  assert.equal(newsWorkflowStop({ steps }), true);
});

test("新闻技能与可执行引擎随应用打包，运行时数据被排除", () => {
  assert.ok(SKILL_LIBRARY.some((entry) => entry.id === "ai-news"));
  for (const file of [
    "news.py",
    "radar/workflow.py",
    "radar/storage.py",
    "references/official-news-sources.json",
    "LICENSE",
  ]) {
    const relative = `scripts/ai-news/${file}`;
    assert.ok(existsSync(path.join(root, relative)));
    assert.equal(shouldPackagePath(relative), true);
  }
  assert.equal(shouldPackagePath("data/ai-news/state.db"), false);
  assert.equal(shouldPackagePath("data/ai-news/reports/2026-08-25_digest.md"), false);
  const bridge = readFileSync(path.join(root, "src/core/ai-news.ts"), "utf8");
  assert.ok(!bridge.includes("shell: true"));
});

test("新闻入口真实运行 doctor，数据隔离且缺失解释器可恢复", async () => {
  const original = { data: process.env.RAPTOR_DATA_DIR, python: process.env.RAPTOR_AI_NEWS_PYTHON };
  const dir = mkdtempSync(path.join(os.tmpdir(), "raptor-news-bridge-"));
  process.env.RAPTOR_DATA_DIR = dir;
  try {
    process.env.RAPTOR_AI_NEWS_PYTHON = path.join(dir, "missing-python");
    const missing = await runAiNews("doctor", {});
    assert.equal(missing.status, "unavailable");
    assert.match(String(missing.error), /Python 3\.11/);
    if (interpreter) {
      process.env.RAPTOR_AI_NEWS_PYTHON = interpreter;
      assert.equal((await runAiNews("doctor", {})).status, "ok");
      const controller = new AbortController();
      controller.abort();
      assert.match(String((await runAiNews("prepare", {}, controller.signal)).error), /取消/);
      const historical = await runAiNews("prepare", { date: "2026-01-01" });
      assert.equal(historical.status, "failed");
      assert.match(String(historical.error), /历史日期/);
      assert.equal(existsSync(path.join(dir, "ai-news", "state.db")), false);
      const invalid = await runAiNews("query", { date: "../../secret" });
      assert.equal(invalid.status, "failed");
    }
  } finally {
    if (original.data === undefined) delete process.env.RAPTOR_DATA_DIR;
    else process.env.RAPTOR_DATA_DIR = original.data;
    if (original.python === undefined) delete process.env.RAPTOR_AI_NEWS_PYTHON;
    else process.env.RAPTOR_AI_NEWS_PYTHON = original.python;
  }
});

test("新闻工具限定操作与结构，不暴露任意命令参数", () => {
  assert.deepEqual(Object.keys(aiNewsTools).sort(), [
    "prepare_ai_news",
    "query_ai_news",
    "save_ai_news_digest",
  ]);
  const schema = aiNewsTools.query_ai_news.inputSchema as ZodObject<any>;
  assert.equal(schema.safeParse({ kind: "publish" }).success, false);
  assert.equal(schema.safeParse({ date: "../../secret" }).success, false);
  assert.equal(schema.safeParse({ days: 32 }).success, false);
  const save = aiNewsTools.save_ai_news_digest.inputSchema as ZodObject<any>;
  assert.equal(save.safeParse({ source_set_sha256: "invalid", entries: [] }).success, false);
});

test("Python 新闻回归：分页到冻结日报、证据校验、趋势和锁", { skip: !interpreter }, () => {
  const result = spawnSync(interpreter!, ["-B", path.join(root, "tests", "ai_news_test.py")], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
