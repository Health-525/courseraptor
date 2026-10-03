/**
 * 模型清单与选择校验（多供应商）
 *
 * 「设置」里的模型下拉不能凭空写死：厂商会换型号 id（DeepSeek V4.1 上线
 * 时退役了 V4 Flash 系列，deepseek-chat / deepseek-reasoner 旧别名更已于
 * 2026-07-24 停用）。所以清单以 `GET {base}/models` 的实时结果为准
 * （OpenAI 兼容，取 data[].id），拉取失败（没配 Key / 断网 / 401 / 非标准
 * 代理）时退回该供应商的内置兜底清单（providers.ts）——弹窗永远得可选。
 *
 * 默认供应商 deepseek 的官方当前主力是 deepseek-flash（V4.1-Flash，原生
 * 支持图片输入）。官方换代不再保证保留别名，本地若存着已退役的旧 id，
 * 启动时由 ensureModelAvailable 拉实时清单检出并自动迁移（仅 deepseek 做
 * 自动迁移，其他厂商宁可报错也不误迁），避免对话请求直接 4xx。
 *
 * 本模块不 import config，免得和 config <-> credentials 的依赖绕圈：baseUrl、
 * apiKey 由调用方显式传入，fetch 也可注入，纯逻辑与网络都能单独测。
 * （本模块在 njtech 技能包闭包内，只准 import providers.ts 这类纯数据。）
 */

import {
  CUSTOM_PROVIDER_ID,
  DEFAULT_PROVIDER_ID,
  describeProviderModel,
  getProviderDef,
  type ModelOption,
  providerBaseUrl,
} from "./providers";

export type { ModelOption };

const DEEPSEEK_DEF = getProviderDef(DEFAULT_PROVIDER_ID);

/** 官方默认服务地址（历史导出：DeepSeek；各家地址见 providers.ts） */
const DEFAULT_BASE_URL = DEEPSEEK_DEF.baseUrl;

/** 兜底默认值：DeepSeek 官方当前主力型号（V4.1-Flash），官方换代时随公告更新 */
export const FALLBACK_MODEL_ID = DEEPSEEK_DEF.fallbackModels[0]?.id ?? "deepseek-flash";

/** 模型 id 形状白名单：只接受 API 可能返回的标识字符（含硅基流动的 "厂商/型号" 斜杠） */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

/** 供配置层甄别 env/存储里的脏型号值（如 RAPTOR_SITE_MODEL）用 */
export function isValidModelId(raw: string | undefined | null): boolean {
  return typeof raw === "string" && MODEL_ID_RE.test(raw);
}

/** 兜底清单（历史导出：DeepSeek 的内置清单）；其他供应商见 fallbackModelsFor */
export const FALLBACK_MODELS: ModelOption[] = DEEPSEEK_DEF.fallbackModels.map((m) => ({ ...m }));

/** 供应商的内置兜底清单副本；custom 无兜底（型号由用户填或实时拉取） */
export function fallbackModelsFor(providerId: string): ModelOption[] {
  return getProviderDef(providerId).fallbackModels.map((m) => ({ ...m }));
}

/** 服务返回的新型号没有中文名时，直接用 id 展示，不编造说明 */
export function describeModel(id: string): ModelOption {
  return describeProviderModel(DEFAULT_PROVIDER_ID, id);
}

/**
 * 与 resolveDeepSeekApiKey 同构：交互式（设置弹窗）明确选过的值优先于 .env，
 * 否则用户在界面里换了型号、重启又被 RAPTOR_MODEL 拉回去。
 *
 * siteModel（RAPTOR_SITE_MODEL，多用户网关注入的站点默认型号）插在
 * environmentModel 与旧格式 storedModel 之间：同学按供应商的型号记忆
 * （storedOverride 语义）与本地 RAPTOR_MODEL 都压过它，站点默认只兜底
 * 「从没选过型号」的同学——站长切站点默认不会劫持任何人的明确选择。
 */
export function resolveStoredModel(input: {
  environmentModel?: string;
  storedModel?: string;
  storedOverride?: boolean;
  siteModel?: string;
}): string {
  if (input.storedOverride && input.storedModel) return input.storedModel;
  if (input.environmentModel) return input.environmentModel;
  if (input.siteModel) return input.siteModel;
  if (input.storedModel) return input.storedModel;
  return FALLBACK_MODEL_ID;
}

/**
 * 归一化 `/models` 响应：兼容 `{ data: [{ id }] }` 与裸数组两种形态，
 * 顺手丢掉形状不对或含意外字符的条目——脏数据绝不能进下拉框再被存盘。
 */
export function parseModelIds(payload: unknown): string[] {
  const container = payload as { data?: unknown } | unknown[] | null;
  const rows = Array.isArray(container)
    ? container
    : Array.isArray(container?.data)
      ? (container.data as unknown[])
      : [];
  const ids: string[] = [];
  for (const row of rows) {
    const raw =
      typeof row === "string"
        ? row
        : typeof row === "object" && row
          ? (row as { id?: unknown }).id
          : undefined;
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (MODEL_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface ModelListResult {
  options: ModelOption[];
  /** live = 服务实时返回；fallback = 内置清单（附原因） */
  source: "live" | "fallback";
  message?: string;
}

const CACHE_TTL_MS = 10 * 60_000;
/** 按供应商分桶缓存：切换供应商不互踩，也不吃别家的旧清单 */
const cache = new Map<string, { at: number; options: ModelOption[] }>();

/** 换了 API Key 或供应商后必须重取清单：旧 Key 的可用型号可能完全不同 */
export function invalidateModelCache(): void {
  cache.clear();
}

function fallbackResultFor(providerId: string): ModelListResult {
  return {
    options: fallbackModelsFor(providerId),
    source: "fallback",
  };
}

/**
 * 同步版清单：给 /api/settings 这类不能等网络的组装点用。
 * 有实时缓存就用它，否则退回该供应商的内置清单；联网刷新走 listModelOptions。
 */
export function cachedModelOptions(providerId: string = DEFAULT_PROVIDER_ID): ModelOption[] {
  const hit = cache.get(providerId);
  const source = hit ? hit.options : fallbackModelsFor(providerId);
  return source.map((m) => ({ ...m }));
}

/** 读取可用模型清单；只缓存成功结果，失败时下次进来还能重试 */
export async function listModelOptions(
  input: {
    providerId?: string;
    /** custom 供应商的自填端点（其他供应商忽略，用 providers.ts 内置地址） */
    customBaseUrl?: string;
    baseUrl?: string;
    apiKey?: string;
    force?: boolean;
    /** 只查不写缓存（设置弹窗的供应商预览：未保存的选择不污染已存供应商的桶） */
    noCache?: boolean;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ModelListResult> {
  const providerId = getProviderDef(input.providerId ?? DEFAULT_PROVIDER_ID).id;
  const hit = cache.get(providerId);
  if (!input.force && !input.noCache && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { options: hit.options.map((m) => ({ ...m })), source: "live" };
  }
  if (providerId === CUSTOM_PROVIDER_ID && !input.baseUrl && !input.customBaseUrl) {
    return {
      options: [],
      source: "fallback",
      message: "自定义端点：填好服务地址并保存后即可拉取型号清单，或直接输入型号 ID",
    };
  }
  if (!input.apiKey) {
    return {
      ...fallbackResultFor(providerId),
      message: "尚未配置 API Key，已显示内置清单",
    };
  }
  const doFetch = input.fetchImpl ?? fetch;
  const base = (
    input.baseUrl ||
    providerBaseUrl(providerId, input.customBaseUrl) ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  try {
    const response = await doFetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
    });
    if (!response.ok) {
      const reason =
        response.status === 401 || response.status === 403
          ? "API Key 无效或没有权限"
          : `服务返回 HTTP ${response.status}`;
      return {
        ...fallbackResultFor(providerId),
        message: `模型清单读取失败（${reason}），已显示内置清单`,
      };
    }
    const ids = parseModelIds(await response.json());
    if (!ids.length) {
      return {
        ...fallbackResultFor(providerId),
        message: "模型服务未返回可用清单，已显示内置清单",
      };
    }
    const options = ids.map((id) => ({ ...describeProviderModel(providerId, id) }));
    if (input.noCache !== true) cache.set(providerId, { at: Date.now(), options });
    return { options: options.map((m) => ({ ...m })), source: "live" };
  } catch (error) {
    const detail = oneLine(error instanceof Error ? error.message : String(error));
    return {
      ...fallbackResultFor(providerId),
      message: `模型清单读取失败（${detail}），已显示内置清单`,
    };
  }
}

/** 弹窗一次只提交一个改动：留空表示不修改，清单外型号一律拒绝 */
export function validateModelChoice(input: {
  requested: string;
  allowed: string[];
  current: string;
  providerId?: string;
}): { ok: boolean; model: string; message: string } {
  const id = input.requested.trim();
  if (!MODEL_ID_RE.test(id)) {
    return {
      ok: false,
      model: input.current,
      message: "模型标识不合法，请从下拉列表中选择或填写正确的型号 ID",
    };
  }
  if (!input.allowed.includes(id)) {
    return {
      ok: false,
      model: input.current,
      message: `「${id}」不在可用清单中，请从下拉列表中选择`,
    };
  }
  const option = describeProviderModel(input.providerId ?? DEFAULT_PROVIDER_ID, id);
  return {
    ok: true,
    model: id,
    message: `已切换模型为 ${option.label}（${id}）`,
  };
}

/** 校验用的可选项集合：内置清单 ∪ 实时清单 ∪ 当前值，避免换网后把现值判为非法 */
export function allowedModelIds(...groups: string[][]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    for (const id of group) if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface ModelDriftResult {
  /** 迁移后的模型；无需迁移时等于传入的 current */
  model: string;
  /** 本地型号已退役、发生了自动迁移 */
  migrated: boolean;
  /** 迁移说明（给 TUI/控制台的提示）；未迁移时仅清单读取失败时带原因 */
  message?: string;
}

/**
 * 退役判定（纯逻辑）：当前型号不在实时清单里即视为已下架，迁到兜底默认
 * 型号。清单为空说明无从判定（比如代理返回了非标准响应），宁可不迁移——
 * 误迁会让用户莫名其妙地换模型，比一次报错更难排查。
 */
export function resolveModelDrift(current: string, liveIds: string[]): ModelDriftResult {
  if (!current || !liveIds.length || liveIds.includes(current)) {
    return { model: current, migrated: false };
  }
  const target = FALLBACK_MODEL_ID;
  if (target === current) return { model: current, migrated: false };
  return {
    model: target,
    migrated: true,
    message: `模型 ${describeModel(current).label}（${current}）已不在服务可用清单中，已自动切换到 ${describeModel(target).label}（${target}）。可在「设置」里改选其他型号。`,
  };
}

/**
 * 启动时退役检测：强制拉一次实时清单，对照本地生效的模型。只有拿到 live
 * 清单才做判定——断网 / Key 失效时保持现状，把联网失败留给真正对话时报。
 * 成功结果顺便进了缓存，设置弹窗首次打开不用再等一轮网络。
 *
 * 自动迁移仅对 deepseek 做（兜底目标 FALLBACK_MODEL_ID 是 DeepSeek 语义）；
 * 其他供应商返回原样——误迁会让用户莫名其妙地换模型，比一次报错更难排查。
 */
export async function ensureModelAvailable(input: {
  current: string;
  providerId?: string;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ModelDriftResult> {
  const providerId = getProviderDef(input.providerId ?? DEFAULT_PROVIDER_ID).id;
  if (!input.current) return { model: input.current, migrated: false };
  const list = await listModelOptions({
    providerId,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    force: true,
  });
  if (list.source !== "live" || providerId !== DEFAULT_PROVIDER_ID) {
    return { model: input.current, migrated: false, message: list.message };
  }
  return resolveModelDrift(
    input.current,
    list.options.map((m) => m.id),
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}
