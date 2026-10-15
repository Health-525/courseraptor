import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeFileAtomicSync } from "../src/core/atomic-write";
import { isInsideDir } from "../src/core/paths";

test("Windows中文/空格路径: 原子写往返", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-"));
  const target = path.join(root, "带 空格 目录", "姜书 数据.json");
  writeFileAtomicSync(target, JSON.stringify({ ok: 1 }));
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).ok, 1);
  assert.equal(
    fs.readdirSync(root).some((f) => f.endsWith(".tmp")),
    false,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("isInsideDir: 中文路径越界护栏", () => {
  const root = path.join(os.tmpdir(), "姜 书 raptor");
  assert.ok(isInsideDir(root, path.join(root, "data", "a.json")));
  assert.ok(!isInsideDir(root, path.join(root, "..", "evil.json")));
});
