/**
 * 模型供应商注册表（纯数据 + 纯函数，不 import 任何 SDK）
 *
 * 所有内置厂商都提供官方 OpenAI 兼容端点，接入层用 @ai-sdk/openai-compatible
 * 统一处理；DeepSeek 走官方 @ai-sdk/deepseek（现状零改动）。型号清单仍以
 * `GET {base}/models` 实时结果为准（models.ts），这里只内置「断网/未配 Key
 * 时的兜底清单」——厂商换代时型号 id 会过期，兜底宁可保守，注明以拉取为准。
 *
 * 依赖方向红线：本模块会被 config.ts / models.ts import，而它们在 njtech
 * 技能包的 esbuild 闭包里——所以这里绝不能 import SDK 或任何重依赖。
 */

export interface ModelOption {
  id: string;
  /** 下拉框首行：型号简称 */
  label: string;
  /** 下拉框副行：一句话说明适合什么，供用户决策 */
  note: string;
}

export interface ProviderDef {
  id: string;
  /** 下拉框首行：厂商名 */
  label: string;
  /** OpenAI 兼容端点（chat/completions 直接拼在其后）；custom 为空串 */
  baseUrl: string;
  /** 下拉框副行：厂商一句话说明 */
  note: string;
  /** 兜底型号清单（实时拉取失败时下拉仍可选用） */
  fallbackModels: ModelOption[];
  /** API Key 输入框提示（placeholder 与录入提示共用） */
  keyHint: string;
  /** 严格的 Key 形状校验；缺省走通用宽松校验（长度 + 可打印字符） */
  keyPattern?: RegExp;
  /** 已退役/兼容路由的旧型号（只做展示，不进兜底清单） */
  legacyModels?: ModelOption[];
}

/** 自定义 OpenAI 兼容端点的特殊 id（托管版禁用，防实例探测内网） */
export const CUSTOM_PROVIDER_ID = "custom";

/** 默认供应商：与历史行为一致，什么都不配就是 DeepSeek */
export const DEFAULT_PROVIDER_ID = "deepseek";

export const BUILTIN_PROVIDERS: ProviderDef[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    note: "默认供应商 · V4.1 Flash 便宜好用",
    keyHint: "sk-…（DeepSeek 开放平台）",
    keyPattern: /^sk-[A-Za-z0-9]{16,}$/,
    fallbackModels: [
      {
        id: "deepseek-flash",
        label: "Flash（V4.1，最新）",
        note: "当前主力型号 · 原生支持图片输入，响应快、消耗低",
      },
      {
        id: "deepseek-v4-pro",
        label: "V4 Pro",
        note: "上一代旗舰 · 2026-09-14 起由 V4.1-Flash 承接并按 Flash 计费",
      },
    ],
    legacyModels: [
      { id: "deepseek-v4-flash", label: "V4 Flash", note: "已退役 · 请求由 V4.1-Flash 承接" },
      {
        id: "deepseek-v4-flash-vision-exp",
        label: "V4 Flash 视觉实验版",
        note: "已退役 · 请求由 V4.1-Flash 承接",
      },
      { id: "deepseek-chat", label: "Chat（旧别名）", note: "官方已于 2026-07-24 停用该别名" },
      {
        id: "deepseek-reasoner",
        label: "Reasoner（旧别名）",
        note: "官方已于 2026-07-24 停用该别名",
      },
    ],
  },
  {
    id: "qwen",
    label: "通义千问（阿里百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    note: "阿里百炼 · qwen 系列与开源模型一站接入",
    keyHint: "sk-…（阿里云百炼控制台）",
    fallbackModels: [
      { id: "qwen3.8-max", label: "qwen3.8-max", note: "最新旗舰 · 2.4T MoE 多模态" },
      { id: "qwen3.8-flash", label: "qwen3.8-flash", note: "高性价比 · 1M 上下文" },
      { id: "qwen-plus", label: "qwen-plus", note: "通用别名 · 自动跟随官方升级" },
    ],
    legacyModels: [
      { id: "qwen-max", label: "qwen-max", note: "通用别名 · 自动跟随官方升级" },
      { id: "qwen-flash", label: "qwen-flash", note: "通用别名 · 自动跟随官方升级" },
    ],
  },
  {
    id: "glm",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    note: "智谱开放平台 · GLM-5 系列",
    keyHint: "…（智谱 bigmodel 控制台）",
    fallbackModels: [
      { id: "glm-5.3-flash", label: "GLM-5.3-Flash", note: "最新 · 原生多模态 + 1M 上下文，价低" },
      { id: "glm-5.3", label: "GLM-5.3", note: "最新旗舰" },
    ],
    legacyModels: [
      { id: "glm-5.2", label: "GLM-5.2", note: "上一代旗舰 · 1M 长上下文" },
      { id: "glm-5", label: "GLM-5", note: "上一代基座" },
    ],
  },
  {
    id: "kimi",
    label: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    note: "月之暗面 · 长文本见长",
    keyHint: "sk-…（platform.kimi.ai）",
    fallbackModels: [{ id: "kimi-k3", label: "Kimi K3", note: "最新旗舰 · 视觉理解与 1M 上下文" }],
  },
  {
    id: "doubao",
    label: "豆包（火山方舟）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    note: "字节火山方舟 · 也托管 DeepSeek/GLM 等",
    keyHint: "…（火山方舟控制台 API Key）",
    fallbackModels: [
      {
        id: "doubao-seed-2-0-pro",
        label: "Seed 2.0 Pro",
        note: "最新旗舰 · 多模态（需在方舟控制台开通）",
      },
      { id: "doubao-seed-2-0-lite", label: "Seed 2.0 Lite", note: "轻量高速 · 多模态" },
    ],
    legacyModels: [
      { id: "doubao-seed-1-8", label: "Seed 1.8", note: "上一代旗舰 · 256K 上下文全模态" },
      { id: "doubao-seed-1-6", label: "Seed 1.6", note: "上一代通用" },
    ],
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    note: "腾讯云 · OpenAI 兼容入口",
    keyHint: "…（腾讯云控制台，选 OpenAI SDK 接入）",
    fallbackModels: [
      { id: "hunyuan-turbos", label: "hunyuan-turbos", note: "速度与成本优化" },
      { id: "hunyuan-t1", label: "hunyuan-t1", note: "推理增强旗舰" },
    ],
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    note: "MiniMax 开放平台 · M 系列",
    keyHint: "…（MiniMax 开放平台，注意国内站 Key）",
    fallbackModels: [
      {
        id: "MiniMax-M2.5",
        label: "MiniMax-M2.5",
        note: "最新主力 · 价格极低（国内站 Key 与海外站不通用）",
      },
    ],
    legacyModels: [
      { id: "MiniMax-M2", label: "MiniMax-M2", note: "上一代主力（国内站 Key 与海外站不通用）" },
    ],
  },
  {
    id: "step",
    label: "阶跃星辰",
    baseUrl: "https://api.stepfun.com/v1",
    note: "StepFun 开放平台 · 多模态",
    keyHint: "…（StepFun 控制台）",
    fallbackModels: [
      { id: "step-5-preview", label: "Step 5 Preview", note: "最新（预览版）· 1M 上下文开源 MoE" },
      { id: "step-3.7-flash", label: "step-3.7-flash", note: "多模态推理 · 响应快" },
    ],
  },
  {
    id: "ernie",
    label: "文心（百度千帆）",
    baseUrl: "https://qianfan.baidubce.com/v2",
    note: "百度千帆模型服务 · ERNIE 系列",
    keyHint: "bce-v3…（千帆控制台 API Key）",
    fallbackModels: [
      { id: "ernie-5.0", label: "ERNIE 5.0", note: "最新旗舰 · 原生全模态" },
      { id: "ernie-4.5-turbo-128k", label: "ERNIE 4.5 Turbo", note: "高频轻量 · 128K 上下文" },
    ],
  },
  {
    id: "spark",
    label: "讯飞星火",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    note: "讯飞开放平台 · HTTP 兼容入口",
    keyHint: "…（讯飞控制台，选 HTTP 接入的 Key）",
    fallbackModels: [
      { id: "lite", label: "Lite", note: "免费档 · 轻量任务" },
      { id: "4.0Ultra", label: "4.0 Ultra", note: "旗舰档" },
    ],
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    note: "聚合平台 · 一个 Key 用多家开源模型",
    keyHint: "sk-…（siliconflow.cn）",
    fallbackModels: [
      {
        id: "Qwen/Qwen3-8B",
        label: "Qwen3-8B",
        note: "免费档 · 日常对话够用",
      },
      {
        id: "deepseek-ai/DeepSeek-V3.2",
        label: "DeepSeek-V3.2",
        note: "开源旗舰（硅基流动托管）",
      },
    ],
  },
  {
    id: "zhenze",
    label: "移动云",
    baseUrl: "https://zhenze-huhehaote.cmecloud.cn/v1",
    note: "中国移动云 · 聚合 DeepSeek/GLM/Qwen/九天等模型",
    keyHint: "…（移动云 API Key）",
    fallbackModels: [
      {
        id: "deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash",
        note: "与默认供应商同款主力 · 1M 上下文",
      },
      { id: "glm-5.3", label: "GLM-5.3", note: "旗舰 · 1M 上下文推理" },
      { id: "qwen3.5-397b-a17b", label: "Qwen3.5 397B", note: "开源旗舰 · 262K 上下文" },
      { id: "MiniMax-M2.5", label: "MiniMax-M2.5", note: "高性价比主力" },
      { id: "JIUTIAN-75B-32K", label: "九天 75B", note: "移动自研 · 32K 上下文" },
    ],
    legacyModels: [
      {
        id: "deepseek-v4-flash-0731",
        label: "DeepSeek V4 Flash (0731)",
        note: "旧版快照 · 建议用 V4.1-Flash",
      },
      { id: "glm-5.2", label: "GLM-5.2", note: "上一代旗舰 · 200K 上下文" },
      { id: "DeepSeek-V3.1", label: "DeepSeek V3.1", note: "上一代开源旗舰" },
    ],
  },
  {
    id: CUSTOM_PROVIDER_ID,
    label: "自定义（OpenAI 兼容）",
    baseUrl: "",
    note: "填任意 OpenAI 兼容端点（本地版可用）",
    keyHint: "该端点的 API Key",
    fallbackModels: [],
  },
];

const PROVIDER_MAP = new Map(BUILTIN_PROVIDERS.map((p) => [p.id, p]));

/** 解析供应商 id：不认识的一律回落 DeepSeek（含 undefined/null/空串） */
export function resolveProviderId(raw: string | undefined | null): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  return PROVIDER_MAP.has(id) ? id : DEFAULT_PROVIDER_ID;
}

export function getProviderDef(id: string): ProviderDef {
  return PROVIDER_MAP.get(resolveProviderId(id)) ?? BUILTIN_PROVIDERS[0];
}

export function isCustomProvider(id: string): boolean {
  return resolveProviderId(id) === CUSTOM_PROVIDER_ID;
}

/** 下拉候选：全部内置厂商（含自定义）；托管版是否含 custom 由前端按 hosted 过滤 */
export function providerOptionList(): {
  id: string;
  label: string;
  note: string;
  keyHint: string;
}[] {
  return BUILTIN_PROVIDERS.map(({ id, label, note, keyHint }) => ({ id, label, note, keyHint }));
}

/**
 * 当前供应商的 OpenAI 兼容端点。custom 必须给自填地址；其余厂商忽略
 * 自填地址（避免把别家的 baseUrl 改到官方 id 上）。
 */
export function providerBaseUrl(id: string, customBaseUrl?: string): string {
  const def = getProviderDef(id);
  if (def.id === CUSTOM_PROVIDER_ID) {
    return normalizeCustomBaseUrl(customBaseUrl).url;
  }
  return def.baseUrl;
}

/** 自定义端点校验：必须是 http(s) URL，去尾斜杠，长度封顶 */
export function normalizeCustomBaseUrl(raw: string | undefined | null): {
  ok: boolean;
  url: string;
  message: string;
} {
  const url = (typeof raw === "string" ? raw : "").trim().replace(/\/+$/, "");
  if (!url) return { ok: false, url: "", message: "请填写自定义服务地址（https://…）" };
  if (url.length > 200) return { ok: false, url: "", message: "服务地址过长（上限 200 字符）" };
  if (!/^https?:\/\/[A-Za-z0-9.:-]+(\/[^\s]*)?$/.test(url)) {
    return {
      ok: false,
      url: "",
      message: "服务地址需以 http(s):// 开头，例如 https://api.example.com/v1",
    };
  }
  return { ok: true, url, message: "" };
}

/**
 * 按供应商校验 API Key 形状：DeepSeek 维持严格的 sk- 前缀（历史行为），
 * 其余厂商 Key 格式各异，只做宽松校验（长度 + 常见字符集），把「对不对」
 * 留给连接诊断去问服务端。
 */
export function validateProviderApiKey(id: string, key: string): { ok: boolean; message: string } {
  const def = getProviderDef(id);
  const trimmed = key.trim();
  if (def.keyPattern) {
    if (!def.keyPattern.test(trimmed)) {
      return { ok: false, message: `格式不对：请输入该供应商的完整 API Key（${def.keyHint}）` };
    }
    return { ok: true, message: "" };
  }
  if (trimmed.length < 16 || trimmed.length > 200 || /\s/.test(trimmed)) {
    return { ok: false, message: "API Key 长度或字符不合常理，请检查是否复制完整" };
  }
  return { ok: true, message: "" };
}

/** 该供应商已知型号（兜底 + 退役）的展示信息；未知 id 返回裸 id 展示 */
export function describeProviderModel(id: string, modelId: string): ModelOption {
  const def = getProviderDef(id);
  const known = [...def.fallbackModels, ...(def.legacyModels ?? [])].find((m) => m.id === modelId);
  return known ?? { id: modelId, label: modelId, note: "模型服务返回的型号" };
}
