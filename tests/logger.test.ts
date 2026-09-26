/**
 * core 文件日志契约（core/logger）：
 * 行格式与 qq-bridge.log 一致、级别过滤、轮转（超阈值换 .old 只留一代）、
 * 惰性建文件（import 不落盘）、磁盘故障静默放弃不崩主流程。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFileLogger } from "../src/core/logger";

function tmpLog(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "raptor-log-")), name);
}

test("行格式：[ISO] [级别] 消息 {JSON meta}，与 qq-bridge.log 同构", async () => {
  const file = tmpLog("format.log");
  const log = createFileLogger(file);
  log.warn("直连失败", { error: "timeout" });
  await log.close();
  const line = fs.readFileSync(file, "utf8").trim();
  assert.match(line, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[warn\] 直连失败 \{"error":"timeout"\}$/);
});

test("级别过滤：minLevel=info 时 debug 不落盘", async () => {
  const file = tmpLog("level.log");
  const log = createFileLogger(file, { minLevel: "info" });
  log.debug("不该出现");
  log.error("该出现");
  await log.close();
  const content = fs.readFileSync(file, "utf8");
  assert.ok(!content.includes("不该出现"));
  assert.ok(content.includes("该出现"));
});

test("惰性建文件：仅 createFileLogger 不写盘，首次写入才创建", () => {
  const file = tmpLog("lazy.log");
  createFileLogger(file);
  assert.equal(fs.existsSync(file), false, "未写入不应创建文件");
});

test("轮转：超过 maxBytes 换 .old，只留一代", async () => {
  const file = tmpLog("rotate.log");
  const log = createFileLogger(file, { maxBytes: 120 });
  const long = "x".repeat(80);
  log.info(long); // ~100 字节
  log.info(long); // 累计超 120 → 轮转后重开
  log.info("轮转后的新行");
  await log.close();
  assert.ok(fs.existsSync(`${file}.old`), "旧内容应轮转到 .old");
  const fresh = fs.readFileSync(file, "utf8");
  assert.ok(fresh.endsWith("轮转后的新行\n"), "轮转后新文件从空开始");
  assert.ok(!fresh.includes(long), "轮转前的大块内容不留在新文件");
});

test("close 幂等，未写盘时 close 也不报错", async () => {
  const file = tmpLog("close.log");
  const log = createFileLogger(file);
  await log.close();
  await log.close();
  assert.equal(fs.existsSync(file), false);
});
