/**
 * 供应商注册表测试
 *
 * 钉住：内置清单形状（id 唯一、端点合法、每家有兜底型号与 Key 提示）、
 * resolveProviderId 的非法回落、custom 端点校验（http(s)、去尾斜杠、长度）、
 * 按供应商的 Key 形状校验（DeepSeek 维持严格 sk-，其余宽松）、
 * providerBaseUrl 对 custom 与内置厂商的取值规则。纯数据与纯函数，不联网。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  BUILTIN_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  DEFAULT_PROVIDER_ID,
  describeProviderModel,
  getProviderDef,
  isCustomProvider,
  normalizeCustomBaseUrl,
  providerBaseUrl,
  providerOptionList,
  resolveProviderId,
  validateProviderApiKey,
} = await import("../src/core/providers");

test("内置清单覆盖主流国内厂商且形状完整", () => {
  const ids = BUILTIN_PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "供应商 id 不得重复");
  for (const expected of [
    "deepseek",
    "qwen",
    "glm",
    "kimi",
    "doubao",
    "hunyuan",
    "minimax",
    "step",
    "ernie",
    "spark",
    "siliconflow",
    "custom",
  ]) {
    assert.ok(ids.includes(expected), `内置清单应包含 ${expected}`);
  }
  for (const p of BUILTIN_PROVIDERS) {
    assert.match(p.id, /^[a-z][a-z0-9-]*$/, "id 是小写短横线形状（网关侧同款校验）");
    assert.ok(p.label && p.note, `${p.id} 需有显示名与说明`);
    if (p.id !== CUSTOM_PROVIDER_ID) {
      assert.match(p.baseUrl, /^https:\/\/[^\s]+$/, `${p.id} 端点必须是 https URL`);
      assert.ok(p.fallbackModels.length > 0, `${p.id} 需要兜底型号清单`);
      for (const m of p.fallbackModels) {
        assert.ok(m.id && m.label && m.note, `${p.id} 的兜底型号要带说明`);
      }
    }
    assert.ok(p.keyHint, `${p.id} 需要 Key 输入提示`);
  }
});

test("deepseek 是默认供应商且维持严格的 sk- Key 校验", () => {
  assert.equal(DEFAULT_PROVIDER_ID, "deepseek");
  const def = getProviderDef("deepseek");
  assert.equal(def.baseUrl, "https://api.deepseek.com/v1");
  assert.ok(def.keyPattern, "deepseek 保留严格 Key 形状（历史行为）");
  assert.equal(validateProviderApiKey("deepseek", "sk-abcdefgh12345678").ok, true);
  assert.equal(validateProviderApiKey("deepseek", "short").ok, false);
});

test("resolveProviderId：合法 id 原样返回，一切非法值回落 deepseek", () => {
  assert.equal(resolveProviderId("glm"), "glm");
  assert.equal(resolveProviderId(" deepseek "), "deepseek");
  assert.equal(resolveProviderId(undefined), "deepseek");
  assert.equal(resolveProviderId(null), "deepseek");
  assert.equal(resolveProviderId(""), "deepseek");
  assert.equal(resolveProviderId("gpt"), "deepseek");
  assert.equal(resolveProviderId("../../etc/passwd"), "deepseek");
  assert.equal(isCustomProvider(CUSTOM_PROVIDER_ID), true);
  assert.equal(isCustomProvider("glm"), false);
});

test("normalizeCustomBaseUrl：合法 http(s) 去尾斜杠，其余拒绝", () => {
  assert.deepEqual(normalizeCustomBaseUrl("https://api.example.com/v1/"), {
    ok: true,
    url: "https://api.example.com/v1",
    message: "",
  });
  assert.equal(
    normalizeCustomBaseUrl("http://127.0.0.1:11434/v1").ok,
    true,
    "本地版允许 http 与回环（自建服务）",
  );
  assert.equal(normalizeCustomBaseUrl("").ok, false);
  assert.equal(normalizeCustomBaseUrl("ftp://x.com").ok, false);
  assert.equal(normalizeCustomBaseUrl("api.example.com/v1").ok, false, "缺协议头拒绝");
  assert.equal(normalizeCustomBaseUrl(`https://${"a".repeat(200)}.com/v1`).ok, false, "超长拒绝");
  assert.equal(normalizeCustomBaseUrl("https://a.com/v1?q=1 2").ok, false, "含空白拒绝");
});

test("validateProviderApiKey：非 deepseek 厂商宽松校验（长度 + 无空白）", () => {
  // 智谱 Key 形如 id.secret，不含 sk- 前缀——宽松校验放行
  assert.equal(validateProviderApiKey("glm", "8a1b2c3d4e5f6.abcdef0123456789").ok, true);
  assert.equal(validateProviderApiKey("qwen", "sk-".padEnd(32, "x")).ok, true);
  assert.equal(validateProviderApiKey("doubao", "too-short").ok, false);
  assert.equal(validateProviderApiKey("kimi", "has space in key padding!!").ok, false);
  // custom：任意端点的 Key，同样宽松
  assert.equal(validateProviderApiKey(CUSTOM_PROVIDER_ID, "opaque-key-0123456789abcdef").ok, true);
});

test("providerBaseUrl：custom 用自填地址，内置厂商忽略自填地址", () => {
  assert.equal(providerBaseUrl(CUSTOM_PROVIDER_ID, "https://my.llm/v1"), "https://my.llm/v1");
  assert.equal(providerBaseUrl("glm", "https://evil.example.com"), getProviderDef("glm").baseUrl);
  assert.equal(providerBaseUrl("deepseek"), "https://api.deepseek.com/v1");
});

test("providerOptionList 给下拉完整候选（含 Key 提示）", () => {
  const list = providerOptionList();
  assert.equal(list.length, BUILTIN_PROVIDERS.length);
  for (const item of list) {
    assert.ok(item.id && item.label && item.note && item.keyHint);
  }
});

test("describeProviderModel：已知型号带说明，未知型号裸 id 展示", () => {
  assert.equal(describeProviderModel("deepseek", "deepseek-flash").label, "Flash（V4.1，最新）");
  assert.equal(describeProviderModel("deepseek", "deepseek-chat").note.includes("停用"), true);
  const unknown = describeProviderModel("glm", "glm-9x-preview");
  assert.equal(unknown.label, "glm-9x-preview");
  assert.equal(unknown.note, "模型服务返回的型号");
});
