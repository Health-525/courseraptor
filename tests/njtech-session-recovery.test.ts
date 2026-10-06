/**
 * 会话失效自动恢复 + 教务查询错误可见性测试（njtech/session + portal）
 *
 * 钉住三类真实回归：
 * 1. portal 查询曾把断网/会话失效吞成「空列表」——故障被翻译成正常态，
 *    同学说「暂无已选课程」其实是没连上（fetchEnrolledClasses）。
 * 2. 死 cookie 熬满 25 分钟 TTL：fetch 层识别登录页抛 SESSION_EXPIRED，
 *    session.withAuthRetry 换新 cookie 自动重登一次。
 * 3. 一轮对话里模型并行调多个教务工具时并发 getCookie 只登录一次
 *    （此前每次都真实登录，且只留最后一个 cookie，前面的会话白白作废）。
 * https.request 用进程内 mock 替身（同 jwgl-http.test.ts），不联网。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-sess-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");
process.env.JWGL_USERNAME = "20230101";
process.env.JWGL_PASSWORD = "test-password";

const { setRateLimit } = await import("../src/core/http");
const { RaptorError, isRaptorError } = await import("../src/core/errors");
const { fetchEnrolledClasses } = await import("../src/adapters/njtech/portal");
const { getCookie, invalidateAuthCache, withAuthRetry } = await import(
  "../src/adapters/njtech/session"
);
const { loginJwgl } = await import("../src/adapters/njtech/auth");

// ── mock：https.request 进程内替身（借 jwgl-http.test.ts 的模式）──────

interface MockSpec {
  status: number;
  headers?: Record<string, string | string[] | undefined>;
  chunks?: Buffer[];
  networkError?: string;
}

const httpsMod = https as unknown as { request: unknown };

function installMock(respond: () => MockSpec | undefined) {
  const original = httpsMod.request;
  const seen: Array<{ method?: string; path?: string }> = [];
  httpsMod.request = ((opts: Record<string, unknown>, cb: (res: EventEmitter) => void) => {
    seen.push({ method: opts.method as string, path: opts.path as string });
    const spec = respond();
    const res = new EventEmitter();
    Object.assign(res, { statusCode: spec?.status ?? 200, headers: spec?.headers ?? {} });
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: (ms: number, fn: () => void) => void;
      write: (b: string) => void;
      end: () => void;
    };
    req.setTimeout = () => {};
    req.write = () => {};
    req.end = () => {
      queueMicrotask(() => {
        if (spec?.networkError) {
          req.emit("error", new Error(spec.networkError));
          return;
        }
        for (const c of spec?.chunks ?? [Buffer.from("")]) res.emit("data", c);
        res.emit("end");
      });
    };
    cb(res);
    return req;
  }) as unknown;
  return {
    restore: () => {
      httpsMod.request = original;
    },
    seen,
  };
}

// 节流是进程级共享状态：每个用例前把桶恢复到宽裕档
const looseRate = () => setRateLimit(10_000, 10_000);

// ── 登录时序替身：页面 → RSA 公钥 → 登录成功，3 个请求一组 ─────────

const keyPair = (() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return {
    modulusB64: Buffer.from(jwk.n, "base64url").toString("base64"),
    exponentB64: Buffer.from(jwk.e, "base64url").toString("base64"),
    privateKey: privateKey.export({ type: "pkcs1", format: "pem" }) as string,
  };
})();

/** 登录页 HTML（含 isSessionExpired 认的 csrftoken 标记） */
const LOGIN_PAGE_HTML = (token: string) =>
  Buffer.from(`<html><input id="csrftoken" value="${token}"></html>`);

/** 一次完整登录的 3 个响应；每组带独立 JSESSIONID */
function loginQueue(sessionId: string): MockSpec[] {
  return [
    {
      status: 200,
      headers: { "set-cookie": [`JSESSIONID=${sessionId}; Path=/`] },
      chunks: [LOGIN_PAGE_HTML(`tok-${sessionId}`)],
    },
    {
      status: 200,
      chunks: [
        Buffer.from(JSON.stringify({ modulus: keyPair.modulusB64, exponent: keyPair.exponentB64 })),
      ],
    },
    { status: 200, chunks: [Buffer.from("<html>main frame</html>")] },
  ];
}

// ── 0. 登录失败文案分类 ─────────────────────────────────────────

test("登录遇验证码错误：如实说验证码，不误导同学改密码", async () => {
  looseRate();
  const queue: MockSpec[] = [
    // 登录页
    {
      status: 200,
      headers: { "set-cookie": ["JSESSIONID=captcha-sess; Path=/"] },
      chunks: [LOGIN_PAGE_HTML("tok-captcha")],
    },
    // RSA 公钥
    {
      status: 200,
      chunks: [
        Buffer.from(JSON.stringify({ modulus: keyPair.modulusB64, exponent: keyPair.exponentB64 })),
      ],
    },
    // 登录响应：正方开启验证码时的失败文案
    { status: 200, chunks: [Buffer.from("<html>验证码错误</html>")] },
  ];
  const mock = installMock(() => queue.shift());
  try {
    await assert.rejects(loginJwgl("20230101", "correct-password"), (e: Error) => {
      assert.match(e.message, /验证码/);
      assert.ok(!/密码不正确/.test(e.message), "不得再说「密码不正确」误导同学改密码");
      return true;
    });
  } finally {
    mock.restore();
  }
});

// ── 1. portal 错误可见性：故障 ≠ 空列表 ─────────────────────────

test("fetchEnrolledClasses：网络故障必须抛错，不能翻译成「暂无已选课程」", async () => {
  looseRate();
  const mock = installMock(() => ({ status: 200, networkError: "connect ECONNREFUSED" }));
  try {
    await assert.rejects(
      fetchEnrolledClasses("JSESSIONID=dead"),
      (e: unknown) => isRaptorError(e) && !isRaptorError(e, "SESSION_EXPIRED"),
      "网络故障应如实上抛（NETWORK/UPSTREAM）",
    );
  } finally {
    mock.restore();
  }
});

test("fetchEnrolledClasses：非 JSON 响应抛 PARSE（改版可见），不再静默吞掉", async () => {
  looseRate();
  const mock = installMock(() => ({ status: 200, chunks: [Buffer.from("<html>oops</html>")] }));
  try {
    await assert.rejects(fetchEnrolledClasses("JSESSIONID=ok"), (e: unknown) =>
      isRaptorError(e, "PARSE"),
    );
  } finally {
    mock.restore();
  }
});

// ── 2. withAuthRetry：会话失效自动重登一次 ─────────────────────

test("withAuthRetry：fn 抛 SESSION_EXPIRED 时换新 cookie 重试一次", async () => {
  looseRate();
  invalidateAuthCache();
  const queue = [...loginQueue("s1"), ...loginQueue("s2")];
  const mock = installMock(() => queue.shift());
  try {
    let calls = 0;
    const seenCookies: string[] = [];
    const out = await withAuthRetry(async (cookie) => {
      seenCookies.push(cookie);
      calls += 1;
      if (calls === 1) throw new RaptorError("SESSION_EXPIRED", "模拟会话被踢");
      return `ok:${cookie}`;
    });
    assert.equal(calls, 2, "恰好重试一次");
    assert.equal(out, "ok:JSESSIONID=s2", "重试用的是重登后的新 cookie");
    assert.deepEqual(seenCookies, ["JSESSIONID=s1", "JSESSIONID=s2"]);
    assert.equal(
      mock.seen.filter((s) => s.path?.includes("login_slogin")).length,
      4,
      "两次完整登录（每次 2 个 login_slogin 请求）",
    );
  } finally {
    mock.restore();
    invalidateAuthCache();
  }
});

test("withAuthRetry：非会话错误直接上抛，不多余登录", async () => {
  looseRate();
  invalidateAuthCache();
  const queue = [...loginQueue("s1")];
  const mock = installMock(() => queue.shift());
  try {
    await assert.rejects(
      withAuthRetry(async () => {
        throw new RaptorError("UPSTREAM", "业务故障");
      }),
      (e: unknown) => isRaptorError(e, "UPSTREAM"),
    );
    assert.equal(queue.length, 0, "只发生一次登录，没有多余请求");
  } finally {
    mock.restore();
    invalidateAuthCache();
  }
});

// ── 3. getCookie 并发去重：一轮多工具并发只登录一次 ─────────────

test("getCookie 并发调用共享同一次登录（不再触发登录风暴）", async () => {
  looseRate();
  invalidateAuthCache();
  const queue = [...loginQueue("shared")];
  const mock = installMock(() => queue.shift());
  try {
    const cookies = await Promise.all([getCookie(true), getCookie(true), getCookie(true)]);
    assert.deepEqual(cookies, ["JSESSIONID=shared", "JSESSIONID=shared", "JSESSIONID=shared"]);
    assert.equal(mock.seen.length, 3, "三请求并发只走一遍登录时序（页面+公钥+提交）");
    assert.equal(queue.length, 0);
  } finally {
    mock.restore();
    invalidateAuthCache();
  }
});

// ── 4. 查询性能：进程内快照 + 失败回退缓存 ─────────────────────

const { clearGradesMemo, fetchAllGrades } = await import("../src/adapters/njtech/grades");
const { saveScheduleCache } = await import("../src/core/schedule-cache");
const { saveExamCache } = await import("../src/core/exam-cache");
const { scheduleTools } = await import("../src/adapters/njtech/tools/schedule");
const { gradesTools } = await import("../src/adapters/njtech/tools/grades");

const asTool = (t: unknown) =>
  t as { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };

test("fetchAllGrades：TTL 内重复调用零新增教务请求（大四一年 ~10 个学期接口不再打两遍）", async () => {
  looseRate();
  clearGradesMemo();
  let calls = 0;
  const mock = installMock(() => {
    calls += 1;
    return {
      status: 200,
      chunks: [
        Buffer.from(
          JSON.stringify({
            items: [
              {
                kcmc: "高等数学A",
                kch: "MATH1",
                cj: 92,
                xf: "4",
                kcxzmc: "必修",
                xnmmc: "2025-2026",
                xqmmc: "1",
              },
            ],
          }),
        ),
      ],
    };
  });
  try {
    const a = await fetchAllGrades("JSESSIONID=t", "20230101");
    const b = await fetchAllGrades("JSESSIONID=t", "20230101");
    assert.equal(a.gpa, "4.00");
    assert.equal(b.gpa, "4.00", "第二次调用应返回同一份结果");
    const perRound = (new Date().getFullYear() - 2023 + 1) * 2;
    assert.equal(calls, perRound, `首轮 ${perRound} 个学期请求后，第二次应零新增`);
  } finally {
    mock.restore();
    clearGradesMemo();
  }
});

test("get_schedule：教务在线失败时回退最后已知课表，如实标注不新鲜", async () => {
  looseRate();
  invalidateAuthCache();
  saveScheduleCache({
    year: 2026,
    semester: 3,
    label: "2025-2026-2",
    courses: [
      {
        title: "高等数学A",
        weekday: 1,
        periods: [2, 3],
        weeks: "1-16",
        location: "同和楼 101",
        teacher: "张三",
      },
    ],
  });
  // 登录成功，但课表接口全线不可达
  const queue = [...loginQueue("s1")];
  const mock = installMock(() => queue.shift() ?? { status: 0, networkError: "教务线路不可达" });
  try {
    const out = await asTool(scheduleTools.get_schedule).execute({});
    assert.match(String(out.staleNote ?? ""), /本地缓存/, "必须带「本地缓存」的如实提示");
    assert.equal(out.total, 1);
    assert.equal(out.term, "2025-2026-2");
  } finally {
    mock.restore();
    invalidateAuthCache();
  }
});

test("get_exams：教务在线失败时回退最后已知考试安排，如实标注不新鲜", async () => {
  looseRate();
  invalidateAuthCache();
  saveExamCache({
    year: 2026,
    semester: 3,
    label: "2026-2027-1",
    exams: [
      {
        subject: "线性代数",
        date: "2026-12-30",
        time: "14:00-16:00",
        location: "仁智楼 202",
        seatNumber: "12",
      },
    ],
  });
  const queue = [...loginQueue("s1")];
  const mock = installMock(() => queue.shift() ?? { status: 0, networkError: "教务线路不可达" });
  try {
    const out = await asTool(gradesTools.get_exams).execute({});
    assert.match(String(out.staleNote ?? ""), /本地缓存/);
    assert.equal(out.total, 1);
    assert.equal(out.term, "2026-2027-1");
  } finally {
    mock.restore();
    invalidateAuthCache();
  }
});
