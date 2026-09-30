import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createGatewayServer } = await import("../gateway/app.mjs");
const { createRegistry } = await import("../gateway/registry.mjs");
const totp = await import("../gateway/admin/totp.mjs");

/** 独立实现的 TOTP oracle：不经被测代码算出「此刻」的 6 位码（RFC 4226 截断） */
function codeAt(secretBase32: string, unixSec = Math.floor(Date.now() / 1000)): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secretBase32.replace(/[^A-Za-z2-7]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(Math.floor(unixSec / 30)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** 6).padStart(6, "0");
}

async function startBackend(t: { after: (fn: () => void) => void }) {
  const backend = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("backend-ok");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => backend.close());
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

function fakeSpawner(port: number) {
  const running = new Set<string>();
  return {
    async acquire(userId: string) {
      running.add(userId);
      return port;
    },
    noteActivity() {},
    kick(userId: string) {
      running.delete(userId);
    },
    async stopAll() {},
    runningCount() {
      return running.size;
    },
    isRunning(userId: string) {
      return running.has(userId);
    },
    listRunning() {
      return [...running].map((userId) => ({
        userId,
        port,
        startedAt: Date.now(),
        lastRequestAt: Date.now(),
        restarts: 0,
      }));
    },
    startReaper() {
      return () => {};
    },
  };
}

async function startGateway(t: { after: (fn: () => void) => void }, backendPort: number) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-totp-"));
  const registry = createRegistry({ stateDir });
  const server = createGatewayServer({
    registry,
    spawner: fakeSpawner(backendPort),
    secret: "unit-test-secret-0123456789",
    adminPassword: "admin-master-pw",
    maxConcurrent: 4,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, registry, stateDir };
}

async function adminLogin(
  base: string,
  password: string,
  code = "",
): Promise<{ status: number; cookie: string; text: string }> {
  const res = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, code }),
  });
  return {
    status: res.status,
    cookie: res.headers.get("set-cookie") ?? "",
    text: await res.text(),
  };
}

/** 登录 + 拿到已登录 Cookie；MFA 开启时自动补当前动态码 */
async function loginOk(base: string, secret?: string) {
  const result = await adminLogin(base, "admin-master-pw", secret ? codeAt(secret) : "");
  assert.equal(result.status, 200, `登录应成功：${result.text.slice(0, 200)}`);
  return result.cookie;
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

test("TOTP 纯函数：RFC 6238 标准向量 / 拒错 / 防重放 / 时钟漂移", () => {
  const secret = totp.base32Encode(Buffer.from("12345678901234567890"));
  // 附录 B（SHA1、8 位码 94287082 等）折算成 6 位 = 值 mod 10^6
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];
  for (const [unixSec, code] of vectors) {
    assert.equal(totp.verifyTotp(secret, code, { now: unixSec * 1000 }).ok, true, `${unixSec}`);
  }
  assert.equal(totp.verifyTotp(secret, "000000", { now: 59_000 }).ok, false, "错码拒绝");
  assert.equal(totp.verifyTotp(secret, "12345", { now: 59_000 }).ok, false, "位数不对拒绝");
  assert.equal(totp.verifyTotp(secret, "abcdef", { now: 59_000 }).ok, false, "非数字拒绝");

  // 防重放：命中的 counter 记水位后，同一枚码不再放行
  const hit = totp.verifyTotp(secret, "287082", { now: 59_000 });
  assert.equal(hit.ok, true);
  if (hit.ok) {
    const replay = totp.verifyTotp(secret, "287082", { now: 59_000, lastUsedCounter: hit.counter });
    assert.equal(replay.ok, false, "同码重放应拒绝");
  }
  // ±1 步（30 秒）时钟漂移仍可命中
  assert.equal(totp.verifyTotp(secret, "287082", { now: 59_000 + 29_000 }).ok, true);
  // ±2 步之外拒绝
  assert.equal(totp.verifyTotp(secret, "287082", { now: 59_000 + 90_000 }).ok, false);

  // base32 编解码互逆
  const raw = Buffer.from("courseraptor-admin-totp");
  assert.equal(totp.base32Decode(totp.base32Encode(raw)).toString(), raw.toString());

  // 密钥形态：32 位 base32
  assert.match(totp.generateTotpSecret(), /^[A-Z2-7]{32}$/);
  // otpauth URI 可被验证器识别
  assert.match(
    totp.otpauthUri({ secret }),
    /^otpauth:\/\/totp\/CourseRaptor:admin\?secret=[A-Z2-7]+&issuer=CourseRaptor&algorithm=SHA1&digits=6&period=30$/,
  );
});

test("恢复码：格式规整、归一化等价（大小写/连字符/空格）", () => {
  const codes = totp.generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, "恢复码不重复");
  for (const code of codes) {
    assert.match(code, /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/, "避开易混字符");
  }
  const [one] = codes;
  const variants = [
    one,
    one.toLowerCase(),
    one.replace("-", ""),
    one.toLowerCase().split("").join(" "),
  ];
  const hashes = new Set(variants.map((v) => totp.hashRecoveryCode(v)));
  assert.equal(hashes.size, 1, "各种输入形态应归一化到同一哈希");
  assert.notEqual(totp.hashRecoveryCode(one), totp.hashRecoveryCode(codes[1]));
});

test("registry：admin-totp.json 写 / 读 / 清", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-gw-totp-reg-"));
  const registry = createRegistry({ stateDir });
  assert.equal(await registry.getAdminTotp(), null, "缺文件视为未启用");
  const doc = {
    secret: "A".repeat(32),
    enabledAt: "2026-09-29T00:00:00Z",
    recovery: [totp.hashRecoveryCode("ABCDE-FGHJK")],
    lastUsedCounter: 3,
    sessionEpoch: 1,
  };
  await registry.setAdminTotp(doc);
  assert.deepEqual(await registry.getAdminTotp(), doc);
  await registry.clearAdminTotp();
  assert.equal(await registry.getAdminTotp(), null);
  await registry.clearAdminTotp();
  assert.equal(await registry.getAdminTotp(), null, "重复清理不报错");
  // 损坏的 JSON 也按未启用处理（读取失败回 null）
  fs.writeFileSync(path.join(stateDir, "admin-totp.json"), "{oops");
  assert.equal(await registry.getAdminTotp(), null);
});

test("MFA 全链路：扫码绑定→旧会话注销→密码+动态码登录→恢复码→关闭", async (t) => {
  const backendPort = await startBackend(t);
  const { base, registry } = await startGateway(t, backendPort);

  // 未启用：会话探测声明无需动态码，bootstrap 报 mfaEnabled=false
  const anonSession = (await (await fetch(`${base}/admin/api/session`)).json()) as {
    mfaRequired: boolean;
  };
  assert.equal(anonSession.mfaRequired, false);

  // 仅密码登录（MFA 关闭时行为与从前一致）
  const cookieA = await loginOk(base);
  const boot1 = (
    await json(await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie: cookieA } }))
  ).security as { mfaEnabled: boolean; recoveryLeft: number };
  assert.deepEqual(boot1, { mfaEnabled: false, enabledAt: "", recoveryLeft: 0 });

  // 生成绑定二维码：otpauth URI + SVG 二维码 + 手输密钥
  const setup = await json(
    await fetch(`${base}/admin/api/totp/setup`, {
      method: "POST",
      headers: { cookie: cookieA },
    }),
  );
  const secret = String(setup.secret ?? "");
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.ok(String(setup.uri ?? "").includes(secret), "URI 带密钥");
  assert.ok(String(setup.qrSvg ?? "").startsWith("<svg"), "返回 SVG 二维码");

  // 错码绑定被拒
  const badEnable = await fetch(`${base}/admin/api/totp/enable`, {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/json" },
    body: JSON.stringify({ code: "000000" }),
  });
  assert.equal(badEnable.status, 400);
  assert.match(((await badEnable.json()) as { error: string }).error, /动态码不正确/);

  // 正确动态码完成绑定，带回 10 枚恢复码（明文仅此一次）
  const enable = await fetch(`${base}/admin/api/totp/enable`, {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/json" },
    body: JSON.stringify({ code: codeAt(secret) }),
  });
  assert.equal(enable.status, 200);
  const { recoveryCodes } = (await enable.json()) as { recoveryCodes: string[] };
  assert.equal(recoveryCodes.length, 10);
  assert.ok(recoveryCodes.every((c) => /^[2-9A-HJKMNP-Z]{5}-/.test(c)));

  // 启用即注销全部旧会话（sessionEpoch 翻转）：启用用的 cookieA 立即失效
  assert.equal(
    (await fetch(`${base}/admin/api/overview`, { headers: { cookie: cookieA } })).status,
    401,
  );

  // 会话探测声明需要动态码；少码 / 错码都进不去
  const sessionInfo = (await (await fetch(`${base}/admin/api/session`)).json()) as {
    mfaRequired: boolean;
  };
  assert.equal(sessionInfo.mfaRequired, true, "SPA 登录页应据 session 接口显示动态码输入框");
  assert.equal((await adminLogin(base, "admin-master-pw")).status, 401, "缺动态码拒绝");
  assert.equal((await adminLogin(base, "admin-master-pw", "000000")).status, 401, "错码拒绝");

  // 密码 + 当前动态码：进入（绑定那枚码在首登窗口内仍可用——防重放自首登起收紧）
  const firstCode = codeAt(secret);
  const login2 = await adminLogin(base, "admin-master-pw", firstCode);
  assert.equal(login2.status, 200);
  const cookieB = login2.cookie;
  const boot2 = (
    await json(await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie: cookieB } }))
  ).security as { mfaEnabled: boolean; enabledAt: string; recoveryLeft: number };
  assert.equal(boot2.mfaEnabled, true);
  assert.equal(boot2.recoveryLeft, 10);

  // 同一枚码立即重放：被防重放水位拦下（提示「刚用过」而非「不正确」）
  const replay = await adminLogin(base, "admin-master-pw", firstCode);
  assert.equal(replay.status, 401, "同码重放应拒绝");
  assert.match(replay.text, /刚用过/);

  // 恢复码可替代动态码登录：小写 + 去连字符也应命中（归一化）；用后即焚
  const lower = recoveryCodes[0].toLowerCase().replace("-", "");
  const viaRecovery = await adminLogin(base, "admin-master-pw", lower);
  assert.equal(viaRecovery.status, 200);
  const cookieC = viaRecovery.cookie;
  const boot3 = (
    await json(await fetch(`${base}/admin/api/bootstrap`, { headers: { cookie: cookieC } }))
  ).security as { recoveryLeft: number };
  assert.equal(boot3.recoveryLeft, 9, "消耗一枚");
  assert.equal((await adminLogin(base, "admin-master-pw", lower)).status, 401, "恢复码一次性");

  // 关闭两步验证必须再验动态码：错码 401；正确码关闭成功
  const badDisable = await fetch(`${base}/admin/api/totp/disable`, {
    method: "POST",
    headers: { cookie: cookieC, "content-type": "application/json" },
    body: JSON.stringify({ code: "000000" }),
  });
  assert.equal(badDisable.status, 401);
  // 水位拨回两个窗口前，避免「登录刚用过的码」被防重放误伤（水位本身已单测）
  const docNow = await registry.getAdminTotp();
  assert.ok(docNow, "启用后应有 admin-totp.json");
  await registry.setAdminTotp({
    ...docNow,
    lastUsedCounter: Math.floor(Date.now() / 1000 / 30) - 2,
  });
  const disable = await fetch(`${base}/admin/api/totp/disable`, {
    method: "POST",
    headers: { cookie: cookieC, "content-type": "application/json" },
    body: JSON.stringify({ code: codeAt(secret) }),
  });
  assert.equal(disable.status, 200);

  // 关闭后回到仅密码登录（多余的 code 字段被忽略；恢复码随 MFA 一同退役）
  const afterOff = await (await fetch(`${base}/admin`)).text();
  assert.doesNotMatch(afterOff, /动态码/);
  await loginOk(base);
});

test("MFA 登录：错码五次同样触发防爆破锁定", async (t) => {
  const backendPort = await startBackend(t);
  const { base } = await startGateway(t, backendPort);
  const cookie = await loginOk(base);
  const setup = await json(
    await fetch(`${base}/admin/api/totp/setup`, { method: "POST", headers: { cookie } }),
  );
  const enable = await fetch(`${base}/admin/api/totp/enable`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: codeAt(String(setup.secret)) }),
  });
  assert.equal(enable.status, 200);

  for (let i = 0; i < 5; i++) {
    assert.equal((await adminLogin(base, "admin-master-pw", "000000")).status, 401);
  }
  // 第 5 次失败即锁：随后密码+正确动态码也 429
  const locked = await adminLogin(base, "admin-master-pw", codeAt(String(setup.secret)));
  assert.equal(locked.status, 429);
  assert.match(locked.text, /尝试次数过多/);
});

test("MFA 恢复码重生成：需验码、旧码全作废、新码可用", async (t) => {
  const backendPort = await startBackend(t);
  const { base, registry } = await startGateway(t, backendPort);
  const cookie = await loginOk(base);
  const setup = await json(
    await fetch(`${base}/admin/api/totp/setup`, { method: "POST", headers: { cookie } }),
  );
  const secret = String(setup.secret);
  const { recoveryCodes: firstSet } = (await json(
    await fetch(`${base}/admin/api/totp/enable`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: codeAt(secret) }),
    }),
  )) as { recoveryCodes: string[] };

  // 启用即注销旧会话：重新拿会话（消耗当前码、推进水位）
  const cookie2 = await loginOk(base, secret);

  // 未验码不给重生成
  assert.equal(
    (
      await fetch(`${base}/admin/api/totp/recovery`, {
        method: "POST",
        headers: { cookie: cookie2, "content-type": "application/json" },
        body: JSON.stringify({ code: "000000" }),
      })
    ).status,
    401,
  );
  // 水位拨回两个窗口前，避免「登录刚用过的码」被防重放误伤（水位本身已单测）
  const docNow = await registry.getAdminTotp();
  assert.ok(docNow);
  await registry.setAdminTotp({
    ...docNow,
    lastUsedCounter: Math.floor(Date.now() / 1000 / 30) - 2,
  });
  // 验动态码重生成：拿到新一套
  const regen = await fetch(`${base}/admin/api/totp/recovery`, {
    method: "POST",
    headers: { cookie: cookie2, "content-type": "application/json" },
    body: JSON.stringify({ code: codeAt(secret) }),
  });
  assert.equal(regen.status, 200);
  const { recoveryCodes: secondSet } = (await regen.json()) as { recoveryCodes: string[] };
  assert.equal(secondSet.length, 10);

  // 旧恢复码全部作废，新恢复码可用
  assert.equal((await adminLogin(base, "admin-master-pw", firstSet[0])).status, 401);
  assert.equal((await adminLogin(base, "admin-master-pw", secondSet[0])).status, 200);
});
