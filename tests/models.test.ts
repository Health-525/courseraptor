/**
 * 模型清单与选择校验测试
 *
 * 钉住：/models 响应归一化（脏数据不得进下拉）、优先级（界面选过 > .env > 兜底）、
 * 清单外型号一律拒绝、联网失败退回内置清单并带原因、缓存不重复打网络、
 * 启动退役检测（型号从实时清单消失才迁移到当前默认型号，联网失败不动配置）。
 * 只测纯逻辑与注入 fetch；不碰 credentials.enc（那是真机上用户的加密凭证）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  FALLBACK_MODEL_ID,
  FALLBACK_MODELS,
  allowedModelIds,
  cachedModelOptions,
  describeModel,
  ensureModelAvailable,
  fallbackModelsFor,
  invalidateModelCache,
  isValidModelId,
  listModelOptions,
  parseModelIds,
  resolveModelDrift,
  resolveStoredModel,
  validateModelChoice,
} = await import("../src/core/models");
const { getProviderDef } = await import("../src/core/providers");

/** 假 Response：listModelOptions 只用到 ok / status / json() */
function fakeFetch(payload: unknown, options: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    calls.push(String(input));
    return {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      json: async () => payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("兜底默认指向官方当前主力型号，兜底清单只列在架型号", () => {
  assert.equal(FALLBACK_MODEL_ID, "deepseek-flash", "V4.1-Flash（2026-09-10 发布）是当前默认");
  assert.deepEqual(
    FALLBACK_MODELS.map((m) => m.id),
    ["deepseek-flash", "deepseek-v4-pro"],
    "deepseek-chat / deepseek-reasoner 别名已于 2026-07-24 停用，V4 Flash 系列已退役，均不得再作默认或兜底选项",
  );
});

test("parseModelIds 兼容标准响应并剔除脏条目", () => {
  assert.deepEqual(
    parseModelIds({
      object: "list",
      data: [
        { id: " deepseek-flash ", object: "model", owned_by: "deepseek" },
        { id: "deepseek-v4-pro" },
        { id: "deepseek-flash" },
        { id: "bad id/with~chars" },
        { note: "没有 id" },
        null,
        "deepseek-string-entry",
      ],
    }),
    ["deepseek-flash", "deepseek-v4-pro", "deepseek-string-entry"],
    "应去重、去空白、拒绝含非法字符或缺 id 的条目",
  );
  assert.deepEqual(parseModelIds(["model-a", 42, {}]), ["model-a"]);
  assert.deepEqual(parseModelIds(undefined), []);
  assert.deepEqual(parseModelIds({ data: "not-an-array" }), []);
});

test("resolveStoredModel：界面明确选过的值优先于 .env，其次才轮到 .env", () => {
  assert.equal(
    resolveStoredModel({
      environmentModel: "deepseek-v4-pro",
      storedModel: "deepseek-flash",
      storedOverride: true,
    }),
    "deepseek-flash",
    "用户在弹窗选过就不该被 .env 拉回旧值",
  );
  assert.equal(
    resolveStoredModel({ environmentModel: "deepseek-v4-pro", storedModel: "deepseek-flash" }),
    "deepseek-v4-pro",
    "未标记覆盖的历史值仍保持 .env 优先",
  );
  assert.equal(resolveStoredModel({ storedModel: "deepseek-v4-pro" }), "deepseek-v4-pro");
  assert.equal(resolveStoredModel({}), FALLBACK_MODEL_ID);
});

test("isValidModelId：放行 API 形状的型号标识，拒绝脏值", () => {
  assert.ok(isValidModelId("deepseek-v4.1-flash"));
  assert.ok(isValidModelId("MiniMax-M2.5"));
  assert.ok(isValidModelId("Qwen/Qwen3-8B"), "硅基流动的 厂商/型号 斜杠形式");
  assert.ok(!isValidModelId("bad id"));
  assert.ok(!isValidModelId(""));
  assert.ok(!isValidModelId(" leading-space"));
  assert.ok(!isValidModelId(undefined));
});

test("resolveStoredModel：站点默认（siteModel）只兜底从没选过型号的同学", () => {
  assert.equal(
    resolveStoredModel({
      storedModel: "glm-5.3",
      storedOverride: true,
      siteModel: "deepseek-v4.1-flash",
    }),
    "glm-5.3",
    "同学按供应商的型号记忆（override 语义）压过站点默认",
  );
  assert.equal(
    resolveStoredModel({ environmentModel: "deepseek-chat", siteModel: "site-pick" }),
    "deepseek-chat",
    "本地 RAPTOR_MODEL 语义不变，仍压过站点默认",
  );
  assert.equal(
    resolveStoredModel({ storedModel: "deepseek-v4-pro", siteModel: "glm-5.3" }),
    "glm-5.3",
    "旧格式未覆盖的存量值让位给站点统一默认（站长显式配置的意图优先）",
  );
  assert.equal(resolveStoredModel({ siteModel: "glm-5.3" }), "glm-5.3");
  assert.equal(resolveStoredModel({}), FALLBACK_MODEL_ID, "无站点默认时行为不变");
});

test("validateModelChoice 只放行清单内型号，且不改动当前值", () => {
  const allowed = allowedModelIds(["deepseek-flash", "deepseek-v4-pro"], ["deepseek-flash"]);
  assert.deepEqual(allowed, ["deepseek-flash", "deepseek-v4-pro"], "候选集合应合并去重");

  const ok = validateModelChoice({
    requested: "deepseek-v4-pro",
    allowed,
    current: "deepseek-flash",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.model, "deepseek-v4-pro");
  assert.match(ok.message, /V4 Pro/, "提示应带可读型号名，别只吐 id");

  const unknown = validateModelChoice({
    requested: "gpt-whatever",
    allowed,
    current: "deepseek-flash",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.model, "deepseek-flash", "拒绝时必须保持原值");
  assert.match(unknown.message, /下拉列表/);

  for (const bad of ["deepsee k-x", "../etc/passwd", "模型中文", ""]) {
    const r = validateModelChoice({ requested: bad, allowed, current: "deepseek-flash" });
    assert.equal(r.ok, false, `非法标识应被拒：${JSON.stringify(bad)}`);
    assert.equal(r.model, "deepseek-flash");
  }
});

test("describeModel 对未知型号如实回显 id，不编造中文说明", () => {
  assert.equal(describeModel("deepseek-flash").label, "Flash（V4.1，最新）");
  assert.equal(describeModel("deepseek-v4-pro").label, "V4 Pro");
  // 已退役/已停用的型号仍要有可读名字：兼容路由会让旧 id 继续出现在清单里
  assert.match(describeModel("deepseek-chat").note, /2026-07-24 停用/);
  assert.match(describeModel("deepseek-v4-flash").note, /已退役/);
  const foreign = describeModel("some-new-model");
  assert.equal(foreign.label, "some-new-model");
  assert.equal(foreign.note, "模型服务返回的型号");
});

test("listModelOptions 走 /models 并缓存成功结果，force 才重取", async () => {
  invalidateModelCache();
  const first = fakeFetch({
    data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
  });
  const base = "https://stub.local/v1";
  const r1 = await listModelOptions({ apiKey: "sk-test", baseUrl: base, fetchImpl: first.impl });
  assert.equal(r1.source, "live");
  assert.deepEqual(
    r1.options.map((m) => m.id),
    ["deepseek-flash", "deepseek-v4-pro"],
  );
  assert.equal(first.calls[0], `${base}/models`, "应请求 OpenAI 兼容的列表端点");

  const second = fakeFetch({ data: [{ id: "should-not-be-fetched" }] });
  const r2 = await listModelOptions({ apiKey: "sk-test", baseUrl: base, fetchImpl: second.impl });
  assert.equal(r2.source, "live");
  assert.deepEqual(
    r2.options.map((m) => m.id),
    ["deepseek-flash", "deepseek-v4-pro"],
  );
  assert.equal(second.calls.length, 0, "10 分钟缓存内不得重复联网");

  const r3 = await listModelOptions({
    apiKey: "sk-test",
    baseUrl: base,
    force: true,
    fetchImpl: second.impl,
  });
  assert.equal(second.calls.length, 1, "?refresh=1 语义：强制绕开缓存");
  assert.deepEqual(
    r3.options.map((m) => m.id),
    ["should-not-be-fetched"],
  );
});

test("listModelOptions 联网失败退回内置清单并说明原因，且不污染缓存", async () => {
  invalidateModelCache();
  assert.deepEqual(
    cachedModelOptions().map((m) => m.id),
    FALLBACK_MODELS.map((m) => m.id),
    "没有缓存时同步清单应等于内置兜底",
  );

  const noKey = await listModelOptions({});
  assert.equal(noKey.source, "fallback");
  assert.match(noKey.message ?? "", /尚未配置 API Key/);

  const denied = await listModelOptions({
    apiKey: "sk-test",
    baseUrl: "https://stub.local/v1",
    fetchImpl: fakeFetch({}, { ok: false, status: 401 }).impl,
  });
  assert.equal(denied.source, "fallback");
  assert.match(denied.message ?? "", /API Key 无效/);
  assert.ok(denied.options.length >= 2, "兜底清单必须让用户仍然可选");

  const empty = await listModelOptions({
    apiKey: "sk-test",
    baseUrl: "https://stub.local/v1",
    fetchImpl: fakeFetch({ data: [] }).impl,
  });
  assert.match(empty.message ?? "", /未返回可用清单/);

  const broken = await listModelOptions({
    apiKey: "sk-test",
    baseUrl: "https://stub.local/v1",
    fetchImpl: (async () => {
      throw new Error("getaddrinfo    ENOTFOUND");
    }) as unknown as typeof fetch,
  });
  assert.equal(broken.source, "fallback");
  assert.match(broken.message ?? "", /ENOTFOUND/, "网络错误摘要要压成一行回给用户");

  assert.equal(
    cachedModelOptions().length,
    FALLBACK_MODELS.length,
    "失败结果不得写入实时缓存，否则下次进来仍是空转",
  );
});

test("resolveModelDrift：型号从实时清单消失才迁移，清单不可判定时宁可不迁", () => {
  assert.deepEqual(resolveModelDrift("deepseek-flash", ["deepseek-flash", "deepseek-v4-pro"]), {
    model: "deepseek-flash",
    migrated: false,
  });

  // 官方 2026-07-24 停用 deepseek-chat 别名后 /models 不再返回它：
  // 本地存着这个旧值的用户必须被自动迁走，不能等对话报 4xx
  const retired = resolveModelDrift("deepseek-chat", ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(retired.migrated, true, "停用型号必须自动迁走");
  assert.equal(retired.model, FALLBACK_MODEL_ID, "迁移目标是当前默认型号");
  assert.match(retired.message ?? "", /deepseek-chat/, "提示要带上退役型号 id");
  assert.match(retired.message ?? "", new RegExp(FALLBACK_MODEL_ID), "提示要带上新模型 id");

  assert.deepEqual(
    resolveModelDrift("deepseek-chat", []),
    { model: "deepseek-chat", migrated: false },
    "空清单无从判定，误迁比报错更难排查",
  );
  assert.deepEqual(
    resolveModelDrift(FALLBACK_MODEL_ID, ["deepseek-v4-pro"]),
    { model: FALLBACK_MODEL_ID, migrated: false },
    "当前值已是默认型号时无事可做",
  );
});

test("ensureModelAvailable：live 清单才判定退役，联网失败保持现状", async () => {
  invalidateModelCache();

  // 已有缓存也必须强制重取：缓存里的旧清单可能早于官方下架
  const stale = fakeFetch({ data: [{ id: "deepseek-v4-flash" }] });
  await listModelOptions({
    apiKey: "sk-test",
    baseUrl: "https://stub.local/v1",
    fetchImpl: stale.impl,
  });
  const forced = fakeFetch({ data: [{ id: "deepseek-flash" }] });
  const r1 = await ensureModelAvailable({
    current: "deepseek-v4-flash",
    apiKey: "sk-test",
    baseUrl: "https://stub.local/v1",
    fetchImpl: forced.impl,
  });
  assert.equal(forced.calls.length, 1, "退役检测必须绕过缓存拿最新清单");
  assert.equal(r1.migrated, true);
  assert.equal(r1.model, FALLBACK_MODEL_ID);

  const healthy = fakeFetch({
    data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
  });
  const r2 = await ensureModelAvailable({
    current: "deepseek-v4-pro",
    apiKey: "sk-test",
    baseUrl: "https://stub.local/v1",
    fetchImpl: healthy.impl,
  });
  assert.deepEqual(r2, { model: "deepseek-v4-pro", migrated: false }, "在架型号不得被动");

  const offline = ensureModelAvailable({
    current: "deepseek-chat",
    apiKey: "sk-test",
    baseUrl: "https://stub.local/v1",
    fetchImpl: (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch,
  });
  const r3 = await offline;
  assert.equal(r3.model, "deepseek-chat", "断网时检测不得改配置");
  assert.equal(r3.migrated, false);
  assert.match(r3.message ?? "", /ENOTFOUND/, "失败原因要带出来，调用方可选择提示");

  const noKey = await ensureModelAvailable({
    current: "deepseek-chat",
    fetchImpl: fakeFetch({ data: [{ id: "deepseek-flash" }] }).impl,
  });
  assert.equal(noKey.migrated, false, "没有 Key 拉不到 live 清单，同样不动配置");
});

/* ── 多供应商：按厂商的兜底清单 / 缓存分桶 / 拉取地址 / 退役迁移边界 ── */

test("fallbackModelsFor：各供应商有自己的兜底清单，custom 为空", async () => {
  const { fallbackModelsFor } = await import("../src/core/models");
  assert.deepEqual(
    fallbackModelsFor("glm").map((m) => m.id),
    getProviderDef("glm").fallbackModels.map((m) => m.id),
  );
  assert.deepEqual(fallbackModelsFor("custom"), [], "custom 型号由用户填或实时拉取");
  assert.deepEqual(
    fallbackModelsFor("deepseek").map((m) => m.id),
    ["deepseek-flash", "deepseek-v4-pro"],
    "deepseek 兜底与历史导出 FALLBACK_MODELS 同源",
  );
});

test("listModelOptions 按 provider 打对应端点；缓存按供应商分桶互不污染", async () => {
  invalidateModelCache();
  const glm = fakeFetch({ data: [{ id: "glm-5" }, { id: "glm-5.2" }] });
  const r1 = await listModelOptions({
    providerId: "glm",
    apiKey: "opaque-test-key-123456",
    fetchImpl: glm.impl,
  });
  assert.equal(r1.source, "live");
  assert.equal(glm.calls[0], "https://open.bigmodel.cn/api/paas/v4/models", "glm 走智谱端点");
  assert.deepEqual(
    r1.options.map((m) => m.id),
    ["glm-5", "glm-5.2"],
  );

  // deepseek 的同步兜底不受 glm 拉取影响（分桶）；glm 的桶里是 live 结果
  assert.deepEqual(
    cachedModelOptions("deepseek").map((m) => m.id),
    ["deepseek-flash", "deepseek-v4-pro"],
  );
  assert.deepEqual(
    cachedModelOptions("glm").map((m) => m.id),
    ["glm-5", "glm-5.2"],
  );

  // 没拉过的供应商同步读兜底
  assert.ok(cachedModelOptions("qwen").length > 0);

  invalidateModelCache();
  assert.deepEqual(
    cachedModelOptions("glm").map((m) => m.id),
    getProviderDef("glm").fallbackModels.map((m) => m.id),
    "invalidateModelCache 清全部桶",
  );
});

test("listModelOptions：custom 未给地址时给手输指引，硅基流动斜杠 id 放行", async () => {
  const noUrl = await listModelOptions({ providerId: "custom", apiKey: "k" });
  assert.equal(noUrl.source, "fallback");
  assert.deepEqual(noUrl.options, []);
  assert.match(noUrl.message ?? "", /自定义端点/);

  const sf = fakeFetch({ data: [{ id: "Qwen/Qwen3-8B" }, { id: "deepseek-ai/DeepSeek-V3.2" }] });
  const r = await listModelOptions({
    providerId: "siliconflow",
    apiKey: "sk-sf-test-0123456789",
    customBaseUrl: "https://wrong.example.com", // 内置厂商忽略自填地址
    fetchImpl: sf.impl,
  });
  assert.equal(r.source, "live");
  assert.equal(sf.calls[0], "https://api.siliconflow.cn/v1/models");
  assert.deepEqual(
    r.options.map((m) => m.id),
    ["Qwen/Qwen3-8B", "deepseek-ai/DeepSeek-V3.2"],
    "聚合平台的 厂商/型号 斜杠 id 必须能进清单",
  );
});

test("noCache：预览拉取不落缓存", async () => {
  invalidateModelCache();
  const pass1 = fakeFetch({ data: [{ id: "kimi-k3" }] });
  await listModelOptions({
    providerId: "kimi",
    apiKey: "sk-kimi-test-0123456789",
    fetchImpl: pass1.impl,
    noCache: true,
  });
  assert.deepEqual(
    cachedModelOptions("kimi").map((m) => m.id),
    getProviderDef("kimi").fallbackModels.map((m) => m.id),
    "noCache 拉取成功也不写桶",
  );
});

test("ensureModelAvailable：仅 deepseek 做自动迁移，其他供应商保持原样", async () => {
  invalidateModelCache();
  const gone = fakeFetch({ data: [{ id: "glm-5.2" }] });
  const r = await ensureModelAvailable({
    current: "glm-5",
    providerId: "glm",
    apiKey: "opaque-test-key-123456",
    fetchImpl: gone.impl,
  });
  assert.equal(r.model, "glm-5", "非 deepseek 供应商即便清单里没有也不自动迁移");
  assert.equal(r.migrated, false);
});

test("validateModelChoice 的 providerId 参数让 describeModel 命中各厂清单", () => {
  const r = validateModelChoice({
    requested: "glm-5",
    allowed: ["glm-5"],
    current: "glm-5.2",
    providerId: "glm",
  });
  assert.equal(r.ok, true);
  assert.match(r.message, /GLM-5|glm-5/);
});
