/**
 * 模型清单与选择校验测试
 *
 * 钉住：/models 响应归一化（脏数据不得进下拉）、优先级（界面选过 > .env > 兜底）、
 * 清单外型号一律拒绝、联网失败退回内置清单并带原因、缓存不重复打网络。
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
  invalidateModelCache,
  listModelOptions,
  parseModelIds,
  resolveStoredModel,
  validateModelChoice,
} = await import("../src/models");

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

test("parseModelIds 兼容标准响应并剔除脏条目", () => {
  assert.deepEqual(
    parseModelIds({
      object: "list",
      data: [
        { id: " deepseek-v4-flash ", object: "model", owned_by: "deepseek" },
        { id: "deepseek-v4-pro" },
        { id: "deepseek-v4-flash" },
        { id: "bad id/with~chars" },
        { note: "没有 id" },
        null,
        "deepseek-string-entry",
      ],
    }),
    ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-string-entry"],
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
      storedModel: "deepseek-v4-flash",
      storedOverride: true,
    }),
    "deepseek-v4-flash",
    "用户在弹窗选过就不该被 .env 拉回旧值",
  );
  assert.equal(
    resolveStoredModel({ environmentModel: "deepseek-v4-pro", storedModel: "deepseek-v4-flash" }),
    "deepseek-v4-pro",
    "未标记覆盖的历史值仍保持 .env 优先",
  );
  assert.equal(resolveStoredModel({ storedModel: "deepseek-v4-pro" }), "deepseek-v4-pro");
  assert.equal(resolveStoredModel({}), FALLBACK_MODEL_ID);
});

test("validateModelChoice 只放行清单内型号，且不改动当前值", () => {
  const allowed = allowedModelIds(["deepseek-v4-flash", "deepseek-v4-pro"], ["deepseek-v4-flash"]);
  assert.deepEqual(allowed, ["deepseek-v4-flash", "deepseek-v4-pro"], "候选集合应合并去重");

  const ok = validateModelChoice({
    requested: "deepseek-v4-pro",
    allowed,
    current: "deepseek-v4-flash",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.model, "deepseek-v4-pro");
  assert.match(ok.message, /V4 Pro/, "提示应带可读型号名，别只吐 id");

  const unknown = validateModelChoice({
    requested: "gpt-whatever",
    allowed,
    current: "deepseek-v4-flash",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.model, "deepseek-v4-flash", "拒绝时必须保持原值");
  assert.match(unknown.message, /下拉列表/);

  for (const bad of ["deepsee k-x", "../etc/passwd", "模型中文", ""]) {
    const r = validateModelChoice({ requested: bad, allowed, current: "deepseek-v4-flash" });
    assert.equal(r.ok, false, `非法标识应被拒：${JSON.stringify(bad)}`);
    assert.equal(r.model, "deepseek-v4-flash");
  }
});

test("describeModel 对未知型号如实回显 id，不编造中文说明", () => {
  assert.equal(describeModel("deepseek-v4-pro").label, "V4 Pro");
  const foreign = describeModel("some-new-model");
  assert.equal(foreign.label, "some-new-model");
  assert.equal(foreign.note, "模型服务返回的型号");
});

test("listModelOptions 走 /models 并缓存成功结果，force 才重取", async () => {
  invalidateModelCache();
  const first = fakeFetch({
    data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }],
  });
  const base = "https://stub.local/v1";
  const r1 = await listModelOptions({ apiKey: "sk-test", baseUrl: base, fetchImpl: first.impl });
  assert.equal(r1.source, "live");
  assert.deepEqual(
    r1.options.map((m) => m.id),
    ["deepseek-v4-pro", "deepseek-v4-flash"],
  );
  assert.equal(first.calls[0], `${base}/models`, "应请求 OpenAI 兼容的列表端点");

  const second = fakeFetch({ data: [{ id: "should-not-be-fetched" }] });
  const r2 = await listModelOptions({ apiKey: "sk-test", baseUrl: base, fetchImpl: second.impl });
  assert.equal(r2.source, "live");
  assert.deepEqual(
    r2.options.map((m) => m.id),
    ["deepseek-v4-pro", "deepseek-v4-flash"],
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
