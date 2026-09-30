/**
 * 管理台构建产物静态校验（admin/dist 随仓库提交，服务器 git pull 即用）：
 * - index.html 存在且是中文 SPA 入口
 * - 引用的每个构建产物都在 dist 里（忘跑 build 或漏提交会在这里红）
 * - 不再残留旧版（admin-app.js / Tabler）引用
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "admin", "dist");

test("管理台 dist：index.html 存在且为中文 SPA 入口", () => {
  const indexHtml = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
  assert.match(indexHtml, /<div id="root">/);
  assert.match(indexHtml, /管理后台 · CourseRaptor/);
});

test("管理台 dist：index.html 引用的资产全部在盘", () => {
  const indexHtml = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
  const refs = [...indexHtml.matchAll(/(?:src|href)="(\/admin\/assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, `应至少引用 js 与 css（实际 ${refs.length} 个）`);
  for (const ref of refs) {
    const rel = ref.replace("/admin/", "");
    assert.ok(
      fs.existsSync(path.join(distRoot, rel)),
      `index.html 引用的 ${ref} 不存在于 admin/dist（改前端后需重新 npm run build 并提交）`,
    );
  }
});

test("管理台 dist：不残留旧版（admin-app.js / Tabler）引用", () => {
  const indexHtml = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
  assert.doesNotMatch(indexHtml, /admin-app\.js/);
  assert.doesNotMatch(indexHtml, /tabler/);
});
