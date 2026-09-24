/**
 * 首次运行凭证引导：交互式录入学号/密码 -> 真实登录验证 -> 加密保存
 * 触发条件：.env 与 credentials.enc 都没有教务凭证时
 *
 * 引导不强制：学号密码都留空回车即跳过，直接进入应用；验证连续失败也
 * 不拦启动，由用户选择保存未验证账号或跳过。跳过后教务功能报「尚未
 * 配置」，网页「设置 → 教务账号」里随时补填。
 */

import readline from "node:readline/promises";

import { config, type DeepSeekApiKeySource, maskDeepSeekApiKey } from "./config";
import { saveCredentialsStore, saveStoredCredentials } from "./credentials";
import { school } from "./school";
import { createMutedTerminalOutput } from "./secret-input";

/** 引导结果：configured=已保存（含用户确认的未验证保存）；skipped=跳过，稍后在设置里补填 */
export type CredentialSetupOutcome = "configured" | "skipped";

/** 凭证引导唯一需要的终端能力；测试可注入内存实现，不读真实 stdin。 */
export interface CredentialSetupIO {
  write(message: string): void;
  ask(prompt: string): Promise<string>;
  askSecret(prompt: string): Promise<string>;
  close?(): void;
}

interface CredentialSetupServices {
  isConfigured(): boolean;
  login(username: string, password: string): Promise<void>;
  save(username: string, password: string): void;
}

const credentialServices: CredentialSetupServices = {
  isConfigured: () => !!(config.jwglUsername && config.jwglPassword),
  login: async (username, password) => {
    await school().auth.login(username, password);
  },
  save: (username, password) => saveStoredCredentials(username, password),
};

export async function ensureCredentials(
  io?: CredentialSetupIO,
  services: CredentialSetupServices = credentialServices,
): Promise<CredentialSetupOutcome> {
  if (services.isConfigured()) return "configured";

  const terminal = io ?? createTerminalCredentialIO();
  try {
    terminal.write("🦖 首次使用：第 1 步，共 2 步——配置教务系统账号");
    terminal.write("   账号和密码将 AES-256-GCM 加密保存在本机，不会明文落盘。");
    terminal.write(
      "   暂时不填也可以：学号处直接回车跳过，之后在网页「设置 → 教务账号」里补填。\n",
    );

    for (let attempt = 1; ; attempt++) {
      const username = (await terminal.ask("学号（输入后按回车，留空跳过）: ")).trim();
      const password = await terminal.askSecret("教务系统密码（输入不回显，输入后按回车）: ");

      if (!username && !password) {
        terminal.write("⏭️ 已跳过教务账号配置：聊天、待办、通知等功能照常使用。");
        terminal.write(
          "   需要查课表/成绩时，在网页对话窗口右上角「设置 → 教务账号」里补填即可。\n",
        );
        return "skipped";
      }
      if (!username || !password) {
        terminal.write("❌ 学号和密码需要一起填写；都不填则跳过");
        continue;
      }

      try {
        // 真实登录验证：密码错误当场重输，避免存入无效凭证
        await services.login(username, password);
        services.save(username, password);
        applyConfiguredCredentials(username, password);
        terminal.write("✅ 教务账号验证通过，已加密保存。\n");
        return "configured";
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("密码") || msg.includes("学号")) {
          terminal.write(`❌ ${msg.slice(0, 60)}，请重试`);
        } else {
          terminal.write(`⚠️ 登录异常（${msg.slice(0, 50)}）——多为网络抖动，请重试`);
        }
        if (attempt >= 5) {
          // 不拦启动：验证连不过（网络/教务系统不可达等）时由用户决定存不存
          const keep = /^(y|yes)$/i.test(
            (await terminal.ask("连续 5 次验证未通过。仍要保存刚输入的账号吗？[y/N] ")).trim(),
          );
          if (keep) {
            services.save(username, password);
            applyConfiguredCredentials(username, password);
            terminal.write(
              "✅ 已保存教务账号（本次未验证）；如填错了，之后可在网页「设置」里修改。\n",
            );
            return "configured";
          }
          terminal.write(
            "⏭️ 未保存教务账号，不影响进入应用；之后可在网页「设置 → 教务账号」里补填。\n",
          );
          return "skipped";
        }
      }
    }
  } finally {
    terminal.close?.();
  }
}

/** 保存成功后热生效：本进程内立即用上新账号，不必重启 */
function applyConfiguredCredentials(username: string, password: string): void {
  config.jwglUsername = username;
  config.jwglPassword = password;
  config.credentialsSource = "encrypted";
}

function createTerminalCredentialIO(): CredentialSetupIO {
  const out = createMutedTerminalOutput();
  // terminal: true 不能省：output 是自定义 Writable（没有 isTTY），省了它
  // readline 就判定为非终端、不给 stdin 开 raw mode，终端自身的回显会把密码
  // 直接打在屏幕上——「输入不回显」就成了空话。开了之后提示符与回显都走
  // out.stream，由 setMuted 统一开关。
  const rl = readline.createInterface({
    input: process.stdin,
    output: out.stream,
    terminal: true,
  });
  return {
    write: (message) => console.log(message),
    ask: (prompt) => rl.question(prompt),
    askSecret: async (prompt) => {
      // 提示必须在开启静音前直接写出；否则用户只看到空白行，不知道该填什么。
      process.stdout.write(prompt);
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

    io.write("请粘贴或输入新的 DeepSeek API Key（输入内容不会显示）。");
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
 * 配置 DeepSeek API Key（校验 -> 热生效 -> 加密持久化）
 * 热生效原理：provider 构建时不绑定 key，每次请求实时读
 * process.env.DEEPSEEK_API_KEY（AI SDK loadApiKey 惰性求值）
 */
export function setDeepSeekApiKey(key: string): { ok: boolean; message: string } {
  const trimmed = key.trim();
  if (!/^sk-[A-Za-z0-9]{16,}$/.test(trimmed)) {
    return {
      ok: false,
      message: "❌ 格式不对：请输入 sk- 开头的完整 API Key。",
    };
  }
  process.env.DEEPSEEK_API_KEY = trimmed; // 热生效
  config.deepseekApiKey = trimmed;
  config.deepseekApiKeySource = "encrypted";
  // 明确覆盖标记让重启后优先使用加密新值，但绝不改写 .env 的明文旧值。
  saveCredentialsStore({ deepseekApiKey: trimmed, deepseekApiKeyOverride: true });
  return { ok: true, message: "✅ API Key 已加密保存并立即生效，重启后仍使用新 Key。" };
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
