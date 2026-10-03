/**
 * 网关子实例环境变量白名单测试（spawner.buildInstanceEnv）。
 *
 * 实例是跑在同学会话里的 AI Agent，任何工具代码都能读进程 env——
 * 网关自身的凭据（GATEWAY_SECRET / GATEWAY_ADMIN_PASSWORD /
 * GATEWAY_UPDATE_TOKEN / GATEWAY_DEEPSEEK_KEY）绝不能透传进子实例，
 * 否则等于把管理台密码发给每个同学。此前 ...process.env 全量透传。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { buildInstanceEnv } = await import("../gateway/spawner.mjs");

test("buildInstanceEnv：网关凭据与同学侧敏感变量绝不进入子实例", () => {
  const env = buildInstanceEnv(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/home/raptor",
      GATEWAY_SECRET: "top-secret-16chars!",
      GATEWAY_ADMIN_PASSWORD: "admin-master-pw",
      GATEWAY_UPDATE_TOKEN: "upd-tok",
      GATEWAY_UPDATE_URL: "http://127.0.0.1:8787",
      GATEWAY_DEEPSEEK_KEY: "sk-env-fallback",
      GATEWAY_STATE_DIR: "/var/lib/raptor-gateway",
      DEEPSEEK_API_KEY: "sk-outer",
      JWGL_USERNAME: "leak-me",
    },
    { port: 33123, dataDir: "/d", credFile: "/c", siteKey: "sk-site", fallbackKey: "sk-fb" },
  );

  // 网关配置一概不给
  for (const key of [
    "GATEWAY_SECRET",
    "GATEWAY_ADMIN_PASSWORD",
    "GATEWAY_UPDATE_TOKEN",
    "GATEWAY_UPDATE_URL",
    "GATEWAY_DEEPSEEK_KEY",
    "GATEWAY_STATE_DIR",
    // 网关进程环境里的教务账号不得顺带泄漏（外层 DEEPSEEK_API_KEY
    // 由下面单独断言被站点值显式覆盖）
    "JWGL_USERNAME",
  ]) {
    assert.equal(env[key], undefined, `${key} 不应进入子实例`);
  }
  assert.equal(env.DEEPSEEK_API_KEY, "sk-site", "站点 Key 由调用方显式注入（站点值优先）");

  // 系统与运行必需项保留
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/raptor");
  assert.equal(env.RAPTOR_WEB_PORT, "33123");
  assert.equal(env.RAPTOR_DATA_DIR, "/d");
  assert.equal(env.RAPTOR_CREDENTIALS_FILE, "/c");
  assert.equal(env.RAPTOR_NO_UPDATE_CHECK, "1");
  assert.equal(env.RAPTOR_NO_TODO_REMINDERS, "1");
  assert.equal(env.RAPTOR_LOCAL_FILE_ROOT, "/d", "实例只能读自己数据目录内的本机文件");
  assert.equal(env.RAPTOR_DISABLE_DS_OVERRIDE, undefined, "非钉站点模式不注入禁用旗标");
});

test("buildInstanceEnv：站点 Key 缺省回退构造兜底；钉站点模式注入禁用旗标", () => {
  const env = buildInstanceEnv(
    {},
    { port: 1, dataDir: "d", credFile: "c", fallbackKey: "sk-fb", forceSite: true },
  );
  assert.equal(env.DEEPSEEK_API_KEY, "sk-fb", "无站点值时回退 deepseekKey 构造参数");
  assert.equal(env.RAPTOR_DISABLE_DS_OVERRIDE, "1", "钉站点模式必须注入禁用自己 Key 的旗标");

  const bare = buildInstanceEnv({}, { port: 2, dataDir: "d", credFile: "c" });
  assert.equal(bare.DEEPSEEK_API_KEY, undefined, "两侧都无 Key 时不设（同学必须自带）");
});

test("buildInstanceEnv：注入同学选择的供应商与托管标志", () => {
  const env = buildInstanceEnv({}, { port: 1, dataDir: "d", credFile: "c", providerId: "glm" });
  assert.equal(env.RAPTOR_PROVIDER_ID, "glm", "同学的供应商选择注入实例（users.json 的值）");
  assert.equal(env.RAPTOR_HOSTED, "1");
  assert.equal(
    env.RAPTOR_HOSTED,
    "1",
    "托管标志：实例据此禁收 providerId/customBaseUrl（防 SSRF）",
  );

  const bare = buildInstanceEnv({}, { port: 2, dataDir: "d", credFile: "c" });
  assert.equal(bare.RAPTOR_PROVIDER_ID, undefined, "未选择不注入（实例回落 deepseek）");
  assert.equal(bare.RAPTOR_HOSTED, "1");
});

test("buildInstanceEnv：按供应商注入站点 Key（多厂商）", () => {
  // 智谱会话：站点 Key 走 RAPTOR_PROVIDER_KEY，绝不经 DEEPSEEK_API_KEY 泄露
  const glm = buildInstanceEnv(
    {},
    { port: 1, dataDir: "d", credFile: "c", providerId: "glm", providerSiteKey: "glm-site-key" },
  );
  assert.equal(glm.RAPTOR_PROVIDER_KEY, "glm-site-key");
  assert.equal(glm.DEEPSEEK_API_KEY, undefined, "非 deepseek 会话不得带 DeepSeek 通道的 Key");

  // deepseek 会话：RAPTOR_PROVIDER_KEY 与历史通道 DEEPSEEK_API_KEY 同值双注
  const ds = buildInstanceEnv(
    {},
    { port: 2, dataDir: "d", credFile: "c", providerId: "deepseek", providerSiteKey: "sk-site1" },
  );
  assert.equal(ds.RAPTOR_PROVIDER_KEY, "sk-site1");
  assert.equal(ds.DEEPSEEK_API_KEY, "sk-site1");

  // 站点没配该厂商 Key：什么都不注入（同学必须自带）
  const bare = buildInstanceEnv({}, { port: 3, dataDir: "d", credFile: "c", providerId: "qwen" });
  assert.equal(bare.RAPTOR_PROVIDER_KEY, undefined);
  assert.equal(bare.DEEPSEEK_API_KEY, undefined);
});

test("buildInstanceEnv：站点默认型号按需注入，未配置不设", () => {
  const withSite = buildInstanceEnv(
    {},
    { port: 1, dataDir: "d", credFile: "c", siteModel: "deepseek-v4.1-flash" },
  );
  assert.equal(
    withSite.RAPTOR_SITE_MODEL,
    "deepseek-v4.1-flash",
    "站点默认型号注入实例（config.ts 里同学自选优先，这里只兜底）",
  );
  const bare = buildInstanceEnv({}, { port: 2, dataDir: "d", credFile: "c" });
  assert.equal(bare.RAPTOR_SITE_MODEL, undefined, "未配置站点默认时不设变量（本地版零改动）");
});
