import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createRegistry } = await import("../gateway/registry.mjs");

function makeRegistry() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-reg-"));
  return { registry: createRegistry({ stateDir }), stateDir };
}

test("注册表：建号、校验密码、拒绝重名与非法输入", async () => {
  const { registry } = makeRegistry();
  const user = await registry.createUser({ username: "student01", password: "password123" });
  assert.match(user.id, /^u_[0-9a-f]{12}$/);

  const ok = await registry.authenticate("student01", "password123");
  assert.ok(ok && ok.user && !ok.disabled);

  const bad = await registry.authenticate("student01", "wrong-password");
  assert.equal(bad, null);
  // 不存在的用户与密码错误返回同一种结果，避免探测用户名
  const missing = await registry.authenticate("nobody", "wrong-password");
  assert.equal(missing, null);

  await assert.rejects(
    () => registry.createUser({ username: "student01", password: "password456" }),
    /已被使用/,
  );
  await assert.rejects(
    () => registry.createUser({ username: "x", password: "password123" }),
    /用户名/,
  );
  await assert.rejects(
    () => registry.createUser({ username: "student02", password: "short" }),
    /密码/,
  );
});

test("注册表：停用后立即拒绝认证，启用后恢复", async () => {
  const { registry } = makeRegistry();
  const user = await registry.createUser({ username: "student01", password: "password123" });
  await registry.setDisabled(user.id, true);
  const blocked = await registry.authenticate("student01", "password123");
  assert.ok(blocked && blocked.disabled && !blocked.user);

  await registry.setDisabled(user.id, false);
  const restored = await registry.authenticate("student01", "password123");
  assert.ok(restored && restored.user);
});

test("注册表：重置密码后旧密码失效", async () => {
  const { registry } = makeRegistry();
  const user = await registry.createUser({ username: "student01", password: "password123" });
  await registry.setPassword(user.id, "newpassword456");
  assert.equal(await registry.authenticate("student01", "password123"), null);
  const ok = await registry.authenticate("student01", "newpassword456");
  assert.ok(ok && ok.user);
});

test("邀请码：一次性消费，无效/过期/已用都拒绝", async () => {
  const { registry } = makeRegistry();
  const [invite] = await registry.createInvites({ count: 1, note: "测试" });
  assert.equal(invite.maxUses, 1);
  assert.equal(await registry.consumeInvite("does-not-exist"), false);
  assert.equal(await registry.consumeInvite(invite.code), true);
  assert.equal(await registry.consumeInvite(invite.code), false, "第二次消费应失败");

  const [expiring] = await registry.createInvites({ count: 1, expiresDays: -1 });
  assert.equal(await registry.consumeInvite(expiring.code), false, "过期邀请码应拒绝");
});

test("邀请码：建号失败后释放占位，码退回可再次消费", async () => {
  const { registry } = makeRegistry();
  const [invite] = await registry.createInvites({ count: 1, note: "班级群" });
  assert.equal(await registry.consumeInvite(invite.code), true);

  // 模拟注册中途失败（用户名被占等）：释放后不留 pending 占位
  await registry.releaseInvite(invite.code);
  assert.deepEqual((await registry.listInvites())[0].usedBy, []);
  assert.equal(await registry.consumeInvite(invite.code), true, "释放后应能再次消费");

  // 正常闭环：占位回填为真实用户名，绑定关系落盘
  await registry.markInviteUsed(invite.code, "student01");
  assert.deepEqual((await registry.listInvites())[0].usedBy, ["student01"]);
});

test("当日用量：累加并按日期自动清零", async () => {
  const { registry, stateDir } = makeRegistry();
  const user = await registry.createUser({ username: "student01", password: "password123" });
  assert.equal(await registry.addTurns(user.id, 3), 3);
  assert.equal(await registry.turnsToday(user.id), 3);
  assert.equal(await registry.addTurns(user.id, 2), 5);

  // 把记录改成旧日期，模拟跨天后的读取
  const usersFile = path.join(stateDir, "users.json");
  const raw = JSON.parse(fs.readFileSync(usersFile, "utf8"));
  raw.users[0].turns = { date: "2000-01-01", count: 99 };
  fs.writeFileSync(usersFile, JSON.stringify(raw));
  assert.equal(await registry.turnsToday(user.id), 0, "旧日期计数应视为清零");
  assert.equal(await registry.addTurns(user.id, 1), 1);
});
