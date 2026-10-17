/**
 * 便携 zip 条目校验（scripts/lib/zip-lint.mjs）测试。
 *
 * 起因：2026-10-17 CI Release 连败两版——TEMP 是 8.3 短名时 zip 打包偏移错位，
 * 病包（双斜杠/半截名）都能通过仅凭 startsWith 的前缀检查。
 *
 * 名字判定走纯函数 lintEntryNames 直喂条目名（JSZip 生成 fixture 时会把 `//`
 * 折叠，真实病包造不出来，恰好说明必须测纯函数层）；文件层只测一个正常包
 * 与坏文件抛错。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const JSZip = (await import("jszip")).default;
const { lintEntryNames, lintPortableZip, PORTABLE_TOP_DIR } = await import(
  "../scripts/lib/zip-lint.mjs"
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-zip-lint-"));

/** 关键文件齐全的正常包条目集 */
const healthyEntries = [
  `${PORTABLE_TOP_DIR}/start.bat`,
  `${PORTABLE_TOP_DIR}/runtime/node.exe`,
  `${PORTABLE_TOP_DIR}/runtime/npm.cmd`,
  `${PORTABLE_TOP_DIR}/runtime/node_modules/npm/package.json`,
  `${PORTABLE_TOP_DIR}/app/bin/raptor.cjs`,
  `${PORTABLE_TOP_DIR}/app/scripts/doctor.mjs`,
  `${PORTABLE_TOP_DIR}/app/local/host/headless.ts`,
];

test("正常包条目名：前缀恰好一层、关键文件齐全，通过并统计", () => {
  const r = lintEntryNames(healthyEntries);
  assert.equal(r.ok, true);
  assert.equal(r.count, healthyEntries.length);
  assert.equal(r.maxRel, "runtime/node_modules/npm/package.json".length);
  assert.deepEqual(r.errors, []);
});

test("双斜杠条目（短路径差 1 字符的真实形态）：拒绝", () => {
  const dbl = healthyEntries.map((n) => n.replace(`${PORTABLE_TOP_DIR}/`, `${PORTABLE_TOP_DIR}//`));
  const r = lintEntryNames(dbl);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e: string) => e.includes("双斜杠")));
});

test("半截名条目（runner 差 3 字符的真实形态）：靠关键文件缺失拒绝", () => {
  // 条目都以合法前缀开头，但目录名被吃掉半截 —— 仅凭前缀检查放行过
  const shifted = healthyEntries.map((n) =>
    n
      .replace(`${PORTABLE_TOP_DIR}/runtime/`, `${PORTABLE_TOP_DIR}/ptor/runtime/`)
      .replace(`${PORTABLE_TOP_DIR}/app/`, `${PORTABLE_TOP_DIR}/pp/app/`),
  );
  const r = lintEntryNames(shifted);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e: string) => e.includes("runtime/node.exe")));
  assert.ok(r.errors.some((e: string) => e.includes("app/bin/raptor.cjs")));
});

test("顶层目录之外的条目：拒绝", () => {
  const r = lintEntryNames([...healthyEntries, "LooseFile.txt"]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e: string) => e.includes("LooseFile.txt")));
});

test("相对路径超 MAX_REL 护栏：拒绝", () => {
  const deep = `${PORTABLE_TOP_DIR}/${`a/`.repeat(80)}deep.txt`;
  const r = lintEntryNames([...healthyEntries, deep]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e: string) => e.includes("护栏")));
});

test("文件层：正常 zip 读回条目校验通过", async () => {
  const zip = new JSZip();
  for (const entry of healthyEntries) zip.file(entry, "x");
  const file = path.join(tmpDir, "healthy.zip");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  const r = await lintPortableZip(file);
  assert.equal(r.ok, true);
  assert.equal(r.count, healthyEntries.length);
});

test("文件层：坏 zip 抛错由调用方处理（lint 不吞异常）", async () => {
  const file = path.join(tmpDir, "broken.zip");
  fs.writeFileSync(file, "not a zip");
  await assert.rejects(() => lintPortableZip(file));
});
