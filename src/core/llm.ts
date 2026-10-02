/**
 * 语言模型工厂：按当前供应商构建 AI SDK 模型实例
 *
 * - DeepSeek：官方 @ai-sdk/deepseek（历史路径零改动）。不传 apiKey，SDK
 *   每次请求实时读 process.env.DEEPSEEK_API_KEY——/key 与设置弹窗保存 Key
 *   后写 env 即热生效，无需重建 agent。
 * - 其余厂商（含自定义 OpenAI 兼容端点）：@ai-sdk/openai-compatible。SDK
 *   的 apiKey 参数是构建时字符串（不支持惰性求值），所以走自定义 fetch：
 *   每次请求从 process.env.RAPTOR_PROVIDER_KEY 现取并注入 Authorization，
 *   保住与 DeepSeek 相同的「保存 Key 即热生效」语义。
 *
 * 本模块 import SDK，严禁被 config.ts / models.ts / credentials.ts 引用——
 * 它们在 njtech 技能包的 esbuild 闭包里，拖进 SDK 会撑爆单文件包。
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { config } from "./config";
import { getProviderDef } from "./providers";

export interface BuildModelOptions {
  /** 覆盖 config.model（演示等场景自带型号时用） */
  model?: string;
  /** 覆盖 config 解析出的端点（仅对 DeepSeek 历史路径有意义） */
  baseUrl?: string;
}

/** 每次请求注入当前 Key：Key 保存路径（onboarding/设置弹窗）会回写这个 env */
function fetchWithBearer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const key = process.env.RAPTOR_PROVIDER_KEY || "";
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return globalThis.fetch(input, { ...init, headers });
}

/** 构建当前供应商的语言模型；agent 重组装（换型号/换供应商）时重新调用 */
export function buildLanguageModel(options: BuildModelOptions = {}) {
  const providerId = config.providerId;
  const modelId = options.model ?? config.model;
  const def = getProviderDef(providerId);

  if (def.id === "deepseek") {
    const deepseek = createDeepSeek(
      (options.baseUrl ?? config.deepseekBaseUrl)
        ? { baseURL: (options.baseUrl ?? config.deepseekBaseUrl) as string }
        : {},
    );
    return deepseek(modelId);
  }

  const baseURL = (options.baseUrl ?? config.providerBaseUrl).replace(/\/+$/, "");
  const provider = createOpenAICompatible({
    name: `raptor-${def.id}`,
    baseURL,
    // 占位值：真实 Key 由 fetchWithBearer 每请求注入
    apiKey: "resolved-per-request",
    fetch: fetchWithBearer,
  });
  return provider.chatModel(modelId);
}
