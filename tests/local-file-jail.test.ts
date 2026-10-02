/**
 * RAPTOR_LOCAL_FILE_ROOT 文件读取边界测试（托管实例安全）
 *
 * 托管形态下同学的 agent 与网关账本/站点 Key 同机，read_local_file 若无
 * 边界可被诱导读取任意服务器文件。设置 RAPTOR_LOCAL_FILE_ROOT 后只放行
 * 该目录内的路径；本地完整版不设置此变量，任意路径行为不变。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-jail-data-"));
const tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-jail-out-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const insideFile = path.join(tmpData, "note.txt");
fs.writeFileSync(insideFile, "数据目录内的示例文件", "utf8");
const outsideFile = path.join(tmpOutside, "secret.txt");
fs.writeFileSync(outsideFile, "网关账本之类的敏感内容", "utf8");

const { assertWithinLocalFileRoot, openLocalFile } = await import("../src/core/attachments");

/** 文本类附件的正文（table 形态没有 text 字段，联合类型需收窄） */
function textOf(r: Awaited<ReturnType<typeof openLocalFile>>): string {
  return "text" in r ? String(r.text) : "";
}

test("未设置 RAPTOR_LOCAL_FILE_ROOT：任意路径照旧可读（本地版行为零改动）", async () => {
  delete process.env.RAPTOR_LOCAL_FILE_ROOT;
  const result = await openLocalFile(outsideFile);
  assert.match(textOf(result), /敏感内容/);
});

test("设置 RAPTOR_LOCAL_FILE_ROOT：目录外路径被拒，目录内照常", async () => {
  process.env.RAPTOR_LOCAL_FILE_ROOT = tmpData;
  await assert.rejects(() => openLocalFile(outsideFile), /只允许读取你的数据目录/);
  await assert.rejects(
    () => openLocalFile(path.join(tmpData, "..", path.basename(tmpOutside), "secret.txt")),
    /只允许读取你的数据目录/,
    "../ 拼接逃逸也要拦",
  );
  const ok = await openLocalFile(insideFile);
  assert.match(textOf(ok), /示例文件/);
});

test("assertWithinLocalFileRoot：符号链接逃逸跟随真实路径拦截", () => {
  const escapeLink = path.join(tmpData, "escape-link.txt");
  try {
    fs.symlinkSync(outsideFile, escapeLink);
  } catch (e) {
    // Windows 无开发者模式/管理员权限时建不了符号链接：本地跳过，
    // Linux CI 上正常执行（ realpath 拦截逻辑正是在那里生效）
    if ((e as NodeJS.ErrnoException).code === "EPERM") return;
    throw e;
  }
  try {
    assert.throws(() => assertWithinLocalFileRoot(escapeLink), /只允许读取你的数据目录/);
  } finally {
    fs.rmSync(escapeLink, { force: true });
  }
});
