import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 真实拉起一个 headless 实例（node + tsx + gateway/headless/entry.ts），验证：
 * 就绪端口上报、页面可访问、数据目录隔离、并发上限、kick 回收。
 * 这是网关链路里最关键的一环，代价是本测试比单元测试慢（约 10-20 秒）。
 */
const { createSpawner } = await import("../gateway/spawner.mjs");

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("spawner：拉起真实 headless 实例并隔离数据目录", async (t) => {
  const usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-spawn-"));
  const spawner = createSpawner({
    projectRoot: PROJECT_ROOT,
    usersDir,
    maxConcurrent: 2,
    idleMinutes: 30,
    reapIntervalMs: 3_600_000,
  });
  t.after(() => void spawner.stopAll());

  const port = await spawner.acquire("u_smoke1");
  assert.ok(Number.isInteger(port) && port > 0, `应拿到实际监听端口，got ${port}`);

  // headless 入口自带 keepalive：就绪后进程必须持续存活，否则网关形同虚设
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.ok(html.length > 500, "对话页应是完整 HTML");

  // 同一用户再次 acquire 复用实例；第二个用户各起各的
  assert.equal(await spawner.acquire("u_smoke1"), port, "同用户应复用同一实例");
  const port2 = await spawner.acquire("u_smoke2");
  assert.notEqual(port2, port, "不同用户必须是不同实例");

  // 并发上限：第三个实例被拒
  await assert.rejects(
    () => spawner.acquire("u_smoke3"),
    (error: Error & { code?: string }) => error.code === "ECONCURRENCY",
  );

  // 数据目录按用户隔离创建
  assert.ok(fs.existsSync(path.join(usersDir, "u_smoke1", "data")));
  assert.ok(fs.existsSync(path.join(usersDir, "u_smoke2", "data")));

  // kick 后实例退出，再次请求会重新拉起（这里只验证踢出后的簿记）
  spawner.kick("u_smoke1");
  assert.equal(spawner.runningCount(), 1);
});

test("spawner：同用户并发 acquire 共享同一次拉起（无 null 端口、无孤儿双实例）", async (t) => {
  // 回归背景：冷启动窗口（最长 30s）里 acquire 曾直接返回 null 端口，
  // 代理会打到 127.0.0.1:80；且检查-拉起之间的异步间隙会产生双实例孤儿
  const usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-race-"));
  const spawner = createSpawner({
    projectRoot: PROJECT_ROOT,
    usersDir,
    maxConcurrent: 2,
    reapIntervalMs: 3_600_000,
  });
  t.after(() => void spawner.stopAll());

  const [p1, p2, p3] = await Promise.all([
    spawner.acquire("u_race"),
    spawner.acquire("u_race"),
    spawner.acquire("u_race"),
  ]);
  assert.ok(
    Number.isInteger(p1) && p1 > 0 && p1 === p2 && p2 === p3,
    `并发 acquire 必须等到同一实例的真实端口：${p1}/${p2}/${p3}`,
  );
  assert.equal(spawner.runningCount(), 1, "并发不得拉出第二个实例");

  // 冷启动期间的请求也应能拿到端口（等 ready 而不是 null）
  const again = await spawner.acquire("u_race");
  assert.equal(again, p1, "已就绪实例直接复用端口");
});
