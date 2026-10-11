/**
 * 自更新链路测试
 *
 * 背景：/update 是全项目风险最高的无测试路径——下载 zip → 解压 → 覆盖安装，
 * 覆盖过滤改坏 = 同学的凭证/记忆/会话被新包冲掉，且坏了毁的是用户已装好的环境。
 *
 * 测试策略：updater.ts 的边缘步骤（下载/解压/复制/装依赖）写成可注入端口，
 * 这里注入假实现跑全流程；唯一的安全核心 updateCopyFilter / isProtected
 * 用纯函数表驱动钉死。全程不碰真实仓库文件、不联网。
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { applyUpdate, isProtected, type UpdateDeps, updateCopyFilter } from "../src/core/updater";

// ── isProtected：覆盖安装保护名单（安全边界） ──────────────────

test("isProtected：名单内的本机数据自身与子路径全部拦截", () => {
  const protectedRoots = [
    ".env",
    "credentials.enc",
    "session.json",
    "memory.json",
    "qq-allowlist.json",
    "node_modules",
    ".git",
    "downloads",
    "data",
    "outputs",
  ];
  for (const root of protectedRoots) {
    assert.equal(isProtected(root), true, `${root} 自身应受保护`);
    assert.equal(isProtected(`${root}/child.txt`), true, `${root}/ 的子路径应受保护`);
    assert.equal(isProtected(`${root}/a/b/c.txt`), true, `${root}/ 深层路径应受保护`);
  }
});

test("isProtected：Windows 反斜杠路径同样命中（覆盖复制来自 fs.cp 的原生分隔）", () => {
  assert.equal(isProtected("data\\raptor.log"), true);
  assert.equal(isProtected("node_modules\\ai\\index.js"), true);
  assert.equal(isProtected(".env"), true);
});

test("isProtected：普通源码与资产放行", () => {
  for (const rel of ["package.json", "src/core/agent.ts", "README.md", "docs/logo.png", "bin"]) {
    assert.equal(isProtected(rel), false, `${rel} 不应被保护名单拦截`);
  }
});

test("isProtected：前缀相似但不同名的路径必须放行（防误伤）", () => {
  // "data" 是按路径段匹配的，不能命中 database/、.env.example 这类前缀相似项
  assert.equal(isProtected("database.ts"), false);
  assert.equal(isProtected("dataset/cache.json"), false);
  assert.equal(isProtected(".env.example"), false);
  assert.equal(isProtected("outputs-archive/x.txt"), false);
});

// ── updateCopyFilter：fs.cp filter 的相对路径归一 ──────────────

test("updateCopyFilter：解压根放行、本机数据相对路径拦截、路径分隔归一", () => {
  // Windows 上 fs.cp 传给 filter 的是反斜杠绝对路径；filter 内部要先归一
  const extractDir = path.resolve("/tmp/fake-extract");
  const filter = updateCopyFilter(extractDir);

  assert.equal(filter(extractDir), true, "解压根目录本身必须放行（cp 需要下钻）");
  assert.equal(filter(path.join(extractDir, "src", "core", "agent.ts")), true);
  assert.equal(filter(path.join(extractDir, ".env")), false);
  assert.equal(filter(path.join(extractDir, "data", "session.json")), false);
  assert.equal(filter(path.join(extractDir, "node_modules", "ai")), false);
});

// ── applyUpdate：注入假端口跑全流程 ────────────────────────────

/** 组装一套假依赖：下载/解压/装依赖记录调用，copyDir 记录入参但不写盘 */
function fakeDeps(overrides: UpdateDeps = {}) {
  const calls: { copied?: { from: string; to: string }; npmInstalled?: boolean } = {};
  const extractDir = "/tmp/fake-extract";
  const deps: UpdateDeps = {
    serverUrl: () => "https://updates.example.com",
    checkUpdate: async () => ({ latest: "9.9.9", current: "0.6.0", notes: "修复若干问题" }),
    download: async () => "/tmp/fake-update.zip",
    extract: async () => extractDir,
    copyDir: async (from, to) => {
      calls.copied = { from, to };
    },
    npmInstall: async () => {
      calls.npmInstalled = true;
    },
    ...overrides,
  };
  return { deps, calls, extractDir };
}

test("applyUpdate：未配置更新后台时给出手动覆盖指引，不动任何文件", async () => {
  const logs: string[] = [];
  const msg = await applyUpdate((m) => logs.push(m), {
    serverUrl: () => null,
    checkUpdate: async () => {
      assert.fail("未配置后台时不应走到版本检查");
    },
  });
  assert.match(msg, /未配置更新后台地址/);
  assert.deepEqual(logs, [], "失败前不应有任何进度输出");
});

test("applyUpdate：默认链路下后台地址必须 HTTPS（自建后台也不许明文拉包）", async () => {
  // HTTPS 强制在默认的 requireSecureUpdateServerUrl 里；注入 serverUrl 的测试不走它
  const prev = process.env.RAPTOR_UPDATE_SERVER;
  process.env.RAPTOR_UPDATE_SERVER = "http://updates.example.com";
  try {
    await assert.rejects(() => applyUpdate(), /必须使用 HTTPS/);
  } finally {
    if (prev === undefined) delete process.env.RAPTOR_UPDATE_SERVER;
    else process.env.RAPTOR_UPDATE_SERVER = prev;
  }
});

test("applyUpdate：已是最新版本时不下载不覆盖", async () => {
  const logs: string[] = [];
  let downloaded = false;
  const msg = await applyUpdate((m) => logs.push(m), {
    serverUrl: () => "https://updates.example.com",
    checkUpdate: async () => null,
    download: async () => {
      downloaded = true;
      return "";
    },
  });
  assert.equal(msg, "当前已是最新版本，无需更新。");
  assert.equal(downloaded, false, "无新版不应触发下载");
  assert.deepEqual(logs, []);
});

test("applyUpdate：全流程顺序正确，复制目标指向项目根且带保护过滤器", async () => {
  const logs: string[] = [];
  let captured: { from: string; to: string; filter: (src: string) => boolean } | undefined;
  const base = fakeDeps();
  const deps: UpdateDeps = {
    ...base.deps,
    copyDir: async (from, to, filter) => {
      captured = { from, to, filter };
    },
  };
  const msg = await applyUpdate((m) => logs.push(m), deps);

  assert.match(msg, /✅ 已更新到 v9\.9\.9/);
  assert.match(msg, /重启 raptor/);
  // 进度顺序：发现新版本 → 解压 → 覆盖安装 → 装依赖
  assert.equal(logs.length, 4, "每个阶段一条进度");
  assert.match(logs[0]!, /发现新版本 v9\.9\.9：修复若干问题/);
  assert.match(logs[1]!, /^解压中/);
  assert.match(logs[2]!, /^覆盖安装中/);
  assert.match(logs[3]!, /^安装依赖中/);
  assert.ok(base.calls.npmInstalled, "覆盖后应装依赖");
  assert.ok(captured, "应执行覆盖复制");
  assert.equal(captured.from, base.extractDir);
  // 传给复制的 filter 就是保护过滤器：解压包里的本机数据不得通过
  assert.equal(captured.filter(path.join(base.extractDir, ".env")), false, "凭证不得被覆盖");
  assert.equal(
    captured.filter(path.join(base.extractDir, "src", "core", "agent.ts")),
    true,
    "源码正常覆盖",
  );
});

test("applyUpdate：npm install 失败向上抛错（默认实现再包装「新代码已就位」提示）", async () => {
  // 注入的端口错误原样透传；包装文案属于默认 runNpmInstall 的职责
  const err = Object.assign(new Error("boom"), { stderr: "EACCES: permission denied" });
  await assert.rejects(
    () =>
      applyUpdate(() => {}, {
        ...fakeDeps({
          npmInstall: async () => {
            throw err;
          },
        }).deps,
      }),
    /boom/,
  );
});
