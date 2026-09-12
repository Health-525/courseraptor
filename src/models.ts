/**
 * DeepSeek 模型清单与选择校验
 *
 * 「账号与模型」里的模型下拉不能凭空写死：DeepSeek 会换型号 id——V4.1 上线
 * 时退役了 V4 Flash 系列（deepseek-v4-flash / -flash-vision-exp 改由 V4.1-
 * Flash 兼容承接），deepseek-chat / deepseek-reasoner 旧别名更已于 2026-07-24
 * 停用。所以清单以 `GET {base}/models` 的实时结果为准（OpenAI 兼容，取
 * data[].id），拉取失败（没配 Key / 断网 / 401 / 非标准代理）时退回内置
 * 兜底清单——弹窗永远得可选。
 *
 * 默认模型 deepseek-flash 是官方当前主力型号（V4.1-Flash，原生支持图片
 * 输入）。官方换代不再保证保留别名，本地若存着已退役的旧 id，启动时由
 * ensureModelAvailable 拉实时清单检出并自动迁移，避免对话请求直接 4xx。
 *
 * 本模块不 import config，免得和 config <-> credentials 的依赖绕圈：baseUrl、
 * apiKey 由调用方显式传入，fetch 也可注入，纯逻辑与网络都能单独测。
 */

export interface ModelOption {
  id: string;
  /** 下拉框首行：型号简称 */
  label: string;
  /** 下拉框副行：一句话说明适合什么，供用户决策 */
  note: string;
}

/** 官方默认服务地址（SDK 内部同款，这里只用于列表请求） */
const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

/** 兜底默认值：官方当前主力型号（V4.1-Flash），官方换代时随公告更新 */
export const FALLBACK_MODEL_ID = "deepseek-flash";

/** 模型 id 形状白名单：只接受 API 可能返回的标识字符，长度与下拉选项同源 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** 兜底清单：网络不可用时也要让用户有得选，只列官方在架型号 */
export const FALLBACK_MODELS: ModelOption[] = [
  {
    id: FALLBACK_MODEL_ID,
    label: "Flash（V4.1，最新）",
    note: "当前主力型号 · 原生支持图片输入，响应快、消耗低",
  },
  {
    id: "deepseek-v4-pro",
    label: "V4 Pro",
    note: "上一代旗舰 · 2026-09-14 起由 V4.1-Flash 承接并按 Flash 计费",
  },
];

/**
 * 已退役型号的展示信息：兼容路由中的旧 id 仍会出现在 /models 里，本地也
 * 可能存着停用前的选择。给它们可读的名字，说明里如实标注退役状态——
 * 不进兜底清单（不推荐新选），但下拉里出现时不能只显示裸 id。
 */
const LEGACY_MODEL_META: ModelOption[] = [
  { id: "deepseek-v4-flash", label: "V4 Flash", note: "已退役 · 请求由 V4.1-Flash 承接" },
  {
    id: "deepseek-v4-flash-vision-exp",
    label: "V4 Flash 视觉实验版",
    note: "已退役 · 请求由 V4.1-Flash 承接",
  },
  { id: "deepseek-chat", label: "Chat（旧别名）", note: "官方已于 2026-07-24 停用该别名" },
  { id: "deepseek-reasoner", label: "Reasoner（旧别名）", note: "官方已于 2026-07-24 停用该别名" },
];

const KNOWN_MODELS = new Map([...FALLBACK_MODELS, ...LEGACY_MODEL_META].map((m) => [m.id, m]));

/** 服务返回的新型号没有中文名时，直接用 id 展示，不编造说明 */
export function describeModel(id: string): ModelOption {
  return KNOWN_MODELS.get(id) ?? { id, label: id, note: "模型服务返回的型号" };
}

/**
 * 与 resolveDeepSeekApiKey 同构：交互式（设置弹窗）明确选过的值优先于 .env，
 * 否则用户在界面里换了型号、重启又被 RAPTOR_MODEL 拉回去。
 */
export function resolveStoredModel(input: {
  environmentModel?: string;
  storedModel?: string;
  storedOverride?: boolean;
}): string {
  if (input.storedOverride && input.storedModel) return input.storedModel;
  if (input.environmentModel) return input.environmentModel;
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
let cache: { at: number; options: ModelOption[] } | null = null;

/** 换了 API Key 后必须重取清单：旧 Key 的可用型号可能完全不同 */
export function invalidateModelCache(): void {
  cache = null;
}

const FALLBACK_RESULT: ModelListResult = {
  options: FALLBACK_MODELS.map((m) => ({ ...m })),
  source: "fallback",
};

/**
 * 同步版清单：给 /api/settings 这类不能等网络的组装点用。
 * 有实时缓存就用它，否则退回内置清单；联网刷新走 listModelOptions。
 */
export function cachedModelOptions(): ModelOption[] {
  const source = cache ? cache.options : FALLBACK_RESULT.options;
  return source.map((m) => ({ ...m }));
}

/** 读取可用模型清单；只缓存成功结果，失败时下次进来还能重试 */
export async function listModelOptions(
  input: {
    baseUrl?: string;
    apiKey?: string;
    force?: boolean;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ModelListResult> {
  if (!input.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { options: cache.options.map((m) => ({ ...m })), source: "live" };
  }
  if (!input.apiKey) {
    return { ...FALLBACK_RESULT, message: "尚未配置 API Key，已显示内置清单" };
  }
  const doFetch = input.fetchImpl ?? fetch;
  const base = (input.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
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
      return { ...FALLBACK_RESULT, message: `模型清单读取失败（${reason}），已显示内置清单` };
    }
    const ids = parseModelIds(await response.json());
    if (!ids.length) {
      return { ...FALLBACK_RESULT, message: "模型服务未返回可用清单，已显示内置清单" };
    }
    const options = ids.map((id) => ({ ...describeModel(id) }));
    cache = { at: Date.now(), options };
    return { options: options.map((m) => ({ ...m })), source: "live" };
  } catch (error) {
    const detail = oneLine(error instanceof Error ? error.message : String(error));
    return {
      ...FALLBACK_RESULT,
      message: `模型清单读取失败（${detail}），已显示内置清单`,
    };
  }
}

/** 弹窗一次只提交一个改动：留空表示不修改，清单外型号一律拒绝 */
export function validateModelChoice(input: {
  requested: string;
  allowed: string[];
  current: string;
}): { ok: boolean; model: string; message: string } {
  const id = input.requested.trim();
  if (!MODEL_ID_RE.test(id)) {
    return { ok: false, model: input.current, message: "模型标识不合法，请从下拉列表中选择" };
  }
  if (!input.allowed.includes(id)) {
    return {
      ok: false,
      model: input.current,
      message: `「${id}」不在可用清单中，请从下拉列表中选择`,
    };
  }
  const option = describeModel(id);
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
    message: `模型 ${describeModel(current).label}（${current}）已不在服务可用清单中，已自动切换到 ${describeModel(target).label}（${target}）。可在「账号与模型」里改选其他型号。`,
  };
}

/**
 * 启动时退役检测：强制拉一次实时清单，对照本地生效的模型。只有拿到 live
 * 清单才做判定——断网 / Key 失效时保持现状，把联网失败留给真正对话时报。
 * 成功结果顺便进了缓存，设置弹窗首次打开不用再等一轮网络。
 */
export async function ensureModelAvailable(input: {
  current: string;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ModelDriftResult> {
  if (!input.current) return { model: input.current, migrated: false };
  const list = await listModelOptions({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    force: true,
  });
  if (list.source !== "live") {
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
