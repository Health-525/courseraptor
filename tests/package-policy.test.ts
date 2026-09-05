import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { shouldPackagePath } from "../scripts/package-policy.mjs";
import { isProtected } from "../src/updater";

test("安装包过滤在真实目录复制时不带出会话、文件、凭证或临时截图", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "raptor-package-"));
  const source = path.join(dir, "source");
  const target = path.join(dir, "stage");
  const privateFiles = [
    ".env",
    ".env.backup",
    "credentials.enc",
    "session.json",
    "memory.json",
    "qq-allowlist.json",
    "data/chat-sessions.json",
    "data/attachments/index.json",
    "data/generated/report.pdf",
    "data/term-dates.json",
    "outputs/private.png",
    "downloads/private.xlsx",
    "qq-bridge.log",
    "docs/screenshot-web.png",
    "src/debug.log",
    "unknown-personal-file.txt",
  ];
  const publicFiles = [
    "src/index.ts",
    "scripts/doctor.mjs",
    "docs/student-guide.md",
    "docs/courseraptor-logo.png",
    "package-lock.json",
    ".env.example",
  ];
  for (const file of [...privateFiles, ...publicFiles]) {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), "synthetic fixture");
  }
  cpSync(source, target, {
    recursive: true,
    filter: (file) => shouldPackagePath(path.relative(source, file)),
  });
  for (const file of privateFiles) assert.equal(existsSync(path.join(target, file)), false, file);
  for (const file of publicFiles) assert.equal(existsSync(path.join(target, file)), true, file);
});

test("更新保护全部本地数据，同时允许应用源码更新", () => {
  for (const file of [
    "data",
    "data/chat-sessions.json",
    "data/attachments/a.xlsx",
    "data/generated/report.pdf",
    "data/term-dates.json",
    "data\\chat-sessions.json",
    "outputs/a.png",
    "credentials.enc",
  ]) {
    assert.equal(isProtected(file), true, file);
  }
  assert.equal(isProtected("src/index.ts"), false);
  assert.equal(isProtected("src/jwgl/term-dates.ts"), false);
});
