/**
 * 多用户网关的用户注册表与邀请码（JSON 落盘，无数据库依赖）。
 *
 * 文件布局（stateDir 下）：
 * - users.json   用户表：id、用户名、scrypt 密码散列（独立盐）、启停状态、当日用量
 * - invites.json 邀请码表：一次性（maxUses 默认 1），可设过期天数
 *
 * 写入走原子替换（tmp + rename），全部变更经模块内 Promise 链串行化，
 * 与项目其他落盘（credentials.enc / update-data）的约定一致。
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const USERNAME_RE = /^[A-Za-z0-9_-]{2,32}$/;
const MIN_PASSWORD_LEN = 8;

/** scrypt 参数与 src/core/credentials.ts 同族：N=16384、keylen=64 */
function hashPassword(password, salt = randomBytes(16)) {
  const hash = scryptSync(password, salt, 64);
  return { salt: salt.toString("base64"), hash: hash.toString("base64") };
}

function verifyPassword(stored, password) {
  try {
    const salt = Buffer.from(stored.salt, "base64");
    const expected = Buffer.from(stored.hash, "base64");
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function createRegistry({ stateDir }) {
  if (!stateDir) throw new Error("createRegistry 需要 stateDir");
  mkdirSync(stateDir, { recursive: true });
  const usersFile = path.join(stateDir, "users.json");
  const invitesFile = path.join(stateDir, "invites.json");

  // 串行化所有读-改-写，避免并发注册互相覆盖
  let chain = Promise.resolve();
  const serialized = (task) => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };

  async function writeAtomic(file, content) {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, content);
    await rename(temp, file);
  }

  const readUsers = () => readJson(usersFile, { users: [] });
  const writeUsers = (users) => writeAtomic(usersFile, JSON.stringify({ users }, null, 2));
  const readInvites = () => readJson(invitesFile, { invites: [] });
  const writeInvites = (invites) =>
    writeAtomic(invitesFile, JSON.stringify({ invites }, null, 2));

  const registry = {
    /** 明文密码只在散列前短暂存在，永不落盘 */
    async createUser({ username, password }) {
      return serialized(async () => {
        if (!USERNAME_RE.test(username ?? "")) {
          throw new Error("用户名需 2-32 位字母 / 数字 / _ / -");
        }
        if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
          throw new Error(`密码至少 ${MIN_PASSWORD_LEN} 位`);
        }
        const users = (await readUsers()).users;
        if (users.some((u) => u.username === username)) {
          throw new Error("用户名已被使用");
        }
        const user = {
          id: `u_${randomBytes(6).toString("hex")}`,
          username,
          pass: hashPassword(password),
          disabled: false,
          createdAt: new Date().toISOString(),
          turns: { date: "", count: 0 },
        };
        users.push(user);
        await writeUsers(users);
        return { id: user.id, username: user.username };
      });
    },

    async findUserByName(username) {
      const users = (await readUsers()).users;
      return users.find((u) => u.username === username) ?? null;
    },

    async findUserById(id) {
      const users = (await readUsers()).users;
      return users.find((u) => u.id === id) ?? null;
    },

    async authenticate(username, password) {
      const user = await this.findUserByName(String(username ?? ""));
      // 用户不存在与密码错误返回同一种失败，避免探测已注册用户名
      if (!user || !verifyPassword(user.pass, String(password ?? ""))) return null;
      if (user.disabled) return { user: null, disabled: true };
      return { user, disabled: false };
    },

    async setPassword(id, newPassword) {
      return serialized(async () => {
        const users = (await readUsers()).users;
        const user = users.find((u) => u.id === id);
        if (!user) throw new Error("用户不存在");
        if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LEN) {
          throw new Error(`密码至少 ${MIN_PASSWORD_LEN} 位`);
        }
        user.pass = hashPassword(newPassword);
        await writeUsers(users);
      });
    },

    async setDisabled(id, disabled) {
      return serialized(async () => {
        const users = (await readUsers()).users;
        const user = users.find((u) => u.id === id);
        if (!user) throw new Error("用户不存在");
        user.disabled = Boolean(disabled);
        await writeUsers(users);
      });
    },

    /** 当日对话轮数计数：跨网关重启保留，按本地日期自动清零 */
    async addTurns(id, count = 1) {
      return serialized(async () => {
        const users = (await readUsers()).users;
        const user = users.find((u) => u.id === id);
        if (!user) return 0;
        const today = new Date().toISOString().slice(0, 10);
        if (user.turns?.date !== today) user.turns = { date: today, count: 0 };
        user.turns.count += count;
        await writeUsers(users);
        return user.turns.count;
      });
    },

    async turnsToday(id) {
      const user = await this.findUserById(id);
      if (!user) return 0;
      const today = new Date().toISOString().slice(0, 10);
      return user.turns?.date === today ? user.turns.count : 0;
    },

    async listUsers() {
      return (await readUsers()).users.map((u) => ({
        id: u.id,
        username: u.username,
        disabled: Boolean(u.disabled),
        createdAt: u.createdAt,
        turns: u.turns ?? { date: "", count: 0 },
      }));
    },

    // ── 邀请码 ──────────────────────────────────────────────

    async createInvites({ count = 1, note = "", expiresDays = 0 } = {}) {
      return serialized(async () => {
        const invites = (await readInvites()).invites;
        const created = [];
        for (let i = 0; i < Math.max(1, Math.min(count, 100)); i++) {
          const invite = {
            code: randomBytes(8).toString("hex"),
            note: String(note).slice(0, 100),
            maxUses: 1,
            usedBy: [],
            expiresAt:
              expiresDays !== 0
                ? new Date(Date.now() + expiresDays * 86_400_000).toISOString()
                : "",
          };
          invites.push(invite);
          created.push(invite);
        }
        await writeInvites(invites);
        return created;
      });
    },

    /** 一次性消费：校验并占用，成功返回 true（注册流程紧接着建号） */
    async consumeInvite(code) {
      return serialized(async () => {
        const invites = (await readInvites()).invites;
        const invite = invites.find((i) => i.code === String(code ?? "").trim());
        if (!invite) return false;
        if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return false;
        if ((invite.usedBy?.length ?? 0) >= (invite.maxUses ?? 1)) return false;
        // usedBy 留空占位：真正的用户名由紧随其后的 createUser 补记
        invite.usedBy = [...(invite.usedBy ?? []), `pending-${Date.now()}`];
        await writeInvites(invites);
        return true;
      });
    },

    /** 注册完成后把占位换成实际用户名（失败不影响注册结果） */
    async markInviteUsed(code, username) {
      return serialized(async () => {
        const invites = (await readInvites()).invites;
        const invite = invites.find((i) => i.code === String(code ?? "").trim());
        if (!invite) return;
        const index = invite.usedBy.findIndex((u) => String(u).startsWith("pending-"));
        if (index >= 0) invite.usedBy[index] = username;
        await writeInvites(invites);
      });
    },

    async listInvites() {
      return (await readInvites()).invites;
    },
  };

  return registry;
}
