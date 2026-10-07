/**
 * 凭证设置流程
 *
 * 2026-10 起不再有教务账号引导（程序不保存教务密码，课表数据由用户
 * 自行导入）；本文件保留 API Key 设置流程（终端 /key、设置面板）与
 * QQ 机器人凭证的保存/状态逻辑。
 */

import readline from "node:readline/promises";

import { config, type DeepSeekApiKeySource, maskDeepSeekApiKey } from "./config";
import { loadCredentialsStore, saveCredentialsStore } from "./credentials";
import { getProviderDef, validateProviderApiKey } from "./providers";
import { createMutedTerminalOutput } from "./secret-input";

export interface DeepSeekKeyStatus {
  configured: boolean;
  masked?: string;
  source: DeepSeekApiKeySource;
}

/** 给 UI 的状态不包含任何完整 Key，防止调用方误回显或误传给 Agent。 */
export function getDeepSeekKeyStatus(): DeepSeekKeyStatus {
  if (!config.deepseekApiKey) return { configured: false, source: "unset" };
  return {
    configured: true,
    masked: maskDeepSeekApiKey(config.deepseekApiKey),
    source: config.deepseekApiKeySource,
  };
}

/** 本地 /key 设置流程唯一需要的终端能力；测试可注入内存实现，不读真实 stdin。 */
export interface KeySetupIO {
  write(message: string): void;
  confirm(prompt: string): Promise<boolean>;
  readSecret(prompt: string): Promise<string>;
  close?(): void;
}

export type KeySetupResult = "saved" | "kept" | "cancelled" | "invalid";

interface KeySetupServices {
  getStatus(): DeepSeekKeyStatus;
  setKey(key: string): { ok: boolean; message: string };
}

function createTerminalKeySetupIO(): KeySetupIO {
  const out = createMutedTerminalOutput();
  const rl = readline.createInterface({
    input: process.stdin,
    output: out.stream,
    terminal: true,
  });
  return {
    write: (message) => console.log(message),
    confirm: async (prompt) => /^(y|yes)$/i.test((await rl.question(`${prompt} [y/N] `)).trim()),
    readSecret: async (prompt) => {
      // 提示必须在开启静音前直接写出；否则用户只看到空白行，不知道该填什么。
      process.stdout.write(`${prompt}（输入不回显）: `);
      out.setMuted(true);
      try {
        return await rl.question("");
      } finally {
        out.setMuted(false);
        process.stdout.write("\n");
      }
    },
    close: () => rl.close(),
  };
}

/**
 * 无参 /key 的本地安全流程：已有值仅展示脱敏摘要，明确确认后才静音读取新值。
 * 完整 Key 只从 readSecret 传到 setKey；不写入 TUI、Agent、会话或日志。
 */
export async function runDeepSeekKeySetup(
  io: KeySetupIO = createTerminalKeySetupIO(),
  services: KeySetupServices = {
    getStatus: getDeepSeekKeyStatus,
    setKey: setDeepSeekApiKey,
  },
): Promise<KeySetupResult> {
  try {
    const status = services.getStatus();
    if (status.configured) {
      io.write(`当前 API Key：${status.masked ?? "已配置"}`);
      if (!(await io.confirm("是否覆盖当前 Key？"))) {
        io.write("已保留当前 API Key。");
        return "kept";
      }
    }

    io.write(
      `请粘贴或输入新的 ${getProviderDef(config.providerId).label} API Key（输入内容不会显示）。`,
    );
    const key = await io.readSecret("API Key");
    if (!key.trim()) {
      io.write("已取消，未修改 API Key。");
      return "cancelled";
    }

    const result = services.setKey(key);
    io.write(result.message);
    return result.ok ? "saved" : "invalid";
  } finally {
    io.close?.();
  }
}

/**
 * 配置当前供应商的 API Key（校验 -> 热生效 -> 加密持久化）
 * 热生效原理：回写 process.env（RAPTOR_PROVIDER_KEY；deepseek 另镜像
 * DEEPSEEK_API_KEY 供官方包），llm.ts 每次请求实时读取。
 * 每供应商一把 Key：切换供应商不丢已存的其他厂商 Key。
 */
export function setProviderApiKey(
  providerId: string,
  key: string,
): { ok: boolean; message: string } {
  const def = getProviderDef(providerId);
  const check = validateProviderApiKey(def.id, key);
  const trimmed = key.trim();
  if (!check.ok) return { ok: false, message: `❌ ${check.message}` };

  const stored = loadCredentialsStore();
  const providerKeys = { ...(stored?.providerKeys ?? {}), [def.id]: trimmed };
  const providerKeyOverrides = { ...(stored?.providerKeyOverrides ?? {}), [def.id]: true };
  process.env.RAPTOR_PROVIDER_KEY = trimmed; // 热生效（llm.ts fetch 每请求读取）
  if (def.id === "deepseek") process.env.DEEPSEEK_API_KEY = trimmed; // 官方包路径
  config.deepseekApiKey = trimmed;
  config.deepseekApiKeySource = "encrypted";
  // 明确覆盖标记让重启后优先使用加密新值，但绝不改写 .env 的明文旧值。
  saveCredentialsStore({ providerKeys, providerKeyOverrides });
  return { ok: true, message: "✅ API Key 已加密保存并立即生效，重启后仍使用新 Key。" };
}

/** 历史入口（TUI /key 与既有测试）：作用于当前供应商 */
export function setDeepSeekApiKey(key: string): { ok: boolean; message: string } {
  return setProviderApiKey(config.providerId, key);
}

// ── QQ 官方机器人凭证（设置面板保存；.env 优先级规则与教务账号一致）──

export interface QQBotStatus {
  configured: boolean;
  appIdMasked?: string;
  passcodeSet: boolean;
  source: "env" | "encrypted" | "unset";
}

/** 给 UI 的状态只带脱敏 AppID，绝不回显 AppSecret */
export function getQQBotStatus(): QQBotStatus {
  const configured = !!(config.qqBotAppId && config.qqBotAppSecret);
  return {
    configured,
    ...(configured ? { appIdMasked: maskQQAppId(config.qqBotAppId ?? "") } : {}),
    passcodeSet: !!config.qqBotPasscode,
    source: config.qqBotSource,
  };
}

/** AppID 是标识不是口令，但同样只回显首尾，防完整值进截图/会话 */
export function maskQQAppId(appId: string): string {
  const trimmed = appId.trim();
  if (trimmed.length < 8) return "已配置";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-2)}`;
}

export interface QQBotSaveResult {
  ok: boolean;
  message: string;
  /** 保存后 AppID+AppSecret 是否已凑齐（调用方据此决定要不要拉起桥） */
  complete: boolean;
}

/**
 * 保存 QQ 机器人凭证（校验 -> 热生效 -> 加密持久化）。
 * AppID 与 AppSecret 必须成对提交（同教务账号的学号/密码规则）；
 * 暗号可单独设置。调用方负责保存成功后的桥热启动。
 */
export function setQQBotCredentials(patch: {
  appId?: string;
  appSecret?: string;
  passcode?: string;
}): QQBotSaveResult {
  const appId = patch.appId?.trim() ?? "";
  const appSecret = patch.appSecret?.trim() ?? "";
  const passcode = patch.passcode?.trim() ?? "";
  if ((appId || appSecret) && !(appId && appSecret)) {
    return {
      ok: false,
      message: "❌ AppID 与 AppSecret 需要一起填写（q.qq.com 机器人详情页可查）。",
      complete: !!(config.qqBotAppId && config.qqBotAppSecret),
    };
  }
  if (appId) {
    saveCredentialsStore({ qqBotAppId: appId, qqBotAppSecret: appSecret });
    config.qqBotAppId = appId;
    config.qqBotAppSecret = appSecret;
    config.qqBotSource = "encrypted";
  }
  if (passcode) {
    saveCredentialsStore({ qqBotPasscode: passcode });
    config.qqBotPasscode = passcode;
  }
  const complete = !!(config.qqBotAppId && config.qqBotAppSecret);
  const bits: string[] = [];
  if (appId) bits.push("AppID 与 AppSecret 已加密保存");
  if (passcode) bits.push("激活暗号已保存，到 QQ 里发给机器人即完成授权");
  if (!bits.length) {
    return { ok: false, message: "❌ 没有需要保存的 QQ 配置。", complete };
  }
  return {
    ok: true,
    message: `✅ ${bits.join("；")}。`,
    complete,
  };
}
