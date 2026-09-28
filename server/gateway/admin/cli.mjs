#!/usr/bin/env node
/**
 * 多用户网关的管理命令（在部署机上执行，读写网关同一份注册表文件）。
 *
 *   node server/gateway/admin/cli.mjs invite [--count 5] [--note 班级群] [--days 14]
 *   node server/gateway/admin/cli.mjs list
 *   node server/gateway/admin/cli.mjs disable <用户名或ID>   # 停用：立即禁止登录
 *   node server/gateway/admin/cli.mjs enable <用户名或ID>
 *   node server/gateway/admin/cli.mjs reset-pass <用户名或ID> --password <新密码>
 *   node server/gateway/admin/cli.mjs kick <用户名或ID>      # 踢下线实例（经网关内部端点）
 *
 * 环境变量与 gateway.mjs 一致：GATEWAY_STATE_DIR（注册表位置）、
 * GATEWAY_URL + GATEWAY_SECRET（kick 用，默认 http://127.0.0.1:8080）。
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry } from "../registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const stateDir = process.env.GATEWAY_STATE_DIR || path.join(ROOT, "server", "gateway", "state");
const registry = createRegistry({ stateDir });

function usage(code = 1) {
  console.log(`用法：
  admin.mjs invite [--count N] [--note 备注] [--days 有效天数]
  admin.mjs list
  admin.mjs disable <用户名或ID>
  admin.mjs enable <用户名或ID>
  admin.mjs reset-pass <用户名或ID> --password <新密码>
  admin.mjs kick <用户名或ID>`);
  process.exit(code);
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function findUser(target) {
  if (!target) usage();
  const byId = await registry.findUserById(target);
  return byId ?? registry.findUserByName(target);
}

async function kickViaGateway(username) {
  const base = process.env.GATEWAY_URL || "http://127.0.0.1:8080";
  const secret = process.env.GATEWAY_SECRET;
  if (!secret) {
    console.error("kick 需要 GATEWAY_SECRET（与网关进程一致）");
    process.exit(1);
  }
  const result = await new Promise((resolve) => {
    const body = JSON.stringify({ user: username });
    const req = http.request(
      `${base}/internal/kick`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gateway-secret": secret,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch {
            resolve({ status: res.statusCode, data: {} });
          }
        });
      },
    );
    req.on("error", (error) => resolve({ status: 0, data: { error: error.message } }));
    req.end(body);
  });
  if (result.status !== 200) {
    console.error(`kick 失败（${result.status}）：${result.data.error ?? "未知错误"}`);
    process.exit(1);
  }
  console.log(`✅ 已踢下线：${result.data.kicked}`);
}

const [command, target] = process.argv.slice(2);

switch (command) {
  case "invite": {
    const count = Number(arg("count")) || 1;
    const note = arg("note") ?? "";
    const days = Number(arg("days")) || 0;
    const invites = await registry.createInvites({ count, note, expiresDays: days });
    console.log(`✅ 已生成 ${invites.length} 个邀请码${note ? `（${note}）` : ""}：`);
    for (const invite of invites) {
      const expiry = invite.expiresAt ? `，${invite.expiresAt.slice(0, 10)} 前有效` : "";
      console.log(`  ${invite.code}${expiry}`);
    }
    break;
  }
  case "list": {
    const users = await registry.listUsers();
    console.log(`用户（${users.length}）：`);
    for (const user of users) {
      const used = user.turns.count ? `，今日 ${user.turns.count} 轮` : "";
      console.log(
        `  ${user.disabled ? "⛔" : "✅"} ${user.username}  (${user.id})  注册于 ${user.createdAt.slice(0, 10)}${used}`,
      );
    }
    const invites = await registry.listInvites();
    const unused = invites.filter((i) => (i.usedBy?.length ?? 0) < (i.maxUses ?? 1));
    console.log(`\n未使用邀请码（${unused.length}）：`);
    for (const invite of unused) {
      const expiry = invite.expiresAt ? `，${invite.expiresAt.slice(0, 10)} 前有效` : "";
      console.log(`  ${invite.code}${invite.note ? `（${invite.note}）` : ""}${expiry}`);
    }
    break;
  }
  case "disable":
  case "enable": {
    const user = await findUser(target);
    if (!user) {
      console.error("用户不存在");
      process.exit(1);
    }
    await registry.setDisabled(user.id, command === "disable");
    console.log(`✅ 已${command === "disable" ? "停用" : "启用"}：${user.username}`);
    break;
  }
  case "reset-pass": {
    const user = await findUser(target);
    if (!user) {
      console.error("用户不存在");
      process.exit(1);
    }
    const password = arg("password");
    if (!password) usage();
    await registry.setPassword(user.id, password);
    console.log(`✅ 已重置密码：${user.username}`);
    break;
  }
  case "kick": {
    const user = await findUser(target);
    if (!user) {
      console.error("用户不存在");
      process.exit(1);
    }
    await kickViaGateway(user.username);
    break;
  }
  default:
    usage();
}
